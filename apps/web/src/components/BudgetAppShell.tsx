"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BudgetApp, ErrorBoundary, useTodayISO, type BudgetAppApi } from "@ynab/ui";
import { Notice, Toast } from "@ynab/theme";
import type { BudgetData } from "@ynab/logic";
import { invalidateBudgetIndex, parseBudgetDataResponse, parseRecurringAutoPostResponse } from "@ynab/logic";
import { logger } from "@/lib/logger";
import { createBudgetApi, createOptimisticMutation, jsonReq, reportBudgetReloadFailure, useToasts, type MutationMessages } from "./api/index";

export function BudgetAppShell({
  initialView = "budget",
  initialMonth,
  initialAccount,
}: {
  initialView?: string;
  initialMonth?: string;
  initialAccount?: number;
}) {
  const [data, _setData] = useState<BudgetData | null>(null);
  const dataRef = useRef<BudgetData | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const setData = useCallback((value: React.SetStateAction<BudgetData | null>) => {
    _setData((prev) => {
      if (prev) {
        invalidateBudgetIndex(prev);
      }
      const next = typeof value === "function" ? (value as (p: BudgetData | null) => BudgetData | null)(prev) : value;
      dataRef.current = next;
      return next;
    });
  }, []);
  const [error, setError] = useState<string | null>(null);
  const { toasts, addToast, dismissToast } = useToasts();
  const [syncingCount, setSyncingCount] = useState(0);
  const reloadSeqRef = useRef(0);
  const latestCompletedReloadSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    const currentMutationSeq = mutationSeqRef.current;
    const budgetRaw: unknown = await jsonReq<unknown>("/api/budget");
    // Fail fast if the server response drifts from the BudgetData contract
    // instead of flowing bad shapes silently into budget calculations.
    const budget = parseBudgetDataResponse(budgetRaw);

    // Drop stale responses if a newer reload has completed or if a newer mutation started
    if (seq <= latestCompletedReloadSeqRef.current || currentMutationSeq < mutationSeqRef.current) {
      return;
    }
    latestCompletedReloadSeqRef.current = seq;

    setData(budget);
  }, []);

  const runMutation = useCallback(
    async <T,>(
      action: () => Promise<T>,
      messages: MutationMessages<T>,
      options?: {
        onRollback?: () => void;
        skipReload?: boolean;
      }
    ): Promise<T> => {
      mutationSeqRef.current++;
      let result: T;
      try {
        result = await action();
      } catch (e) {
        options?.onRollback?.();
        if (messages.notifyFailure !== false) addToast(messages.failure, "danger");
        throw e;
      }

      if (messages.success) addToast(messages.success, "ok");
      messages.onSuccess?.(result);

      if (!options?.skipReload) {
        try {
          await reload();
        } catch (refreshErr) {
          reportBudgetReloadFailure(refreshErr, addToast);
        }
      }

      return result;
    },
    [addToast, reload]
  );

  const withSync = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setSyncingCount((c) => c + 1);
    try {
      return await fn();
    } finally {
      setSyncingCount((c) => Math.max(0, c - 1));
    }
  }, []);

  const runAutoPost = useCallback(async () => {
    try {
      const autoPostRes = parseRecurringAutoPostResponse(
        await jsonReq<unknown>("/api/recurring", {
          method: "POST",
          body: JSON.stringify({ action: "autopost" }),
        })
      );
      if (autoPostRes) {
        const count = autoPostRes.postedCount ?? 0;
        if (count > 0) {
          addToast(
            `Automatically entered ${count} scheduled transaction${
              count === 1 ? "" : "s"
            }.`,
            "ok"
          );
        }
        if (autoPostRes.capped && autoPostRes.capped.length > 0) {
          const names = autoPostRes.capped
            .map((c) => c.payee || "Scheduled transaction")
            .join(", ");
          addToast(
            `Catch-up limit reached for ${names}. Additional overdue occurrences remain.`,
            "warn"
          );
        }
        if (autoPostRes.failures && autoPostRes.failures.length > 0) {
          const names = autoPostRes.failures
            .map((f) => (f.payee ? `${f.payee}: ${f.error}` : f.error))
            .join("; ");
          addToast(
            `Failed to auto-post scheduled transaction: ${names}`,
            "danger"
          );
        }
      }
    } catch (autoErr) {
      logger.error("Auto-post failed:", autoErr);
    }
  }, [addToast]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // Auto-post due scheduled transactions on mount (keeping GET /api/budget pure, BUG-20)
        await runAutoPost();
        if (!mounted) return;
        await reload();
      } catch (e: unknown) {
        if (mounted) setError(String(e));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [reload, runAutoPost]);

  // Overnight rollover: when the wall-date ticks over while the app stays
  // open, re-run auto-post (new rules may have come due at midnight) and
  // reload so the red due-count badges and ledger stay correct. The mount
  // effect above covers the initial load, so skip the first value.
  const today = useTodayISO();
  const initialTodayRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialTodayRef.current == null) {
      initialTodayRef.current = today;
      return;
    }
    if (initialTodayRef.current === today) return;
    initialTodayRef.current = today;
    let cancelled = false;
    (async () => {
      await runAutoPost();
      if (cancelled) return;
      try {
        await reload();
      } catch (e: unknown) {
        logger.error("Budget reload after date rollover failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [today, runAutoPost, reload]);

  const api: BudgetAppApi = {
    reload,
    ...createBudgetApi({
      dataRef,
      setData,
      reload,
      runMutation,
      optimisticMutation: createOptimisticMutation({ reload, runMutation, withSync, addToast }),
      withSync,
      addToast,
    }),
  };

  if (error) {
    return (
      <div className="grid h-screen place-items-center">
        <Notice tone="danger" title="Error" className="!max-w-[480px]">
          {error}
        </Notice>
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
              borderTopColor: "var(--y-side-ink)",
            }}
          />
          <span style={{ color: "var(--y-side-ink)" }}>Loading budget</span>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary name="Budget Application">
      <div className="relative h-screen w-screen overflow-hidden flex flex-col">
        {syncingCount > 0 && (
          <div
            className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full px-3 py-1.5 shadow-md transition-opacity"
            style={{
              background: "var(--y-chrome-top)",
              border: "1px solid var(--y-chrome-line)",
              color: "var(--y-ink)",
              fontSize: "11px",
            }}
            aria-live="polite"
            role="status"
          >
            <div
              className="h-3 w-3 animate-spin rounded-full"
              style={{
                border: "2px solid var(--y-ink-faint)",
                borderTopColor: "var(--y-ink)",
              }}
            />
            <span>Syncing</span>
          </div>
        )}
        <BudgetApp data={data} api={api} initialView={initialView} initialMonth={initialMonth} initialAccount={initialAccount} />
        <Toast items={toasts} onDismiss={dismissToast} />
      </div>
    </ErrorBoundary>
  );
}
