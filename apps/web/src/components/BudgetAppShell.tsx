"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BudgetApp, ErrorBoundary, type BudgetAppApi } from "@ynab/ui";
import { Notice, Toast, type ToastItem, createToast } from "@ynab/theme";
import type { BudgetData, DuplicateAnalysisResult, ImportSkippedEntry, ImportSummary } from "@ynab/logic";
import { todayISO, num, nextDateFor } from "@ynab/logic";

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

export function BudgetAppShell() {
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
    const json = await jsonReq<BudgetData>("/api/budget");
    setData(json);
  }, []);

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
      let snapshot: BudgetData | null = null;
      const tempId = -Date.now();
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const newTx = {
          id: tempId,
          accountId: t.accountId,
          categoryId: t.categoryId,
          date: t.date,
          payee: t.payee,
          memo: t.memo,
          amount: t.amount.toFixed(2),
          status: t.status,
          transferAccountId: t.transferAccountId ?? null,
          parentId: t.parentId ?? null,
        };
        return { ...prev, transactions: [newTx, ...prev.transactions], budgetIndex: undefined };
      });
      return withSync(async () => {
        try {
          await jsonReq("/api/transactions", { method: "POST", body: JSON.stringify(t) });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          await reload().catch(() => {});
          addToast("Failed to add transaction. Please try again.", "danger");
          throw e;
        }
      });
    },
    updateTransaction: async (id, t) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const transactions = prev.transactions.map((x) => {
          if (x.id !== id) return x;
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
      return withSync(async () => {
        try {
          await jsonReq("/api/transactions", {
            method: "PATCH",
            body: JSON.stringify({ id, ...t }),
          });
          if (t.amount !== undefined || t.accountId !== undefined || t.subTransactions !== undefined) {
            await reload();
          }
        } catch (e) {
          if (snapshot) setData(snapshot);
          await reload().catch(() => {});
          addToast("Failed to update transaction.", "danger");
          throw e;
        }
      });
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
      return withSync(async () => {
        try {
          await jsonReq(`/api/transactions?id=${id}`, { method: "DELETE" });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          await reload().catch(() => {});
          addToast("Failed to delete transaction.", "danger");
          throw e;
        }
      });
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
      return withSync(async () => {
        try {
          await jsonReq("/api/transactions?action=bulk-delete", {
            method: "POST",
            body: JSON.stringify({ ids }),
          });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          await reload().catch(() => {});
          addToast("Failed to delete transactions.", "danger");
          throw e;
        }
      });
    },
    bulkUpdateTransactions: async (
      ids: number[],
      patch: { status?: "u" | "c" | "r"; categoryId?: number | null }
    ) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const idSet = new Set(ids);
        const transactions = prev.transactions.map((x) => {
          if (!idSet.has(x.id)) return x;
          return {
            ...x,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
          };
        });
        return { ...prev, transactions, budgetIndex: undefined };
      });
      return withSync(async () => {
        try {
          await jsonReq("/api/transactions?action=bulk-update", {
            method: "POST",
            body: JSON.stringify({ ids, patch }),
          });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          await reload().catch(() => {});
          addToast("Failed to update transactions.", "danger");
          throw e;
        }
      });
    },
    addRecurring: async (v) => {
      return withSync(async () => {
        try {
          await jsonReq("/api/recurring", { method: "POST", body: JSON.stringify(v) });
          await reload();
        } catch (e) {
          addToast("Failed to create recurring transaction.", "danger");
          throw e;
        }
      });
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
      return withSync(async () => {
        try {
          await jsonReq("/api/recurring", {
            method: "PATCH",
            body: JSON.stringify({ id, ...v }),
          });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          addToast("Failed to update recurring transaction.", "danger");
          throw e;
        }
      });
    },
    deleteRecurring: async (id) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const recurring = prev.recurring.filter((r) => r.id !== id);
        return { ...prev, recurring, budgetIndex: undefined };
      });
      return withSync(async () => {
        try {
          await jsonReq(`/api/recurring?id=${id}`, { method: "DELETE" });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          addToast("Failed to delete recurring transaction.", "danger");
          throw e;
        }
      });
    },
    postRecurring: async (id: number, date?: string) => {
      return withSync(async () => {
        try {
          const url = date
            ? `/api/recurring?action=post&id=${id}&date=${encodeURIComponent(date)}`
            : `/api/recurring?action=post&id=${id}`;
          await jsonReq(url, { method: "POST" });
          await reload();
          addToast("Scheduled transaction entered.", "ok");
        } catch (e) {
          addToast("Failed to post recurring transaction.", "danger");
          throw e;
        }
      });
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
      return withSync(async () => {
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
          addToast("Failed to save category.", "danger");
          throw e;
        }
      });
    },
    deleteCategory: async (id, opts) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const categories = prev.categories.filter((c) => c.id !== id);
        return { ...prev, categories, budgetIndex: undefined };
      });
      return withSync(async () => {
        try {
          const url = opts?.moveToCategoryId
            ? `/api/categories?id=${id}&moveToCategoryId=${opts.moveToCategoryId}`
            : `/api/categories?id=${id}`;
          await jsonReq(url, { method: "DELETE" });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          addToast("Failed to delete category.", "danger");
          throw e;
        }
      });
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
      return withSync(async () => {
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
      });
    },
    deleteGroup: async (id) => {
      return withSync(async () => {
        await jsonReq(`/api/categories?type=group&id=${id}`, { method: "DELETE" });
        await reload();
      });
    },
    addAccount: async (v) => {
      return withSync(async () => {
        try {
          await jsonReq("/api/accounts", { method: "POST", body: JSON.stringify(v) });
          await reload();
        } catch (e) {
          addToast("Failed to create account.", "danger");
          throw e;
        }
      });
    },
    deleteAccount: async (id) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const accounts = prev.accounts.filter((a) => a.id !== id);
        return { ...prev, accounts, budgetIndex: undefined };
      });
      return withSync(async () => {
        try {
          await jsonReq(`/api/accounts?id=${id}`, { method: "DELETE" });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          addToast("Failed to delete account.", "danger");
          throw e;
        }
      });
    },
    updateAccount: async (id, patch) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const accounts = prev.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a));
        return { ...prev, accounts, budgetIndex: undefined };
      });
      return withSync(async () => {
        try {
          await jsonReq("/api/accounts", {
            method: "PATCH",
            body: JSON.stringify({ id, ...patch }),
          });
          await reload();
        } catch (e) {
          if (snapshot) setData(snapshot);
          addToast("Failed to update account.", "danger");
          throw e;
        }
      });
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
      return withSync(async () => {
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
      });
    },
    unreconcileAccount: async (accountId) => {
      return withSync(async () => {
        await jsonReq("/api/reconcile", {
          method: "POST",
          body: JSON.stringify({ action: "unreconcile", accountId }),
        });
        await reload();
      });
    },
    importYnab4: async (file: File) => {
      return withSync(async () => {
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
      });
    },
    importCsv: async ({ accountId, swap, csv }) => {
      return withSync(async () => {
        const res = await fetch("/api/import/csv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, swap, csv }),
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
        addToast(
          skipped > 0
            ? `Imported ${count} transaction${count === 1 ? "" : "s"} (${skipped} duplicate${skipped === 1 ? "" : "s"} skipped).`
            : `Imported ${count} transaction${count === 1 ? "" : "s"}.`,
          "ok"
        );
        return count;
      });
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
          <span style={{ color: "var(--y-side-ink)" }}>Loading budget…</span>
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
            <span>Syncing…</span>
          </div>
        )}
        <BudgetApp data={data} api={api} />
        <Toast items={toasts} onDismiss={dismissToast} />
      </div>
    </ErrorBoundary>
  );
}
