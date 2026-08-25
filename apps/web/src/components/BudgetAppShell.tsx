"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BudgetApp, ErrorBoundary, type BudgetAppApi } from "@ynab/ui";
import { Notice, Toast, type ToastItem, createToast } from "@ynab/theme";
import type { BudgetData, BulkUpdateTransactionPatch, DuplicateAnalysisResult, ImportSkippedEntry, ImportSummary, Transaction } from "@ynab/logic";

async function jsonReq<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

type BudgetResponse = BudgetData & { autoPostedRecurringCount?: number };

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
  const [data, setData] = useState<BudgetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [syncingCount, setSyncingCount] = useState(0);
  const toastTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

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
    const json = await jsonReq<BudgetResponse>("/api/budget");
    const { autoPostedRecurringCount, ...budget } = json;
    setData(budget);
    if (autoPostedRecurringCount != null && autoPostedRecurringCount > 0) {
      addToast(
        `Automatically entered ${autoPostedRecurringCount} scheduled transaction${
          autoPostedRecurringCount === 1 ? "" : "s"
        }.`,
        "ok"
      );
    }
  }, [addToast]);

  const runMutation = useCallback(
    async <T,>(action: () => Promise<T>, messages: MutationMessages<T>): Promise<T> => {
      try {
        const result = await action();
        if (messages.success) addToast(messages.success, "ok");
        messages.onSuccess?.(result);
        return result;
      } catch (e) {
        if (messages.notifyFailure !== false) addToast(messages.failure, "danger");
        throw e;
      }
    },
    [addToast]
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
    reload().catch((e: unknown) => setError(String(e)));
  }, [reload]);

  const api: BudgetAppApi = {
    reload,
    assign: async (categoryId, amount, month) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const existing = prev.assignments.find(
          (a) => a.categoryId === categoryId && a.month === month
        );
        const assignments = existing
          ? prev.assignments.map((a) =>
              a.id === existing.id ? { ...a, amount: amount.toFixed(2) } : a
            )
          : [
              ...prev.assignments,
              { id: -Date.now(), categoryId, month, amount: amount.toFixed(2) },
            ];
        return { ...prev, assignments, budgetIndex: undefined };
      });
      return withSync(async () => {
        try {
          await jsonReq("/api/assignments", {
            method: "PUT",
            body: JSON.stringify({ categoryId, month, amount }),
          });
        } catch (e) {
          if (snapshot) setData(snapshot);
          await reload().catch(() => {});
          addToast("Failed to save assignment. Please try again.", "danger");
          throw e;
        }
      });
    },
    addTransaction: async (t) => {
      const successMsg = "Transaction added.";
      let snapshot: BudgetData | null = null;
      const tempId = -Date.now();
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const newTx: Transaction = {
          id: tempId,
          accountId: t.accountId,
          categoryId: t.categoryId,
          date: t.date,
          payee: t.payee,
          memo: t.memo ?? "",
          amount: t.amount.toFixed(2),
          status: t.status,
          flagColor: t.flagColor ?? null,
          transferAccountId: t.transferAccountId ?? null,
          parentId: null,
        };
        return { ...prev, transactions: [newTx, ...prev.transactions], budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(async () => {
          try {
            await jsonReq("/api/transactions", { method: "POST", body: JSON.stringify(t) });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            await reload().catch(() => {});
            throw e;
          }
        }, { success: successMsg, failure: "Failed to add transaction. Please try again." })
      );
    },
    updateTransaction: async (id, t) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const transactions = prev.transactions.map((x) => {
          if (x.id !== id && x.parentId !== id) return x;
          if (x.parentId === id) {
            return {
              ...x,
              ...(t.date !== undefined ? { date: t.date } : {}),
            };
          }
          return {
            ...x,
            ...(t.accountId !== undefined ? { accountId: t.accountId } : {}),
            ...(t.categoryId !== undefined ? { categoryId: t.categoryId } : {}),
            ...(t.date !== undefined ? { date: t.date } : {}),
            ...(t.payee !== undefined ? { payee: t.payee } : {}),
            ...(t.memo !== undefined ? { memo: t.memo } : {}),
            ...(t.amount !== undefined ? { amount: t.amount.toFixed(2) } : {}),
            ...(t.status !== undefined ? { status: t.status } : {}),
            ...(t.flagColor !== undefined ? { flagColor: t.flagColor ?? null } : {}),
          };
        });
        return { ...prev, transactions, budgetIndex: undefined };
      });
      const isStatusOrFlagOnly =
        (t.status !== undefined || t.flagColor !== undefined) &&
        t.accountId === undefined &&
        t.categoryId === undefined &&
        t.date === undefined &&
        t.payee === undefined &&
        t.memo === undefined &&
        t.amount === undefined &&
        t.subTransactions === undefined;
      return withSync(() =>
        runMutation(async () => {
          try {
            await jsonReq("/api/transactions", {
              method: "PATCH",
              body: JSON.stringify({ id, ...t }),
            });
            if (t.amount !== undefined || t.accountId !== undefined || t.subTransactions !== undefined || t.date !== undefined) {
              await reload();
            }
          } catch (e) {
            if (snapshot) setData(snapshot);
            await reload().catch(() => {});
            throw e;
          }
        }, { success: isStatusOrFlagOnly ? undefined : "Transaction updated.", failure: "Failed to update transaction." })
      );
    },
    deleteTransaction: async (id) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const transactions = prev.transactions.filter(
          (x) => x.id !== id && x.parentId !== id
        );
        return { ...prev, transactions, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(async () => {
          try {
            await jsonReq(`/api/transactions?id=${id}`, { method: "DELETE" });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            await reload().catch(() => {});
            throw e;
          }
        }, { success: "Transaction deleted.", failure: "Failed to delete transaction." })
      );
    },
    bulkDeleteTransactions: async (ids: number[]) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const idSet = new Set(ids);
        const transactions = prev.transactions.filter(
          (x) => !idSet.has(x.id) && (x.parentId == null || !idSet.has(x.parentId))
        );
        return { ...prev, transactions, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(async () => {
          try {
            await jsonReq("/api/transactions?action=bulk-delete", {
              method: "POST",
              body: JSON.stringify({ ids }),
            });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            await reload().catch(() => {});
            throw e;
          }
        }, { success: `Deleted ${ids.length} transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to delete transactions." })
      );
    },
    bulkUpdateTransactions: async (
      ids: number[],
      patch: BulkUpdateTransactionPatch
    ) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const idSet = new Set(ids);
        const transactions = prev.transactions.map((x) => {
          if (!idSet.has(x.id)) {
            if (x.parentId != null && idSet.has(x.parentId) && patch.date !== undefined) {
              return {
                ...x,
                date: patch.date,
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
        return { ...prev, transactions, budgetIndex: undefined };
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
        runMutation(async () => {
          try {
            await jsonReq("/api/transactions?action=bulk-update", {
              method: "POST",
              body: JSON.stringify({ ids, patch }),
            });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            await reload().catch(() => {});
            throw e;
          }
        }, { success: isStatusOnly ? undefined : `Updated ${ids.length} transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to update transactions." })
      );
    },
    addRecurring: async (v) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq("/api/recurring", { method: "POST", body: JSON.stringify(v) });
          await reload();
        }, { success: "Recurring transaction scheduled.", failure: "Failed to create recurring transaction." })
      );
    },
    updateRecurring: async (id, v) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
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
        runMutation(async () => {
          try {
            await jsonReq("/api/recurring", {
              method: "PATCH",
              body: JSON.stringify({ id, ...v }),
            });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            throw e;
          }
        }, { success: "Recurring transaction updated.", failure: "Failed to update recurring transaction." })
      );
    },
    deleteRecurring: async (id) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const recurring = prev.recurring.filter((r) => r.id !== id);
        return { ...prev, recurring, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(async () => {
          try {
            await jsonReq(`/api/recurring?id=${id}`, { method: "DELETE" });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            throw e;
          }
        }, { success: "Recurring transaction deleted.", failure: "Failed to delete recurring transaction." })
      );
    },
    postRecurring: async (id: number, date?: string) => {
      return withSync(() =>
        runMutation(async () => {
          const url = date
            ? `/api/recurring?action=post&id=${id}&date=${encodeURIComponent(date)}`
            : `/api/recurring?action=post&id=${id}`;
          await jsonReq(url, { method: "POST" });
          await reload();
        }, { success: "Scheduled transaction entered.", failure: "Failed to post recurring transaction." })
      );
    },
    bulkPostRecurring: async (ids: number[], date?: string) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq("/api/recurring", {
            method: "POST",
            body: JSON.stringify({ action: "bulk-post", ids, date }),
          });
          await reload();
        }, { success: `Entered ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to enter scheduled transactions." })
      );
    },
    bulkUpdateRecurring: async (ids: number[], patch: { flagColor?: any; active?: boolean }) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq("/api/recurring", {
            method: "PATCH",
            body: JSON.stringify({ action: "bulk-update", ids, patch }),
          });
          await reload();
        }, { success: `Updated ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to update scheduled transactions." })
      );
    },
    bulkDeleteRecurring: async (ids: number[]) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const idSet = new Set(ids);
        const recurring = prev.recurring.filter((r) => !idSet.has(r.id));
        return { ...prev, recurring, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(async () => {
          try {
            await jsonReq("/api/recurring", {
              method: "DELETE",
              body: JSON.stringify({ ids }),
            });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            throw e;
          }
        }, { success: `Deleted ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to delete scheduled transactions." })
      );
    },
    saveCategory: async (groupId, categoryId, v) => {
      let snapshot: BudgetData | null = null;
      if (categoryId) {
        setData((prev) => {
          if (!prev) return prev;
          snapshot = prev;
          const categories = prev.categories.map((c) =>
            c.id === categoryId
              ? {
                  ...c,
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
        runMutation(async () => {
          try {
            if (categoryId) {
              await jsonReq("/api/categories", {
                method: "PATCH",
                body: JSON.stringify({
                  id: categoryId,
                  name: v.name,
                  goalTarget: v.goalTarget,
                  carryover: v.carryover,
                  overspendCarriesOver: v.overspendCarriesOver,
                }),
              });
            } else {
              await jsonReq("/api/categories", {
                method: "POST",
                body: JSON.stringify({
                  groupId,
                  name: v.name,
                  goalTarget: v.goalTarget,
                  carryover: v.carryover,
                  overspendCarriesOver: v.overspendCarriesOver,
                }),
              });
            }
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            throw e;
          }
        }, { success: categoryId ? "Category updated." : "Category created.", failure: "Failed to save category." })
      );
    },
    deleteCategory: async (id, opts) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const categories = prev.categories.filter((c) => c.id !== id);
        return { ...prev, categories, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(async () => {
          try {
            const url = opts?.moveToCategoryId
              ? `/api/categories?id=${id}&moveToCategoryId=${opts.moveToCategoryId}`
              : `/api/categories?id=${id}`;
            await jsonReq(url, { method: "DELETE" });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            throw e;
          }
        }, { success: "Category deleted.", failure: "Failed to delete category." })
      );
    },
    reorderCategory: async (id, sort) => {
      return withSync(async () => {
        await jsonReq("/api/categories", {
          method: "PATCH",
          body: JSON.stringify({ id, sort }),
        });
        await reload();
      });
    },
    reorderGroup: async (id, sort) => {
      return withSync(async () => {
        await jsonReq("/api/categories", {
          method: "PATCH",
          body: JSON.stringify({ id, type: "group", sort }),
        });
        await reload();
      });
    },
    saveGroup: async (groupId, name) => {
      return withSync(() =>
        runMutation(async () => {
          if (groupId) {
            await jsonReq("/api/categories", {
              method: "PATCH",
              body: JSON.stringify({ id: groupId, type: "group", name }),
            });
          } else {
            await jsonReq("/api/categories", {
              method: "POST",
              body: JSON.stringify({ type: "group", name }),
            });
          }
          await reload();
        }, { success: groupId ? "Category group updated." : "Category group created.", failure: "Failed to save category group." })
      );
    },
    deleteGroup: async (id) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq(`/api/categories?type=group&id=${id}`, { method: "DELETE" });
          await reload();
        }, { success: "Category group deleted.", failure: "Failed to delete category group." })
      );
    },
    addAccount: async (v) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq("/api/accounts", { method: "POST", body: JSON.stringify(v) });
          await reload();
        }, { success: "Account created.", failure: "Failed to create account." })
      );
    },
    deleteAccount: async (id) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const accounts = prev.accounts.filter((a) => a.id !== id);
        return { ...prev, accounts, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(async () => {
          try {
            await jsonReq(`/api/accounts?id=${id}`, { method: "DELETE" });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            throw e;
          }
        }, { success: "Account deleted.", failure: "Failed to delete account." })
      );
    },
    updateAccount: async (id, patch) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const accounts = prev.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a));
        return { ...prev, accounts, budgetIndex: undefined };
      });
      const successMsg =
        patch.archived === true
          ? "Account archived."
          : patch.archived === false
            ? "Account restored."
            : "Account updated.";
      return withSync(() =>
        runMutation(async () => {
          try {
            await jsonReq("/api/accounts", {
              method: "PATCH",
              body: JSON.stringify({ id, ...patch }),
            });
            await reload();
          } catch (e) {
            if (snapshot) setData(snapshot);
            throw e;
          }
        }, { success: successMsg, failure: "Failed to update account." })
      );
    },
    reorderAccount: async (id, sort) => {
      return withSync(async () => {
        await jsonReq("/api/accounts", {
          method: "PATCH",
          body: JSON.stringify({ id, sort }),
        });
        await reload();
      });
    },
    reconcileAccount: async ({ accountId, statementBalance, adjustmentCategoryId }) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq("/api/reconcile", {
            method: "POST",
            body: JSON.stringify({
              action: "reconcile",
              accountId,
              statementBalance,
              adjustmentCategoryId,
            }),
          });
          await reload();
        }, { success: "Account reconciled.", failure: "Failed to reconcile account." })
      );
    },
    unreconcileAccount: async (accountId) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq("/api/reconcile", {
            method: "POST",
            body: JSON.stringify({ action: "unreconcile", accountId }),
          });
          await reload();
        }, { success: "Reconciliation undone.", failure: "Failed to undo reconciliation." })
      );
    },
    importYnab4: async (file: File) => {
      return withSync(() =>
        runMutation(async () => {
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
          await reload();
          return json?.summary;
        }, {
          success: undefined,
          failure: "Failed to import YNAB4 backup.",
          onSuccess: (summary?: ImportSummary) => {
            if (summary && !summary.duplicatesSkipped?.length) {
              addToast(`Imported ${summary.transactions} transaction${summary.transactions === 1 ? "" : "s"}.`, "ok");
            }
          },
        })
      );
    },
    importCsv: async ({ accountId, swap, dateFormat, csv }) => {
      return withSync(() =>
        runMutation(async () => {
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
          await reload();
          return { count, skipped };
        }, {
          success: undefined,
          failure: "Failed to import CSV.",
          onSuccess: ({ count, skipped }) => {
            addToast(
              skipped > 0
                ? `Imported ${count} transaction${count === 1 ? "" : "s"} (${skipped} duplicate${skipped === 1 ? "" : "s"} skipped).`
                : `Imported ${count} transaction${count === 1 ? "" : "s"}.`,
              "ok"
            );
          },
        })
      ).then(({ count }) => count);
    },
    analyzeDuplicates: async () => {
      return withSync(async () => {
        const json = await jsonReq<DuplicateAnalysisResult>("/api/duplicates", {
          method: "POST",
        });
        await reload();
        return json;
      });
    },
    addRenameRule: async (sourcePattern, targetPayee) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq("/api/rename-rules", {
            method: "POST",
            body: JSON.stringify({ sourcePattern, targetPayee }),
          });
          await reload();
        }, { success: "Rename rule created.", failure: "Failed to save rename rule.", notifyFailure: false })
      );
    },
    updateRenameRule: async (id, sourcePattern, targetPayee) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq("/api/rename-rules", {
            method: "PATCH",
            body: JSON.stringify({ id, sourcePattern, targetPayee }),
          });
          await reload();
        }, { success: "Rename rule updated.", failure: "Failed to save rename rule.", notifyFailure: false })
      );
    },
    deleteRenameRule: async (id) => {
      return withSync(() =>
        runMutation(async () => {
          await jsonReq(`/api/rename-rules?id=${id}`, { method: "DELETE" });
          await reload();
        }, { success: "Rename rule deleted.", failure: "Failed to delete rename rule.", notifyFailure: false })
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
