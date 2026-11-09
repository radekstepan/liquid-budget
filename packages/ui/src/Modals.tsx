"use client";

// Barrel: the modal components live in ./modals/*. Every consumer
// (BudgetApp, index.ts, tests) keeps importing from this path.
export { BulkEditTransactionsModal } from "./BulkEditModal.js";
export type {
  SingleTransactionSavePayload,
  TransferTransactionSavePayload,
  SplitTransactionSavePayload,
  TransactionSavePayload,
  SingleRecurringSavePayload,
  TransferRecurringSavePayload,
  SplitRecurringSavePayload,
  RecurringSavePayload,
} from "@ynab/logic";
export type { DraftSubRow } from "./modals/shared.js";
export { TransactionModal } from "./modals/TransactionModal.js";
export { CategoryModal } from "./modals/CategoryModal.js";
export { GroupModal } from "./modals/GroupModal.js";
export { RecurringModal } from "./modals/RecurringModal.js";
export { AccountModal } from "./modals/AccountModal.js";
