"use client";

import { useCallback, useState, useTransition } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { BudgetData, Query, RenameRule, Transaction } from "@ynab/logic";
import { renameRulePayeeFilter } from "@ynab/logic";
import type { View } from "./Sidebar.js";
import type { GlobalSearchJump } from "./GlobalSearch.js";

export type FocusTransaction = { id: number; nonce: number } | null;

export type RegisterFilter = {
  payee?: string;
  categoryId?: number | null;
  text?: string;
  query?: Query;
  nonce: number;
} | null;

export type BudgetViewRoutingArgs = {
  data: BudgetData;
  month: string;
  updateUrl: (newView: View, newAccount: number | null, newMonth: string) => void;
  setView: (v: View) => void;
  accountFilter: number | null;
  setAccountFilter: (id: number | null) => void;
  setShowSettingsOverlay: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
};

export type BudgetViewRouting = {
  reportsResetKey: number;
  setReportsResetKey: Dispatch<SetStateAction<number>>;
  focusTransaction: FocusTransaction;
  registerFilter: RegisterFilter;
  navigateView: (v: View) => void;
  handleSelectAccount: (id: number) => void;
  handleBadgeClick: (accountId: number, kind: "new" | "duplicates") => void;
  handleSelectTransactionFromReport: (t: Transaction) => void;
  handleGoToTransfer: (targetAccountId: number, targetTxnId: number) => void;
  handleClearRegisterFilter: () => void;
  handleGlobalSearchJump: (jump: GlobalSearchJump) => void;
  handleViewRuleMatches: (rule: RenameRule) => void;
};

/** View routing for the app shell (ui-split slice 13, BudgetApp slice 3).
 * Owns the navigation-target state (reports reset key, focused row,
 * register filter) and every view jump: sidebar/account/badge navigation,
 * report-to-register and transfer jumps, global-search jumps, and rename
 * rule-match jumps. View/account state stays in the shell (the month hook
 * also consumes it); overlay and search-modal visibility likewise stay
 * with their UI domains and are only dismissed from here. */
export function useBudgetViewRouting({
  data,
  month,
  updateUrl,
  setView,
  accountFilter,
  setAccountFilter,
  setShowSettingsOverlay,
  setSearchOpen,
}: BudgetViewRoutingArgs): BudgetViewRouting {
  const [reportsResetKey, setReportsResetKey] = useState(0);
  const [focusTransaction, setFocusTransaction] = useState<{ id: number; nonce: number } | null>(null);
  const [registerFilter, setRegisterFilter] = useState<{
    payee?: string;
    categoryId?: number | null;
    text?: string;
    query?: Query;
    nonce: number;
  } | null>(null);
  const [, startTransition] = useTransition();

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

  return {
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
  };
}
