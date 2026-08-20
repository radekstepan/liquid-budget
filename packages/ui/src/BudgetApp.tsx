"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import type { BudgetData, DuplicateAnalysisResult, ImportSummary } from "@ynab/logic";
import {
  computeBudget,
  computeCashFlow,
  computeTrailingNetWorth,
  computeMonthlyInsights,
  num,
  parseMonthKey,
  monthKey,
  previousMonthKey,
  round2,
  todayISO,
  countDueRecurring,
  DEMO_MONTH,
  type TransactionFlagColor,
} from "@ynab/logic";
import { Sidebar, type View } from "./Sidebar.js";
import { Inspector } from "./Inspector.js";
import { BudgetView } from "./BudgetView.js";
import { TransactionsView } from "./TransactionsView.js";
import { RecurringView } from "./RecurringView.js";
import { ReportsView } from "./ReportsView.js";
import { CalendarView } from "./CalendarView.js";
import { ProjectionsView } from "./ProjectionsView.js";
import { SettingsView } from "./SettingsView.js";
import {
  TransactionModal,
  CategoryModal,
  GroupModal,
  RecurringModal,
  AccountModal,
} from "./Modals.js";
import { CsvImportModal } from "./CsvImportModal.js";
import { ReconcileModal } from "./ReconcileModal.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

