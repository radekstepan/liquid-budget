"use client";

import { useCallback, useMemo, useState } from "react";
import type { BudgetData } from "@ynab/logic";
import { computeBudget, num, parseMonthKey, monthKey, todayISO } from "@ynab/logic";
import { Sidebar, type View } from "./Sidebar.js";
import { Inspector } from "./Inspector.js";
import { BudgetView } from "./BudgetView.js";
import { TransactionsView } from "./TransactionsView.js";
import { RecurringView } from "./RecurringView.js";
import { ReportsView } from "./ReportsView.js";
import { CalendarView } from "./CalendarView.js";
import { ProjectionsView } from "./ProjectionsView.js";
import {
  TransactionModal,
  CategoryModal,
  GroupModal,
  RecurringModal,
  AccountModal,
} from "./Modals.js";

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

export type BudgetAppApi = {
  reload: () => Promise<void>;
  assign: (categoryId: number, amount: number, month: string) => Promise<void>;
  addTransaction: (t: {
    accountId: number;
    categoryId: number | null;
    date: string;
    payee: string;
    memo: string;
    amount: number;
  }) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  addRecurring: (v: unknown) => Promise<void>;
  deleteRecurring: (id: number) => Promise<void>;
  postRecurring: (id: number) => Promise<void>;
  saveCategory: (
    groupId: number | null,
    categoryId: number | null,
    v: { name: string; goalTarget: number | null }
  ) => Promise<void>;
  deleteCategory: (id: number) => Promise<void>;
  saveGroup: (groupId: number | null, name: string) => Promise<void>;
  addAccount: (v: unknown) => Promise<void>;
};

export function BudgetApp({
  data,
  api,
}: {
  data: BudgetData;
  api: BudgetAppApi;
}) {
  const [view, setView] = useState<View>("budget");
  const [month, setMonth] = useState(DEMO_MONTH);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    const cc = data.groups.find((g) => g.isCreditCardPayments);
    return cc ? { [cc.id]: true } : {};
  });
  const [accountFilter, setAccountFilter] = useState<number | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [accent, setAccent] = useState("liquid");

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", next);
      }
      return next;
    });
  }, []);

  const setAccentTheme = useCallback((a: string) => {
    setAccent(a);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-accent", a);
    }
  }, []);

  const { year } = parseMonthKey(month);

  const budget = useMemo(() => computeBudget(data, month), [data, month]);
  const groups = budget.groups;
  const budgetGroups = groups.filter((g) => !g.group.isCreditCardPayments);
  const summary = {
    assigned: budget.totalAssigned,
    // Exclude CC payment group outflow — it's debt repayment, not a budget expense
    outflow: budgetGroups.reduce((s, g) => s + g.outflow, 0),
    available: budgetGroups.reduce((s, g) => s + g.available, 0),
    totalAvailable: groups.reduce((s, g) => s + g.available, 0),
  };


  const { history, avg } = useMemo(() => {
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

  const assign = useCallback(
    async (categoryId: number, amount: number) => {
      await api.assign(categoryId, amount, month);
    },
    [api, month]
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
            onDeleteCategory={api.deleteCategory}
            onEditGroup={(groupId) => setModal({ kind: "editGroup", groupId })}
          />
        )}
        {view === "transactions" && (
          <TransactionsView
            data={data}
            accountFilter={accountFilter}
            setAccountFilter={setAccountFilter}
            onAdd={() => setModal({ kind: "transaction" })}
            onDelete={api.deleteTransaction}
          />
        )}
        {view === "recurring" && (
          <RecurringView
            data={data}
            onAdd={() => setModal({ kind: "recurring" })}
            onDelete={api.deleteRecurring}
            onPost={api.postRecurring}
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
        tbb={budget.tbb}
        overBudgeted={budget.overBudgeted}
        priorSurplus={budget.priorSurplus}
        theme={theme}
        accent={accent}
        onToggleTheme={toggleTheme}
        onSetAccent={setAccentTheme}
      />

      {modal.kind === "transaction" && (
        <TransactionModal
          accounts={data.accounts}
          categories={data.categories}
          defaultAccountId={accountFilter}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (t) => {
            await api.addTransaction(t);
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
            await api.addRecurring(v);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "account" && (
        <AccountModal
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await api.addAccount(v);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "addCategory" && (
        <CategoryModal
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await api.saveCategory(modal.groupId, null, v);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "editCategory" && editingCategory && (
        <CategoryModal
          initial={editingCategory}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await api.saveCategory(null, editingCategory.id, v);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "addGroup" && (
        <GroupModal
          onClose={() => setModal({ kind: "none" })}
          onSave={async (name) => {
            await api.saveGroup(null, name);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "editGroup" && editingGroup && (
        <GroupModal
          initialName={editingGroup.name}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (name) => {
            await api.saveGroup(editingGroup.id, name);
            setModal({ kind: "none" });
          }}
        />
      )}
    </div>
  );
}

export const __demoConstants = { DEMO_MONTH, todayISO };
