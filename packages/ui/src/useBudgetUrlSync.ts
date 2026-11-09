"use client";

import { useCallback, useEffect } from "react";
import { isValidISOMonth } from "@ynab/logic";
import type { View } from "./Sidebar.js";

/**
 * Path-based nice URLs (`/budget/2026-01`, `/transactions/12`) kept in
 * sync with view state. Returns `updateUrl` for navigation handlers;
 * the mount effect parses the initial path and follows popstate.
 * The transactions URL is the source of truth for the account filter.
 */
export function useBudgetUrlSync(args: {
  setView: (v: View) => void;
  setAccountFilter: (id: number | null) => void;
  setMonth: (m: string) => void;
}): (newView: View, newAccount: number | null, newMonth: string) => void {
  const { setView, setAccountFilter, setMonth } = args;
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
  return updateUrl;
}
