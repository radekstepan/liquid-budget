import type { TransactionSavePayload, RecurringSavePayload, TransactionFlagColor } from "@ynab/logic";
import type { BulkUpdateTransactionPatch, DuplicateAnalysisResult, ImportSummary, MergeOverrides, ReconcileState, RenameSuggestResponse, RenameSuggestStatusResponse, TransactionMergeResponse } from "@ynab/logic";
import type { SnapshotSummary } from "./SnapshotsView.js";

// Canonical wire inputs live in @ynab/logic (action-payloads.ts):
// TransactionSavePayload / RecurringSavePayload. This interface references
// them directly (Partial for PATCH-style updates) so the shapes cannot drift.

export type BudgetAppApi = {
  reload: () => Promise<void>;
  assign: (categoryId: number, amount: number, month: string) => Promise<void>;
  batchAssign?: (assignments: { categoryId: number; amount: number; month: string }[]) => Promise<void>;
  addTransaction: (t: TransactionSavePayload) => Promise<void>;
  updateTransaction: (id: number, t: Partial<TransactionSavePayload>) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  bulkDeleteTransactions?: (ids: number[]) => Promise<void>;
  bulkUpdateTransactions?: (
    ids: number[],
    patch: BulkUpdateTransactionPatch
  ) => Promise<void>;
  mergeTransactions?: (ids: number[], overrides?: MergeOverrides) => Promise<TransactionMergeResponse | void>;
  addRecurring: (v: RecurringSavePayload) => Promise<void>;
  updateRecurring: (id: number, v: Partial<RecurringSavePayload>) => Promise<void>;
  deleteRecurring: (id: number) => Promise<void>;
  postRecurring: (id: number, date?: string) => Promise<void>;
  bulkPostRecurring?: (ids: number[], date?: string) => Promise<void>;
  bulkUpdateRecurring?: (
    ids: number[],
    patch: { flagColor?: TransactionFlagColor | null; active?: boolean }
  ) => Promise<void>;
  bulkDeleteRecurring?: (ids: number[]) => Promise<void>;
  saveCategory: (
    groupId: number | null,
    categoryId: number | null,
    v: {
      name: string;
      groupId?: number;
      goalTarget: number | null;
      carryover?: number | null;
      overspendCarriesOver?: boolean;
    }
  ) => Promise<void>;
  deleteCategory: (
    id: number,
    opts?: { moveToCategoryId?: number | null }
  ) => Promise<void>;
  reorderCategory: (id: number, sort: number) => Promise<void>;
  reorderGroup: (id: number, sort: number) => Promise<void>;
  saveGroup: (groupId: number | null, name: string) => Promise<void>;
  deleteGroup: (id: number) => Promise<void>;
  addAccount: (v: {
    name: string;
    kind: "liquid" | "credit" | "offbudget";
    groupLabel: string;
    startingBalance?: number;
    balance?: number;
    notes?: string;
  }) => Promise<void>;
  deleteAccount: (id: number) => Promise<void>;
  updateAccount: (
    id: number,
    patch: {
      name?: string;
      kind?: "liquid" | "credit" | "offbudget";
      onBudget?: boolean;
      archived?: boolean;
      notes?: string;
    },
    opts?: { undo?: boolean }
  ) => Promise<void>;
  reorderAccount: (id: number, sort: number) => Promise<void>;
  reconcileAccount: (input: {
    accountId: number;
    statementBalance: number;
    statementDate: string;
    adjustmentCategoryId: number | null;
    expectedWorkingBalance?: number | null;
  }) => Promise<void>;
  getReconcileState?: (accountId: number, statementDate?: string) => Promise<ReconcileState>;
  unreconcileAccount: (accountId: number) => Promise<void>;
  importYnab4?: (file: File) => Promise<ImportSummary | void>;
  importCsv?: (input: { accountId: number; swap: boolean; dateFormat?: "auto" | "dmy" | "mdy"; csv: string }) => Promise<number | void>;
  analyzeDuplicates?: () => Promise<DuplicateAnalysisResult | void>;
  dismissDuplicateGroup?: (fingerprint: string) => Promise<void>;
  addRenameRule?: (sourcePattern: string, targetPayee: string) => Promise<void>;
  updateRenameRule?: (id: number, sourcePattern: string, targetPayee: string) => Promise<void>;
  deleteRenameRule?: (id: number) => Promise<void>;
  applyRenameRule?: (id: number) => Promise<{ updated: number; skippedLocked: number }>;
  getRenameSuggestStatus?: () => Promise<RenameSuggestStatusResponse>;
  suggestRenameRules?: (offset: number, limit: number) => Promise<RenameSuggestResponse>;
  acceptRenameSuggestions?: (
    suggestions: { sourcePattern: string; targetPayee: string }[],
    applyToExisting: boolean
  ) => Promise<{ updated: number; skippedLocked: number; generalised: boolean }>;
  ensurePayee?: (name: string) => Promise<number>;
  renamePayee?: (id: number, name: string) => Promise<void>;
  setPayeeDefaultCategory?: (id: number, categoryId: number | null) => Promise<void>;
  mergePayees?: (targetId: number, sourceIds: number[]) => Promise<void>;
  deletePayee?: (id: number) => Promise<void>;
  listSnapshots?: () => Promise<{ snapshots: SnapshotSummary[]; suggestedName: string }>;
  createSnapshot?: (name: string) => Promise<void>;
  restoreSnapshot?: (id: string) => Promise<void>;
  deleteSnapshot?: (id: string) => Promise<void>;
};
