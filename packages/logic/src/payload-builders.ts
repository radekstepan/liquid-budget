import type {
  ClearedStatus,
  SubTransaction,
  TransactionDuplicateFlag,
  TransactionFlagColor,
  TransactionFlagState,
} from "./types.js";
import type {
  RecurringSavePayload,
  SingleRecurringSavePayload,
  SingleTransactionSavePayload,
  SplitRecurringSavePayload,
  SplitTransactionSavePayload,
  TransactionSavePayload,
  TransferRecurringSavePayload,
  TransferTransactionSavePayload,
} from "./action-payloads.js";
import { evalAmount, dollarsToCents, nextMonthKey } from "./format.js";
import { assertSplitsBalanced } from "./split.js";

export type PayloadAccountContext = {
  id: number;
  name?: string;
  onBudget?: boolean;
  kind?: "liquid" | "credit" | "offbudget" | string;
};

export type DraftSubRowInput = {
  id?: number;
  payee?: string;
  categoryId?: number | "" | null;
  transferAccountId?: number | "" | null;
  amount: number | string;
  memo?: string;
};

export type TransactionFormData = {
  mode: "single" | "transfer" | "split";
  id?: number;
  accountId: number;
  categoryId?: number | "" | "__deferred__" | null;
  date: string;
  payee?: string;
  memo?: string;
  amount: number | string;
  status?: ClearedStatus;
  cleared?: boolean;
  flagColor?: TransactionFlagState;
  transferAccountId?: number | "" | null;
  incomeMonth?: string | null;
  subRows?: DraftSubRowInput[];
};

export type TransactionBuilderOptions = {
  accounts?: PayloadAccountContext[];
  initial?: {
    id?: number;
    status?: ClearedStatus;
    transferAccountId?: number | null;
    payee?: string;
  };
};

export type RecurringFormData = {
  mode: "single" | "transfer" | "split";
  id?: number;
  accountId: number;
  categoryId?: number | "" | null;
  payee?: string;
  memo?: string;
  amount: number | string;
  frequency: string;
  nextDate: string;
  anchorDay?: number | null;
  active?: boolean;
  flagColor?: TransactionFlagColor | null;
  transferAccountId?: number | "" | null;
  subRows?: DraftSubRowInput[];
};

export type RecurringBuilderOptions = {
  accounts?: PayloadAccountContext[];
  initial?: {
    id?: number;
    anchorDay?: number | null;
    transferAccountId?: number | null;
    payee?: string;
  };
};

/**
 * Builds a type-safe TransactionSavePayload from form data, ensuring exact discriminated
 * union shape and preventing invalid payloads or dropped nullable keys when switching modes.
 * Returns null if the form data is invalid or incomplete.
 */
