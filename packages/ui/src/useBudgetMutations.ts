"use client";

import { useCallback } from "react";
import type { BudgetData, TransactionFlagColor } from "@ynab/logic";
import { todayISO } from "@ynab/logic";
import type { BudgetAppApi } from "./BudgetAppApi.js";

export type BudgetMutationsArgs = {
  api: BudgetAppApi;
  data: BudgetData;
  month: string;
  accountFilter: number | null;
};

export type BudgetMutations = {
  assign: (categoryId: number, amount: number, m?: string) => Promise<void>;
  cycleStatus: (id: number) => Promise<void>;
  setFlag: (id: number, flagColor: TransactionFlagColor | null) => Promise<void>;
  postRecurringOneClick: (id: number, date?: string) => Promise<void>;
};

/** Entity-mutation callbacks for the app shell (ui-split slice 12,
 * BudgetApp slice 2). Thin wrappers over BudgetAppApi with per-action
 * pre-logic: month defaulting, cleared-status cycling with incoming
 * transfer handling, flag writes, and resume-then-post for recurring.
 * Reload/optimistic behavior stays in the api layer (skipReload
 * semantics); these wrappers only shape the calls. */
export function useBudgetMutations({
  api,
  data,
  month,
  accountFilter,
}: BudgetMutationsArgs): BudgetMutations {
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

  return { assign, cycleStatus, setFlag, postRecurringOneClick };
}
