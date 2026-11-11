"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
// Display locale is fixed en-US/$ by decision (docs/locale-decision.md) — no locale plumbing.
import type { BudgetData, Query } from "@ynab/logic";
import {
  buildPageTitle,
  computeBudget,
  computeCashFlow,
  computeTrailingNetWorth,
  computeMonthlyInsights,
  num,
  parseMonthKey,
  monthKey,
  resolveSplitTemplatePresets,
  SPLIT_TEMPLATE_PRESETS,
  todayISO,
  countDuplicatesByAccount,
  countNewByAccount,
  DEMO_MONTH,
} from "@ynab/logic";
import { useLocalStorage } from "./useLocalStorage.js";
import { useTodayISO } from "./useTodayISO.js";
import { Sidebar, type View } from "./Sidebar.js";
import { usePrivacyBudget } from "./usePrivacyBudget.js";
import { useBudgetMonthNav } from "./useBudgetMonthNav.js";
import { useBudgetMutations } from "./useBudgetMutations.js";
import { useBudgetViewRouting } from "./useBudgetViewRouting.js";
import { useQuickBudget } from "./useQuickBudget.js";
import { useRenameSuggestStatus, useSnapshots } from "./useSettingsData.js";
import type { SearchListOption, ThemeId } from "@ynab/theme";
import {
  Icon,
  Tooltip,
  Notice,
  THEME_STORAGE_KEY,
  DEFAULT_THEME_ID,
  isThemeId,
  applyThemeId,
} from "@ynab/theme";
import { GlobalSearchModal } from "./GlobalSearchModal.js";
import { Inspector } from "./Inspector.js";
import { BudgetView } from "./BudgetView.js";
import { TransactionsView } from "./TransactionsView.js";
import { ReportsView } from "./ReportsView.js";
import { SettingsView } from "./SettingsView.js";
import { MenuSettingsView } from "./MenuSettingsView.js";
import { ThemesView } from "./ThemesView.js";
import { PayeesView } from "./PayeesView.js";
import { SnapshotsView } from "./SnapshotsView.js";
import {
  DEFAULT_NAV_VISIBILITY,
  NAV_VISIBILITY_STORAGE_KEY,
  firstAvailableView,
  isNavVisibility,
  visibleViewCount,
} from "./navVisibility.js";
import {
  TransactionModal,
  BulkEditTransactionsModal,
  CategoryModal,
  GroupModal,
  RecurringModal,
  AccountModal,
} from "./Modals.js";
import { CsvImportModal } from "./CsvImportModal.js";
import { ReconcileModal } from "./ReconcileModal.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

export type ModalState =
  | { kind: "none" }
  | { kind: "addTransaction"; defaultDate?: string; mode?: "single" | "transfer" }
  | { kind: "editTransaction"; transactionId: number }
  | { kind: "bulkEditTransactions"; transactionIds: number[] }
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

export type { BudgetAppApi } from "./BudgetAppApi.js";
import type { BudgetAppApi } from "./BudgetAppApi.js";
export type { QuickBudgetType } from "./useQuickBudget.js";

export const ACCOUNT_FILTER_STORAGE_KEY = "ynab:transactions:accountFilter";

export function isStoredAccountFilter(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v > 0);
}

/**
 * Drop a persisted/URL account id that no longer matches a live account
 * (e.g. the account was deleted or archived away) so the register falls
 * back to all accounts instead of an empty dead-end.
 */
export function resolveAccountFilter(
  stored: number | null,
  accounts: { id: number }[]
): number | null {
  if (stored == null) return null;
  return accounts.some((a) => a.id === stored) ? stored : null;
}

export { PRIVACY_STORAGE_KEY, isPrivacySettings, type PrivacySettings } from "./usePrivacyBudget.js";

