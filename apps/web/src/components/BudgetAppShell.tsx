"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BudgetApp, ErrorBoundary, type BudgetAppApi } from "@ynab/ui";
import { Notice, Toast, type ToastItem, createToast } from "@ynab/theme";
import type { BudgetData } from "@ynab/logic";
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

  useEffect(() => {
    reload().catch((e: unknown) => setError(String(e)));
  }, [reload]);

  const api: BudgetAppApi = {
    reload,
    assign: async (categoryId, amount, month) => {
      // Capture the pre-mutation snapshot so we can roll back if the
      // PUT to /api/assignments fails. Without this, a network blip
      // or 500 leaves the UI showing money successfully assigned
      // while the server never recorded it — the user would then
      // operate on a budget that's quietly out of sync until the
      // next page refresh.
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
        return { ...prev, assignments };
      });
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
    },
    addTransaction: async (t) => {
      await jsonReq("/api/transactions", { method: "POST", body: JSON.stringify(t) });
      await reload();
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
          };
        });
        return { ...prev, transactions };
      });
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
        throw e;
      }
    },
    deleteTransaction: async (id) => {
      let snapshot: BudgetData | null = null;
      setData((prev) => {
        if (!prev) return prev;
        snapshot = prev;
        const transactions = prev.transactions.filter(
          (x) => x.id !== id && x.parentId !== id
        );
        return { ...prev, transactions };
      });
      try {
        await jsonReq(`/api/transactions?id=${id}`, { method: "DELETE" });
        await reload();
      } catch (e) {
        if (snapshot) setData(snapshot);
        await reload().catch(() => {});
        throw e;
      }
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
        return { ...prev, transactions };
      });
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
        return { ...prev, transactions };
      });
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
    },
    addRecurring: async (v) => {
      await jsonReq("/api/recurring", { method: "POST", body: JSON.stringify(v) });
      await reload();
    },
    updateRecurring: async (id, v) => {
      await jsonReq("/api/recurring", {
        method: "PATCH",
        body: JSON.stringify({ id, ...v }),
      });
      await reload();
    },
    deleteRecurring: async (id) => {
      await jsonReq(`/api/recurring?id=${id}`, { method: "DELETE" });
      await reload();
    },
    postRecurring: async (id) => {
      await jsonReq(`/api/recurring?action=post&id=${id}`, { method: "POST" });
      await reload();
    },
    saveCategory: async (groupId, categoryId, v) => {
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
    },
    deleteCategory: async (id, opts) => {
      const url = opts?.moveToCategoryId
        ? `/api/categories?id=${id}&moveToCategoryId=${opts.moveToCategoryId}`
        : `/api/categories?id=${id}`;
      await jsonReq(url, { method: "DELETE" });
      await reload();
    },
    reorderCategory: async (id, sort) => {
      await jsonReq("/api/categories", {
        method: "PATCH",
        body: JSON.stringify({ id, sort }),
      });
      await reload();
    },
    reorderGroup: async (id, sort) => {
      await jsonReq("/api/categories", {
        method: "PATCH",
        body: JSON.stringify({ id, type: "group", sort }),
      });
      await reload();
    },
    saveGroup: async (groupId, name) => {
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
    },
    deleteGroup: async (id) => {
      await jsonReq(`/api/categories?type=group&id=${id}`, { method: "DELETE" });
      await reload();
    },
    addAccount: async (v) => {
      await jsonReq("/api/accounts", { method: "POST", body: JSON.stringify(v) });
      await reload();
    },
    deleteAccount: async (id) => {
      await jsonReq(`/api/accounts?id=${id}`, { method: "DELETE" });
      await reload();
    },
    updateAccount: async (id, patch) => {
      await jsonReq("/api/accounts", {
        method: "PATCH",
        body: JSON.stringify({ id, ...patch }),
      });
      await reload();
    },
    reorderAccount: async (id, sort) => {
      await jsonReq("/api/accounts", {
        method: "PATCH",
        body: JSON.stringify({ id, sort }),
      });
      await reload();
    },
    reconcileAccount: async ({ accountId, statementBalance, adjustmentCategoryId }) => {
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
    },
    unreconcileAccount: async (accountId) => {
      await jsonReq("/api/reconcile", {
        method: "POST",
        body: JSON.stringify({ action: "unreconcile", accountId }),
      });
      await reload();
    },
    resetDemo: async () => {
      await jsonReq("/api/reset", { method: "POST" });
      await reload();
    },
    importYnab4: async (file: File) => {
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
      await reload();
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
      <BudgetApp data={data} api={api} />
      <Toast items={toasts} onDismiss={dismissToast} />
    </ErrorBoundary>
  );
}
