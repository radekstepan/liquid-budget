"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { BudgetData, BulkUpdateTransactionPatch, DuplicateAnalysisResult, ImportSummary, MergeOverrides, Query, RenameRule, RenameSuggestResponse, RenameSuggestStatusResponse, Transaction } from "@ynab/logic";
import {
  buildPageTitle,
  computeBudget,
  computeCashFlow,
  computeTrailingNetWorth,
  computeMonthlyInsights,
  num,
  parseMonthKey,
  monthKey,
  previousMonthKey,
  renameRulePayeeFilter,
  resolveSplitTemplatePresets,
  round2,
  SPLIT_TEMPLATE_PRESETS,
  todayISO,
  countDuplicatesByAccount,
  countNewByAccount,
  isValidISOMonth,
  DEMO_MONTH,
  type TransactionFlagColor,
  createPrivacyMask,
  maskBudgetData,
  isPrivacyFactor,
} from "@ynab/logic";
import { useLocalStorage } from "./useLocalStorage.js";
import { useTodayISO } from "./useTodayISO.js";
import { guardApiForPrivacy, randomPrivacyFactor } from "./privacyApi.js";
import { Sidebar, type View } from "./Sidebar.js";
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
import type { GlobalSearchJump } from "./GlobalSearch.js";
import { GlobalSearchModal } from "./GlobalSearchModal.js";
import { Inspector } from "./Inspector.js";
import { BudgetView, isInternalGroup } from "./BudgetView.js";
import { TransactionsView } from "./TransactionsView.js";
import { ReportsView } from "./ReportsView.js";
import { SettingsView } from "./SettingsView.js";
import { MenuSettingsView } from "./MenuSettingsView.js";
import { ThemesView } from "./ThemesView.js";
import { PayeesView } from "./PayeesView.js";
import { SnapshotsView, type SnapshotSummary } from "./SnapshotsView.js";
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
  type TransactionSavePayload,
  type RecurringSavePayload,
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

