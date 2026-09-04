"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BudgetApp, ErrorBoundary, type BudgetAppApi } from "@ynab/ui";
import { Notice, Toast, type ToastItem, createToast } from "@ynab/theme";
import type { Account, Assignment, BudgetData, BulkUpdateTransactionPatch, DuplicateAnalysisResult, ImportSkippedEntry, ImportSummary, ReconcileState, Transaction } from "@ynab/logic";
import { invalidateBudgetIndex, num, classifyBoundaryTransfer, parseAssignmentResponse, parseBudgetDataResponse, parseDuplicateAnalysisResponse, parseReconcileStateResponse, parseRecurringAutoPostResponse, parseTransactionMutationResult } from "@ynab/logic";

function applyAccountDeltas(
  accounts: Account[],
  deltas: Map<number, number>
): Account[] {
  if (deltas.size === 0) return accounts;
  return accounts.map((acc) => {
    const delta = deltas.get(acc.id);
    if (!delta) return acc;
    const current = num(acc.balance);
    return { ...acc, balance: String(current + Math.round(delta)) };
  });
}

function applyOptimisticTransactionDeletion(
  prev: BudgetData,
  ids: number[]
): { nextData: BudgetData; deltas: Map<number, number> } {
  const idSet = new Set(ids);
  const deltas = new Map<number, number>();
  const removedIds = new Set(ids);
  const parentNewTotals = new Map<number, number>();
  const deletedParentIds = new Set<number>();
  const flattenedChildren = new Map<number, { payee?: string; flagColor?: any }>();

  for (const tx of prev.transactions) {
    if (idSet.has(tx.id) && tx.parentId == null) {
      const children = prev.transactions.filter((x) => x.parentId === tx.id);
      if (children.length > 0) {
        deletedParentIds.add(tx.id);
        for (const c of children) {
          deltas.set(c.accountId, (deltas.get(c.accountId) ?? 0) - num(c.amount));
          if (c.transferAccountId != null) {
            deltas.set(c.transferAccountId, (deltas.get(c.transferAccountId) ?? 0) + num(c.amount));
          }
          removedIds.add(c.id);
        }
      } else {
        deltas.set(tx.accountId, (deltas.get(tx.accountId) ?? 0) - num(tx.amount));
        if (tx.transferAccountId != null) {
          deltas.set(tx.transferAccountId, (deltas.get(tx.transferAccountId) ?? 0) + num(tx.amount));
        }
      }
    }
  }

  const childrenByParent = new Map<number, typeof prev.transactions>();
  for (const tx of prev.transactions) {
    if (tx.parentId != null) {
      let list = childrenByParent.get(tx.parentId);
      if (!list) {
        list = [];
        childrenByParent.set(tx.parentId, list);
      }
      list.push(tx);
    }
  }

  for (const [parentId, allChildren] of childrenByParent.entries()) {
    if (deletedParentIds.has(parentId)) continue;
    const childrenToDelete = allChildren.filter((c) => idSet.has(c.id));
    if (childrenToDelete.length === 0) continue;

    for (const c of childrenToDelete) {
      deltas.set(c.accountId, (deltas.get(c.accountId) ?? 0) - num(c.amount));
      if (c.transferAccountId != null) {
        deltas.set(c.transferAccountId, (deltas.get(c.transferAccountId) ?? 0) + num(c.amount));
      }
      removedIds.add(c.id);
    }

    const remainingChildren = allChildren.filter((c) => !idSet.has(c.id));
    if (remainingChildren.length === 1) {
      const lastChild = remainingChildren[0]!;
      const parentTx = prev.transactions.find((t) => t.id === parentId);
      const childPayee =
        lastChild.payee && lastChild.payee.trim() !== ""
          ? lastChild.payee
          : (parentTx?.payee ?? "");
      const childFlagColor = lastChild.flagColor ?? (parentTx?.flagColor ?? null);
      flattenedChildren.set(lastChild.id, {
        payee: childPayee,
        flagColor: childFlagColor,
      });
      removedIds.add(parentId);
      parentNewTotals.delete(parentId);
    } else if (remainingChildren.length === 0) {
      removedIds.add(parentId);
      parentNewTotals.delete(parentId);
    } else {
      const newTotal = remainingChildren.reduce((sum, c) => sum + num(c.amount), 0);
      parentNewTotals.set(parentId, newTotal);
    }
  }

  const accounts = applyAccountDeltas(prev.accounts, deltas);
  let transactions = prev.transactions
    .filter(
      (x) =>
        !removedIds.has(x.id) &&
        (x.parentId == null || flattenedChildren.has(x.id) || !removedIds.has(x.parentId))
    )
    .map((x) => {
      const flat = flattenedChildren.get(x.id);
      if (flat) {
        return {
          ...x,
          parentId: null,
          payee: flat.payee || x.payee,
          flagColor: flat.flagColor !== undefined ? flat.flagColor : x.flagColor,
        };
      }
      return x;
    });
  if (parentNewTotals.size > 0) {
    transactions = transactions.map((x) => {
      const updatedTotal = parentNewTotals.get(x.id);
      return updatedTotal !== undefined ? { ...x, amount: updatedTotal.toFixed(2) } : x;
    });
  }
  return { nextData: { ...prev, accounts, transactions, budgetIndex: undefined }, deltas };
}

async function jsonReq<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      const text = await res.text().catch(() => "");
      body = { error: text };
    }
    const err = new Error(body?.error || `Request failed (${res.status})`);
    (err as any).status = res.status;
    if (body?.state) {
      (err as any).state = body.state;
    }
    throw err;
  }
  return res.json() as Promise<T>;
}

type MutationMessages<T> = {
  success?: string;
  failure: string;
  notifyFailure?: boolean;
  onSuccess?: (result: T) => void;
};

