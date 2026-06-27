import { v4 as uuidv4 } from "uuid";
import type { z } from "zod";
import { generateOCMF, getOCMFPublicKey } from "../ocmfGenerator";
import type { VCP } from "../vcp";
import type { IdTokenTypeSchema } from "./messages/_common";
import { statusNotificationOcppOutgoing } from "./messages/statusNotification";
import { transactionEventOcppOutgoing } from "./messages/transactionEvent";

export type IdToken = z.infer<typeof IdTokenTypeSchema>;

// triggerReason values used when a session begins. "RemoteStart" = a paid/remote
// authorization that started on plug-in; "CablePluggedIn" = unauthorized plug
// (scan & charge).
type StartTriggerReason = "Authorized" | "RemoteStart" | "CablePluggedIn";

interface StartOpts {
  evseId?: number | null;
  connectorId?: number;
  idToken?: IdToken | null;
  remoteStartId?: number | null;
  triggerReason?: StartTriggerReason;
}

/**
 * Start (or refuse to start) a charging session and emit the OCPP messages a real
 * charger sends when energy begins to flow: StatusNotification(Occupied) +
 * TransactionEvent(Started) + the periodic meter-values loop.
 *
 * Shared by RequestStartTransaction (when the cable is already plugged in) and the
 * Plug admin action (remote-start armed earlier, or unauthorized scan & charge).
 * Returns the transactionId, or null if a session is already running.
 */
export function startChargingSession(vcp: VCP, opts: StartOpts = {}): string | null {
  const evseId = opts.evseId ?? 1;
  const connectorId = opts.connectorId ?? 1;
  const triggerReason = opts.triggerReason ?? "RemoteStart";

  if (!vcp.transactionManager.canStartNewTransaction(connectorId)) {
    return null;
  }

  const transactionId = uuidv4();
  vcp.transactionManager.startTransaction(vcp, {
    transactionId,
    idTag: opts.idToken?.idToken ?? "",
    evseId,
    connectorId,
    meterValuesCallback: async (transactionStatus) => {
      vcp.send(
        transactionEventOcppOutgoing.request({
          eventType: "Updated",
          timestamp: new Date().toISOString(),
          seqNo: 0,
          triggerReason: "MeterValuePeriodic",
          transactionInfo: { transactionId },
          evse: { id: evseId, connectorId },
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [
                {
                  value: transactionStatus.meterValue,
                  measurand: "Energy.Active.Import.Register",
                  unitOfMeasure: { unit: "kWh" },
                },
              ],
            },
          ],
        }),
      );
    },
  });

  vcp.send(
    statusNotificationOcppOutgoing.request({
      evseId,
      connectorId,
      connectorStatus: "Occupied",
      timestamp: new Date().toISOString(),
    }),
  );
  vcp.send(
    transactionEventOcppOutgoing.request({
      eventType: "Started",
      timestamp: new Date().toISOString(),
      seqNo: 0,
      triggerReason,
      transactionInfo: {
        transactionId,
        remoteStartId: opts.remoteStartId ?? undefined,
      },
      idToken: opts.idToken ?? undefined,
      evse: { id: evseId, connectorId },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: 0,
              measurand: "Energy.Active.Import.Register",
              unitOfMeasure: { unit: "kWh" },
            },
          ],
        },
      ],
    }),
  );

  return transactionId;
}

/**
 * End a running session: emit TransactionEvent(Ended) with the real metered energy
 * (kWh, OCMF-signed) + StatusNotification(Available), and stop the internal meter
 * loop. Shared by RequestStopTransaction and the Unplug admin action.
 */
export function endChargingSession(vcp: VCP, transactionId: string): boolean {
  const transaction = vcp.transactionManager.transactions.get(transactionId);
  if (!transaction) {
    return false;
  }

  const ocmf = generateOCMF({
    startTime: transaction.startedAt,
    startEnergy: 0,
    endTime: new Date(),
    // getMeterValue is already kWh
    endEnergy: vcp.transactionManager.getMeterValue(transactionId),
    idTag: transaction.idTag,
  });

  vcp.send(
    transactionEventOcppOutgoing.request({
      eventType: "Ended",
      timestamp: new Date().toISOString(),
      seqNo: 0,
      triggerReason: "RemoteStop",
      transactionInfo: { transactionId },
      evse: { id: transaction.evseId ?? 1, connectorId: transaction.connectorId },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: vcp.transactionManager.getMeterValue(transactionId),
              measurand: "Energy.Active.Import.Register",
              unitOfMeasure: { unit: "kWh" },
              signedMeterValue: {
                signedMeterData: Buffer.from(ocmf).toString("base64"),
                signingMethod: "",
                encodingMethod: "OCMF",
                publicKey: getOCMFPublicKey().toString("base64"),
              },
              context: "Transaction.End",
            },
          ],
        },
      ],
    }),
  );
  vcp.send(
    statusNotificationOcppOutgoing.request({
      evseId: transaction.evseId ?? 1,
      connectorId: transaction.connectorId,
      connectorStatus: "Available",
      timestamp: new Date().toISOString(),
    }),
  );
  vcp.transactionManager.stopTransaction(transactionId);
  return true;
}
