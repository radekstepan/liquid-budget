import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ACCOUNT_FILTER_STORAGE_KEY,
  isStoredAccountFilter,
  resolveAccountFilter,
} from "../src/BudgetApp.js";
import {
  SIDEBAR_SECTIONS_STORAGE_KEY,
  isCollapsedSections,
  Sidebar,
} from "../src/Sidebar.js";
import type { Account } from "@ynab/logic";

describe("account filter prefs", () => {
  it("validates stored values", () => {
    expect(isStoredAccountFilter(null)).toBe(true);
    expect(isStoredAccountFilter(3)).toBe(true);
    expect(isStoredAccountFilter(0)).toBe(false);
    expect(isStoredAccountFilter(-1)).toBe(false);
    expect(isStoredAccountFilter(1.5)).toBe(false);
    expect(isStoredAccountFilter("3")).toBe(false);
    expect(isStoredAccountFilter({})).toBe(false);
    expect(ACCOUNT_FILTER_STORAGE_KEY).toBe("ynab:transactions:accountFilter");
  });

  it("falls back to all accounts when the stored id is gone", () => {
    const accounts = [{ id: 1 }, { id: 2 }];
    expect(resolveAccountFilter(null, accounts)).toBeNull();
    expect(resolveAccountFilter(2, accounts)).toBe(2);
    expect(resolveAccountFilter(99, accounts)).toBeNull();
    expect(resolveAccountFilter(99, [])).toBeNull();
  });
});

describe("sidebar section prefs", () => {
  it("validates stored section maps", () => {
    expect(isCollapsedSections({ Retirement: true })).toBe(true);
    expect(isCollapsedSections({})).toBe(true);
    expect(isCollapsedSections({ Retirement: "yes" })).toBe(false);
    expect(isCollapsedSections([])).toBe(false);
    expect(isCollapsedSections(null)).toBe(false);
  });

  const accounts: Account[] = [
    { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "10000", onBudget: true, sort: 0 },
    { id: 4, name: "Retirement", kind: "offbudget", groupLabel: "Retirement", balance: "5800000", onBudget: false, sort: 3 },
  ];

  const sidebarProps = {
    view: "budget" as const,
    setView: () => {},
    accounts,
    selectedAccountId: null as number | null,
    onSelectAccount: () => {},
    onAddAccount: () => {},
  };

  it("persists section collapse across mounts", () => {
    const { unmount } = render(<Sidebar {...sidebarProps} />);
    // Retirement starts collapsed: only the section head mentions it.
    expect(screen.getAllByText("Retirement")).toHaveLength(1);
    const head = screen.getByText("Retirement").closest("button");
    expect(head).not.toBeNull();
    fireEvent.click(head!);
    // Expanded: the account row appears too.
    expect(screen.getAllByText("Retirement")).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY)!)).toMatchObject({
      Retirement: false,
    });

    unmount();
    render(<Sidebar {...sidebarProps} />);
    // Still expanded after remount — the preference survived.
    expect(screen.getAllByText("Retirement")).toHaveLength(2);
  });
});
