"use client";

import { useCallback, useMemo, useState } from "react";
import type { BudgetData } from "@ynab/logic";
import { computeBudget, num, parseMonthKey, monthKey, todayISO, DEMO_MONTH, MONTHS } from "@ynab/logic";
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
import { ReconcileModal } from "./ReconcileModal.js";

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
  | { kind: "editGroup"; groupId: number }
  | { kind: "reconcile"; accountId: number };

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
    status: "u" | "c" | "r";
    transferAccountId?: number | null;
    parentId?: number | null;
    skipBalance?: boolean;
    subTransactions?: {
      categoryId: number | null;
      amount: number;
      memo?: string;
    }[];
  }) => Promise<void>;
  updateTransaction: (
    id: number,
    t: {
      accountId?: number;
      categoryId?: number | null;
      date?: string;
      payee?: string;
      memo?: string;
      amount?: number;
      status?: "u" | "c" | "r";
      subTransactions?: {
        categoryId: number | null;
        amount: number;
        memo?: string;
      }[];
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
    transferAccountId?: number | null;
    subTransactions?: { categoryId: number | null; amount: number; memo?: string }[];
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
      transferAccountId?: number | null;
      subTransactions?: { categoryId: number | null; amount: number; memo?: string }[];
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
  reconcileAccount: (input: {
    accountId: number;
    statementBalance: number;
    adjustmentCategoryId: number | null;
  }) => Promise<void>;
  unreconcileAccount: (accountId: number) => Promise<void>;
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
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    const cc = data.groups.find((g) => g.isCreditCardPayments);
    return cc ? { [cc.id]: true } : {};
  });
  const [accountFilter, setAccountFilter] = useState<number | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });

  const { year } = parseMonthKey(month);

  const budget = useMemo(() => computeBudget(data, month), [data, month]);

  const groups = budget.groups;
  const budgetGroups = groups.filter((g) => !g.group.isCreditCardPayments);
  const summary = {
    assigned: budget.totalAssigned,
    outflow: budgetGroups.reduce((s, g) => s + g.outflow, 0),
    available: budgetGroups.reduce((s, g) => s + g.available, 0),
    totalAvailable: groups.reduce((s, g) => s + g.available, 0),
  };

  const { history, avg } = useMemo(() => {
    const realMonths = new Set(data.assignments.map((a) => a.month));
    const assignedFor = (key: string) =>
      data.assignments
        .filter((a) => a.month === key)
        .reduce((s, a) => s + num(a.amount), 0);
    const { year: y, month0 } = parseMonthKey(month);
    const hist: { key: string; assigned: number; real: boolean }[] = [];
    for (let i = -4; i <= 7; i++) {
      const mm = ((month0 + i) % 12 + 12) % 12;
      const yy = y + Math.floor((month0 + i) / 12);
      const key = monthKey(yy, mm);
      const real = realMonths.has(key);
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

  const openReconcile = useCallback(
    (accountId: number) => setModal({ kind: "reconcile", accountId }),
    []
  );

  const navigateView = useCallback((v: View) => {
    if (v === "transactions") setAccountFilter(null);
    setView(v);
  }, []);

  const cycleStatus = useCallback(
    async (id: number) => {
      const t = data.transactions.find((x) => x.id === id);
      if (!t) return;
      // U ↔ C only via the in-register toggle. R is set exclusively
      // by the reconcile flow and is locked; users un-reconcile via
      // the modal's "undo the last reconciliation" link.
      const next: "u" | "c" = t.status === "c" ? "u" : "c";
      await api.updateTransaction(id, { status: next });
    },
    [api, data.transactions]
  );

  const clearOverdraft = useCallback(
    async (categoryIds: number[]): Promise<void> => {
      await Promise.all(categoryIds.map((id) => api.assign(id, 0, month)));
    },
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

  const { minYear, maxYear } = useMemo(() => {
    const thisYear = Number(todayISO().slice(0, 4));
    const futureCap = thisYear + 5;
    let minY = thisYear;
    let maxY = futureCap;
    const consider = (key: string) => {
      const y = Number(key.slice(0, 4));
      if (Number.isFinite(y)) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    };
    for (const t of data.transactions) consider(t.date);
    for (const a of data.assignments) consider(a.month);
    return { minYear: minY, maxYear: maxY };
  }, [data.transactions, data.assignments]);

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

  // Derive the reconcile state for the currently-open account from
  // the in-memory data — no extra API call needed because the
  // working balance is just account.balance − sum(uncleared.amounts).
  const reconcileState = useMemo(() => {
    if (modal.kind !== "reconcile") return null;
    const acct = data.accounts.find((a) => a.id === modal.accountId);
    if (!acct) return null;
    const txns = data.transactions.filter((t) => t.accountId === acct.id);
    const unclearedTotal = txns
      .filter((t) => t.status === "u")
      .reduce((s, t) => s + num(t.amount), 0);
    const unclearedCount = txns.filter((t) => t.status === "u").length;
    const clearedCount = txns.filter((t) => t.status === "c").length;
    const reconciledCount = txns.filter((t) => t.status === "r").length;
    const workingBalance = round2(num(acct.balance) - unclearedTotal);
    return {
      accountId: acct.id,
      accountName: acct.name,
      workingBalance,
      unclearedTotal: round2(unclearedTotal),
      unclearedCount,
      clearedCount,
      reconciledCount,
      lastReconciledAt: acct.lastReconciledAt ?? null,
      lastReconciledBalance:
        acct.lastReconciledBalance != null ? num(acct.lastReconciledBalance) : null,
    };
  }, [modal, data.accounts, data.transactions]);

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--y-app-bg)" }}>
      <Sidebar
        view={view}
        setView={navigateView}
        accounts={data.accounts}
        selectedAccountId={accountFilter}
        onSelectAccount={(id) => {
          setAccountFilter((cur) => (cur === id ? null : id));
          setView("transactions");
        }}
        onAddAccount={() => setModal({ kind: "account" })}
        onEditAccount={(id) => setModal({ kind: "editAccount", accountId: id })}
      />

      <main className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--y-row)" }}>
        {view === "budget" && (
          <BudgetView
            budget={budget}
            currentMonth={month}
            collapsed={collapsed}
            onToggleGroup={toggleGroup}
            onAssign={assign}
            onShiftMonth={shiftMonth}
            onSetMonth={setMonth}
            minYear={minYear}
            maxYear={maxYear}
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
            onClearOverdraft={clearOverdraft}
          />
        )}
        {view === "transactions" && (
          <TransactionsView
            data={data}
            accountFilter={accountFilter}
            onAdd={() => setModal({ kind: "addTransaction" })}
            onEdit={(id) => setModal({ kind: "editTransaction", transactionId: id })}
            onDelete={api.deleteTransaction}
            onReconcile={openReconcile}
            onCycleStatus={cycleStatus}
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
            onSetMonth={setMonth}
            minYear={minYear}
            maxYear={maxYear}
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
          allTransactions={data.transactions}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (t) => {
            const { id: _ignored, ...rest } = t;
            await api.addTransaction(rest);
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
          allTransactions={data.transactions}
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
          transactionCount={
            data.transactions.filter((t) => t.accountId === editingAccount.id).length
          }
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await api.updateAccount(editingAccount.id, {
              name: v.name,
              kind: v.kind,
              balance: v.balance,
            });
            setModal({ kind: "none" });
          }}
          onDelete={async () => {
            await api.deleteAccount(editingAccount.id);
            setAccountFilter((cur) => (cur === editingAccount.id ? null : cur));
            setView("budget");
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
      {modal.kind === "reconcile" && reconcileState && (
        <ReconcileModal
          state={reconcileState}
          categories={data.categories}
          groups={data.groups}
          onClose={() => setModal({ kind: "none" })}
          onReconcile={async (input) => {
            await api.reconcileAccount(input);
            setModal({ kind: "none" });
          }}
          onUnreconcile={async (accountId) => {
            await api.unreconcileAccount(accountId);
            setModal({ kind: "none" });
          }}
        />
      )}
    </div>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const __demoConstants = { DEMO_MONTH, todayISO };