export function toTransactionPayload(
  formData: TransactionFormData,
  options?: TransactionBuilderOptions
): TransactionSavePayload | null {
  const { mode, accountId, date } = formData;
  if (!accountId || !date) return null;

  const accounts = options?.accounts ?? [];
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const isOffBudget = selectedAccount ? !selectedAccount.onBudget : false;
  const otherAccounts = accounts.filter((a) => a.id !== accountId);

  const evaled = typeof formData.amount === "number" ? formData.amount : evalAmount(formData.amount);
  if (evaled == null || Number.isNaN(evaled)) return null;
  const amountCents = typeof formData.amount === "number" && Number.isInteger(formData.amount) && Math.abs(formData.amount) >= 1 && typeof formData.amount !== "string"
    ? formData.amount
    : dollarsToCents(evaled);
  if (amountCents === 0) return null;

  const initial = options?.initial;
  const finalStatus: ClearedStatus =
    formData.status !== undefined
      ? formData.status
      : formData.cleared !== undefined
      ? formData.cleared
        ? initial?.status === "r"
          ? "r"
          : "c"
        : "u"
      : "c";

  const isDuplicateFlag = formData.flagColor === "duplicate";
  const savedFlagColor: TransactionFlagColor | null | undefined = isDuplicateFlag
    ? undefined
    : (formData.flagColor as TransactionFlagColor | null | undefined);

  if (mode === "transfer") {
    const transferAccId = formData.transferAccountId ? Number(formData.transferAccountId) : null;
    if (!transferAccId || Number.isNaN(transferAccId) || transferAccId === accountId) {
      return null;
    }

    const transferDestAccount = otherAccounts.find((a) => a.id === transferAccId);
    const isTransferBoundary =
      transferDestAccount != null &&
      Boolean(selectedAccount?.onBudget) !== Boolean(transferDestAccount.onBudget);

    const srcOnBudget = Boolean(selectedAccount?.onBudget);
    const destOnBudget = Boolean(transferDestAccount?.onBudget);
    const transferNetOnBudgetDelta = isTransferBoundary
      ? (srcOnBudget ? amountCents : 0) + (destOnBudget ? -amountCents : 0)
      : 0;
    const isBoundaryOutflow = isTransferBoundary && transferNetOnBudgetDelta <= 0;

    if (
      isBoundaryOutflow &&
      (formData.categoryId === "" ||
        formData.categoryId === "__deferred__" ||
        formData.categoryId == null)
    ) {
      return null;
    }

    const destName = transferDestAccount?.name ?? "";
    const isInitialTransfer = Boolean(initial?.transferAccountId);
    const oldDestName = isInitialTransfer
      ? otherAccounts.find((a) => a.id === Number(initial?.transferAccountId))?.name
      : "";
    const rawPayee = (formData.payee ?? "").trim();

    let finalPayee: string;
    if (!initial) {
      finalPayee = rawPayee || `Transfer : ${destName || "Unknown"}`;
    } else if (!isInitialTransfer) {
      finalPayee = `Transfer : ${destName || "Unknown"}`;
    } else {
      const hadStandardPayee =
        !rawPayee || (oldDestName && rawPayee === `Transfer : ${oldDestName}`);
      finalPayee = hadStandardPayee ? `Transfer : ${destName || "Unknown"}` : rawPayee;
    }

    let finalCatId: number | null = null;
    let incMonth: string | null = null;
    if (isTransferBoundary) {
      if (isBoundaryOutflow) {
        finalCatId = Number(formData.categoryId);
      } else {
        const isDeferred = formData.categoryId === "__deferred__";
        finalCatId =
          formData.categoryId === "" || isDeferred ? null : Number(formData.categoryId);
        incMonth = isDeferred
          ? formData.incomeMonth || nextMonthKey(date.slice(0, 7))
          : null;
      }
    }

    const payload: TransferTransactionSavePayload = {
      mode: "transfer",
      id: formData.id ?? initial?.id,
      accountId,
      transferAccountId: transferAccId,
      categoryId: finalCatId,
      date,
      payee: finalPayee,
      memo: (formData.memo ?? "").trim(),
      amount: amountCents,
      status: finalStatus,
      flagColor: savedFlagColor,
      incomeMonth: incMonth,
      subTransactions: undefined,
    };
    return payload;
  }

  if (mode === "split") {
    const rawPayee = (formData.payee ?? "").trim();
    if (!rawPayee) return null;

    const subRows = formData.subRows ?? [];
    if (subRows.length < 2) return null;

    // Validate split amounts
    const mappedSubTransactions: SubTransaction[] = [];
    let subSum = 0;

    for (const r of subRows) {
      const rEvaled = typeof r.amount === "number" ? r.amount : evalAmount(r.amount);
      if (rEvaled == null || Number.isNaN(rEvaled)) return null;
      const rAmountCents = typeof r.amount === "number" && Number.isInteger(r.amount) && Math.abs(r.amount) >= 1 && typeof r.amount !== "string"
        ? r.amount
        : dollarsToCents(rEvaled);
      subSum += rAmountCents;

      const subTransferId = r.transferAccountId ? Number(r.transferAccountId) : null;
      const dest = subTransferId ? otherAccounts.find((a) => a.id === subTransferId) : null;
      const isBoundary = dest != null && Boolean(selectedAccount?.onBudget) !== Boolean(dest.onBudget);

      let finalCatId: number | null = null;
      if (subTransferId) {
        if (isBoundary) {
          const netDelta = (selectedAccount?.onBudget ? rAmountCents : 0) + (dest.onBudget ? -rAmountCents : 0);
          if (netDelta <= 0 && !r.categoryId) {
            return null;
          }
          finalCatId = r.categoryId ? Number(r.categoryId) : null;
        } else {
          finalCatId = null;
        }
      } else if (isOffBudget) {
        finalCatId = null;
      } else {
        finalCatId = r.categoryId ? Number(r.categoryId) : null;
      }

      mappedSubTransactions.push({
        id: r.id,
        payee: r.payee,
        categoryId: finalCatId,
        transferAccountId: subTransferId,
        amount: rAmountCents,
        memo: r.memo ?? "",
      });
    }

    if (subSum !== amountCents) {
      return null;
    }

    const payload: SplitTransactionSavePayload = {
      mode: "split",
      id: formData.id ?? initial?.id,
      accountId,
      date,
      payee: rawPayee,
      memo: (formData.memo ?? "").trim(),
      amount: amountCents,
      status: finalStatus,
      flagColor: savedFlagColor,
      categoryId: null,
      transferAccountId: null,
      incomeMonth: null,
      subTransactions: mappedSubTransactions,
    };
    return payload;
  }

  // Single mode
  const rawPayee = (formData.payee ?? "").trim();
  if (!rawPayee) return null;

  const isDeferred = !isOffBudget && formData.categoryId === "__deferred__";
  const finalCatId =
    isOffBudget || formData.categoryId === "" || isDeferred || formData.categoryId == null
      ? null
      : Number(formData.categoryId);
  const incMonth = isDeferred
    ? formData.incomeMonth || nextMonthKey(date.slice(0, 7))
    : null;

  const payload: SingleTransactionSavePayload = {
    mode: "single",
    id: formData.id ?? initial?.id,
    accountId,
    categoryId: finalCatId,
    date,
    payee: rawPayee,
    memo: (formData.memo ?? "").trim(),
    amount: amountCents,
    status: finalStatus,
    flagColor: savedFlagColor,
    incomeMonth: incMonth,
    transferAccountId: null,
    subTransactions: undefined,
  };
  return payload;
}

