import type {
  BulkUpdateTransactionPatch,
  ClearedStatus,
  SubTransaction,
  TransactionFlagColor,
} from "./types.js";

/**
 * Payload for creating or updating a single (non-split, non-transfer) transaction.
 */
export type SingleTransactionSavePayload = {
  mode: "single";
  id?: number;
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  status: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
  transferAccountId?: null;
  incomeMonth?: string | null;
  subTransactions?: undefined;
};

/**
 * Payload for creating or updating a transfer transaction between accounts.
 */
export type TransferTransactionSavePayload = {
  mode: "transfer";
  id?: number;
  accountId: number;
  transferAccountId: number;
  categoryId?: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  status: ClearedStatus;
  transferStatus?: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
  incomeMonth?: string | null;
  subTransactions?: undefined;
};

/**
 * Payload for creating or updating a split transaction with sub-transactions.
 */
export type SplitTransactionSavePayload = {
  mode: "split";
  id?: number;
  accountId: number;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  status: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
  categoryId?: null;
  transferAccountId?: null;
  incomeMonth?: null;
  subTransactions: SubTransaction[];
};

/**
 * Discriminated union for all transaction save/create operations.
 */
export type TransactionSavePayload =
  | SingleTransactionSavePayload
  | TransferTransactionSavePayload
  | SplitTransactionSavePayload;

/**
 * Payload for creating or updating a single scheduled/recurring transaction.
 */
export type SingleRecurringSavePayload = {
  mode: "single";
  id?: number;
  accountId: number;
  categoryId: number | null;
  payee: string;
  memo?: string;
  amount: number;
  frequency: string;
  nextDate: string;
  anchorDay?: number | null;
  active: boolean;
  flagColor?: TransactionFlagColor | null;
  transferAccountId?: null;
  subTransactions?: undefined;
};

/**
 * Payload for creating or updating a recurring transfer transaction.
 */
export type TransferRecurringSavePayload = {
  mode: "transfer";
  id?: number;
  accountId: number;
  transferAccountId: number;
  categoryId?: number | null;
  payee: string;
  memo?: string;
  amount: number;
  frequency: string;
  nextDate: string;
  anchorDay?: number | null;
  active: boolean;
  flagColor?: TransactionFlagColor | null;
  subTransactions?: undefined;
};

/**
 * Payload for creating or updating a recurring split transaction.
 */
export type SplitRecurringSavePayload = {
  mode: "split";
  id?: number;
  accountId: number;
  categoryId?: null;
  transferAccountId?: null;
  payee: string;
  memo?: string;
  amount: number;
  frequency: string;
  nextDate: string;
  anchorDay?: number | null;
  active: boolean;
  flagColor?: TransactionFlagColor | null;
  subTransactions: {
    id?: number;
    categoryId: number | null;
    transferAccountId?: number | null;
    amount: number;
    memo?: string;
  }[];
};

/**
 * Discriminated union for all recurring save/create operations.
 */
export type RecurringSavePayload =
  | SingleRecurringSavePayload
  | TransferRecurringSavePayload
  | SplitRecurringSavePayload;

export type TransactionBulkDeleteActionPayload = {
  action?: "delete";
  ids: number[];
};

export type TransactionBulkUpdateActionPayload = {
  action?: "bulk-update";
  ids: number[];
  patch: BulkUpdateTransactionPatch;
};

export type RecurringBulkUpdateActionPayload = {
  action: "bulk-update";
  ids: number[];
  patch: {
    flagColor?: TransactionFlagColor | null;
    active?: boolean;
    categoryId?: number | null;
    nextDate?: string;
  };
};

export type RecurringBulkDeleteActionPayload = {
  action?: "delete";
  ids: number[];
};

export type RecurringPostActionPayload = {
  action: "post";
  id: number;
  date?: string;
};

export type RecurringBulkPostActionPayload = {
  action: "bulk-post";
  ids: number[];
  date?: string;
};

export type RecurringAutoPostActionPayload = {
  action: "autopost";
  asOfDate?: string;
};

export type AccountSavePayload = {
  name: string;
  kind: "liquid" | "credit" | "offbudget";
  groupLabel: string;
  startingBalance?: number;
};

export type CategorySavePayload = {
  name: string;
  groupId?: number;
  goalTarget: number | null;
  carryover?: number | null;
  overspendCarriesOver?: boolean;
};

export type AssignmentSavePayload = {
  categoryId: number;
  month: string;
  amount: number;
};
