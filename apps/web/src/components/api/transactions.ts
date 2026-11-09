import type { BudgetAppApi } from "@ynab/ui";
import type { BulkUpdateTransactionPatch, MergeOverrides } from "@ynab/logic";
import { applyOptimisticTransactionDeletion, applyPreparedMerge, collectSplitAffectedIds, isStatusOnlyBulkUpdate, isStatusOrFlagOnlyUpdate, mapOptimisticInsertIds, planOptimisticBulkUpdate, planOptimisticInsert, planOptimisticUpdate, prepareOptimisticMerge, restoreTransactionRows, rollbackOptimisticInsert, snapshotTransactions, transactionUpdateNeedsReload, parseTransactionMutationResult } from "@ynab/logic";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createTransactionsApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "addTransaction" | "updateTransaction" | "deleteTransaction" | "bulkDeleteTransactions" | "bulkUpdateTransactions" | "mergeTransactions"> {
  const { dataRef, setData, reload, runMutation, withSync } = deps;
  return {
  addTransaction: async (t) => {
    const successMsg = "Transaction added.";
    const tempId = -Date.now();
    const childCount = t.subTransactions?.length ?? 0;
    const createdTempIds = new Set<number>([tempId]);
    for (let i = 1; i <= childCount; i++) {
      createdTempIds.add(tempId - i);
    }

    let appliedDeltas = new Map<number, number>();
    setData((prev) => {
      if (!prev) return prev;
      const planned = planOptimisticInsert(prev, t, tempId);
      appliedDeltas = planned.deltas;
      return planned.next;
    });
    return withSync(async () => {
      await runMutation(
        async () => {
          const res = parseTransactionMutationResult(
            await jsonReq<unknown>("/api/transactions", {
              method: "POST",
              body: JSON.stringify(t),
            })
          );
          setData((prev) => {
            if (!prev) return prev;
            return { ...prev, transactions: mapOptimisticInsertIds(prev.transactions, tempId, res) };
          });
          return res;
        },
        { success: successMsg, failure: "Failed to add transaction. Please try again." },
        {
          onRollback: () => {
            setData((current) => {
              if (!current) return current;
              return rollbackOptimisticInsert(current, createdTempIds, tempId, appliedDeltas);
            });
            reload().catch(() => {});
          },
        }
      );
    });
  },
  updateTransaction: async (id, t) => {
    const snapshot = dataRef.current;
    const target = snapshot?.transactions.find((x) => x.id === id);
    const splitParentId =
      target?.parentId ?? (snapshot?.transactions.some((x) => x.parentId === id) ? id : null);

    const affectedTxIds = collectSplitAffectedIds(snapshot?.transactions ?? [], [id]);
    const prevAffectedTxs = snapshotTransactions(snapshot?.transactions ?? [], affectedTxIds);

    const appliedDeltas = new Map<number, number>();

    setData((prev) => {
      if (!prev) return prev;
      const planned = planOptimisticUpdate(prev, id, t, splitParentId);
      for (const [k, v] of planned.deltas.entries()) {
        appliedDeltas.set(k, v);
      }
      return planned.next;
    });
    const statusOrFlagOnly = isStatusOrFlagOnlyUpdate(t);
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/transactions", {
            method: "PATCH",
            body: JSON.stringify({ id, ...t }),
          });
        },
        { success: statusOrFlagOnly ? undefined : "Transaction updated.", failure: "Failed to update transaction." },
        {
          onRollback: () => {
            setData((current) => {
              if (!current) return current;
              return restoreTransactionRows(current, affectedTxIds, prevAffectedTxs, appliedDeltas);
            });
            reload().catch(() => {});
          },
          skipReload: !transactionUpdateNeedsReload(t),
        }
      )
    );
  },
  deleteTransaction: async (id) => {
    const snapshot = dataRef.current;
    const allAffectedIds = collectSplitAffectedIds(snapshot?.transactions ?? [], [id]);
    const prevAffectedTxs = snapshotTransactions(snapshot?.transactions ?? [], allAffectedIds);

    let appliedDeltas = new Map<number, number>();
    setData((prev) => {
      if (!prev) return prev;
      const result = applyOptimisticTransactionDeletion(prev, [id]);
      appliedDeltas = result.deltas;
      return result.nextData;
    });
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq(`/api/transactions?id=${id}`, { method: "DELETE" });
        },
        { success: "Transaction deleted.", failure: "Failed to delete transaction." },
        {
          onRollback: () => {
            setData((current) => {
              if (!current) return current;
              return restoreTransactionRows(current, allAffectedIds, prevAffectedTxs, appliedDeltas);
            });
            reload().catch(() => {});
          },
        }
      )
    );
  },
  bulkDeleteTransactions: async (ids: number[]) => {
    const snapshot = dataRef.current;
    const allAffectedIds = collectSplitAffectedIds(snapshot?.transactions ?? [], ids);
    const prevAffectedTxs = snapshotTransactions(snapshot?.transactions ?? [], allAffectedIds);

    let appliedDeltas = new Map<number, number>();
    setData((prev) => {
      if (!prev) return prev;
      const result = applyOptimisticTransactionDeletion(prev, ids);
      appliedDeltas = result.deltas;
      return result.nextData;
    });
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/transactions?action=bulk-delete", {
            method: "POST",
            body: JSON.stringify({ ids }),
          });
        },
        { success: `Deleted ${ids.length} transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to delete transactions." },
        {
          onRollback: () => {
            setData((current) => {
              if (!current) return current;
              return restoreTransactionRows(current, allAffectedIds, prevAffectedTxs, appliedDeltas);
            });
            reload().catch(() => {});
          },
        }
      )
    );
  },
  bulkUpdateTransactions: async (
    ids: number[],
    patch: BulkUpdateTransactionPatch
  ) => {
    const snapshot = dataRef.current;
    const allAffectedIds = collectSplitAffectedIds(snapshot?.transactions ?? [], ids);
    const prevAffectedTxs = snapshotTransactions(snapshot?.transactions ?? [], allAffectedIds);

    const appliedDeltas = new Map<number, number>();

    setData((prev) => {
      if (!prev) return prev;
      const planned = planOptimisticBulkUpdate(prev, ids, patch);
      for (const [k, v] of planned.deltas.entries()) {
        appliedDeltas.set(k, v);
      }
      return planned.next;
    });
    const statusOnly = isStatusOnlyBulkUpdate(patch);
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/transactions?action=bulk-update", {
            method: "POST",
            body: JSON.stringify({ ids, patch }),
          });
        },
        { success: statusOnly ? undefined : `Updated ${ids.length} transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to update transactions." },
        {
          onRollback: () => {
            setData((current) => {
              if (!current) return current;
              return restoreTransactionRows(current, allAffectedIds, prevAffectedTxs, appliedDeltas);
            });
            reload().catch(() => {});
          },
        }
      )
    );
  },
  mergeTransactions: async (ids: number[], overrides?: MergeOverrides) => {
    const prepared = prepareOptimisticMerge(dataRef.current, ids, overrides);
    const patch = overrides ?? {};
    let appliedDeltas = new Map<number, number>();
    setData((prev) => {
      if (!prev) return prev;
      const applied = applyPreparedMerge(prev, prepared);
      appliedDeltas = applied.deltas;
      return applied.next;
    });
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/transactions?action=merge", {
            method: "POST",
            body: JSON.stringify(
              Object.keys(patch).length > 0 ? { ids, patch } : { ids }
            ),
          });
        },
        { success: "Merged 2 transactions into one.", failure: "Failed to merge transactions." },
        {
          onRollback: () => {
            setData((currentData) => {
              if (!currentData) return currentData;
              return restoreTransactionRows(
                currentData,
                new Set([prepared.primary.id, prepared.secondary.id]),
                prepared.prevRows,
                appliedDeltas,
                { includeChildren: false }
              );
            });
            reload().catch(() => {});
          },
        }
      )
    );
  },
  };
}
