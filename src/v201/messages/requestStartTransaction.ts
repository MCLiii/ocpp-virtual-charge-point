import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { endChargingSession, startChargingSession } from "../chargingSession";
import {
  ChargingProfileSchema,
  IdTokenTypeSchema,
  StatusInfoTypeSchema,
} from "./_common";

const RequestStartTransactionReqSchema = z.object({
  evseId: z.number().int().nullish(),
  remoteStartId: z.number().int(),
  idToken: IdTokenTypeSchema,
  chargingProfile: ChargingProfileSchema.nullish(),
  groupIdToken: IdTokenTypeSchema.nullish(),
});
type RequestStartTransactionReqType = typeof RequestStartTransactionReqSchema;

const RequestStartTransactionResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
  transactionId: z.string().max(36).nullish(),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type RequestStartTransactionResType = typeof RequestStartTransactionResSchema;

class RequestStartTransactionOcppIncoming extends OcppIncoming<
  RequestStartTransactionReqType,
  RequestStartTransactionResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<RequestStartTransactionReqType>>,
  ): Promise<void> => {
    const transactionEvseId = call.payload.evseId ?? 1;
    const transactionConnectorId = 1;

    // A prior session may still be running on this connector (e.g. it was never
    // unplugged in testing). Rather than permanently rejecting every new remote
    // start, supersede it: end the stale session (settles it) and free the
    // connector so this new authorization can proceed.
    if (
      !vcp.transactionManager.canStartNewTransaction(transactionConnectorId)
    ) {
      const stale = Array.from(
        vcp.transactionManager.transactions.values(),
      )[0];
      if (stale) {
        endChargingSession(vcp, String(stale.transactionId));
      }
    }

    vcp.respond(this.response(call, { status: "Accepted" }));

    const start = {
      evseId: transactionEvseId,
      connectorId: transactionConnectorId,
      idToken: call.payload.idToken,
      remoteStartId: call.payload.remoteStartId,
    };

    if (vcp.pluggedIn) {
      // Cable already plugged in -> begin charging immediately.
      startChargingSession(vcp, { ...start, triggerReason: "RemoteStart" });
    } else {
      // Pay-before-plug: arm the charger and wait. The session starts
      // automatically when the driver plugs in (see the Plug admin action).
      vcp.pendingRemoteStart = start;
    }
  };
}

export const requestStartTransactionOcppIncoming =
  new RequestStartTransactionOcppIncoming(
    "RequestStartTransaction",
    RequestStartTransactionReqSchema,
    RequestStartTransactionResSchema,
  );
