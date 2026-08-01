"use client";

import { useCallback, useEffect, useState } from "react";
import { BudgetApp, type BudgetAppApi } from "@ynab/ui";
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
      setData((prev) => {
        if (!prev) return prev;
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
      await jsonReq("/api/assignments", {
        method: "PUT",
        body: JSON.stringify({ categoryId, month, amount }),
      });
    },
    addTransaction: async (t) => {
      await jsonReq("/api/transactions", { method: "POST", body: JSON.stringify(t) });
      await reload();
    },
    updateTransaction: async (id, t) => {
      await jsonReq("/api/transactions", {
        method: "PATCH",
        body: JSON.stringify({ id, ...t }),
      });
      await reload();
    },
    deleteTransaction: async (id) => {
      await jsonReq(`/api/transactions?id=${id}`, { method: "DELETE" });
      await reload();
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
      if (!data) return;
      const r = data.recurring.find((x) => x.id === id);
      if (!r) return;
      const today = todayISO();
      await jsonReq("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          accountId: r.accountId,
          categoryId: r.categoryId,
          date: today,
          payee: r.payee,
          memo: "Recurring",
          amount: num(r.amount),
        }),
      });
      // Advance nextDate by one frequency step so the next "Post Now" is
      // a fresh cycle and the recurring card reflects a new schedule.
      const next = nextDateFor(r.frequency, r.nextDate);
      if (next !== r.nextDate) {
        await jsonReq("/api/recurring", {
          method: "PATCH",
          body: JSON.stringify({ id: r.id, nextDate: next }),
        });
      }
      await reload();
    },
    saveCategory: async (groupId, categoryId, v) => {
      if (categoryId) {
        await jsonReq("/api/categories", {
          method: "PATCH",
          body: JSON.stringify({ id: categoryId, name: v.name, goalTarget: v.goalTarget, carryover: v.carryover }),
        });
      } else {
        await jsonReq("/api/categories", {
          method: "POST",
          body: JSON.stringify({ groupId, name: v.name, goalTarget: v.goalTarget }),
        });
      }
      await reload();
    },
    deleteCategory: async (id) => {
      await jsonReq(`/api/categories?id=${id}`, { method: "DELETE" });
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
        <div className="y-notice y-notice--danger" style={{ maxWidth: 480 }}>
          <span className="mt-[1px]">!</span>
          <div>
            <div className="font-bold mb-[2px]">Error</div>
            <div>{error}</div>
          </div>
        </div>
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
              borderTopColor: "var(--y-blue)",
            }}
          />
          <span className="y-hint">Loading budget…</span>
        </div>
      </div>
    );
  }

  return <BudgetApp data={data} api={api} />;
}