export function BudgetAppShell({
  initialView = "budget",
  initialMonth,
  initialAccount,
}: {
  initialView?: string;
  initialMonth?: string;
  initialAccount?: number;
}) {
  const [data, _setData] = useState<BudgetData | null>(null);
  const dataRef = useRef<BudgetData | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const setData = useCallback((value: React.SetStateAction<BudgetData | null>) => {
    _setData((prev) => {
      if (prev) {
        invalidateBudgetIndex(prev);
      }
      const next = typeof value === "function" ? (value as (p: BudgetData | null) => BudgetData | null)(prev) : value;
      dataRef.current = next;
      return next;
    });
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [syncingCount, setSyncingCount] = useState(0);
  const toastTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const reloadSeqRef = useRef(0);
  const latestCompletedReloadSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);

  const addToast = useCallback((message: string, tone: ToastItem["tone"] = "info") => {
    const t = createToast(message, tone);
    setToasts((prev) => [...prev, t]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== t.id));
      toastTimers.current.delete(t.id);
    }, 4000);
    toastTimers.current.set(t.id, timer);
    return t;
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    const currentMutationSeq = mutationSeqRef.current;
    const budgetRaw: unknown = await jsonReq<unknown>("/api/budget");
    // Fail fast if the server response drifts from the BudgetData contract
    // instead of flowing bad shapes silently into budget calculations.
    const budget = parseBudgetDataResponse(budgetRaw);

    // Drop stale responses if a newer reload has completed or if a newer mutation started
    if (seq <= latestCompletedReloadSeqRef.current || currentMutationSeq < mutationSeqRef.current) {
      return;
    }
    latestCompletedReloadSeqRef.current = seq;

    setData(budget);
  }, []);

  const runMutation = useCallback(
    async <T,>(
      action: () => Promise<T>,
      messages: MutationMessages<T>,
      options?: {
        onRollback?: () => void;
        skipReload?: boolean;
      }
    ): Promise<T> => {
      mutationSeqRef.current++;
      let result: T;
      try {
        result = await action();
      } catch (e) {
        options?.onRollback?.();
        if (messages.notifyFailure !== false) addToast(messages.failure, "danger");
        throw e;
      }

      if (messages.success) addToast(messages.success, "ok");
      messages.onSuccess?.(result);

      if (!options?.skipReload) {
        try {
          await reload();
        } catch (refreshErr) {
          console.error("Budget reload failed after successful mutation:", refreshErr);
          addToast("Saved changes, but failed to refresh latest budget data.", "warn");
        }
      }

      return result;
    },
    [addToast, reload]
  );

  const withSync = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setSyncingCount((c) => c + 1);
    try {
      return await fn();
    } finally {
      setSyncingCount((c) => Math.max(0, c - 1));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // Auto-post due scheduled transactions on mount (keeping GET /api/budget pure, BUG-20)
        try {
          const autoPostRes = parseRecurringAutoPostResponse(
            await jsonReq<unknown>("/api/recurring?action=autopost", { method: "POST" })
          );
          if (mounted && autoPostRes) {
            const count = autoPostRes.postedCount ?? 0;
            if (count > 0) {
              addToast(
                `Automatically entered ${count} scheduled transaction${
                  count === 1 ? "" : "s"
                }.`,
                "ok"
              );
            }
            if (autoPostRes.capped && autoPostRes.capped.length > 0) {
              const names = autoPostRes.capped
                .map((c) => c.payee || "Scheduled transaction")
                .join(", ");
              addToast(
                `Catch-up limit reached for ${names}. Additional overdue occurrences remain.`,
                "warn"
              );
            }
            if (autoPostRes.failures && autoPostRes.failures.length > 0) {
              const names = autoPostRes.failures
                .map((f) => (f.payee ? `${f.payee}: ${f.error}` : f.error))
                .join("; ");
              addToast(
                `Failed to auto-post scheduled transaction: ${names}`,
                "danger"
              );
            }
          }
        } catch (autoErr) {
          console.error("Auto-post on mount failed:", autoErr);
        }
        await reload();
      } catch (e: unknown) {
        if (mounted) setError(String(e));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [reload, addToast]);

  const api: BudgetAppApi = {
    reload,
    assign: async (categoryId, amount, month) => {
      const prevAssignment = dataRef.current?.assignments.find(
        (a) => a.categoryId === categoryId && a.month === month
      );
      const prevAssignmentSnapshot = prevAssignment ? { ...prevAssignment } : null;
      const tempId = -Date.now();
      setData((prev) => {
        if (!prev) return prev;
        const existing = prev.assignments.find(
          (a) => a.categoryId === categoryId && a.month === month
        );
        const assignments = existing
          ? prev.assignments.map((a) =>
              a.id === existing.id ? { ...a, amount: String(Math.round(amount)) } : a
            )
          : [
              ...prev.assignments,
              { id: tempId, categoryId, month, amount: String(Math.round(amount)) },
            ];
        return { ...prev, assignments, budgetIndex: undefined };
      });
      await withSync(() =>
        runMutation(
          async () => {
            const res = parseAssignmentResponse(
              await jsonReq<unknown>("/api/assignments", {
                method: "PUT",
                body: JSON.stringify({ categoryId, month, amount }),
              })
            );
            if (res && typeof res.id === "number") {
              setData((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  assignments: prev.assignments.map((a) =>
                    a.id === tempId || (a.categoryId === categoryId && a.month === month)
                      ? { ...a, id: res.id, amount: String(res.amount) }
                      : a
                  ),
                };
              });
            }
            return res;
          },
          { failure: "Failed to save assignment. Please try again." },
          {
            onRollback: () => {
              setData((current) => {
                if (!current) return current;
                let assignments: Assignment[];
                if (prevAssignmentSnapshot) {
                  assignments = current.assignments.map((a) =>
                    a.id === prevAssignmentSnapshot.id ||
                    (a.categoryId === categoryId && a.month === month)
                      ? prevAssignmentSnapshot
                      : a
                  );
                } else {
                  assignments = current.assignments.filter(
                    (a) =>
                      !(
                        a.id === tempId ||
                        (a.categoryId === categoryId && a.month === month)
                      )
                  );
                }
                return { ...current, assignments, budgetIndex: undefined };
              });
              reload().catch(() => {});
            },
            skipReload: true,
          }
        )
      );
    },
    batchAssign: async (assignments) => {
      if (!assignments.length) return;
      const prevAssignmentsSnapshot = dataRef.current ? [...dataRef.current.assignments] : [];
      const tempIdBase = -Date.now();
      setData((prev) => {
        if (!prev) return prev;
        let nextAssignments = [...prev.assignments];
        assignments.forEach((item, idx) => {
          const existing = nextAssignments.find(
            (a) => a.categoryId === item.categoryId && a.month === item.month
          );
          if (existing) {
            nextAssignments = nextAssignments.map((a) =>
              a.id === existing.id ? { ...a, amount: String(Math.round(item.amount)) } : a
            );
          } else {
            nextAssignments.push({
              id: tempIdBase - idx,
              categoryId: item.categoryId,
              month: item.month,
              amount: String(Math.round(item.amount)),
            });
          }
        });
        return { ...prev, assignments: nextAssignments, budgetIndex: undefined };
      });
      await withSync(() =>
        runMutation(
          async () => {
            const results = await Promise.all(
              assignments.map(async (item) =>
                parseAssignmentResponse(
                  await jsonReq<unknown>("/api/assignments", {
                    method: "PUT",
                    body: JSON.stringify({
                      categoryId: item.categoryId,
                      month: item.month,
                      amount: item.amount,
                    }),
                  })
                )
              )
            );
            return results;
          },
          { failure: "Failed to save assignments. Please try again." },
          {
            onRollback: () => {
              setData((current) => {
                if (!current) return current;
                return { ...current, assignments: prevAssignmentsSnapshot, budgetIndex: undefined };
              });
              reload().catch(() => {});
            },
          }
        )
      );
    },
    addTransaction: async (t) => {
      const successMsg = "Transaction added.";
      const tempId = -Date.now();
      const childCount = t.subTransactions?.length ?? 0;
      const createdTempIds = new Set<number>([tempId]);
      for (let i = 1; i <= childCount; i++) {
        createdTempIds.add(tempId - i);
      }

      const deltas = new Map<number, number>();
      if (t.subTransactions && t.subTransactions.length > 0) {
        for (const st of t.subTransactions) {
          deltas.set(t.accountId, (deltas.get(t.accountId) ?? 0) + st.amount);
          if (st.transferAccountId != null) {
            deltas.set(st.transferAccountId, (deltas.get(st.transferAccountId) ?? 0) - st.amount);
          }
        }
      } else {
        deltas.set(t.accountId, (deltas.get(t.accountId) ?? 0) + t.amount);
        if (t.transferAccountId != null) {
          deltas.set(t.transferAccountId, (deltas.get(t.transferAccountId) ?? 0) - t.amount);
        }
      }

      setData((prev) => {
        if (!prev) return prev;

        const srcAccount = prev.accounts.find((a) => a.id === t.accountId);
        const srcOnBudget = srcAccount?.onBudget ?? true;
        const srcKind = srcAccount?.kind ?? "liquid";
        let initialCatId = t.subTransactions?.length ? null : (t.categoryId ?? null);
        let initialIsIncome = false;
        let initialIncomeMonth: string | null = t.incomeMonth ?? null;

        if (t.transferAccountId != null) {
          const destAccount = prev.accounts.find((a) => a.id === t.transferAccountId);
          const destOnBudget = destAccount?.onBudget ?? true;
          const classification = classifyBoundaryTransfer({
            srcOnBudget,
            destOnBudget,
            amount: t.amount,
            categoryId: initialCatId,
            incomeMonth: initialIncomeMonth,
          });
          initialCatId = classification.categoryId;
          initialIsIncome = classification.isIncome;
          initialIncomeMonth = classification.incomeMonth;
        } else if (!t.subTransactions?.length) {
          if (!srcOnBudget || srcKind === "credit") {
            initialIsIncome = false;
            initialIncomeMonth = null;
          } else {
            initialIsIncome = initialCatId == null && t.amount > 0;
            if (!initialIsIncome) initialIncomeMonth = null;
          }
        }

        const newTx: Transaction = {
          id: tempId,
          accountId: t.accountId,
          categoryId: initialCatId,
          date: t.date,
          payee: t.payee,
          memo: t.memo ?? "",
          amount: t.amount.toFixed(2),
          status: t.status ?? "u",
          flagColor: t.flagColor ?? null,
          transferAccountId: t.transferAccountId ?? null,
          parentId: null,
          isIncome: initialIsIncome,
          incomeMonth: initialIncomeMonth,
        };

        let newTransactions: Transaction[] = [newTx];

        if (t.subTransactions && t.subTransactions.length > 0) {
          let childIdx = 1;
          for (const st of t.subTransactions) {
            let childCategoryId = st.categoryId ?? null;
            let isIncome = false;

            if (st.transferAccountId != null) {
              const destAccount = prev.accounts.find((a) => a.id === st.transferAccountId);
              const destOnBudget = destAccount?.onBudget ?? true;
              const classification = classifyBoundaryTransfer({
                srcOnBudget,
                destOnBudget,
                amount: st.amount,
                categoryId: childCategoryId,
              });
              childCategoryId = classification.categoryId;
              isIncome = classification.isIncome;
            } else if (!srcOnBudget || srcAccount?.kind === "credit") {
              childCategoryId = null;
              isIncome = false;
            } else {
              isIncome = childCategoryId == null && st.amount > 0;
            }

            newTransactions.push({
              id: tempId - childIdx,
              accountId: t.accountId,
              categoryId: childCategoryId,
              date: t.date,
              payee: st.transferAccountId != null ? `Transfer : ${prev.accounts.find((a) => a.id === st.transferAccountId)?.name ?? "Unknown"}` : t.payee,
              memo: st.memo ?? "",
              amount: st.amount.toFixed(2),
              status: t.status ?? "u",
              flagColor: t.flagColor ?? null,
              transferAccountId: st.transferAccountId ?? null,
              parentId: tempId,
              isIncome,
            });
            childIdx++;
          }
        }
        const accounts = applyAccountDeltas(prev.accounts, deltas);
        return { ...prev, accounts, transactions: [...newTransactions, ...prev.transactions], budgetIndex: undefined };
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
            if (res && "id" in res && typeof res.id === "number") {
              setData((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  transactions: prev.transactions.map((tx) =>
                    tx.id === tempId ? { ...tx, id: (res as Transaction).id } : tx
                  ),
                };
              });
            } else if (res && "parent" in res && "children" in res) {
              const splitRes = res as { parent: Transaction; children: Transaction[] };
              setData((prev) => {
                if (!prev) return prev;
                const childTempIds = new Map<number, number>();
                let ci = 1;
                for (const child of splitRes.children) {
                  childTempIds.set(tempId - ci, child.id);
                  ci++;
                }
                return {
                  ...prev,
                  transactions: prev.transactions.map((tx) => {
                    if (tx.id === tempId) return { ...tx, id: splitRes.parent.id };
                    const realChildId = childTempIds.get(tx.id);
                    if (realChildId != null) return { ...tx, id: realChildId };
                    return tx;
                  }),
                };
              });
            }
            return res;
          },
          { success: successMsg, failure: "Failed to add transaction. Please try again." },
          {
            onRollback: () => {
              const reverseDeltas = new Map<number, number>();
              for (const [accId, delta] of deltas.entries()) {
                reverseDeltas.set(accId, -delta);
              }
              setData((current) => {
                if (!current) return current;
                const accounts = applyAccountDeltas(current.accounts, reverseDeltas);
                const transactions = current.transactions.filter(
                  (tx) => !createdTempIds.has(tx.id) && tx.parentId !== tempId
                );
                return { ...current, accounts, transactions, budgetIndex: undefined };
              });
              reload().catch(() => {});
            },
          }
        );
      });
    },
    updateTransaction: async (id, t) => {
      const target = dataRef.current?.transactions.find((x) => x.id === id);
      const splitParentId =
        target?.parentId ?? (dataRef.current?.transactions.some((x) => x.parentId === id) ? id : null);

      const prevAffectedTxs = (dataRef.current?.transactions ?? [])
        .filter((x) => x.id === id || (splitParentId != null && (x.id === splitParentId || x.parentId === splitParentId)))
        .map((x) => ({ ...x }));
      const affectedTxIds = new Set(prevAffectedTxs.map((x) => x.id));
      if (splitParentId != null) affectedTxIds.add(splitParentId);

      const appliedDeltas = new Map<number, number>();

      setData((prev) => {
        if (!prev) return prev;
        const currentTarget = prev.transactions.find((x) => x.id === id);
        const isSplitParent = prev.transactions.some((x) => x.parentId === id);
        const deltas = new Map<number, number>();

        if (currentTarget) {
          if (t.subTransactions !== undefined) {
            const oldChildren = prev.transactions.filter((x) => x.parentId === id);
            for (const c of oldChildren) {
              deltas.set(c.accountId, (deltas.get(c.accountId) ?? 0) - num(c.amount));
              if (c.transferAccountId != null) {
                deltas.set(c.transferAccountId, (deltas.get(c.transferAccountId) ?? 0) + num(c.amount));
              }
            }
            for (const st of t.subTransactions) {
              deltas.set(currentTarget.accountId, (deltas.get(currentTarget.accountId) ?? 0) + st.amount);
              if (st.transferAccountId != null) {
                deltas.set(st.transferAccountId, (deltas.get(st.transferAccountId) ?? 0) - st.amount);
              }
            }
          } else if (!isSplitParent) {
            const oldAccountId = currentTarget.accountId;
            const oldAmount = num(currentTarget.amount);
            const newAccountId = t.accountId ?? currentTarget.accountId;
            const newAmount = t.amount !== undefined ? t.amount : oldAmount;
            const newTransferAccountId =
              "transferAccountId" in t ? (t.transferAccountId ?? null) : (currentTarget.transferAccountId ?? null);

            deltas.set(oldAccountId, (deltas.get(oldAccountId) ?? 0) - oldAmount);
            if (currentTarget.transferAccountId != null) {
              deltas.set(
                currentTarget.transferAccountId,
                (deltas.get(currentTarget.transferAccountId) ?? 0) + oldAmount
              );
            }
            deltas.set(newAccountId, (deltas.get(newAccountId) ?? 0) + newAmount);
            if (newTransferAccountId != null) {
              deltas.set(
                newTransferAccountId,
                (deltas.get(newTransferAccountId) ?? 0) - newAmount
              );
            }
          }
        }

        for (const [k, v] of deltas.entries()) {
          appliedDeltas.set(k, v);
        }

        const accounts = applyAccountDeltas(prev.accounts, deltas);

        // Recompute categoryId, isIncome, and incomeMonth to mirror server-side logic
        let nextCategoryId: number | null | undefined = t.categoryId;
        let nextIsIncome: boolean | undefined;
        let nextIncomeMonth: string | null | undefined = t.incomeMonth;

        if (currentTarget) {
          const newAccountId = t.accountId ?? currentTarget.accountId;
          const newAmount = t.amount !== undefined ? t.amount : num(currentTarget.amount);
          const newTransferAccountId =
            "transferAccountId" in t ? (t.transferAccountId ?? null) : (currentTarget.transferAccountId ?? null);
          const srcAccount = prev.accounts.find((a) => a.id === newAccountId);
          const srcOnBudget = srcAccount?.onBudget ?? true;
          const srcKind = srcAccount?.kind ?? "liquid";

          if (newTransferAccountId != null) {
            const destAccount = prev.accounts.find((a) => a.id === newTransferAccountId);
            const rawCatId = "categoryId" in t ? (t.categoryId ?? null) : (currentTarget.categoryId ?? null);
            const rawIncMonth = "incomeMonth" in t ? (t.incomeMonth ?? null) : (currentTarget.incomeMonth ?? null);
            const classification = classifyBoundaryTransfer({
              srcOnBudget,
              destOnBudget: destAccount?.onBudget ?? true,
              amount: newAmount,
              categoryId: rawCatId,
              incomeMonth: rawIncMonth,
            });
            nextCategoryId = classification.categoryId;
            nextIsIncome = classification.isIncome;
            nextIncomeMonth = classification.incomeMonth;
          } else if (isSplitParent) {
            nextCategoryId = null;
            nextIsIncome = false;
            nextIncomeMonth = null;
          } else if (!srcOnBudget) {
            nextCategoryId = null;
            nextIsIncome = false;
            nextIncomeMonth = null;
          } else if (srcKind === "credit") {
            if ("categoryId" in t) {
              nextCategoryId = t.categoryId ?? null;
            } else {
              nextCategoryId = currentTarget.categoryId ?? null;
            }
            nextIsIncome = false;
            nextIncomeMonth = null;
          } else {
            // Liquid cash on-budget account
            const finalCatId = "categoryId" in t ? (t.categoryId ?? null) : (currentTarget.categoryId ?? null);
            nextCategoryId = finalCatId;
            const isEligibleForIncome = finalCatId == null;
            const isIncome = isEligibleForIncome
              ? ("isIncome" in t && t.isIncome !== undefined ? Boolean(t.isIncome) : newAmount > 0)
              : false;
            nextIsIncome = isIncome;
            if (!isIncome) {
              nextIncomeMonth = null;
            } else if ("incomeMonth" in t) {
              nextIncomeMonth = t.incomeMonth ?? null;
            } else {
              nextIncomeMonth = currentTarget.incomeMonth ?? null;
            }
          }
        }

        const transactions = prev.transactions.map((x) => {
          const isTarget = x.id === id;
          const isSplitMember =
            splitParentId != null && (x.id === splitParentId || x.parentId === splitParentId);

          if (!isTarget && !isSplitMember) return x;

          if (!isTarget && isSplitMember) {
            return {
              ...x,
              ...(t.date !== undefined ? { date: t.date } : {}),
              ...(t.status !== undefined ? { status: t.status } : {}),
            };
          }

          return {
            ...x,
            ...(t.accountId !== undefined ? { accountId: t.accountId } : {}),
            ...("transferAccountId" in t ? { transferAccountId: t.transferAccountId ?? null } : {}),
            ...(nextCategoryId !== undefined ? { categoryId: nextCategoryId } : {}),
            ...(t.date !== undefined ? { date: t.date } : {}),
            ...(t.payee !== undefined ? { payee: t.payee } : {}),
            ...(t.memo !== undefined ? { memo: t.memo } : {}),
            ...(t.amount !== undefined ? { amount: t.amount.toFixed(2) } : {}),
            ...(t.status !== undefined ? { status: t.status } : {}),
            ...("transferStatus" in t && t.transferStatus !== undefined ? { transferStatus: t.transferStatus } : {}),
            ...(t.flagColor !== undefined ? { flagColor: t.flagColor ?? null } : {}),
            ...(nextIsIncome !== undefined ? { isIncome: nextIsIncome } : {}),
            ...(nextIncomeMonth !== undefined ? { incomeMonth: nextIncomeMonth } : {}),
          };
        });
        return { ...prev, accounts, transactions, budgetIndex: undefined };
      });
      const isStatusOrFlagOnly =
        (t.status !== undefined || ("transferStatus" in t && t.transferStatus !== undefined) || t.flagColor !== undefined) &&
        t.accountId === undefined &&
        !("categoryId" in t && t.categoryId !== undefined) &&
        !("transferAccountId" in t && t.transferAccountId !== undefined) &&
        t.date === undefined &&
        t.payee === undefined &&
        t.memo === undefined &&
        t.amount === undefined &&
        t.incomeMonth === undefined &&
        !("isIncome" in t && t.isIncome !== undefined) &&
        !("subTransactions" in t && t.subTransactions !== undefined);
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/transactions", {
              method: "PATCH",
              body: JSON.stringify({ id, ...t }),
            });
          },
          { success: isStatusOrFlagOnly ? undefined : "Transaction updated.", failure: "Failed to update transaction." },
          {
            onRollback: () => {
              const reverseDeltas = new Map<number, number>();
              for (const [accId, delta] of appliedDeltas.entries()) {
                reverseDeltas.set(accId, -delta);
              }
              setData((current) => {
                if (!current) return current;
                const accounts = applyAccountDeltas(current.accounts, reverseDeltas);
                const otherTransactions = current.transactions.filter(
                  (x) => !affectedTxIds.has(x.id) && (splitParentId == null || x.parentId !== splitParentId)
                );
                return {
                  ...current,
                  accounts,
                  transactions: [...otherTransactions, ...prevAffectedTxs],
                  budgetIndex: undefined,
                };
              });
              reload().catch(() => {});
            },
            skipReload: !(
              t.amount !== undefined ||
              t.accountId !== undefined ||
              t.transferAccountId !== undefined ||
              t.subTransactions !== undefined ||
              t.date !== undefined ||
              t.categoryId !== undefined ||
              t.incomeMonth !== undefined
            ),
          }
        )
      );
    },
    deleteTransaction: async (id) => {
      const idSet = new Set([id]);
      const allAffectedIds = new Set<number>();
      for (const tx of dataRef.current?.transactions ?? []) {
        if (idSet.has(tx.id)) {
          allAffectedIds.add(tx.id);
          if (tx.parentId != null) allAffectedIds.add(tx.parentId);
        }
      }
      for (const tx of dataRef.current?.transactions ?? []) {
        if (tx.parentId != null && allAffectedIds.has(tx.parentId)) {
          allAffectedIds.add(tx.id);
        }
      }
      const prevAffectedTxs = (dataRef.current?.transactions ?? [])
        .filter((tx) => allAffectedIds.has(tx.id))
        .map((tx) => ({ ...tx }));

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
              const reverseDeltas = new Map<number, number>();
              for (const [accId, delta] of appliedDeltas.entries()) {
                reverseDeltas.set(accId, -delta);
              }
              setData((current) => {
                if (!current) return current;
                const accounts = applyAccountDeltas(current.accounts, reverseDeltas);
                const otherTransactions = current.transactions.filter(
                  (tx) => !allAffectedIds.has(tx.id) && (tx.parentId == null || !allAffectedIds.has(tx.parentId))
                );
                return {
                  ...current,
                  accounts,
                  transactions: [...otherTransactions, ...prevAffectedTxs],
                  budgetIndex: undefined,
                };
              });
              reload().catch(() => {});
            },
          }
        )
      );
    },
    bulkDeleteTransactions: async (ids: number[]) => {
      const idSet = new Set(ids);
      const allAffectedIds = new Set<number>();
      for (const tx of dataRef.current?.transactions ?? []) {
        if (idSet.has(tx.id)) {
          allAffectedIds.add(tx.id);
          if (tx.parentId != null) allAffectedIds.add(tx.parentId);
        }
      }
      for (const tx of dataRef.current?.transactions ?? []) {
        if (tx.parentId != null && allAffectedIds.has(tx.parentId)) {
          allAffectedIds.add(tx.id);
        }
      }
      const prevAffectedTxs = (dataRef.current?.transactions ?? [])
        .filter((tx) => allAffectedIds.has(tx.id))
        .map((tx) => ({ ...tx }));

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
              const reverseDeltas = new Map<number, number>();
              for (const [accId, delta] of appliedDeltas.entries()) {
                reverseDeltas.set(accId, -delta);
              }
              setData((current) => {
                if (!current) return current;
                const accounts = applyAccountDeltas(current.accounts, reverseDeltas);
                const otherTransactions = current.transactions.filter(
                  (tx) => !allAffectedIds.has(tx.id) && (tx.parentId == null || !allAffectedIds.has(tx.parentId))
                );
                return {
                  ...current,
                  accounts,
                  transactions: [...otherTransactions, ...prevAffectedTxs],
                  budgetIndex: undefined,
                };
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
      const idSet = new Set(ids);
      const allAffectedIds = new Set<number>(ids);
      for (const tx of dataRef.current?.transactions ?? []) {
        if (idSet.has(tx.id)) {
          if (tx.parentId != null) allAffectedIds.add(tx.parentId);
        }
      }
      for (const tx of dataRef.current?.transactions ?? []) {
        if (tx.parentId != null && allAffectedIds.has(tx.parentId)) {
          allAffectedIds.add(tx.id);
        }
      }
      const prevAffectedTxs = (dataRef.current?.transactions ?? [])
        .filter((tx) => allAffectedIds.has(tx.id))
        .map((tx) => ({ ...tx }));

      const appliedDeltas = new Map<number, number>();

      setData((prev) => {
        if (!prev) return prev;
        const affectedSplitParentIds = new Set<number>();
        for (const tx of prev.transactions) {
          if (idSet.has(tx.id)) {
            if (tx.parentId != null) affectedSplitParentIds.add(tx.parentId);
            else if (prev.transactions.some((c) => c.parentId === tx.id)) affectedSplitParentIds.add(tx.id);
          }
        }

        const deltas = new Map<number, number>();
        if (patch.accountId != null || patch.amount != null) {
          for (const tx of prev.transactions) {
            if (!idSet.has(tx.id)) continue;
            const isSplitParent = prev.transactions.some((c) => c.parentId === tx.id);
            const oldAccountId = tx.accountId;
            const oldAmount = num(tx.amount);
            const newAccountId = patch.accountId != null ? patch.accountId : oldAccountId;
            const newAmount = patch.amount != null ? patch.amount : oldAmount;

            if (tx.transferAccountId != null) {
              deltas.set(oldAccountId, (deltas.get(oldAccountId) ?? 0) - oldAmount);
              deltas.set(tx.transferAccountId, (deltas.get(tx.transferAccountId) ?? 0) + oldAmount);
              deltas.set(newAccountId, (deltas.get(newAccountId) ?? 0) + newAmount);
              deltas.set(tx.transferAccountId, (deltas.get(tx.transferAccountId) ?? 0) - newAmount);
            } else if (!isSplitParent) {
              if (newAccountId !== oldAccountId || newAmount !== oldAmount) {
                deltas.set(oldAccountId, (deltas.get(oldAccountId) ?? 0) - oldAmount);
                deltas.set(newAccountId, (deltas.get(newAccountId) ?? 0) + newAmount);
              }
            }
          }
        }

        for (const [k, v] of deltas.entries()) {
          appliedDeltas.set(k, v);
        }

        const accounts = applyAccountDeltas(prev.accounts, deltas);

        const transactions = prev.transactions.map((x) => {
          if (!idSet.has(x.id)) {
            const isSplitMember =
              (x.parentId != null && affectedSplitParentIds.has(x.parentId)) ||
              affectedSplitParentIds.has(x.id);
            if (isSplitMember) {
              return {
                ...x,
                ...(patch.date !== undefined ? { date: patch.date } : {}),
                ...(patch.status !== undefined ? { status: patch.status } : {}),
              };
            }
            return x;
          }
          return {
            ...x,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
            ...(patch.flagColor !== undefined ? { flagColor: patch.flagColor } : {}),
            ...(patch.date !== undefined ? { date: patch.date } : {}),
            ...(patch.payee !== undefined ? { payee: patch.payee } : {}),
            ...(patch.memo !== undefined ? { memo: patch.memo ?? "" } : {}),
            ...(patch.amount !== undefined ? { amount: String(patch.amount) } : {}),
            ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
            ...(patch.incomeMonth !== undefined ? { incomeMonth: patch.incomeMonth } : {}),
          };
        });
        return { ...prev, accounts, transactions, budgetIndex: undefined };
      });
      const isStatusOnly =
        patch.categoryId === undefined &&
        patch.payee === undefined &&
        patch.memo === undefined &&
        patch.date === undefined &&
        patch.amount === undefined &&
        patch.accountId === undefined &&
        patch.flagColor === undefined &&
        patch.incomeMonth === undefined;
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/transactions?action=bulk-update", {
              method: "POST",
              body: JSON.stringify({ ids, patch }),
            });
          },
          { success: isStatusOnly ? undefined : `Updated ${ids.length} transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to update transactions." },
          {
            onRollback: () => {
              const reverseDeltas = new Map<number, number>();
              for (const [accId, delta] of appliedDeltas.entries()) {
                reverseDeltas.set(accId, -delta);
              }
              setData((current) => {
                if (!current) return current;
                const accounts = applyAccountDeltas(current.accounts, reverseDeltas);
                const otherTransactions = current.transactions.filter(
                  (tx) => !allAffectedIds.has(tx.id) && (tx.parentId == null || !allAffectedIds.has(tx.parentId))
                );
                return {
                  ...current,
                  accounts,
                  transactions: [...otherTransactions, ...prevAffectedTxs],
                  budgetIndex: undefined,
                };
              });
              reload().catch(() => {});
            },
          }
        )
      );
    },
    addRecurring: async (v) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/recurring", { method: "POST", body: JSON.stringify(v) });
          },
          { success: "Recurring transaction scheduled.", failure: "Failed to create recurring transaction." }
        )
      );
    },
    updateRecurring: async (id, v) => {
      const prevRecurring = dataRef.current?.recurring.find((r) => r.id === id);
      const prevRecurringSnapshot = prevRecurring
        ? {
            ...prevRecurring,
            subTransactions: prevRecurring.subTransactions?.map((st) => ({ ...st })),
          }
        : null;
      setData((prev) => {
        if (!prev) return prev;
        const recurring = prev.recurring.map((r) => {
          if (r.id !== id) return r;
          const { subTransactions, amount, ...rest } = v;
          return {
            ...r,
            ...rest,
            amount: amount !== undefined ? amount.toFixed(2) : r.amount,
            subTransactions:
              subTransactions !== undefined
                ? subTransactions.map((st, i) => ({
                    id: r.subTransactions?.[i]?.id ?? -(i + 1),
                    recurringId: id,
                    categoryId: st.categoryId,
                    transferAccountId: st.transferAccountId ?? null,
                    amount: st.amount.toFixed(2),
                    memo: st.memo ?? "",
                    sort: i,
                  }))
                : r.subTransactions,
          };
        });
        return { ...prev, recurring, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/recurring", {
              method: "PATCH",
              body: JSON.stringify({ id, ...v }),
            });
          },
          { success: "Recurring transaction updated.", failure: "Failed to update recurring transaction." },
          {
            onRollback: () => {
              if (prevRecurringSnapshot) {
                setData((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    recurring: current.recurring.map((r) =>
                      r.id === id ? prevRecurringSnapshot : r
                    ),
                    budgetIndex: undefined,
                  };
                });
              }
              reload().catch(() => {});
            },
          }
        )
      );
    },
    deleteRecurring: async (id) => {
      const prevRecurring = dataRef.current?.recurring.find((r) => r.id === id);
      const prevRecurringSnapshot = prevRecurring
        ? {
            ...prevRecurring,
            subTransactions: prevRecurring.subTransactions?.map((st) => ({ ...st })),
          }
        : null;
      setData((prev) => {
        if (!prev) return prev;
        const recurring = prev.recurring.filter((r) => r.id !== id);
        return { ...prev, recurring, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq(`/api/recurring?id=${id}`, { method: "DELETE" });
          },
          { success: "Recurring transaction deleted.", failure: "Failed to delete recurring transaction." },
          {
            onRollback: () => {
              if (prevRecurringSnapshot) {
                setData((current) => {
                  if (!current) return current;
                  if (current.recurring.some((r) => r.id === id)) return current;
                  return {
                    ...current,
                    recurring: [...current.recurring, prevRecurringSnapshot],
                    budgetIndex: undefined,
                  };
                });
              }
              reload().catch(() => {});
            },
          }
        )
      );
    },
    postRecurring: async (id: number, date?: string) => {
      return withSync(() =>
        runMutation(
          async () => {
            const url = date
              ? `/api/recurring?action=post&id=${id}&date=${encodeURIComponent(date)}`
              : `/api/recurring?action=post&id=${id}`;
            return await jsonReq(url, { method: "POST" });
          },
          { success: "Scheduled transaction entered.", failure: "Failed to post recurring transaction." }
        )
      );
    },
    bulkPostRecurring: async (ids: number[], date?: string) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/recurring", {
              method: "POST",
              body: JSON.stringify({ action: "bulk-post", ids, date }),
            });
          },
          { success: `Entered ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to enter scheduled transactions." }
        )
      );
    },
    bulkUpdateRecurring: async (ids: number[], patch: { flagColor?: any; active?: boolean }) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/recurring", {
              method: "PATCH",
              body: JSON.stringify({ action: "bulk-update", ids, patch }),
            });
          },
          { success: `Updated ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to update scheduled transactions." }
        )
      );
    },
    bulkDeleteRecurring: async (ids: number[]) => {
      const idSet = new Set(ids);
      const prevRecurringSnapshots = (dataRef.current?.recurring ?? [])
        .filter((r) => idSet.has(r.id))
        .map((r) => ({
          ...r,
          subTransactions: r.subTransactions?.map((st) => ({ ...st })),
        }));
      setData((prev) => {
        if (!prev) return prev;
        const recurring = prev.recurring.filter((r) => !idSet.has(r.id));
        return { ...prev, recurring, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/recurring", {
              method: "DELETE",
              body: JSON.stringify({ ids }),
            });
          },
          { success: `Deleted ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to delete scheduled transactions." },
          {
            onRollback: () => {
              if (prevRecurringSnapshots.length > 0) {
                setData((current) => {
                  if (!current) return current;
                  const currentIds = new Set(current.recurring.map((r) => r.id));
                  const toRestore = prevRecurringSnapshots.filter((r) => !currentIds.has(r.id));
                  return {
                    ...current,
                    recurring: [...current.recurring, ...toRestore],
                    budgetIndex: undefined,
                  };
                });
              }
              reload().catch(() => {});
            },
          }
        )
      );
    },
    saveCategory: async (groupId, categoryId, v) => {
      const prevCategory = categoryId
        ? dataRef.current?.categories.find((c) => c.id === categoryId)
        : null;
      const prevCategorySnapshot = prevCategory ? { ...prevCategory } : null;
      const targetGroupId = v.groupId ?? (groupId != null ? groupId : undefined);
      if (categoryId) {
        setData((prev) => {
          if (!prev) return prev;
          const categories = prev.categories.map((c) =>
            c.id === categoryId
              ? {
                  ...c,
                  groupId: targetGroupId ?? c.groupId,
                  name: v.name,
                  goalTarget: v.goalTarget != null ? v.goalTarget.toFixed(2) : null,
                  carryover: v.carryover != null ? v.carryover.toFixed(2) : c.carryover,
                  overspendCarriesOver: v.overspendCarriesOver ?? c.overspendCarriesOver,
                }
              : c
          );
          return { ...prev, categories, budgetIndex: undefined };
        });
      }
      return withSync(() =>
        runMutation(
          async () => {
            if (categoryId) {
              return await jsonReq("/api/categories", {
                method: "PATCH",
                body: JSON.stringify({
                  id: categoryId,
                  groupId: v.groupId,
                  name: v.name,
                  goalTarget: v.goalTarget,
                  carryover: v.carryover,
                  overspendCarriesOver: v.overspendCarriesOver,
                }),
              });
            } else {
              return await jsonReq("/api/categories", {
                method: "POST",
                body: JSON.stringify({
                  groupId: targetGroupId ?? groupId,
                  name: v.name,
                  goalTarget: v.goalTarget,
                  carryover: v.carryover,
                  overspendCarriesOver: v.overspendCarriesOver,
                }),
              });
            }
          },
          { success: categoryId ? "Category updated." : "Category created.", failure: "Failed to save category." },
          {
            onRollback: () => {
              if (prevCategorySnapshot && categoryId) {
                setData((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    categories: current.categories.map((c) =>
                      c.id === categoryId ? prevCategorySnapshot : c
                    ),
                    budgetIndex: undefined,
                  };
                });
              }
              reload().catch(() => {});
            },
          }
        )
      );
    },
    deleteCategory: async (id, opts) => {
      const prevCategory = dataRef.current?.categories.find((c) => c.id === id);
      const prevCategorySnapshot = prevCategory ? { ...prevCategory } : null;
      setData((prev) => {
        if (!prev) return prev;
        const categories = prev.categories.filter((c) => c.id !== id);
        return { ...prev, categories, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(
          async () => {
            const url = opts?.moveToCategoryId
              ? `/api/categories?id=${id}&moveToCategoryId=${opts.moveToCategoryId}`
              : `/api/categories?id=${id}`;
            return await jsonReq(url, { method: "DELETE" });
          },
          { success: "Category deleted.", failure: "Failed to delete category." },
          {
            onRollback: () => {
              if (prevCategorySnapshot) {
                setData((current) => {
                  if (!current) return current;
                  if (current.categories.some((c) => c.id === id)) return current;
                  return {
                    ...current,
                    categories: [...current.categories, prevCategorySnapshot],
                    budgetIndex: undefined,
                  };
                });
              }
              reload().catch(() => {});
            },
          }
        )
      );
    },
    reorderCategory: async (id, sort) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/categories", {
              method: "PATCH",
              body: JSON.stringify({ id, sort }),
            });
          },
          { failure: "Failed to reorder category." }
        )
      );
    },
    reorderGroup: async (id, sort) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/categories", {
              method: "PATCH",
              body: JSON.stringify({ id, type: "group", sort }),
            });
          },
          { failure: "Failed to reorder category group." }
        )
      );
    },
    saveGroup: async (groupId, name) => {
      return withSync(() =>
        runMutation(
          async () => {
            if (groupId) {
              return await jsonReq("/api/categories", {
                method: "PATCH",
                body: JSON.stringify({ id: groupId, type: "group", name }),
              });
            } else {
              return await jsonReq("/api/categories", {
                method: "POST",
                body: JSON.stringify({ type: "group", name }),
              });
            }
          },
          { success: groupId ? "Category group updated." : "Category group created.", failure: "Failed to save category group." }
        )
      );
    },
    deleteGroup: async (id) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq(`/api/categories?type=group&id=${id}`, { method: "DELETE" });
          },
          { success: "Category group deleted.", failure: "Failed to delete category group." }
        )
      );
    },
    addAccount: async (v) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/accounts", { method: "POST", body: JSON.stringify(v) });
          },
          { success: "Account created.", failure: "Failed to create account." }
        )
      );
    },
    deleteAccount: async (id) => {
      const prevAccount = dataRef.current?.accounts.find((a) => a.id === id);
      const prevAccountSnapshot = prevAccount ? { ...prevAccount } : null;
      setData((prev) => {
        if (!prev) return prev;
        const accounts = prev.accounts.filter((a) => a.id !== id);
        return { ...prev, accounts, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq(`/api/accounts?id=${id}`, { method: "DELETE" });
          },
          { success: "Account deleted.", failure: "Failed to delete account." },
          {
            onRollback: () => {
              if (prevAccountSnapshot) {
                setData((current) => {
                  if (!current) return current;
                  if (current.accounts.some((a) => a.id === id)) return current;
                  return {
                    ...current,
                    accounts: [...current.accounts, prevAccountSnapshot],
                    budgetIndex: undefined,
                  };
                });
              }
              reload().catch(() => {});
            },
          }
        )
      );
    },
    updateAccount: async (id, patch) => {
      const prevAccount = dataRef.current?.accounts.find((a) => a.id === id);
      const prevAccountSnapshot = prevAccount ? { ...prevAccount } : null;
      setData((prev) => {
        if (!prev) return prev;
        const accounts = prev.accounts.map((a) => {
          if (a.id !== id) return a;
          const nextKind = patch.kind !== undefined ? patch.kind : a.kind;
          const nextOnBudget =
            patch.onBudget !== undefined
              ? patch.onBudget
              : patch.kind !== undefined
                ? patch.kind !== "offbudget"
                : a.onBudget;
          return {
            ...a,
            ...patch,
            kind: nextKind,
            onBudget: nextOnBudget,
          };
        });
        return { ...prev, accounts, budgetIndex: undefined };
      });
      const successMsg =
        patch.archived === true
          ? "Account archived."
          : patch.archived === false
            ? "Account restored."
            : "Account updated.";
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/accounts", {
              method: "PATCH",
              body: JSON.stringify({ id, ...patch }),
            });
          },
          { success: successMsg, failure: "Failed to update account." },
          {
            onRollback: () => {
              if (prevAccountSnapshot) {
                setData((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    accounts: current.accounts.map((a) =>
                      a.id === id ? prevAccountSnapshot : a
                    ),
                    budgetIndex: undefined,
                  };
                });
              }
              reload().catch(() => {});
            },
          }
        )
      );
    },
    reorderAccount: async (id, sort) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/accounts", {
              method: "PATCH",
              body: JSON.stringify({ id, sort }),
            });
          },
          { failure: "Failed to reorder account." }
        )
      );
    },
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
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/reconcile", {
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
          { success: "Account reconciled.", failure: "Failed to reconcile account." }
        )
      );
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
    importYnab4: async (file: File) => {
      return withSync(() =>
        runMutation(
          async () => {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch("/api/import", {
              method: "POST",
              body: formData,
            });
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              throw new Error(`Import failed (${res.status}): ${text}`);
            }
            const json = (await res.json()) as { summary?: ImportSummary };
            return json?.summary;
          },
          {
            success: undefined,
            failure: "Failed to import YNAB4 backup.",
            onSuccess: (summary?: ImportSummary) => {
              if (summary && !summary.duplicatesSkipped?.length) {
                addToast(`Imported ${summary.transactions} transaction${summary.transactions === 1 ? "" : "s"}.`, "ok");
              }
            },
          }
        )
      );
    },
    importCsv: async ({ accountId, swap, dateFormat, csv }) => {
      return withSync(() =>
        runMutation(
          async () => {
            const res = await fetch("/api/import/csv", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ accountId, swap, dateFormat, csv }),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              throw new Error(`Import failed (${res.status}): ${text}`);
            }
            const json = (await res.json()) as {
              imported?: number;
              skipped?: ImportSkippedEntry[];
            };
            const count = json.imported ?? 0;
            const skipped = json.skipped?.length ?? 0;
            return { count, skipped };
          },
          {
            success: undefined,
            failure: "Failed to import CSV.",
            onSuccess: ({ count, skipped }) => {
              addToast(
                skipped > 0
                  ? `Imported ${count} transaction${count === 1 ? "" : "s"} (${skipped} row${skipped === 1 ? "" : "s"} skipped).`
                  : `Imported ${count} transaction${count === 1 ? "" : "s"}.`,
                "ok"
              );
            },
          }
        )
      ).then(({ count }) => count);
    },
    analyzeDuplicates: async () => {
      return withSync(() =>
        runMutation(
          async () => {
            return parseDuplicateAnalysisResponse(
              await jsonReq<unknown>("/api/duplicates", {
                method: "POST",
              })
            );
          },
          { failure: "Failed to analyze duplicates." }
        )
      );
    },
    addRenameRule: async (sourcePattern, targetPayee) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/rename-rules", {
              method: "POST",
              body: JSON.stringify({ sourcePattern, targetPayee }),
            });
          },
          { success: "Rename rule created.", failure: "Failed to save rename rule.", notifyFailure: false }
        )
      );
    },
    updateRenameRule: async (id, sourcePattern, targetPayee) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/rename-rules", {
              method: "PATCH",
              body: JSON.stringify({ id, sourcePattern, targetPayee }),
            });
          },
          { success: "Rename rule updated.", failure: "Failed to save rename rule.", notifyFailure: false }
        )
      );
    },
    deleteRenameRule: async (id) => {
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq(`/api/rename-rules?id=${id}`, { method: "DELETE" });
          },
          { success: "Rename rule deleted.", failure: "Failed to delete rename rule.", notifyFailure: false }
        )
      );
    },
  };

  if (error) {
    return (
      <div className="grid h-screen place-items-center">
        <Notice tone="danger" title="Error" className="!max-w-[480px]">
          {error}
        </Notice>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-8 w-8 animate-spin rounded-full"
            style={{
              border: "2px solid var(--y-line)",
              borderTopColor: "var(--y-side-ink)",
            }}
          />
          <span style={{ color: "var(--y-side-ink)" }}>Loading budget</span>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary name="Budget Application">
      <div className="relative h-screen w-screen overflow-hidden flex flex-col">
        {syncingCount > 0 && (
          <div
            className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full px-3 py-1.5 shadow-md transition-opacity"
            style={{
              background: "var(--y-chrome-top)",
              border: "1px solid var(--y-chrome-line)",
              color: "var(--y-ink)",
              fontSize: "11px",
            }}
            aria-live="polite"
            role="status"
          >
            <div
              className="h-3 w-3 animate-spin rounded-full"
              style={{
                border: "2px solid var(--y-ink-faint)",
                borderTopColor: "var(--y-ink)",
              }}
            />
            <span>Syncing</span>
          </div>
        )}
        <BudgetApp data={data} api={api} initialView={initialView} initialMonth={initialMonth} initialAccount={initialAccount} />
        <Toast items={toasts} onDismiss={dismissToast} />
      </div>
    </ErrorBoundary>
  );
}
