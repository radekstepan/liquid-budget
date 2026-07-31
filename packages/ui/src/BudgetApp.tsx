"use client";

import { useCallback, useMemo, useState } from "react";
import type { BudgetData } from "@ynab/logic";
import { computeBudget, num, parseMonthKey, monthKey, todayISO, DEMO_MONTH } from "@ynab/logic";
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

type ModalState =
  | { kind: "none" }
  | { kind: "addTransaction"; defaultDate?: string }
  | { kind: "editTransaction"; transactionId: number }
  | { kind: "recurring" }
  | { kind: "editRecurring"; recurringId: number }
  | { kind: "account" }
  | { kind: "editAccount"; accountId: number }
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
    cleared: boolean;
  }) => Promise<void>;
  updateTransaction: (
    id: number,
    t: {
      accountId: number;
      categoryId: number | null;
      date: string;
      payee: string;
      memo: string;
      amount: number;
      cleared: boolean;
    }
  ) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  addRecurring: (v: {
    accountId: number;
    categoryId: number | null;
    payee: string;
    amount: number;
    frequency: string;
    nextDate: string;
  }) => Promise<void>;
  updateRecurring: (
    id: number,
    v: {
      accountId?: number;
      categoryId?: number | null;
      payee?: string;
      amount?: number;
      frequency?: string;
      nextDate?: string;
      active?: boolean;
    }
  ) => Promise<void>;
  deleteRecurring: (id: number) => Promise<void>;
  postRecurring: (id: number) => Promise<void>;
  saveCategory: (
    groupId: number | null,
    categoryId: number | null,
    v: { name: string; goalTarget: number | null; carryover?: number }
  ) => Promise<void>;
  deleteCategory: (id: number) => Promise<void>;
  reorderCategory: (id: number, sort: number) => Promise<void>;
  reorderGroup: (id: number, sort: number) => Promise<void>;
  saveGroup: (groupId: number | null, name: string) => Promise<void>;
  deleteGroup: (groupId: number) => Promise<void>;
  addAccount: (v: {
    name: string;
    kind: "liquid" | "credit" | "offbudget";
    groupLabel: string;
    balance: number;
    onBudget: boolean;
  }) => Promise<void>;
  deleteAccount: (id: number) => Promise<void>;
  updateAccount: (
    id: number,
    patch: { name?: string; kind?: "liquid" | "credit" | "offbudget"; balance?: number }
  ) => Promise<void>;
  resetDemo: () => Promise<void>;
  importYnab4?: (file: File) => Promise<void>;
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
  // Lazy initializer — runs once on mount, not on every render, so reading
  // data.groups here is cheap. A useMemo would re-derive on every data
  // reload and clobber the user's manual collapse/expand choices.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    const cc = data.groups.find((g) => g.isCreditCardPayments);
    return cc ? { [cc.id]: true } : {};
  });
  const [accountFilter, setAccountFilter] = useState<number | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "light";
    const stored = document.documentElement.getAttribute("data-theme");
    return stored === "dark" ? "dark" : "light";
  });
  const [accent, setAccent] = useState<string>(() => {
    if (typeof document === "undefined") return "liquid";
    return document.documentElement.getAttribute("data-accent") ?? "liquid";
  });

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem("liquid-theme", next);
        } catch {
          // ignore quota / privacy errors
        }
      }
      return next;
    });
  }, []);

  const setAccentTheme = useCallback((a: string) => {
    setAccent(a);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-accent", a);
      try {
        localStorage.setItem("liquid-accent", a);
      } catch {
        // ignore quota / privacy errors
      }
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
    const hist: { key: string; assigned: number; real: boolean }[] = [];
    for (let i = -4; i <= 7; i++) {
      const mm = ((month0 + i) % 12 + 12) % 12;
      const yy = y + Math.floor((month0 + i) / 12);
      const key = monthKey(yy, mm);
      const real = realMonths.has(key);
      // Only use real data. Months without assignments render as 0 so the bar
      // chart shows an honest empty slot rather than a fabricated value.
      const assigned = real ? assignedFor(key) : 0;
      hist.push({ key, assigned, real });
    }
    const reals = hist.filter((h) => h.real && h.assigned > 0);
    const currentAssigned = assignedFor(month) || summary.assigned;
    const average = reals.length
      ? reals.reduce((s, h) => s + h.assigned, 0) / reals.length
      : currentAssigned;
    return { history: hist, avg: average };
  }, [data, month, summary.assigned]);

  const assign = useCallback(
    async (categoryId: number, amount: number) => {
      await api.assign(categoryId, amount, month);
    },
    [api, month]
  );

  const clearOverdraft = useCallback(
    (categoryIds: number[]) =>
      Promise.all(categoryIds.map((id) => api.assign(id, 0, month))),
    [api, month]
  );

  const toggleGroup = useCallback((id: number) => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(Object.fromEntries(data.groups.map((g) => [g.id, true])));
  }, [data.groups]);

  const expandAll = useCallback(() => setCollapsed({}), []);

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
  const editingTransaction =
    modal.kind === "editTransaction"
      ? data.transactions.find((t) => t.id === modal.transactionId)
      : undefined;
  const editingRecurring =
    modal.kind === "editRecurring"
      ? data.recurring.find((r) => r.id === modal.recurringId)
      : undefined;
  const editingAccount =
    modal.kind === "editAccount" ? data.accounts.find((a) => a.id === modal.accountId) : undefined;

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
        onEditAccount={(id) => setModal({ kind: "editAccount", accountId: id })}
        onDeleteAccount={api.deleteAccount}
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
            onDeleteGroup={api.deleteGroup}
            onCollapseAll={collapseAll}
            onExpandAll={expandAll}
            onReorderCategory={api.reorderCategory}
            onReorderGroup={api.reorderGroup}
          />
        )}
        {view === "transactions" && (
          <TransactionsView
            data={data}
            accountFilter={accountFilter}
            setAccountFilter={setAccountFilter}
            onAdd={() => setModal({ kind: "addTransaction" })}
            onEdit={(id) => setModal({ kind: "editTransaction", transactionId: id })}
            onDelete={api.deleteTransaction}
          />
        )}
        {view === "recurring" && (
          <RecurringView
            data={data}
            onAdd={() => setModal({ kind: "recurring" })}
            onEdit={(id) => setModal({ kind: "editRecurring", recurringId: id })}
            onDelete={api.deleteRecurring}
            onPost={api.postRecurring}
            onToggleActive={(id, active) => api.updateRecurring(id, { active })}
          />
        )}
        {view === "reports" && <ReportsView data={data} month={month} onPrev={() => shiftMonth(-1)} onNext={() => shiftMonth(1)} />}
        {view === "calendar" && (
          <CalendarView
            data={data}
            month={month}
            onPrev={() => shiftMonth(-1)}
            onNext={() => shiftMonth(1)}
            onAdd={(date) => setModal({ kind: "addTransaction", defaultDate: date })}
          />
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
        onSelectMonth={setMonth}
        onResetDemo={api.resetDemo}
        onImportYnab4={api.importYnab4}
        onClearOverdraft={clearOverdraft}
      />

      {modal.kind === "addTransaction" && (
        <TransactionModal
          accounts={data.accounts}
          categories={data.categories}
          defaultAccountId={accountFilter}
          defaultDate={modal.defaultDate}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (t) => {
            await api.addTransaction(t);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "editTransaction" && editingTransaction && (
        <TransactionModal
          accounts={data.accounts}
          categories={data.categories}
          defaultAccountId={accountFilter}
          initial={editingTransaction}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (t) => {
            const { id, ...rest } = t;
            if (id) await api.updateTransaction(id, rest);
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
      {modal.kind === "editRecurring" && editingRecurring && (
        <RecurringModal
          accounts={data.accounts}
          categories={data.categories}
          initial={editingRecurring}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            const { id, ...rest } = v;
            if (id) await api.updateRecurring(id, rest);
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
      {modal.kind === "editAccount" && editingAccount && (
        <AccountModal
          initial={editingAccount}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await api.updateAccount(editingAccount.id, {
              name: v.name,
              kind: v.kind,
              balance: v.balance,
            });
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
