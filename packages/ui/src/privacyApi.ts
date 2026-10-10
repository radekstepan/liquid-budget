import type { BudgetAppApi } from "./BudgetApp.js";
import type { PrivacyMask } from "@ynab/logic";
import {
  maskReconcileState,
  maskRenameSuggestResponse,
  maskRenameSuggestStatus,
} from "@ynab/logic";
import type { SnapshotSummary } from "./SnapshotsView.js";

/**
 * Draw a fresh disguise factor for privacy mode. Wide enough to hide
 * real magnitudes ([0.15, 4.00)), coarse enough (cents) to stay stable
 * once persisted. Lives here — not in `@ynab/logic` — because random
 * generation is impure and logic stays pure.
 */
export function randomPrivacyFactor(): number {
  return Math.round((0.15 + Math.random() * 3.85) * 100) / 100;
}

/**
 * Wrap a BudgetAppApi so privacy mode is display-only:
 * - every mutation resolves `undefined` and reports via `onBlocked`
 *   (all existing call sites already tolerate void/undefined results);
 * - reads pass through, with names/amounts in their results masked.
 *
 * Every BudgetAppApi member must appear below. The PrivacyMode test
 * enumerates a stub api and fails if a member is neither blocked nor
 * an explicitly allowed read, so newly added mutations cannot leak
 * through by default.
 */
export function guardApiForPrivacy(
  api: BudgetAppApi,
  mask: PrivacyMask,
  onBlocked: (method: string) => void
): BudgetAppApi {
  const blocked =
    (method: string) =>
    (..._args: any[]): Promise<never> => {
      onBlocked(method);
      return Promise.resolve(undefined as never);
    };
  const maybeBlocked = <T extends (...args: never[]) => Promise<unknown>>(
    method: string,
    fn: T | undefined
  ): T | undefined =>
    (fn == null ? undefined : (blocked(method) as unknown as T)) as
      | T
      | undefined;

  return {
    // Reads: allowed. listSnapshots/suggest/getReconcileState results
    // carry names and amounts, so they are masked on the way out.
    reload: api.reload,
    getReconcileState: api.getReconcileState
      ? async (accountId: number, statementDate?: string) => {
          const state = await api.getReconcileState!(accountId, statementDate);
          return maskReconcileState(state, mask);
        }
      : undefined,
    listSnapshots: api.listSnapshots
      ? async (): Promise<{
          snapshots: SnapshotSummary[];
          suggestedName: string;
        }> => {
          const res = await api.listSnapshots!();
          return {
            snapshots: res.snapshots.map((s, i) => ({
              ...s,
              name: `Snapshot ${i + 1}`,
            })),
            suggestedName: "Snapshot",
          };
        }
      : undefined,
    getRenameSuggestStatus: api.getRenameSuggestStatus
      ? async () => maskRenameSuggestStatus(await api.getRenameSuggestStatus!(), mask)
      : undefined,
    suggestRenameRules: api.suggestRenameRules
      ? async (offset: number, limit: number) =>
          maskRenameSuggestResponse(
            await api.suggestRenameRules!(offset, limit),
            mask
          )
      : undefined,
    // Writes: blocked.
    assign: blocked("assign"),
    batchAssign: maybeBlocked("batchAssign", api.batchAssign),
    addTransaction: blocked("addTransaction"),
    updateTransaction: blocked("updateTransaction"),
    deleteTransaction: blocked("deleteTransaction"),
    bulkDeleteTransactions: maybeBlocked(
      "bulkDeleteTransactions",
      api.bulkDeleteTransactions
    ),
    bulkUpdateTransactions: maybeBlocked(
      "bulkUpdateTransactions",
      api.bulkUpdateTransactions
    ),
    mergeTransactions: maybeBlocked("mergeTransactions", api.mergeTransactions),
    addRecurring: blocked("addRecurring"),
    updateRecurring: blocked("updateRecurring"),
    deleteRecurring: blocked("deleteRecurring"),
    postRecurring: blocked("postRecurring"),
    bulkPostRecurring: maybeBlocked("bulkPostRecurring", api.bulkPostRecurring),
    bulkUpdateRecurring: maybeBlocked(
      "bulkUpdateRecurring",
      api.bulkUpdateRecurring
    ),
    bulkDeleteRecurring: maybeBlocked(
      "bulkDeleteRecurring",
      api.bulkDeleteRecurring
    ),
    saveCategory: blocked("saveCategory"),
    deleteCategory: blocked("deleteCategory"),
    reorderCategory: blocked("reorderCategory"),
    reorderGroup: blocked("reorderGroup"),
    saveGroup: blocked("saveGroup"),
    deleteGroup: blocked("deleteGroup"),
    addAccount: blocked("addAccount"),
    deleteAccount: blocked("deleteAccount"),
    updateAccount: blocked("updateAccount"),
    reorderAccount: blocked("reorderAccount"),
    reconcileAccount: blocked("reconcileAccount"),
    unreconcileAccount: blocked("unreconcileAccount"),
    importYnab4: maybeBlocked("importYnab4", api.importYnab4),
    importCsv: maybeBlocked("importCsv", api.importCsv),
    analyzeDuplicates: maybeBlocked("analyzeDuplicates", api.analyzeDuplicates),
    dismissDuplicateGroup: maybeBlocked(
      "dismissDuplicateGroup",
      api.dismissDuplicateGroup
    ),
    addRenameRule: maybeBlocked("addRenameRule", api.addRenameRule),
    updateRenameRule: maybeBlocked("updateRenameRule", api.updateRenameRule),
    deleteRenameRule: maybeBlocked("deleteRenameRule", api.deleteRenameRule),
    applyRenameRule: maybeBlocked("applyRenameRule", api.applyRenameRule),
    acceptRenameSuggestions: maybeBlocked(
      "acceptRenameSuggestions",
      api.acceptRenameSuggestions
    ),
    ensurePayee: maybeBlocked("ensurePayee", api.ensurePayee),
    renamePayee: maybeBlocked("renamePayee", api.renamePayee),
    setPayeeDefaultCategory: maybeBlocked(
      "setPayeeDefaultCategory",
      api.setPayeeDefaultCategory
    ),
    mergePayees: maybeBlocked("mergePayees", api.mergePayees),
    deletePayee: maybeBlocked("deletePayee", api.deletePayee),
    createSnapshot: maybeBlocked("createSnapshot", api.createSnapshot),
    restoreSnapshot: maybeBlocked("restoreSnapshot", api.restoreSnapshot),
    deleteSnapshot: maybeBlocked("deleteSnapshot", api.deleteSnapshot),
  };
}