/**
 * Returns true if the transaction form data can build a valid save payload.
 */
export function canBuildTransactionPayload(
  formData: TransactionFormData,
  options?: TransactionBuilderOptions
): boolean {
  return toTransactionPayload(formData, options) !== null;
}

/**
 * Builds a type-safe RecurringSavePayload from form data, ensuring exact discriminated
 * union shape and preventing invalid payloads or dropped nullable keys when switching modes.
 * Returns null if the form data is invalid or incomplete.
 */
export function toRecurringPayload(
  formData: RecurringFormData,
  options?: RecurringBuilderOptions
): RecurringSavePayload | null {
  const { mode, accountId, frequency, nextDate } = formData;
  if (!accountId || !frequency || !nextDate) return null;

  const accounts = options?.accounts ?? [];
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const isOffBudget = selectedAccount ? !selectedAccount.onBudget : false;
  const otherAccounts = accounts.filter((a) => a.id !== accountId);

  const evaled = typeof formData.amount === "number" ? formData.amount : evalAmount(formData.amount);
  if (evaled == null || Number.isNaN(evaled)) return null;
  const amountCents = typeof formData.amount === "number" && Number.isInteger(formData.amount) && Math.abs(formData.amount) >= 1 && typeof formData.amount !== "string"
    ? formData.amount
    : dollarsToCents(evaled);
  if (amountCents === 0) return null;

  const initial = options?.initial;
  const active = formData.active ?? true;
  const flagColor = formData.flagColor ?? null;
  const anchorDay = formData.anchorDay ?? initial?.anchorDay ?? null;

  if (mode === "transfer") {
    const transferAccId = formData.transferAccountId ? Number(formData.transferAccountId) : null;
    if (!transferAccId || Number.isNaN(transferAccId) || transferAccId === accountId) {
      return null;
    }

    const transferDestAccount = otherAccounts.find((a) => a.id === transferAccId);
    const isTransferBoundary =
      transferDestAccount != null &&
      Boolean(selectedAccount?.onBudget) !== Boolean(transferDestAccount.onBudget);

    const srcOnBudget = Boolean(selectedAccount?.onBudget);
    const destOnBudget = Boolean(transferDestAccount?.onBudget);
    const transferNetOnBudgetDelta = isTransferBoundary
      ? (srcOnBudget ? amountCents : 0) + (destOnBudget ? -amountCents : 0)
      : 0;
    const isBoundaryOutflow = isTransferBoundary && transferNetOnBudgetDelta <= 0;

    if (isBoundaryOutflow && (formData.categoryId === "" || formData.categoryId == null)) {
      return null;
    }

    const destName = transferDestAccount?.name ?? "";
    const rawPayee = (formData.payee ?? "").trim();
    const finalPayee = rawPayee || `Transfer : ${destName || "Unknown"}`;

    let finalCatId: number | null = null;
    if (isTransferBoundary) {
      if (isBoundaryOutflow) {
        finalCatId = Number(formData.categoryId);
      } else {
        finalCatId = formData.categoryId === "" || formData.categoryId == null ? null : Number(formData.categoryId);
      }
    }

    const payload: TransferRecurringSavePayload = {
      mode: "transfer",
      id: formData.id ?? initial?.id,
      accountId,
      transferAccountId: transferAccId,
      categoryId: finalCatId,
      payee: finalPayee,
      memo: (formData.memo ?? "").trim(),
      amount: amountCents,
      frequency,
      nextDate,
      anchorDay,
      active,
      flagColor,
      subTransactions: undefined,
    };
    return payload;
  }

  if (mode === "split") {
    const rawPayee = (formData.payee ?? "").trim();
    if (!rawPayee) return null;

    const subRows = formData.subRows ?? [];
    if (subRows.length < 2) return null;

    const mappedSubTransactions: {
      id?: number;
      categoryId: number | null;
      transferAccountId?: number | null;
      amount: number;
      memo?: string;
    }[] = [];
    let subSum = 0;

    for (const r of subRows) {
      const rEvaled = typeof r.amount === "number" ? r.amount : evalAmount(r.amount);
      if (rEvaled == null || Number.isNaN(rEvaled)) return null;
      const rAmountCents = typeof r.amount === "number" && Number.isInteger(r.amount) && Math.abs(r.amount) >= 1 && typeof r.amount !== "string"
        ? r.amount
        : dollarsToCents(rEvaled);
      subSum += rAmountCents;

      const subTransferId = r.transferAccountId ? Number(r.transferAccountId) : null;
      const dest = subTransferId ? otherAccounts.find((a) => a.id === subTransferId) : null;
      const isBoundary = dest != null && Boolean(selectedAccount?.onBudget) !== Boolean(dest.onBudget);

      let finalCatId: number | null = null;
      if (subTransferId) {
        if (isBoundary) {
          const netDelta = (selectedAccount?.onBudget ? rAmountCents : 0) + (dest.onBudget ? -rAmountCents : 0);
          if (netDelta <= 0 && !r.categoryId) {
            return null;
          }
          finalCatId = r.categoryId ? Number(r.categoryId) : null;
        } else {
          finalCatId = null;
        }
      } else if (isOffBudget) {
        finalCatId = null;
      } else {
        finalCatId = r.categoryId ? Number(r.categoryId) : null;
      }

      mappedSubTransactions.push({
        id: r.id,
        categoryId: finalCatId,
        transferAccountId: subTransferId,
        amount: rAmountCents,
        memo: r.memo ?? "",
      });
    }

    if (subSum !== amountCents) {
      return null;
    }

    const payload: SplitRecurringSavePayload = {
      mode: "split",
      id: formData.id ?? initial?.id,
      accountId,
      categoryId: null,
      transferAccountId: null,
      payee: rawPayee,
      memo: (formData.memo ?? "").trim(),
      amount: amountCents,
      frequency,
      nextDate,
      anchorDay,
      active,
      flagColor,
      subTransactions: mappedSubTransactions,
    };
    return payload;
  }

  // Single mode
  const rawPayee = (formData.payee ?? "").trim();
  if (!rawPayee) return null;

  const finalCatId =
    isOffBudget || formData.categoryId === "" || formData.categoryId == null
      ? null
      : Number(formData.categoryId);

  const payload: SingleRecurringSavePayload = {
    mode: "single",
    id: formData.id ?? initial?.id,
    accountId,
    categoryId: finalCatId,
    payee: rawPayee,
    memo: (formData.memo ?? "").trim(),
    amount: amountCents,
    frequency,
    nextDate,
    anchorDay,
    active,
    flagColor,
    transferAccountId: null,
    subTransactions: undefined,
  };
  return payload;
}

/**
 * Returns true if the recurring form data can build a valid save payload.
 */
export function canBuildRecurringPayload(
  formData: RecurringFormData,
  options?: RecurringBuilderOptions
): boolean {
  return toRecurringPayload(formData, options) !== null;
}
