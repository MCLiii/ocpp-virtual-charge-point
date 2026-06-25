import type { VCP } from "./vcp";

const METER_VALUES_INTERVAL_SEC = 15;

// Simulated charging power (kW) used to derive a realistic
// Energy.Active.Import.Register (kWh) from elapsed time, instead of the previous
// fake counter (elapsedMs/100). Kept high enough that a short test session
// accrues enough energy to clear payment-gateway minimums at typical tariffs;
// override with SIMULATED_CHARGE_POWER_KW.
const SIMULATED_CHARGE_POWER_KW =
  Number(process.env.SIMULATED_CHARGE_POWER_KW) || 60;

type TransactionId = string | number;

interface TransactionState {
  startedAt: Date;
  idTag: string;
  transactionId: TransactionId;
  meterValue: number;
  evseId?: number;
  connectorId: number;
}

interface StartTransactionProps {
  transactionId: TransactionId;
  idTag: string;
  evseId?: number;
  connectorId: number;
  meterValuesCallback: (transactionState: TransactionState) => Promise<void>;
}

export class TransactionManager {
  transactions: Map<
    TransactionId,
    TransactionState & { meterValuesTimer: ReturnType<typeof setInterval> }
  > = new Map();

  canStartNewTransaction(connectorId: number) {
    return !Array.from(this.transactions.values()).some(
      (transaction) => transaction.connectorId === connectorId,
    );
  }

  startTransaction(vcp: VCP, startTransactionProps: StartTransactionProps) {
    const meterValuesTimer = setInterval(() => {
      // biome-ignore lint/style/noNonNullAssertion: transaction must exist
      const currentTransactionState = this.transactions.get(
        startTransactionProps.transactionId,
      )!;
      const { meterValuesTimer, ...currentTransaction } =
        currentTransactionState;
      startTransactionProps.meterValuesCallback({
        ...currentTransaction,
        meterValue: this.getMeterValue(startTransactionProps.transactionId),
      });
    }, METER_VALUES_INTERVAL_SEC * 1000);
    this.transactions.set(startTransactionProps.transactionId, {
      transactionId: startTransactionProps.transactionId,
      idTag: startTransactionProps.idTag,
      meterValue: 0,
      startedAt: new Date(),
      evseId: startTransactionProps.evseId,
      connectorId: startTransactionProps.connectorId,
      meterValuesTimer: meterValuesTimer,
    });
  }

  stopTransaction(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);
    if (transaction?.meterValuesTimer) {
      clearInterval(transaction.meterValuesTimer);
    }
    this.transactions.delete(transactionId);
  }

  // Cumulative energy register in kWh: power(kW) * elapsed time(h). Consumers
  // that need Wh should multiply by 1000.
  getMeterValue(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return 0;
    }
    const elapsedHours =
      (new Date().getTime() - transaction.startedAt.getTime()) / 3_600_000;
    return elapsedHours * SIMULATED_CHARGE_POWER_KW;
  }
}
