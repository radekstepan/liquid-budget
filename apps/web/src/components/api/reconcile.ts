import type { BudgetAppApi } from "@ynab/ui";
import type { Account, Transaction } from "@ynab/logic";
import { applyAccountDeltas, applyOptimisticReconcileFlips, computeReconcileState, RECONCILE_ADJUSTMENT_MEMO, todayISO, parseReconcileStateResponse } from "@ynab/logic";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createReconcileApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "getReconcileState" | "reconcileAccount" | "unreconcileAccount"> {
  const { dataRef, setData, runMutation, withSync, optimisticMutation } = deps;
  return {
  getReconcileState: async (accountId: number, statementDate?: string) => {
    const qs = new URLSearchParams({ accountId: String(accountId) });
    if (statementDate) qs.set("statementDate", statementDate);
    return parseReconcileStateResponse(
      await jsonReq<unknown>(`/api/reconcile?${qs.toString()}`)
    );
  },
  reconcileAccount: async ({
    accountId,
    statementBalance,
    statementDate,
    adjustmentCategoryId,
    expectedWorkingBalance,
  }) => {
    // Optimistic preview so the register reflects the reconcile the
    // moment the modal closes instead of after the confirming
    // full-budget reload. Mirrors addTransaction's temp-id + rollback
    // conventions: flip in-scope Cleared rows, stage the provisional
    // adjustment row, and stamp the account.
    const prevData = dataRef.current;
    const statementDateEff = statementDate ?? todayISO();
    const today = todayISO();
    let canPreview = false;
    let diff = 0;
    let prevAccount: Account | null = null;
    let prevAffectedTxs: Transaction[] = [];
    if (prevData) {
      const target = prevData.accounts.find((a) => a.id === accountId);
      if (target) {
        const state = computeReconcileState(
          { id: target.id, name: target.name },
          prevData.transactions,
          statementDateEff
        );
        diff = state.workingBalance - statementBalance;
        // The server rejects a non-zero diff without an adjustment
        // category (422) — skip the preview in that case so a doomed
        // POST doesn't flash the register into reconciled state.
        if (diff === 0 || adjustmentCategoryId != null) {
          canPreview = true;
          prevAccount = { ...target };
          const probe = applyOptimisticReconcileFlips(
            prevData.transactions,
            accountId,
            statementDateEff
          );
          const changedIds = new Set<number>();
          for (let i = 0; i < probe.length; i++) {
            if (probe[i] !== prevData.transactions[i]) changedIds.add(probe[i]!.id);
          }
          prevAffectedTxs = prevData.transactions
            .filter((tx) => changedIds.has(tx.id))
            .map((tx) => ({ ...tx }));
        }
      }
    }

    const adjustmentAmount = -diff;
    const tempAdjustmentId = canPreview && diff !== 0 ? -Date.now() : null;
    const provisional: Transaction | null =
      canPreview && tempAdjustmentId != null
        ? {
            id: tempAdjustmentId,
            accountId,
            categoryId: adjustmentCategoryId ?? null,
            date: statementDateEff,
            payee: RECONCILE_ADJUSTMENT_MEMO,
            memo: RECONCILE_ADJUSTMENT_MEMO,
            amount: adjustmentAmount.toFixed(2),
            status: "r",
            flagColor: null,
            transferAccountId: null,
            parentId: null,
            isIncome: false,
            incomeMonth: null,
            reconciledAt: today,
          }
        : null;
    const previewDeltas = new Map<number, number>();
    if (provisional) previewDeltas.set(accountId, adjustmentAmount);

    await optimisticMutation({
      // Resolve as soon as the POST lands so the modal closes onto the
      // already-updated register; the confirming reload below picks up
      // server-assigned ids and round stamps.
      deferredReload: true,
      plan: () => {
        if (!canPreview) return;
        setData((prev) => {
          if (!prev) return prev;
          const flipped = applyOptimisticReconcileFlips(prev.transactions, accountId, statementDateEff);
          const transactions = provisional ? [provisional, ...flipped] : flipped;
          const accounts = applyAccountDeltas(prev.accounts, previewDeltas).map((a) =>
            a.id === accountId
              ? { ...a, lastReconciledAt: today, lastReconciledBalance: statementBalance }
              : a
          );
          return { ...prev, accounts, transactions, budgetIndex: undefined };
        });
      },
      request: async () => {
        return await jsonReq<{ adjustmentTransactionId?: number | null }>("/api/reconcile", {
          method: "POST",
          body: JSON.stringify({
            action: "reconcile",
            accountId,
            statementBalance,
            statementDate,
            adjustmentCategoryId,
            expectedWorkingBalance,
          }),
        });
      },
      mapResult: (result) => {
        const realId = result?.adjustmentTransactionId;
        if (tempAdjustmentId != null && typeof realId === "number") {
          setData((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              transactions: prev.transactions.map((tx) =>
                tx.id === tempAdjustmentId ? { ...tx, id: realId } : tx
              ),
            };
          });
        }
      },
      messages: {
        success: "Account reconciled.",
        failure: "Failed to reconcile account.",
      },
      rollback: canPreview
        ? () => {
            if (!prevAccount) return;
            const restoredAccount = prevAccount;
            const restoredById = new Map(prevAffectedTxs.map((tx) => [tx.id, tx]));
            setData((current) => {
              if (!current) return current;
              const accounts = current.accounts.map((a) =>
                a.id === accountId ? { ...restoredAccount } : a
              );
              const transactions = current.transactions
                .filter((tx) => tx.id !== tempAdjustmentId)
                .map((tx) => restoredById.get(tx.id) ?? tx);
              return { ...current, accounts, transactions, budgetIndex: undefined };
            });
          }
        : undefined,
    });
  },
  unreconcileAccount: async (accountId) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/reconcile", {
            method: "POST",
            body: JSON.stringify({ action: "unreconcile", accountId }),
          });
        },
        { success: "Reconciliation undone.", failure: "Failed to undo reconciliation." }
      )
    );
  },
  };
}
