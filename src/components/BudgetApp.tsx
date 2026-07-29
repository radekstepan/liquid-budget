"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BudgetData } from "@/lib/types";
import { computeGroups, summarize } from "@/lib/compute";
import { num, parseMonthKey, monthKey, todayISO } from "@/lib/format";
import { Sidebar, type View } from "./Sidebar";
import { Inspector } from "./Inspector";
import { BudgetView } from "./BudgetView";
import { TransactionsView } from "./TransactionsView";
import { RecurringView } from "./RecurringView";
import { ReportsView } from "./ReportsView";
import { CalendarView } from "./CalendarView";
import { ProjectionsView } from "./ProjectionsView";
import {
  TransactionModal,
  CategoryModal,
  GroupModal,
  RecurringModal,
  AccountModal,
} from "./Modals";

const DEMO_MONTH = "2025-07";

type ModalState =
  | { kind: "none" }
  | { kind: "transaction" }
  | { kind: "recurring" }
  | { kind: "account" }
  | { kind: "addCategory"; groupId: number }
  | { kind: "editCategory"; categoryId: number }
  | { kind: "addGroup" }
  | { kind: "editGroup"; groupId: number };

export function BudgetApp() {
  const [data, setData] = useState<BudgetData | null>(null);
  const [view, setView] = useState<View>("budget");
  const [month, setMonth] = useState(DEMO_MONTH);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [accountFilter, setAccountFilter] = useState<number | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [accent, setAccent] = useState("liquid");

  // ---- theme init ----
  useEffect(() => {
    const t = (localStorage.getItem("liquid-theme") as "light" | "dark") || "light";
    const a = localStorage.getItem("liquid-accent") || "liquid";
    setTheme(t);
    setAccent(a);
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.setAttribute("data-accent", a);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("liquid-theme", next);
      return next;
    });
  }, []);

  const setAccentTheme = useCallback((a: string) => {
    setAccent(a);
    document.documentElement.setAttribute("data-accent", a);
    localStorage.setItem("liquid-accent", a);
  }, []);

  // ---- data ----
  const load = useCallback(async () => {
    const res = await fetch("/api/budget");
    const json = (await res.json()) as BudgetData;
    setData(json);
    // default: credit card payments group collapsed
    setCollapsed((c) => {
      if (Object.keys(c).length > 0) return c;
      const cc = json.groups.find((g) => g.isCreditCardPayments);
      return cc ? { [cc.id]: true } : {};
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ---- derived ----
  const { year } = parseMonthKey(month);

  const groups = useMemo(() => (data ? computeGroups(data, month) : []), [data, month]);
  const summary = useMemo(() => summarize(groups), [groups]);

  const { history, avg } = useMemo(() => {
    if (!data) return { history: [], avg: 0 };
    const realMonths = new Set(data.assignments.map((a) => a.month));
    const assignedFor = (key: string) =>
      data.assignments.filter((a) => a.month === key).reduce((s, a) => s + num(a.amount), 0);
    const { year: y, month0 } = parseMonthKey(month);
    const base = assignedFor(month) || summary.assigned || 3991;
    const hist: { key: string; assigned: number; real: boolean }[] = [];
    for (let i = -4; i <= 7; i++) {
      const mm = ((month0 + i) % 12 + 12) % 12;
      const yy = y + Math.floor((month0 + i) / 12);
      const key = monthKey(yy, mm);
      const real = realMonths.has(key);
      const assigned = real
        ? assignedFor(key)
        : Math.round(base * (0.72 + 0.5 * Math.abs(Math.sin(i * 1.7 + 2))));
      hist.push({ key, assigned, real });
    }
    const reals = hist.filter((h) => h.real && h.assigned > 0);
    const average = reals.length ? reals.reduce((s, h) => s + h.assigned, 0) / reals.length : base;
    return { history: hist, avg: average };
  }, [data, month, summary.assigned]);

  // ---- mutations ----
  const assign = useCallback(
    async (categoryId: number, amount: number) => {
      setData((prev) => {
        if (!prev) return prev;
        const existing = prev.assignments.find((a) => a.categoryId === categoryId && a.month === month);
        let assignments;
        if (existing) {
          assignments = prev.assignments.map((a) =>
            a.id === existing.id ? { ...a, amount: amount.toFixed(2) } : a
          );
        } else {
          assignments = [
            ...prev.assignments,
            { id: -Date.now(), categoryId, month, amount: amount.toFixed(2) },
          ];
        }
        return { ...prev, assignments };
      });
      await fetch("/api/assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId, month, amount }),
      });
    },
    [month]
  );

  const addTransaction = useCallback(
    async (t: {
      accountId: number;
      categoryId: number | null;
      date: string;
      payee: string;
      memo: string;
      amount: number;
    }) => {
      await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(t),
      });
      await load();
    },
    [load]
  );

  const deleteTransaction = useCallback(
    async (id: number) => {
      await fetch(`/api/transactions?id=${id}`, { method: "DELETE" });
      await load();
    },
    [load]
  );

  const addRecurring = useCallback(
    async (v: unknown) => {
      await fetch("/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
      await load();
    },
    [load]
  );

  const deleteRecurring = useCallback(
    async (id: number) => {
      await fetch(`/api/recurring?id=${id}`, { method: "DELETE" });
      await load();
    },
    [load]
  );

  const postRecurring = useCallback(
    async (id: number) => {
      if (!data) return;
      const r = data.recurring.find((x) => x.id === id);
      if (!r) return;
      await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: r.accountId,
          categoryId: r.categoryId,
          date: todayISO(),
          payee: r.payee,
          memo: "Recurring",
          amount: num(r.amount),
        }),
      });
      await load();
    },
    [data, load]
  );

  const saveCategory = useCallback(
    async (groupId: number | null, categoryId: number | null, v: { name: string; goalTarget: number | null }) => {
      if (categoryId) {
        await fetch("/api/categories", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: categoryId, name: v.name, goalTarget: v.goalTarget }),
        });
      } else {
        await fetch("/api/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupId, name: v.name, goalTarget: v.goalTarget }),
        });
      }
      await load();
    },
    [load]
  );

  const deleteCategory = useCallback(
    async (id: number) => {
      await fetch(`/api/categories?id=${id}`, { method: "DELETE" });
      await load();
    },
    [load]
  );

  const saveGroup = useCallback(
    async (groupId: number | null, name: string) => {
      if (groupId) {
        await fetch("/api/categories", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: groupId, type: "group", name }),
        });
      } else {
        await fetch("/api/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "group", name }),
        });
      }
      await load();
    },
    [load]
  );

  const addAccount = useCallback(
    async (v: unknown) => {
      await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
      await load();
    },
    [load]
  );

  const toggleGroup = useCallback((id: number) => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  }, []);

  const shiftMonth = useCallback(
    (delta: number) => {
      const { year: y, month0 } = parseMonthKey(month);
      const total = y * 12 + month0 + delta;
      setMonth(monthKey(Math.floor(total / 12), ((total % 12) + 12) % 12));
    },
    [month]
  );

  if (!data) {
    return (
      <div className="grid h-screen place-items-center" style={{ background: "var(--app)" }}>
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--accent)]" />
          <span className="text-[14px]" style={{ color: "var(--muted)" }}>Loading budget…</span>
        </div>
      </div>
    );
  }

  const editingCategory =
    modal.kind === "editCategory" ? data.categories.find((c) => c.id === modal.categoryId) : undefined;
  const editingGroup =
    modal.kind === "editGroup" ? data.groups.find((g) => g.id === modal.groupId) : undefined;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--app)" }}>
      <Sidebar
        view={view}
        setView={setView}
        accounts={data.accounts}
        onSelectAccount={(id) => {
          setAccountFilter(id);
          setView("transactions");
        }}
        onAddAccount={() => setModal({ kind: "account" })}
      />

      <main className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--panel)" }}>
        {view === "budget" && (
          <BudgetView
            groups={groups}
            month={month}
            year={year}
            accounts={data.accounts}
            collapsed={collapsed}
            onToggleGroup={toggleGroup}
            onAssign={assign}
            onSelectMonth={setMonth}
            onAddCategory={(groupId) => setModal({ kind: "addCategory", groupId })}
            onAddGroup={() => setModal({ kind: "addGroup" })}
            onEditCategory={(categoryId) => setModal({ kind: "editCategory", categoryId })}
            onDeleteCategory={deleteCategory}
            onEditGroup={(groupId) => setModal({ kind: "editGroup", groupId })}
          />
        )}
        {view === "transactions" && (
          <TransactionsView
            data={data}
            accountFilter={accountFilter}
            setAccountFilter={setAccountFilter}
            onAdd={() => setModal({ kind: "transaction" })}
            onDelete={deleteTransaction}
          />
        )}
        {view === "recurring" && (
          <RecurringView
            data={data}
            onAdd={() => setModal({ kind: "recurring" })}
            onDelete={deleteRecurring}
            onPost={postRecurring}
          />
        )}
        {view === "reports" && <ReportsView data={data} month={month} />}
        {view === "calendar" && (
          <CalendarView data={data} month={month} onPrev={() => shiftMonth(-1)} onNext={() => shiftMonth(1)} />
        )}
        {view === "projections" && <ProjectionsView data={data} month={month} />}
      </main>

      <Inspector
        groups={groups}
        summary={summary}
        month={month}
        history={history}
        avg={avg}
        theme={theme}
        accent={accent}
        onToggleTheme={toggleTheme}
        onSetAccent={setAccentTheme}
      />

      {/* Modals */}
      {modal.kind === "transaction" && (
        <TransactionModal
          accounts={data.accounts}
          categories={data.categories}
          defaultAccountId={accountFilter}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (t) => {
            await addTransaction(t);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "recurring" && (
        <RecurringModal
          accounts={data.accounts}
          categories={data.categories}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await addRecurring(v);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "account" && (
        <AccountModal
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await addAccount(v);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "addCategory" && (
        <CategoryModal
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await saveCategory(modal.groupId, null, v);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "editCategory" && editingCategory && (
        <CategoryModal
          initial={editingCategory}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await saveCategory(null, editingCategory.id, v);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "addGroup" && (
        <GroupModal
          onClose={() => setModal({ kind: "none" })}
          onSave={async (name) => {
            await saveGroup(null, name);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "editGroup" && editingGroup && (
        <GroupModal
          initialName={editingGroup.name}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (name) => {
            await saveGroup(editingGroup.id, name);
            setModal({ kind: "none" });
          }}
        />
      )}
    </div>
  );
}