export type BudgetAppApi = {
  reload: () => Promise<void>;
  assign: (categoryId: number, amount: number, month: string) => Promise<void>;
  batchAssign?: (assignments: { categoryId: number; amount: number; month: string }[]) => Promise<void>;
  addTransaction: (t: TransactionSavePayload | {
    accountId: number;
    categoryId?: number | null;
    date: string;
    payee: string;
    amount: number;
    memo?: string;
    status?: "u" | "c" | "r";
    transferStatus?: "u" | "c" | "r";
    flagColor?: TransactionFlagColor | null;
    transferAccountId?: number | null;
    incomeMonth?: string | null;
    isIncome?: boolean;
    subTransactions?: {
      categoryId: number | null;
      amount: number;
      memo?: string;
      transferAccountId?: number | null;
      transferStatus?: "u" | "c" | "r";
    }[];
  }) => Promise<void>;
  updateTransaction: (
    id: number,
    t: Partial<TransactionSavePayload> | {
      accountId?: number;
      categoryId?: number | null;
      date?: string;
      payee?: string;
      amount?: number;
      memo?: string;
      status?: "u" | "c" | "r";
      transferStatus?: "u" | "c" | "r";
      flagColor?: TransactionFlagColor | null;
      transferAccountId?: number | null;
      incomeMonth?: string | null;
      isIncome?: boolean;
      subTransactions?: {
        categoryId: number | null;
        amount: number;
        memo?: string;
        transferAccountId?: number | null;
        transferStatus?: "u" | "c" | "r";
      }[];
    }
  ) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  bulkDeleteTransactions?: (ids: number[]) => Promise<void>;
  bulkUpdateTransactions?: (
    ids: number[],
    patch: BulkUpdateTransactionPatch
  ) => Promise<void>;
  mergeTransactions?: (ids: number[], overrides?: MergeOverrides) => Promise<void>;
  addRecurring: (v: RecurringSavePayload | {
    accountId: number;
    categoryId?: number | null;
    payee: string;
    memo?: string;
    amount: number;
    frequency: string;
    nextDate: string;
    anchorDay?: number | null;
    active?: boolean;
    flagColor?: TransactionFlagColor | null;
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
    v: Partial<RecurringSavePayload> | {
      accountId?: number;
      categoryId?: number | null;
      payee?: string;
      memo?: string;
      amount?: number;
      frequency?: string;
      nextDate?: string;
      anchorDay?: number | null;
      active?: boolean;
      flagColor?: TransactionFlagColor | null;
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
  bulkPostRecurring?: (ids: number[], date?: string) => Promise<void>;
  bulkUpdateRecurring?: (
    ids: number[],
    patch: { flagColor?: TransactionFlagColor | null; active?: boolean }
  ) => Promise<void>;
  bulkDeleteRecurring?: (ids: number[]) => Promise<void>;
  saveCategory: (
    groupId: number | null,
    categoryId: number | null,
    v: {
      name: string;
      groupId?: number;
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
    balance?: number;
    notes?: string;
  }) => Promise<void>;
  deleteAccount: (id: number) => Promise<void>;
  updateAccount: (
    id: number,
    patch: {
      name?: string;
      kind?: "liquid" | "credit" | "offbudget";
      onBudget?: boolean;
      archived?: boolean;
      notes?: string;
    },
    opts?: { undo?: boolean }
  ) => Promise<void>;
  reorderAccount: (id: number, sort: number) => Promise<void>;
  reconcileAccount: (input: {
    accountId: number;
    statementBalance: number;
    statementDate: string;
    adjustmentCategoryId: number | null;
    expectedWorkingBalance?: number | null;
  }) => Promise<void>;
  getReconcileState?: (accountId: number, statementDate?: string) => Promise<any>;
  unreconcileAccount: (accountId: number) => Promise<void>;
  importYnab4?: (file: File) => Promise<ImportSummary | void>;
  importCsv?: (input: { accountId: number; swap: boolean; dateFormat?: "auto" | "dmy" | "mdy"; csv: string }) => Promise<any>;
  analyzeDuplicates?: () => Promise<DuplicateAnalysisResult | void>;
  dismissDuplicateGroup?: (fingerprint: string) => Promise<void>;
  addRenameRule?: (sourcePattern: string, targetPayee: string) => Promise<void>;
  updateRenameRule?: (id: number, sourcePattern: string, targetPayee: string) => Promise<void>;
  deleteRenameRule?: (id: number) => Promise<void>;
  applyRenameRule?: (id: number) => Promise<{ updated: number; skippedLocked: number }>;
  getRenameSuggestStatus?: () => Promise<RenameSuggestStatusResponse>;
  suggestRenameRules?: (offset: number, limit: number) => Promise<RenameSuggestResponse>;
  acceptRenameSuggestions?: (
    suggestions: { sourcePattern: string; targetPayee: string }[],
    applyToExisting: boolean
  ) => Promise<{ updated: number; skippedLocked: number; generalised: boolean }>;
  ensurePayee?: (name: string) => Promise<number>;
  renamePayee?: (id: number, name: string) => Promise<void>;
  setPayeeDefaultCategory?: (id: number, categoryId: number | null) => Promise<void>;
  mergePayees?: (targetId: number, sourceIds: number[]) => Promise<void>;
  deletePayee?: (id: number) => Promise<void>;
  listSnapshots?: () => Promise<{ snapshots: SnapshotSummary[]; suggestedName: string }>;
  createSnapshot?: (name: string) => Promise<void>;
  restoreSnapshot?: (id: string) => Promise<void>;
  deleteSnapshot?: (id: string) => Promise<void>;
};

export type QuickBudgetType = "lastMonth" | "spentLastMonth" | "avgBudgeted" | "clear";

function lastMonthMapFor(
  assignments: BudgetData["assignments"],
  targetMonth: string
): Map<number, number> {
  const prevMonth = previousMonthKey(targetMonth);
  const map = new Map<number, number>();
  for (const a of assignments) {
    if (a.month === prevMonth) {
      map.set(a.categoryId, num(a.amount));
    }
  }
  return map;
}

function spentLastMonthMapFor(
  transactions: BudgetData["transactions"],
  targetMonth: string
): Map<number, number> {
  const prevMonth = previousMonthKey(targetMonth);
  const map = new Map<number, number>();
  const parentSet = new Set<number>();
  for (const t of transactions) {
    if (t.parentId != null) parentSet.add(t.parentId);
  }
  for (const t of transactions) {
    if (t.date.slice(0, 7) !== prevMonth) continue;
    if (t.categoryId == null) continue;
    if (parentSet.has(t.id)) continue;
    const amt = num(t.amount);
    if (amt < 0) {
      map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + -amt);
    }
  }
  return map;
}

function avgBudgetedMapFor(
  assignments: BudgetData["assignments"],
  targetMonth: string
): Map<number, number> {
  const { year: y, month0 } = parseMonthKey(targetMonth);
  const map = new Map<number, { sum: number; count: number }>();
  for (let i = 1; i <= 3; i++) {
    const mm = ((month0 - i) % 12 + 12) % 12;
    const yy = y + Math.floor((month0 - i) / 12);
    const key = monthKey(yy, mm);
    for (const a of assignments) {
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
}

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

export const PRIVACY_STORAGE_KEY = "ynab:privacy";

export type PrivacySettings = {
  enabled: boolean;
  /** Disguise factor; 0 means "none drawn yet". */
  factor: number;
};

export function isPrivacySettings(v: unknown): v is PrivacySettings {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.enabled === "boolean" &&
    (o.factor === 0 || isPrivacyFactor(o.factor))
  );
}

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
  // Privacy (screenshot) mode: every `data`/`api` use below sees the
  // masked snapshot and the guarded api, so all views, modals, search,
  // titles, and tooltips are disguised with no per-screen changes.
  // Masked data must never be written back: the guard blocks all
  // mutations while the mode is on.
  const [privacy, setPrivacy] = useLocalStorage<PrivacySettings>(
    PRIVACY_STORAGE_KEY,
    { enabled: false, factor: 0 },
    isPrivacySettings
  );
  const [privacyNotice, setPrivacyNotice] = useState(false);
  const privacyMask = useMemo(
    () =>
      privacy.enabled && isPrivacyFactor(privacy.factor)
        ? createPrivacyMask(rawData, privacy.factor)
        : null,
    [privacy, rawData]
  );
  const data = useMemo(
    () => (privacyMask ? maskBudgetData(rawData, privacyMask) : rawData),
    [rawData, privacyMask]
  );
  const api = useMemo(
    () =>
      privacyMask
        ? guardApiForPrivacy(rawApi, privacyMask, () => setPrivacyNotice(true))
        : rawApi,
    [rawApi, privacyMask]
  );
  const enablePrivacy = useCallback(() => {
    setPrivacy((p) => ({
      enabled: true,
      factor: isPrivacyFactor(p.factor) ? p.factor : randomPrivacyFactor(),
    }));
  }, [setPrivacy]);
  const disablePrivacy = useCallback(() => {
    setPrivacy((p) => ({ ...p, enabled: false }));
    setPrivacyNotice(false);
  }, [setPrivacy]);
  const regeneratePrivacyFactor = useCallback(() => {
    setPrivacy((p) => ({ ...p, factor: randomPrivacyFactor() }));
  }, [setPrivacy]);

  const [view, setView] = useState<View>(
    (["budget", "reports", "transactions"] as View[]).includes(initialView as View)
      ? (initialView as View)
      : "budget"
  );
  const [month, setMonth] = useState(() =>
    initialMonth && isValidISOMonth(initialMonth) ? initialMonth : todayISO().slice(0, 7)
  );
  const [monthCount, setMonthCount] = useLocalStorage<number>(
    "ynab:budget:monthCount",
    3,
    (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12
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
  const [reportsResetKey, setReportsResetKey] = useState(0);
  const [focusTransaction, setFocusTransaction] = useState<{ id: number; nonce: number } | null>(null);
  const [registerFilter, setRegisterFilter] = useState<{
    payee?: string;
    categoryId?: number | null;
    text?: string;
    query?: Query;
    nonce: number;
  } | null>(null);
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
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [snapshotSuggestion, setSnapshotSuggestion] = useState("");
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [navVisible, setNavVisible] = useLocalStorage<Record<View, boolean>>(
    NAV_VISIBILITY_STORAGE_KEY,
    DEFAULT_NAV_VISIBILITY,
    isNavVisibility
  );
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [isPending, startTransition] = useTransition();

  // URL routing synchronization — path-based nice URLs
  const updateUrl = useCallback((newView: View, newAccount: number | null, newMonth: string) => {
    if (typeof window === "undefined") return;
    let path: string;
    if (newView === "budget") {
      path = `/budget/${newMonth}`;
    } else if (newView === "transactions" && newAccount != null) {
      path = `/transactions/${newAccount}`;
    } else {
      path = `/${newView}`;
    }
    if (window.location.pathname !== path) {
      try {
        window.history.pushState(null, "", path);
      } catch {
        // pushState is cosmetic; in-memory state + popstate listener
        // already keep the UI in sync.
      }
    }
  }, []);

  // Initialize from initial props on mount and listen for popstate
  useEffect(() => {
    if (typeof window === "undefined") return;
    const parsePath = () => {
      const path = window.location.pathname.replace(/\/$/, "");
      const segments = path.split("/").filter(Boolean);
      const validViews = ["budget", "reports", "transactions"] as const;

      if (segments.length >= 1 && (validViews as readonly string[]).includes(segments[0]!)) {
        setView(segments[0] as View);
      } else {
        setView("budget");
      }

      // The transactions URL is the source of truth for the account
      // filter: an id selects that account, a bare /transactions clears to
      // All Transactions. Any other path leaves the selection alone.
      if (segments[0] === "transactions") {
        if (segments[1]) {
          const accId = Number(segments[1]);
          if (!Number.isNaN(accId)) {
            setAccountFilter(accId);
          }
        } else {
          setAccountFilter(null);
        }
      }

      if (segments[0] === "budget" && segments[1] && isValidISOMonth(segments[1])) {
        setMonth(segments[1]);
      }
    };

    parsePath();
    window.addEventListener("popstate", parsePath);
    return () => window.removeEventListener("popstate", parsePath);
  }, []);

  const isBudgetView = view === "budget";
  const { year } = parseMonthKey(month);

  const budget = useMemo(() => computeBudget(data, month), [data, month]);

  const today = todayISO().slice(0, 7);
  const { year: ty, month0: tm0 } = parseMonthKey(today);
  const todayMonthTotal = ty * 12 + tm0;
  const maxMonthTotal = todayMonthTotal + 1;
  const maxAllowedMonth = monthKey(Math.floor(maxMonthTotal / 12), ((maxMonthTotal % 12) + 12) % 12);

  const visibleMonths = useMemo(() => {
    if (!isBudgetView) return [month];
    const { year: y, month0 } = parseMonthKey(month);
    const anchorTotal = y * 12 + month0;
    const offset = Math.floor((monthCount - 1) / 2);
    const start = anchorTotal - offset;
    const keys: string[] = [];
    for (let i = 0; i < monthCount; i++) {
      const t = start + i;
      if (t > maxMonthTotal) break;
      const yy = Math.floor(t / 12);
      const mm = ((t % 12) + 12) % 12;
      keys.push(monthKey(yy, mm));
    }
    return keys.length > 0 ? keys : [month];
  }, [month, monthCount, isBudgetView, maxMonthTotal]);

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
    const map = new Map<number, number>();
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
        map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + -amt);
      }
    }
    const result = new Map<number, number>();
    for (const [catId, sum] of map) {
      if (sum > 0) {
        result.set(catId, Math.round(sum / 3));
      }
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

  const assign = useCallback(
    async (categoryId: number, amount: number, m?: string) => {
      try {
        await api.assign(categoryId, amount, m ?? month);
      } catch {
        // Handled via notifications toast and rollback in BudgetAppShell
      }
    },
    [api, month]
  );

  const selectedCategory = useMemo(
    () =>
      selectedCategoryId != null
        ? data.categories.find((c) => c.id === selectedCategoryId) ?? null
        : null,
    [data.categories, selectedCategoryId]
  );

  // Per-month quick-budget source maps, keyed by target month. Each month's
  // "last month" / "spent last month" / "average budgeted" figures are
  // relative to that column, not to the anchor month.
  const quickMapsByMonth = useMemo(() => {
    if (!isBudgetView) return {} as Record<string, { lastMonth: Map<number, number>; spentLastMonth: Map<number, number>; avgBudgeted: Map<number, number> }>;
    const out: Record<string, { lastMonth: Map<number, number>; spentLastMonth: Map<number, number>; avgBudgeted: Map<number, number> }> = {};
    for (const m of visibleMonths) {
      out[m] = {
        lastMonth: lastMonthMapFor(data.assignments, m),
        spentLastMonth: spentLastMonthMapFor(data.transactions, m),
        avgBudgeted: avgBudgetedMapFor(data.assignments, m),
      };
    }
    return out;
  }, [data.assignments, data.transactions, visibleMonths, isBudgetView]);

  // Display totals per visible month for the header dropdowns. When a
  // category is selected the figures cover just that category, otherwise
  // they cover the entire budget (same scope the action applies to).
  const quickBudgetByMonth = useMemo(() => {
    const out: Record<string, { lastMonth: number; spentLastMonth: number; avgBudgeted: number }> = {};
    for (const m of visibleMonths) {
      const maps = quickMapsByMonth[m];
      if (!maps) continue;
      if (selectedCategoryId != null) {
        out[m] = {
          lastMonth: maps.lastMonth.get(selectedCategoryId) ?? 0,
          spentLastMonth: maps.spentLastMonth.get(selectedCategoryId) ?? 0,
          avgBudgeted: maps.avgBudgeted.get(selectedCategoryId) ?? 0,
        };
      } else {
        let lastMonth = 0;
        for (const v of maps.lastMonth.values()) lastMonth += v;
        let spentLastMonth = 0;
        for (const v of maps.spentLastMonth.values()) spentLastMonth += v;
        let avgBudgeted = 0;
        for (const v of maps.avgBudgeted.values()) avgBudgeted += v;
        out[m] = { lastMonth, spentLastMonth, avgBudgeted };
      }
    }
    return out;
  }, [quickMapsByMonth, visibleMonths, selectedCategoryId]);

  const handleQuickBudget = useCallback(
    async (type: QuickBudgetType, catId?: number, targetMonth?: string) => {
      const target = targetMonth ?? month;
      const cached = quickMapsByMonth[target];
      const lastMonthMap = cached?.lastMonth ?? lastMonthMapFor(data.assignments, target);
      const spentLastMonthMap =
        cached?.spentLastMonth ?? spentLastMonthMapFor(data.transactions, target);
      const avgBudgetedMap =
        cached?.avgBudgeted ?? avgBudgetedMapFor(data.assignments, target);
      const getAmount = (categoryId: number): number => {
        switch (type) {
          case "lastMonth":
            return lastMonthMap.get(categoryId) ?? 0;
          case "spentLastMonth":
            return spentLastMonthMap.get(categoryId) ?? 0;
          case "avgBudgeted":
            return avgBudgetedMap.get(categoryId) ?? 0;
          case "clear":
            return 0;
        }
      };

      if (catId != null) {
        await assign(catId, getAmount(catId), target);
        return;
      }

      // Apply to all categories in visible structure groups
      const allBudgetCats: number[] = [];
      for (const g of budget.groups) {
        if (g.group.isCreditCardPayments || isInternalGroup(g.group)) continue;
        for (const r of g.rows) {
          allBudgetCats.push(r.category.id);
        }
      }

      const itemsToAssign: { categoryId: number; amount: number; month: string }[] = [];
      for (const cId of allBudgetCats) {
        const amt = getAmount(cId);
        // Apply if there's an amount or if resetting to zero
        if (amt > 0 || type === "clear") {
          itemsToAssign.push({ categoryId: cId, amount: amt, month: target });
        }
      }

      if (itemsToAssign.length === 0) return;

      if (api.batchAssign) {
        try {
          await api.batchAssign(itemsToAssign);
        } catch {
          // Handled via notifications toast and rollback in BudgetAppShell
        }
      } else {
        for (const item of itemsToAssign) {
          await assign(item.categoryId, item.amount, item.month);
        }
      }
    },
    [
      assign,
      api.batchAssign,
      budget.groups,
      data.assignments,
      data.transactions,
      quickMapsByMonth,
      month,
    ]
  );

  const openReconcile = useCallback(
    (accountId: number) => setModal({ kind: "reconcile", accountId }),
    []
  );

  const navigateView = useCallback(
    (v: View) => {
      startTransition(() => {
        setView(v);
        if (v === "reports") {
          setReportsResetKey((k) => k + 1);
        }
        setShowSettingsOverlay(false);
        if (v === "transactions") {
          setAccountFilter(null);
          updateUrl(v, null, month);
        } else {
          updateUrl(v, accountFilter, month);
        }
      });
    },
    [updateUrl, month, accountFilter]
  );

  const refreshSnapshots = useCallback(async () => {
    if (!api.listSnapshots) return;
    setSnapshotsLoading(true);
    setSnapshotsError(null);
    try {
      const res = await api.listSnapshots();
      setSnapshots(res.snapshots);
      setSnapshotSuggestion(res.suggestedName);
    } catch (e: any) {
      setSnapshotsError(e?.message ? String(e.message) : String(e));
    } finally {
      setSnapshotsLoading(false);
    }
  }, [api]);

  const [renameSuggestStatus, setRenameSuggestStatus] =
    useState<RenameSuggestStatusResponse | null>(null);

  const refreshRenameSuggestStatus = useCallback(async () => {
    if (!api.getRenameSuggestStatus) return;
    try {
      setRenameSuggestStatus(await api.getRenameSuggestStatus());
    } catch {
      // Status is best-effort: a failure just hides the AI button.
      setRenameSuggestStatus(null);
    }
  }, [api]);

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

  const handleSelectAccount = useCallback(
    (id: number) => {
      startTransition(() => {
        const next = accountFilter === id ? null : id;
        setAccountFilter(next);
        setShowSettingsOverlay(false);
        updateUrl("transactions", next, month);
        setView("transactions");
      });
    },
    [updateUrl, month, accountFilter]
  );

  // Sidebar badge click: open the account's register pre-filtered to the
  // badge kind (unreviewed rows for "new", marker rows for "duplicates").
  // Unlike row clicks this never toggles the account off.
  const handleBadgeClick = useCallback(
    (accountId: number, kind: "new" | "duplicates") => {
      startTransition(() => {
        setAccountFilter(accountId);
        setView("transactions");
        setShowSettingsOverlay(false);
        setRegisterFilter({
          query: {
            filters: [{ kind: "is", value: kind === "duplicates" ? "duplicate" : "new" }],
            text: "",
          },
          nonce: Date.now(),
        });
        updateUrl("transactions", accountId, month);
      });
    },
    [updateUrl, month]
  );

  const handleSelectTransactionFromReport = useCallback(
    (t: Transaction) => {
      const parentTxn = t.parentId != null ? data.transactions.find((x) => x.id === t.parentId) : null;
      const targetAccountId = parentTxn ? parentTxn.accountId : t.accountId;
      const targetTxnId = t.parentId ?? t.id;

      startTransition(() => {
        setAccountFilter(targetAccountId);
        setView("transactions");
        setFocusTransaction({ id: targetTxnId, nonce: Date.now() });
        setShowSettingsOverlay(false);
        updateUrl("transactions", targetAccountId, month);
      });
    },
    [data.transactions, updateUrl, month]
  );

  const handleGoToTransfer = useCallback(
    (targetAccountId: number, targetTxnId: number) => {
      startTransition(() => {
        setAccountFilter(targetAccountId);
        setView("transactions");
        setFocusTransaction({ id: targetTxnId, nonce: Date.now() });
        setShowSettingsOverlay(false);
        updateUrl("transactions", targetAccountId, month);
      });
    },
    [updateUrl, month]
  );

  // Dropping the register filter entirely (rather than just hiding it) so a
  // cleared filter can't resurrect when the register remounts after a view
  // switch. Stable identity: TransactionsView effects depend on it.
  const handleClearRegisterFilter = useCallback(() => {
    setRegisterFilter(null);
  }, []);

  // Global search jumps always land in the register: a transaction focuses
  // its row, while a payee/category/text/query selection filters the register.
  const handleGlobalSearchJump = useCallback(
    (jump: GlobalSearchJump) => {
      startTransition(() => {
        setShowSettingsOverlay(false);
        setSearchOpen(false);
        if (jump.kind === "transaction") {
          setAccountFilter(jump.accountId);
          setView("transactions");
          setFocusTransaction({ id: jump.transactionId, nonce: Date.now() });
          updateUrl("transactions", jump.accountId, month);
        } else if (jump.kind === "payee") {
          setView("transactions");
          setRegisterFilter({ payee: jump.payee, categoryId: null, nonce: Date.now() });
          updateUrl("transactions", accountFilter, month);
        } else if (jump.kind === "category") {
          setView("transactions");
          setRegisterFilter({ categoryId: jump.categoryId, nonce: Date.now() });
          updateUrl("transactions", accountFilter, month);
        } else if (jump.kind === "query") {
          setView("transactions");
          setRegisterFilter({ query: jump.query, nonce: Date.now() });
          updateUrl("transactions", accountFilter, month);
        } else {
          setView("transactions");
          setRegisterFilter({ text: jump.text, nonce: Date.now() });
          updateUrl("transactions", accountFilter, month);
        }
      });
    },
    [updateUrl, month, accountFilter]
  );

  // A rename rule's Source link jumps to the register filtered to the rows
  // the rule likely matches (exact source, or longest literal fragment of
  // a pattern). Mirrors the global-search payee jump.
  const handleViewRuleMatches = useCallback(
    (rule: RenameRule) => {
      const payee = renameRulePayeeFilter(rule.sourcePattern);
      if (!payee) return;
      startTransition(() => {
        setShowSettingsOverlay(false);
        setView("transactions");
        setRegisterFilter({ payee, categoryId: null, nonce: Date.now() });
        updateUrl("transactions", accountFilter, month);
      });
    },
    [updateUrl, month, accountFilter]
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

  const cycleStatus = useCallback(
    async (id: number) => {
      const t = data.transactions.find((x) => x.id === id);
      if (!t) return;
      const isIncoming = accountFilter != null && t.transferAccountId === accountFilter;
      const currentStatus = isIncoming ? (t.transferStatus ?? t.status) : t.status;
      if (currentStatus === "r") return;
      const next: "u" | "c" = currentStatus === "c" ? "u" : "c";
      if (isIncoming) {
        await api.updateTransaction(id, { transferStatus: next });
      } else {
        await api.updateTransaction(id, { status: next });
      }
    },
    [api, data.transactions, accountFilter]
  );

  const setFlag = useCallback(
    async (id: number, flagColor: TransactionFlagColor | null) => {
      await api.updateTransaction(id, { flagColor });
    },
    [api]
  );

  const toggleGroup = useCallback((id: number) => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  }, []);

  const canShiftRight = useMemo(() => {
    if (monthCount === 1) {
      return month < maxAllowedMonth;
    }
    const rightmost = visibleMonths[visibleMonths.length - 1];
    if (rightmost && rightmost >= maxAllowedMonth) {
      return false;
    }
    const { year: y, month0 } = parseMonthKey(month);
    const candidateTotal = y * 12 + month0 + 1;
    const offset = Math.floor((monthCount - 1) / 2);
    const candidateStart = candidateTotal - offset;
    if (candidateStart > todayMonthTotal) {
      return false;
    }
    return true;
  }, [month, monthCount, visibleMonths, maxAllowedMonth, todayMonthTotal]);

  const collapseAll = useCallback(() => {
    setCollapsed(Object.fromEntries(data.groups.map((g) => [g.id, true])));
  }, [data.groups]);

  const expandAll = useCallback(() => setCollapsed({}), []);

  const shiftMonth = useCallback(
    (delta: number) => {
      if (delta > 0 && !canShiftRight) return;
      const { year: y, month0 } = parseMonthKey(month);
      const total = y * 12 + month0 + delta;
      const nextMonth = monthKey(Math.floor(total / 12), ((total % 12) + 12) % 12);
      setMonth(nextMonth);
      if (view === "budget") {
        updateUrl(view, accountFilter, nextMonth);
      }
    },
    [month, view, accountFilter, updateUrl, canShiftRight]
  );

  const handleSetMonth = useCallback(
    (m: string) => {
      const clamped = m > maxAllowedMonth ? maxAllowedMonth : m;
      setMonth(clamped);
      if (view === "budget") {
        updateUrl(view, accountFilter, clamped);
      }
    },
    [view, accountFilter, updateUrl, maxAllowedMonth]
  );

  const handleSetMonthCount = useCallback(
    (count: number) => {
      setMonthCount(count);
      if (count > 1 && month > today) {
        setMonth(today);
        if (view === "budget") {
          updateUrl(view, accountFilter, today);
        }
      }
    },
    [setMonthCount, month, today, view, accountFilter, updateUrl]
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

  // Single-click entry: resume a paused rule on the fly so posting never
  // takes two clicks. This performs exactly the resume-then-post the user
  // would otherwise do manually, with no new server capabilities.
  const postRecurringOneClick = useCallback(
    async (id: number, date?: string) => {
      const today = todayISO();
      const r = data.recurring.find((x) => x.id === id);
      if (r && !r.active) {
        await api.updateRecurring(id, { active: true });
      }
      await api.postRecurring(id, date ?? (r && r.nextDate > today ? today : undefined));
    },
    [api, data.recurring]
  );

  const otherAccounts = useMemo(
    () => data.accounts.filter((a) => a.id !== accountFilter),
    [data.accounts, accountFilter]
  );

  const payeesForAutocomplete: SearchListOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of data.transactions) {
      const p = (t.payee || "").trim();
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => ({ value: name, label: name }));
  }, [data.transactions]);

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