type ModalState =
  | { kind: "none" }
  | { kind: "addTransaction"; defaultDate?: string; mode?: "single" | "transfer" }
  | { kind: "editTransaction"; transactionId: number }
  | { kind: "recurring"; mode?: "single" | "transfer" }
  | { kind: "editRecurring"; recurringId: number }
  | { kind: "account" }
  | { kind: "editAccount"; accountId: number }
  | { kind: "addCategory"; groupId: number }
  | { kind: "editCategory"; categoryId: number }
  | { kind: "addGroup" }
  | { kind: "editGroup"; groupId: number }
  | { kind: "reconcile"; accountId: number }
  | { kind: "csvImport"; file: File };

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
    subTransactions?: {
      categoryId: number | null;
      amount: number;
      memo?: string;
      transferAccountId?: number | null;
    }[];
    transferAccountId?: number | null;
    parentId?: number | null;
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
      flagColor?: TransactionFlagColor | null;
      subTransactions?: {
        id?: number;
        categoryId: number | null;
        amount: number;
        memo?: string;
        transferAccountId?: number | null;
      }[];
    }
  ) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  bulkDeleteTransactions: (ids: number[]) => Promise<void>;
  bulkUpdateTransactions: (
    ids: number[],
    patch: { status?: "u" | "c" | "r"; categoryId?: number | null }
  ) => Promise<void>;
  addRecurring: (v: {
    accountId: number;
    categoryId: number | null;
    payee: string;
    amount: number;
    frequency: string;
    nextDate: string;
    transferAccountId?: number | null;
    subTransactions?: {
      categoryId: number | null;
      amount: number;
      memo?: string;
      transferAccountId?: number | null;
    }[];
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
      subTransactions?: {
        id?: number;
        categoryId: number | null;
        amount: number;
        memo?: string;
        transferAccountId?: number | null;
      }[];
    }
  ) => Promise<void>;
  deleteRecurring: (id: number) => Promise<void>;
  postRecurring: (id: number, date?: string) => Promise<void>;
  saveCategory: (
    groupId: number | null,
    categoryId: number | null,
    v: {
      name: string;
      goalTarget: number | null;
      carryover?: number | null;
      overspendCarriesOver?: boolean;
    }
  ) => Promise<void>;
  deleteCategory: (
    id: number,
    opts?: { moveToCategoryId?: number | null }
  ) => Promise<void>;
  reorderCategory: (id: number, sort: number) => Promise<void>;
  reorderGroup: (id: number, sort: number) => Promise<void>;
  saveGroup: (groupId: number | null, name: string) => Promise<void>;
  deleteGroup: (id: number) => Promise<void>;
  addAccount: (v: {
    name: string;
    kind: "liquid" | "credit" | "offbudget";
    groupLabel: string;
    startingBalance?: number;
  }) => Promise<void>;
  deleteAccount: (id: number) => Promise<void>;
  updateAccount: (
    id: number,
    patch: {
      name?: string;
      kind?: "liquid" | "credit" | "offbudget";
      archived?: boolean;
    }
  ) => Promise<void>;
  reorderAccount: (id: number, sort: number) => Promise<void>;
  reconcileAccount: (input: {
    accountId: number;
    statementBalance: number;
    adjustmentCategoryId: number | null;
  }) => Promise<void>;
  unreconcileAccount: (accountId: number) => Promise<void>;
  importYnab4?: (file: File) => Promise<ImportSummary | void>;
  importCsv?: (input: { accountId: number; swap: boolean; csv: string }) => Promise<number>;
  analyzeDuplicates?: () => Promise<DuplicateAnalysisResult | void>;
  addRenameRule?: (sourcePattern: string, targetPayee: string) => Promise<void>;
  updateRenameRule?: (id: number, sourcePattern: string, targetPayee: string) => Promise<void>;
  deleteRenameRule?: (id: number) => Promise<void>;
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
  const [monthCount, setMonthCount] = useState<number>(3);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    const cc = data.groups.find((g) => g.isCreditCardPayments);
    if (cc) init[cc.id] = true;
    const hidden = data.groups.find(
      (g) => g.name === "Hidden Categories" || g.name.toLowerCase() === "hidden categories"
    );
    if (hidden) init[hidden.id] = true;
    return init;
  });
  const [accountFilter, setAccountFilter] = useState<number | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [isPending, startTransition] = useTransition();

  const isBudgetView = view === "budget";
  const { year } = parseMonthKey(month);

  const budget = useMemo(() => computeBudget(data, month), [data, month]);

  const visibleMonths = useMemo(() => {
    if (!isBudgetView) return [month];
    const { year: y, month0 } = parseMonthKey(month);
    const anchorTotal = y * 12 + month0;
    const offset = Math.floor((monthCount - 1) / 2);
    const start = anchorTotal - offset;
    const keys: string[] = [];
    for (let i = 0; i < monthCount; i++) {
      const t = start + i;
      const yy = Math.floor(t / 12);
      const mm = ((t % 12) + 12) % 12;
      keys.push(monthKey(yy, mm));
    }
    return keys;
  }, [month, monthCount, isBudgetView]);

  const budgets = useMemo(
    () => (isBudgetView ? visibleMonths.map((m) => computeBudget(data, m)) : [budget]),
    [data, visibleMonths, isBudgetView, budget]
  );

  const groups = budget.groups;
  const budgetGroups = groups.filter((g) => !g.group.isCreditCardPayments);
  const summary = {
    assigned: budget.totalAssigned,
    outflow: budgetGroups.reduce((s, g) => s + g.outflow, 0),
    available: budgetGroups.reduce((s, g) => s + g.available, 0),
    totalAvailable: groups.reduce((s, g) => s + g.available, 0),
  };

  // Quick-fill: last month's budgeted per category (only computed for budget view)
  const lastMonthAssignments = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const prevMonth = previousMonthKey(month);
    const map = new Map<number, number>();
    for (const a of data.assignments) {
      if (a.month === prevMonth) {
        map.set(a.categoryId, num(a.amount));
      }
    }
    return map;
  }, [data, month, isBudgetView]);

  // Quick-fill: spent last month (outflows in M-1) per category (only computed for budget view)
  const spentLastMonthByCategory = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const prevMonth = previousMonthKey(month);
    const map = new Map<number, number>();
    const parentSet = new Set<number>();
    for (const t of data.transactions) {
      if (t.parentId != null) parentSet.add(t.parentId);
    }
    for (const t of data.transactions) {
      if (t.date.slice(0, 7) !== prevMonth) continue;
      if (t.categoryId == null) continue;
      if (parentSet.has(t.id)) continue;
      const amt = num(t.amount);
      if (amt < 0) {
        map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + -amt);
      }
    }
    return map;
  }, [data, month, isBudgetView]);

  // Quick-fill: average spent (outflow) over last 3 months per category (only computed for budget view)
  const avgSpentByCategory = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const { year: y, month0 } = parseMonthKey(month);
    const map = new Map<number, { sum: number; count: number }>();
    const parentSet = new Set<number>();
    for (const t of data.transactions) {
      if (t.parentId != null) parentSet.add(t.parentId);
    }
    for (let i = 1; i <= 3; i++) {
      const mm = ((month0 - i) % 12 + 12) % 12;
      const yy = y + Math.floor((month0 - i) / 12);
      const key = monthKey(yy, mm);
      for (const t of data.transactions) {
        if (t.date.slice(0, 7) !== key) continue;
        if (t.categoryId == null) continue;
        // Skip split parents so we do not double-count, but include split children!
        if (parentSet.has(t.id)) continue;
        const amt = num(t.amount);
        if (amt >= 0) continue; // only outflows
        const entry = map.get(t.categoryId) ?? { sum: 0, count: 0 };
        entry.sum += -amt; // make positive
        entry.count++;
        map.set(t.categoryId, entry);
      }
    }
    const result = new Map<number, number>();
    for (const [catId, { sum, count }] of map) {
      result.set(catId, Math.round(sum / count));
    }
    return result;
  }, [data, month, isBudgetView]);

  // Quick-fill: average budgeted over last 3 months per category (only computed for budget view)
  const avgBudgetedByCategory = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const { year: y, month0 } = parseMonthKey(month);
    const map = new Map<number, { sum: number; count: number }>();
    for (let i = 1; i <= 3; i++) {
      const mm = ((month0 - i) % 12 + 12) % 12;
      const yy = y + Math.floor((month0 - i) / 12);
      const key = monthKey(yy, mm);
      for (const a of data.assignments) {
        if (a.month !== key) continue;
        const amt = num(a.amount);
        const entry = map.get(a.categoryId) ?? { sum: 0, count: 0 };
        entry.sum += amt;
        entry.count++;
        map.set(a.categoryId, entry);
      }
    }
    const result = new Map<number, number>();
    for (const [catId, { sum, count }] of map) {
      if (count > 0) result.set(catId, Math.round(sum / count));
    }
    return result;
  }, [data, month, isBudgetView]);

  // Quick-fill: underfunded = max(0, goalTarget - available)
  const underfundedByCategory = useMemo(() => {
    if (!isBudgetView) return new Map<number, number>();
    const map = new Map<number, number>();
    for (const g of budget.groups) {
      for (const r of g.rows) {
        if (r.category.goalTarget) {
          const goal = num(r.category.goalTarget);
          const underfunded = Math.max(0, goal - r.available);
          if (underfunded > 0) map.set(r.category.id, underfunded);
        }
      }
    }
    return map;
  }, [budget, isBudgetView]);

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

  const cashFlow = useMemo(() => computeCashFlow(data, month), [data, month]);
  const trailingNetWorth = useMemo(
    () => computeTrailingNetWorth(data, month, 12),
    [data, month]
  );
  const insights = useMemo(
    () => computeMonthlyInsights(data, month, budget),
    [data, month, budget]
  );

  const assign = useCallback(
    async (categoryId: number, amount: number, m?: string) => {
      await api.assign(categoryId, amount, m ?? month);
    },
    [api, month]
  );

  const openReconcile = useCallback(
    (accountId: number) => setModal({ kind: "reconcile", accountId }),
    []
  );

  const navigateView = useCallback((v: View) => {
    startTransition(() => {
      setAccountFilter(null);
      setView(v);
    });
  }, []);

  const handleSelectAccount = useCallback((id: number) => {
    startTransition(() => {
      setAccountFilter(id);
      setView("transactions");
    });
  }, []);

  const cycleStatus = useCallback(
    async (id: number) => {
      const t = data.transactions.find((x) => x.id === id);
      if (!t) return;
      const next: "u" | "c" = t.status === "c" ? "u" : "c";
      await api.updateTransaction(id, { status: next });
    },
    [api, data.transactions]
  );

  const setFlag = useCallback(
    async (id: number, flagColor: TransactionFlagColor | null) => {
      await api.updateTransaction(id, { flagColor });
    },
    [api]
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
    const consider = (dateStr: string | undefined | null) => {
      if (!dateStr || dateStr.length < 4) return;
      const y = parseInt(dateStr.slice(0, 4), 10);
      if (Number.isFinite(y)) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    };
    for (let i = 0; i < data.transactions.length; i++) consider(data.transactions[i]!.date);
    for (let i = 0; i < data.assignments.length; i++) consider(data.assignments[i]!.month);
    for (let i = 0; i < data.recurring.length; i++) consider(data.recurring[i]!.nextDate);
    return { minYear: minY, maxYear: maxY };
  }, [data.transactions, data.assignments, data.recurring]);

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
    const workingBalance = num(acct.balance) - unclearedTotal;
    return {
      accountId: acct.id,
      accountName: acct.name,
      workingBalance,
      unclearedTotal,
      unclearedCount,
      clearedCount,
      reconciledCount,
      lastReconciledAt: acct.lastReconciledAt ?? null,
      lastReconciledBalance:
        acct.lastReconciledBalance != null ? num(acct.lastReconciledBalance) : null,
    };
  }, [modal, data.accounts, data.transactions]);

  const dueBadgeCount = useMemo(() => {
    return countDueRecurring(data.recurring, todayISO());
  }, [data.recurring]);

  const dueByAccount = useMemo(() => {
    const today = todayISO();
    const map: Record<number, number> = {};
    for (const r of data.recurring) {
      if (r.active && r.nextDate <= today) {
        map[r.accountId] = (map[r.accountId] ?? 0) + 1;
        if (r.transferAccountId != null) {
          map[r.transferAccountId] = (map[r.transferAccountId] ?? 0) + 1;
        }
        for (const c of r.subTransactions ?? []) {
          if (c.transferAccountId != null) {
            map[c.transferAccountId] = (map[c.transferAccountId] ?? 0) + 1;
          }
        }
      }
    }
    return map;
  }, [data.recurring]);

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "transparent" }}>
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
        onReorderAccount={api.reorderAccount}
        dueBadgeCount={dueBadgeCount}
        dueByAccount={dueByAccount}
      />

      <main className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--y-row)" }}>
        <ErrorBoundary name={`${view.charAt(0).toUpperCase() + view.slice(1)} View`}>
          {view === "budget" && (
            <BudgetView
              budget={budget}
              budgets={budgets}
              visibleMonths={visibleMonths}
              monthCount={monthCount}
              onSetMonthCount={setMonthCount}
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
              lastMonthAssignments={lastMonthAssignments}
              spentLastMonthByCategory={spentLastMonthByCategory}
              avgSpentByCategory={avgSpentByCategory}
              avgBudgetedByCategory={avgBudgetedByCategory}
              underfundedByCategory={underfundedByCategory}
            />
          )}
          {view === "transactions" && (
            <TransactionsView
              data={data}
              accountFilter={accountFilter}
              onAdd={() => setModal({ kind: "addTransaction", mode: "single" })}
              onAddTransfer={() => setModal({ kind: "addTransaction", mode: "transfer" })}
              onEdit={(id) => setModal({ kind: "editTransaction", transactionId: id })}
              onDelete={api.deleteTransaction}
              onReconcile={openReconcile}
              onCycleStatus={cycleStatus}
              onFlag={setFlag}
              onBulkDelete={api.bulkDeleteTransactions}
              onBulkUpdate={api.bulkUpdateTransactions}
              onAddRecurring={() => setModal({ kind: "recurring", mode: "single" })}
              onAddRecurringTransfer={() => setModal({ kind: "recurring", mode: "transfer" })}
              onEditRecurring={(id) => setModal({ kind: "editRecurring", recurringId: id })}
              onDeleteRecurring={api.deleteRecurring}
              onPostRecurring={api.postRecurring}
            />
          )}
          {view === "reports" && (
            <ReportsView
              data={data}
              month={month}
              minYear={minYear}
              maxYear={maxYear}
            />
          )}
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
          {view === "settings" && (
            <SettingsView
              rules={data.renameRules ?? []}
              onAdd={async (sourcePattern, targetPayee) => {
                await api.addRenameRule?.(sourcePattern, targetPayee);
              }}
              onUpdate={async (id, sourcePattern, targetPayee) => {
                await api.updateRenameRule?.(id, sourcePattern, targetPayee);
              }}
              onDelete={async (id) => {
                await api.deleteRenameRule?.(id);
              }}
            />
          )}
        </ErrorBoundary>
      </main>

      <ErrorBoundary name="Inspector">
        <Inspector
          groups={groups}
          summary={summary}
          month={month}
          history={history}
          avg={avg}
          tbb={budget.tbb}
          overBudgeted={budget.overBudgeted}
          priorSurplus={budget.priorSurplus}
          cashFlow={cashFlow}
          trailingNetWorth={trailingNetWorth}
          insights={insights}
          onSelectMonth={setMonth}
          onImportYnab4={api.importYnab4}
          onImportCsv={(file) => setModal({ kind: "csvImport", file })}
          onAnalyzeDuplicates={api.analyzeDuplicates}
          onClearOverdraft={clearOverdraft}
          onOpenRenameRules={() => navigateView("settings")}
        />
      </ErrorBoundary>

      {modal.kind === "addTransaction" && (
        <TransactionModal
          accounts={data.accounts}
          categories={data.categories}
          defaultAccountId={accountFilter}
          defaultDate={modal.defaultDate}
          initialMode={modal.mode}
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
          onDelete={async () => {
            await api.deleteTransaction(editingTransaction.id);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "recurring" && (
        <RecurringModal
          accounts={data.accounts}
          categories={data.categories}
          defaultAccountId={accountFilter}
          initialMode={modal.mode}
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
            });
            setModal({ kind: "none" });
          }}
          onArchive={async () => {
            await api.updateAccount(editingAccount.id, { archived: true });
            setModal({ kind: "none" });
          }}
          onUnarchive={async () => {
            await api.updateAccount(editingAccount.id, { archived: false });
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
          transactionCount={
            data.transactions.filter((t) => t.categoryId === editingCategory.id).length
          }
          otherCategories={data.categories.filter((c) => c.id !== editingCategory.id)}
          onClose={() => setModal({ kind: "none" })}
          onSave={async (v) => {
            await api.saveCategory(null, editingCategory.id, v);
            setModal({ kind: "none" });
          }}
          onDelete={async (opts) => {
            await api.deleteCategory(editingCategory.id, opts);
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
      {modal.kind === "csvImport" && (
        <CsvImportModal
          accounts={data.accounts}
          transactions={data.transactions}
          renameRules={data.renameRules ?? []}
          defaultAccountId={accountFilter}
          file={modal.file}
          onClose={() => setModal({ kind: "none" })}
          onImport={async (input) => {
            await api.importCsv?.(input);
            setModal({ kind: "none" });
          }}
        />
      )}
      {modal.kind === "reconcile" && reconcileState && (
        <ReconcileModal
          state={reconcileState}
          categories={data.categories}
          groups={data.groups.filter(
            (g) => g.name !== "__Internal__" && g.name.toLowerCase() !== "__internal__"
          )}
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

export const __demoConstants = { DEMO_MONTH, todayISO };