export function BudgetApp({
  data: rawData,
  api: rawApi,
  initialView = "budget",
  initialMonth,
  initialAccount,
}: {
  data: BudgetData;
  api: BudgetAppApi;
  initialView?: string;
  initialMonth?: string;
  initialAccount?: number;
}) {
  const {
    data,
    api,
    privacy,
    privacyMask,
    privacyNotice,
    setPrivacyNotice,
    enablePrivacy,
    disablePrivacy,
    regeneratePrivacyFactor,
  } = usePrivacyBudget(rawData, rawApi);
  const [view, setView] = useState<View>(
    (["budget", "reports", "transactions"] as View[]).includes(initialView as View)
      ? (initialView as View)
      : "budget"
  );
  const [collapsed, setCollapsed] = useLocalStorage<Record<number, boolean>>(
    "ynab:budget:collapsed",
    () => {
      const init: Record<number, boolean> = {};
      const cc = data.groups.find((g) => g.isCreditCardPayments);
      if (cc) init[cc.id] = true;
      const hidden = data.groups.find(
        (g) => g.name === "Hidden Categories" || g.name.toLowerCase() === "hidden categories"
      );
      if (hidden) init[hidden.id] = true;
      return init;
    },
    (v): v is Record<number, boolean> =>
      typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "boolean")
  );
  const [storedAccountFilter, setStoredAccountFilter] = useLocalStorage<number | null>(
    ACCOUNT_FILTER_STORAGE_KEY,
    initialAccount ?? null,
    isStoredAccountFilter
  );
  // Active filter: the persisted selection, unless it points at an account
  // that no longer exists. Budget/Reports switches leave this alone, but
  // the Transactions nav clears it so the register always opens on All
  // Transactions.
  const accountFilter = useMemo(
    () => resolveAccountFilter(storedAccountFilter, data.accounts),
    [storedAccountFilter, data.accounts]
  );
  const setAccountFilter = setStoredAccountFilter;
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  // Register selection lives here (not in TransactionsView) so it survives
  // view switches — the register unmounts when we leave the view.
  const [selectedTransactionId, setSelectedTransactionId] = useState<number | null>(null);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<number>>(new Set());
  const [selectedRecurringIds, setSelectedRecurringIds] = useState<Set<number>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  // Query the search modal opens with: null for a fresh search, or the
  // register's applied filter when editing it from the toolbar.
  const [searchInitialQuery, setSearchInitialQuery] = useState<Query | null>(null);
  const [showSettingsOverlay, setShowSettingsOverlay] = useState(false);
  const [settingsPage, setSettingsPage] = useState<
    "rename" | "payees" | "menu" | "snapshots" | "themes"
  >("rename");
  const [themeId, setThemeId] = useLocalStorage<ThemeId>(
    THEME_STORAGE_KEY,
    DEFAULT_THEME_ID,
    isThemeId
  );
  const [navVisible, setNavVisible] = useLocalStorage<Record<View, boolean>>(
    NAV_VISIBILITY_STORAGE_KEY,
    DEFAULT_NAV_VISIBILITY,
    isNavVisibility
  );
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [, startTransition] = useTransition();

  const {
    month,
    monthCount,
    updateUrl,
    visibleMonths,
    canShiftRight,
    minYear,
    maxYear,
    shiftMonth,
    handleSetMonth,
    handleSetMonthCount,
  } = useBudgetMonthNav({
    data,
    view,
    setView,
    accountFilter,
    setAccountFilter,
    initialMonth,
  });

  const isBudgetView = view === "budget";

  const budget = useMemo(() => computeBudget(data, month), [data, month]);

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

  // Distinct payee names from transaction/recurring history, offered as
  // search suggestions in the transaction + recurring modals. New payees
  // typed into the field are always allowed (free-text, `allowCreate`).
  const payeeOptions = useMemo<SearchListOption[]>(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    const add = (name: string) => {
      const t = name.trim();
      if (!t || t.startsWith("Transfer : ")) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(t);
    };
    for (const t of data.transactions) add(t.payee);
    for (const r of data.recurring) add(r.payee);
    names.sort((a, b) => a.localeCompare(b));
    return names.map((n) => ({ value: n, label: n }));
  }, [data]);

  // Stored payee names for the rename-rules match counts. Memoized so a
  // fresh array (and a full match-count rescan) isn't built on every render.
  const existingPayees = useMemo(
    () => data.transactions.map((t) => t.payee),
    [data.transactions]
  );


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

  const { assign, cycleStatus, setFlag, postRecurringOneClick } = useBudgetMutations({
    api,
    data,
    month,
    accountFilter,
  });

  const selectedCategory = useMemo(
    () =>
      selectedCategoryId != null
        ? data.categories.find((c) => c.id === selectedCategoryId) ?? null
        : null,
    [data.categories, selectedCategoryId]
  );
  const {
    lastMonthAssignments,
    spentLastMonthByCategory,
    avgSpentByCategory,
    avgBudgetedByCategory,
    underfundedByCategory,
    quickBudgetByMonth,
    handleQuickBudget,
  } = useQuickBudget({
    data,
    month,
    visibleMonths,
    isBudgetView,
    selectedCategoryId,
    budget,
    assign,
    batchAssign: api.batchAssign,
  });

  const openReconcile = useCallback(
    (accountId: number) => setModal({ kind: "reconcile", accountId }),
    []
  );

  const {
    reportsResetKey,
    setReportsResetKey,
    focusTransaction,
    registerFilter,
    navigateView,
    handleSelectAccount,
    handleBadgeClick,
    handleSelectTransactionFromReport,
    handleGoToTransfer,
    handleClearRegisterFilter,
    handleGlobalSearchJump,
    handleViewRuleMatches,
  } = useBudgetViewRouting({
    data,
    month,
    updateUrl,
    setView,
    accountFilter,
    setAccountFilter,
    setShowSettingsOverlay,
    setSearchOpen,
  });

  const { snapshots, snapshotSuggestion, snapshotsLoading, snapshotsError, refreshSnapshots } =
    useSnapshots(api);
  const { renameSuggestStatus, refreshRenameSuggestStatus } = useRenameSuggestStatus(api);

  // Point <html data-theme> at the persisted theme. A pre-paint script
  // in the web layout applies the stored value before first paint; this
  // keeps it in sync afterwards (and covers the no-script fallback).
  useEffect(() => {
    applyThemeId(themeId);
  }, [themeId]);

  const openSettings = useCallback(
    (page: "rename" | "payees" | "menu" | "snapshots" | "themes") => {
      setSettingsPage(page);
      setShowSettingsOverlay(true);
      if (page === "snapshots") void refreshSnapshots();
      if (page === "rename") void refreshRenameSuggestStatus();
    },
    [refreshSnapshots, refreshRenameSuggestStatus]
  );

  const handleToggleNav = useCallback(
    (v: View, next: boolean) => {
      if (!next && visibleViewCount(navVisible) <= 1 && navVisible[v]) {
        // At least one menu page must stay enabled.
        return;
      }
      const updated = { ...navVisible, [v]: next };
      setNavVisible(updated);
      if (!next && v === view) {
        // We just hid the page we are on — move to the next available page.
        // The settings overlay stays open; navigation happens behind it.
        const fallback = firstAvailableView(updated);
        if (fallback) {
          startTransition(() => {
            setView(fallback);
            if (fallback === "reports") {
              setReportsResetKey((k) => k + 1);
            }
            updateUrl(fallback, null, month);
          });
        }
      }
    },
    [navVisible, setNavVisible, view, updateUrl, month]
  );

  // ⌘K / Ctrl+K and "/" open the search modal from anywhere except while
  // typing in a field. Escape is handled by the modal itself.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Fresh search from anywhere — never resume an edit session.
        setSearchInitialQuery(null);
        setSearchOpen(true);
        return;
      }
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setSearchInitialQuery(null);
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleGroup = useCallback((id: number) => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(Object.fromEntries(data.groups.map((g) => [g.id, true])));
  }, [data.groups]);

  const expandAll = useCallback(() => setCollapsed({}), []);

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

  // Derive the reconcile account for the currently-open modal.
  const reconcileAccount_ = useMemo(() => {
    if (modal.kind !== "reconcile") return null;
    return data.accounts.find((a) => a.id === modal.accountId) ?? null;
  }, [modal, data.accounts]);

  // Live wall-date: ticks over at local midnight (plus focus/visibility
  // re-checks) so due-badge counts stay correct when the app is left open
  // overnight. `todayISO()` alone would freeze inside the memos below.
  const todayDay = useTodayISO();

  const newByAccount = useMemo(() => {
    return countNewByAccount(data.transactions, data.recurring, todayDay);
  }, [data.transactions, data.recurring, todayDay]);

  const duplicatesByAccount = useMemo(() => {
    return countDuplicatesByAccount(data.transactions);
  }, [data.transactions]);

  // Trends use the live wall-date so the in-progress month compares
  // same-day-to-same-day instead of month-to-date vs full-month average.
  const insights = useMemo(
    () => computeMonthlyInsights(data, month, budget, { asOfDate: todayDay }),
    [data, month, budget, todayDay]
  );

  const activeAccount = useMemo(
    () => data.accounts.find((a) => a.id === accountFilter) ?? null,
    [data.accounts, accountFilter]
  );

  // The tab title tracks the URL-driven view. Nice-URL navigation is
  // pushState-only, so Next metadata can't refresh it after the full load.
  useEffect(() => {
    document.title = buildPageTitle(view, {
      month,
      accountName: view === "transactions" ? (activeAccount?.name ?? null) : null,
    });
  }, [view, month, activeAccount]);

  // Split templates are code configuration (see SPLIT_TEMPLATE_PRESETS):
  // resolved against this budget's accounts by name. Preset names can
  // contain real payees, so they are disguised in privacy mode (and
  // won't resolve against the masked account names — by design).
  const splitTemplates = useMemo(() => {
    const resolved = resolveSplitTemplatePresets(
      SPLIT_TEMPLATE_PRESETS,
      privacyMask ? [] : data.accounts
    );
    if (!privacyMask) return resolved;
    return resolved.map((t, i) => ({
      ...t,
      name: `Template ${i + 1}`,
      legs: t.legs.map((l) => ({
        ...l,
        ...(l.payee !== undefined
          ? { payee: privacyMask.maskPayee(l.payee) }
          : {}),
        ...(l.memo !== undefined ? { memo: "" } : {}),
      })),
    }));
  }, [data.accounts, privacyMask]);

  return (
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden"
      style={{ background: "var(--y-canvas)" }}
    >
      {privacy.enabled && privacyNotice && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-50 flex justify-center">
          <div className="pointer-events-auto max-w-[520px] px-4">
            <Notice tone="warn" title="Editing is disabled">
              <div className="flex items-center gap-3">
                <span>Turn off privacy mode to make changes.</span>
                <button
                  className="underline underline-offset-2"
                  onClick={() => setPrivacyNotice(false)}
                >
                  Dismiss
                </button>
              </div>
            </Notice>
          </div>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <Sidebar
          view={view}
          setView={navigateView}
          visibleViews={navVisible}
          privacyEnabled={privacy.enabled}
          accounts={data.accounts}
          selectedAccountId={accountFilter}
          onSelectAccount={handleSelectAccount}
          onAddAccount={() => setModal({ kind: "account" })}
          onEditAccount={(id) => setModal({ kind: "editAccount", accountId: id })}
          onReorderAccount={api.reorderAccount}
          newByAccount={newByAccount}
          duplicatesByAccount={duplicatesByAccount}
          onBadgeClick={handleBadgeClick}
        />

        <main className="relative flex min-w-0 flex-1 flex-col" style={{ background: "var(--y-row)" }}>
          <ErrorBoundary name={`${view.charAt(0).toUpperCase() + view.slice(1)} View`}>
            {view === "budget" && (
              <BudgetView
                budget={budget}
                budgets={budgets}
                visibleMonths={visibleMonths}
                monthCount={monthCount}
                onSetMonthCount={handleSetMonthCount}
                currentMonth={month}
                collapsed={collapsed}
                onToggleGroup={toggleGroup}
                onAssign={assign}
                onShiftMonth={shiftMonth}
                onSetMonth={handleSetMonth}
                canShiftRight={canShiftRight}
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
                lastMonthAssignments={lastMonthAssignments}
                spentLastMonthByCategory={spentLastMonthByCategory}
                avgSpentByCategory={avgSpentByCategory}
                avgBudgetedByCategory={avgBudgetedByCategory}
                underfundedByCategory={underfundedByCategory}
                selectedCategoryId={selectedCategoryId}
                onSelectCategory={setSelectedCategoryId}
                quickBudgetByMonth={quickBudgetByMonth}
                onQuickBudget={handleQuickBudget}
                selectedCategory={selectedCategory}
                onClearSelectedCategory={() => setSelectedCategoryId(null)}
              />
            )}
            {view === "transactions" && (
              <TransactionsView
                data={data}
                accountFilter={accountFilter}
                focusTransaction={focusTransaction}
                externalFilter={registerFilter}
                selectedId={selectedTransactionId}
                onSelectedIdChange={setSelectedTransactionId}
                selectedIds={selectedTransactionIds}
                onSelectedIdsChange={setSelectedTransactionIds}
                selectedRecurringIds={selectedRecurringIds}
                onSelectedRecurringIdsChange={setSelectedRecurringIds}
                onEditFilter={(q) => {
                  setSearchInitialQuery(q);
                  setSearchOpen(true);
                }}
                onClearFilter={handleClearRegisterFilter}
                onGoToTransfer={handleGoToTransfer}
                onAdd={() => setModal({ kind: "addTransaction", mode: "single" })}
                onAddTransfer={() => setModal({ kind: "addTransaction", mode: "transfer" })}
                onEdit={(id) => setModal({ kind: "editTransaction", transactionId: id })}
                onBulkEdit={(ids) => setModal({ kind: "bulkEditTransactions", transactionIds: ids })}
                onDelete={api.deleteTransaction}
                onReconcile={openReconcile}
                onCycleStatus={cycleStatus}
                onFlag={setFlag}
                onBulkDelete={api.bulkDeleteTransactions}
                onBulkUpdate={api.bulkUpdateTransactions}
                onMergeTransactions={api.mergeTransactions}
                onDismissDuplicateGroup={api.dismissDuplicateGroup}
                payees={payeeOptions}
                onAddRecurring={() => setModal({ kind: "recurring", mode: "single" })}
                onAddRecurringTransfer={() => setModal({ kind: "recurring", mode: "transfer" })}
                onEditRecurring={(id) => setModal({ kind: "editRecurring", recurringId: id })}
                onDeleteRecurring={api.deleteRecurring}
                onPostRecurring={api.postRecurring}
                onFlagRecurring={(id, color) => api.updateRecurring(id, { flagColor: color })}
                onBulkPostRecurring={api.bulkPostRecurring}
                onBulkUpdateRecurring={api.bulkUpdateRecurring}
                onBulkDeleteRecurring={api.bulkDeleteRecurring}
              />
            )}
            {view === "reports" && (
              <ReportsView
                data={data}
                month={month}
                minYear={minYear}
                maxYear={maxYear}
                resetKey={reportsResetKey}
                onSelectTransaction={handleSelectTransactionFromReport}
              />
            )}
          </ErrorBoundary>


          {showSettingsOverlay && (
            <div
              className="absolute inset-0 z-50 y-scrim"
              onClick={() => setShowSettingsOverlay(false)}
            >
              <div
                className="absolute inset-0 flex flex-col"
                style={{ background: "var(--y-row)" }}
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  className="flex items-center justify-end px-5 py-3"
                  style={{
                    borderBottom: "1px solid var(--y-line)",
                    background: "var(--y-chrome-top)",
                  }}
                >
                  <Tooltip tip="Close">
                    <button
                      className="y-icon-btn"
                      onClick={() => setShowSettingsOverlay(false)}
                      aria-label="Close"
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </Tooltip>
                </div>
                <div className="flex-1 overflow-hidden">
                  {settingsPage === "menu" ? (
                    <MenuSettingsView
                      visible={navVisible}
                      onToggle={handleToggleNav}
                      privacyEnabled={privacy.enabled}
                      onTogglePrivacy={(next) =>
                        next ? enablePrivacy() : disablePrivacy()
                      }
                      onRegeneratePrivacyAmounts={regeneratePrivacyFactor}
                    />
                  ) : settingsPage === "payees" ? (
                    <PayeesView
                      payees={data.payees ?? []}
                      transactions={data.transactions}
                      recurring={data.recurring}
                      categories={data.categories}
                      groups={data.groups}
                      onEnsurePayee={async (name) => {
                        if (!api.ensurePayee) throw new Error("Payee creation is not available");
                        return api.ensurePayee(name);
                      }}
                      onRename={async (id, name) => {
                        await api.renamePayee?.(id, name);
                      }}
                      onSetDefaultCategory={async (id, categoryId) => {
                        await api.setPayeeDefaultCategory?.(id, categoryId);
                      }}
                      onMerge={async (targetId, sourceIds) => {
                        await api.mergePayees?.(targetId, sourceIds);
                      }}
                      onDelete={async (id) => {
                        await api.deletePayee?.(id);
                      }}
                    />
                  ) : settingsPage === "snapshots" ? (
                    <SnapshotsView
                      snapshots={snapshots}
                      suggestedName={snapshotSuggestion}
                      loading={snapshotsLoading}
                      error={snapshotsError}
                      onCreate={async (name) => {
                        await api.createSnapshot?.(name);
                        await refreshSnapshots();
                      }}
                      onRestore={async (id) => {
                        await api.restoreSnapshot?.(id);
                        await api.reload();
                        await refreshSnapshots();
                      }}
                      onDelete={async (id) => {
                        await api.deleteSnapshot?.(id);
                        await refreshSnapshots();
                      }}
                    />
                  ) : settingsPage === "themes" ? (
                    <ThemesView themeId={themeId} onSelect={setThemeId} />
                  ) : (
                    <SettingsView
                      rules={data.renameRules ?? []}
                      existingPayees={existingPayees}
                      onAdd={async (sourcePattern, targetPayee) => {
                        await api.addRenameRule?.(sourcePattern, targetPayee);
                      }}
                      onUpdate={async (id, sourcePattern, targetPayee) => {
                        await api.updateRenameRule?.(id, sourcePattern, targetPayee);
                      }}
                      onDelete={async (id) => {
                        await api.deleteRenameRule?.(id);
                      }}
                      onApply={api.applyRenameRule}
                      onViewMatches={handleViewRuleMatches}
                      suggestStatus={renameSuggestStatus}
                      onSuggestRules={api.suggestRenameRules}
                      onAcceptSuggestions={
                        api.acceptRenameSuggestions
                          ? async (suggestions, applyToExisting) => {
                              const res = await api.acceptRenameSuggestions!(
                                suggestions,
                                applyToExisting
                              );
                              // Counts changed: refresh the uncovered-payee total.
                              await refreshRenameSuggestStatus();
                              return res;
                            }
                          : undefined
                      }
                    />
                  )}
                </div>
              </div>
            </div>
          )}
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
            totalIncome={budget.totalIncome}
            totalAssigned={budget.totalAssigned}
            overspentPrevious={budget.overspentPrevious}
            overspentPreviousMonthKey={budget.overspentPreviousMonthKey}
            incomeFromFuture={budget.incomeFromFuture}
            incomeFromPast={budget.incomeFromPast}
            incomeDeferredToFuture={budget.incomeDeferredToFuture}
            incomeDeferredToPast={budget.incomeDeferredToPast}
            cashFlow={cashFlow}
            trailingNetWorth={trailingNetWorth}
            insights={insights}
            onSelectMonth={handleSetMonth}
            onImportYnab4={api.importYnab4}
            onImportCsv={(file) => {
              // The import preview parses the real file client-side, so it
              // can't open while names/amounts are disguised.
              if (privacyMask) {
                setPrivacyNotice(true);
                return;
              }
              setModal({ kind: "csvImport", file });
            }}
            onAnalyzeDuplicates={api.analyzeDuplicates}
            onOpenRenameRules={() => openSettings("rename")}
            onOpenPayees={() => openSettings("payees")}
            onOpenPageVisibility={() => openSettings("menu")}
            onOpenSnapshots={() => openSettings("snapshots")}
            onOpenThemes={() => openSettings("themes")}
          />
        </ErrorBoundary>

        {searchOpen && (
          <GlobalSearchModal
            data={data}
            scopeAccountId={accountFilter}
            open={searchOpen}
            onClose={() => setSearchOpen(false)}
            onJump={handleGlobalSearchJump}
            initialQuery={searchInitialQuery}
          />
        )}

        {modal.kind === "addTransaction" && (
          <TransactionModal
            accounts={data.accounts}
            categories={data.categories}
            groups={data.groups}
            payees={payeeOptions}
            defaultAccountId={accountFilter}
            defaultDate={modal.defaultDate}
            initialMode={modal.mode}
            allTransactions={data.transactions}
            splitTemplates={splitTemplates}
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
            groups={data.groups}
            payees={payeeOptions}
            defaultAccountId={accountFilter}
            initial={editingTransaction}
            allTransactions={data.transactions}
            splitTemplates={splitTemplates}
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
        {modal.kind === "bulkEditTransactions" && (
          <BulkEditTransactionsModal
            accounts={data.accounts}
            categories={data.categories}
            groups={data.groups}
            payees={payeeOptions}
            transactionIds={modal.transactionIds}
            transactions={data.transactions.filter((t) => modal.transactionIds.includes(t.id))}
            onClose={() => setModal({ kind: "none" })}
            onSave={async (patch, ids) => {
              if (api.bulkUpdateTransactions) {
                const targetIds = ids ?? modal.transactionIds.filter((id) => {
                  const tx = data.transactions.find((t) => t.id === id);
                  return !tx || tx.status !== "r";
                });
                if (targetIds.length > 0) {
                  await api.bulkUpdateTransactions(targetIds, patch);
                }
              }
              setModal({ kind: "none" });
            }}
          />
        )}
        {modal.kind === "recurring" && (
          <RecurringModal
            accounts={data.accounts}
            categories={data.categories}
            groups={data.groups}
            payees={payeeOptions}
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
            groups={data.groups}
            payees={payeeOptions}
            initial={editingRecurring}
            onClose={() => setModal({ kind: "none" })}
            onSave={async (v) => {
              const { id, ...rest } = v;
              if (id) await api.updateRecurring(id, rest);
              setModal({ kind: "none" });
            }}
            onPost={async (id) => {
              await postRecurringOneClick(id);
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
                onBudget: v.onBudget,
                notes: v.notes,
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
              startTransition(() => {
                setAccountFilter(null);
                setView("budget");
                setShowSettingsOverlay(false);
                updateUrl("budget", null, month);
                setModal({ kind: "none" });
              });
            }}
          />
        )}
        {modal.kind === "addCategory" && (
          <CategoryModal
            groups={data.groups}
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
            groups={data.groups}
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
        {modal.kind === "reconcile" && reconcileAccount_ && (
          <ReconcileModal
            account={reconcileAccount_}
            transactions={data.transactions}
            categories={data.categories}
            groups={data.groups.filter(
              (g) => g.name !== "__Internal__" && g.name.toLowerCase() !== "__internal__"
            )}
            onClose={() => setModal({ kind: "none" })}
            onReconcile={async (input) => {
              await api.reconcileAccount(input);
              setModal({ kind: "none" });
            }}
            onFetchState={api.getReconcileState}
            onUnreconcile={async (accountId) => {
              await api.unreconcileAccount(accountId);
              setModal({ kind: "none" });
            }}
          />
        )}
      </div>
    </div>
  );
}

export const __demoConstants = { DEMO_MONTH, todayISO };
