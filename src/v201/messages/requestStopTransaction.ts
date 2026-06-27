import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { endChargingSession } from "../chargingSession";
import { StatusInfoTypeSchema } from "./_common";

const RequestStopTransactionReqSchema = z.object({
  transactionId: z.string(),
});
type RequestStopTransactionReqType = typeof RequestStopTransactionReqSchema;

const RequestStopTransactionResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type RequestStopTransactionResType = typeof RequestStopTransactionResSchema;

class RequestStopTransactionOcppIncoming extends OcppIncoming<
  RequestStopTransactionReqType,
  RequestStopTransactionResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<RequestStopTransactionReqType>>,
  ): Promise<void> => {
    const { transactionId } = call.payload;
    if (!vcp.transactionManager.transactions.get(transactionId)) {
      vcp.respond(this.response(call, { status: "Rejected" }));
      return;
    }
    vcp.respond(this.response(call, { status: "Accepted" }));
    // The cable is logically still in, but the CSMS stopped the session.
    vcp.pluggedIn = false;
    endChargingSession(vcp, transactionId);
  };
}

export const requestStopTransactionOcppIncoming =
  new RequestStopTransactionOcppIncoming(
    "RequestStopTransaction",
    RequestStopTransactionReqSchema,
    RequestStopTransactionResSchema,
  );
