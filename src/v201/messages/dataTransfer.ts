import { z } from "zod";
import { logger } from "../../logger";
import {
  type OcppCall,
  type OcppCallResult,
  OcppIncoming,
  OcppOutgoing,
} from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { StatusInfoTypeSchema } from "./_common";

// Renova / Rainbow ("rcd") chargers receive the payment QR as a URL over a
// vendor DataTransfer (messageId "qrcode_req", `data` a JSON string) and render
// the QR on their own screen. This simulator only speaks that protocol when
// configured as an RCD device (CP_VENDOR_NAME=RCD) -- otherwise it responds
// UnknownVendorId like a charger that doesn't understand the vendor.
const RENOVA_VENDOR_ID = "rcd";
const RENOVA_QR_MESSAGE_ID = "qrcode_req";

const RenovaQrDataSchema = z.object({
  url: z.string(),
  price: z.number().nullish(),
  unit: z.string().nullish(),
  connector_id: z.number().nullish(),
  evse_id: z.string().nullish(),
});

function isRenovaCharger(): boolean {
  return (process.env.CP_VENDOR_NAME ?? "").toUpperCase() === "RCD";
}

const DataTransferReqSchema = z.object({
  messageId: z.string().max(50).nullish(),
  data: z.any().nullish(),
  vendorId: z.string().max(255),
});
type DataTransferReqType = typeof DataTransferReqSchema;

const DataTransferResSchema = z.object({
  status: z.enum([
    "Accepted",
    "Rejected",
    "UnknownMessageId",
    "UnknownVendorId",
  ]),
  data: z.any().nullish(),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type DataTransferResType = typeof DataTransferResSchema;

class DataTransferIncomingOcppMessage extends OcppIncoming<
  DataTransferReqType,
  DataTransferResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<DataTransferReqType>>,
  ): Promise<void> => {
    const { vendorId, messageId, data } = call.payload;

    if ((vendorId ?? "").toLowerCase() === RENOVA_VENDOR_ID) {
      if (!isRenovaCharger()) {
        vcp.respond(this.response(call, { status: "UnknownVendorId" }));
        return;
      }
      if (messageId === RENOVA_QR_MESSAGE_ID) {
        try {
          const raw = typeof data === "string" ? JSON.parse(data) : data;
          const qr = RenovaQrDataSchema.parse(raw);
          // An empty url is Renova's "take the QR down"; a real device would
          // clear its screen. Otherwise the device renders the QR from the url --
          // the simulator "displays" it by logging it (vcp.sh option 4 renders a
          // scannable QR from this line).
          if (qr.url) {
            logger.info(
              `Renova QR displayed: ${qr.url}` +
                (qr.price != null ? ` (${qr.price} ${qr.unit ?? ""})` : ""),
            );
          } else {
            logger.info("Renova QR cleared");
          }
          vcp.respond(this.response(call, { status: "Accepted" }));
        } catch (e) {
          logger.warn(
            `Renova qrcode_req had invalid data: ${(e as Error).message}`,
          );
          vcp.respond(this.response(call, { status: "Rejected" }));
        }
        return;
      }
      vcp.respond(this.response(call, { status: "UnknownMessageId" }));
      return;
    }

    vcp.respond(this.response(call, { status: "Accepted" }));
  };
}

class DataTransferOutgoingOcppMessage extends OcppOutgoing<
  DataTransferReqType,
  DataTransferResType
> {
  resHandler = async (
    _vcp: VCP,
    _call: OcppCall<z.infer<DataTransferReqType>>,
    _result: OcppCallResult<z.infer<DataTransferResType>>,
  ): Promise<void> => {
    // NOOP
  };
}

export const dataTransferIncomingOcppMessage =
  new DataTransferIncomingOcppMessage(
    "DataTransfer",
    DataTransferReqSchema,
    DataTransferResSchema,
  );

export const dataTransferOutgoingOcppMessage =
  new DataTransferOutgoingOcppMessage(
    "DataTransfer",
    DataTransferReqSchema,
    DataTransferResSchema,
  );
