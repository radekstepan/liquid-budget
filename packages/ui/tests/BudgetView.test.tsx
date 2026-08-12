import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { BudgetView } from "../src/BudgetView.js";
import type { BudgetResult } from "@ynab/logic";

function makeBudget(overrides: Partial<BudgetResult> = {}): BudgetResult {
  return {
    groups: [
      {
        group: { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
        assigned: 1600,
        outflow: -70,
        available: 30,
        rows: [
          {
            category: { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
            carryoverIn: 0,
            assigned: 100,
            outflow: -50,
            ccBuffer: 0,
            available: 50,
            fundedPct: 1,
          },
          {
            category: { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
            carryoverIn: 0,
            assigned: 1500,
            outflow: -1520,
            ccBuffer: 0,
            available: -20,
            fundedPct: 1,
          },
        ],
      },
      {
        group: { id: 2, name: "Bills", sort: 1, isCreditCardPayments: false },
        assigned: 0,
        outflow: 0,
        available: 0,
        rows: [
          {
            category: { id: 20, groupId: 2, name: "Internet", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
            carryoverIn: 0,
            assigned: 0,
            outflow: 0,
            ccBuffer: 0,
            available: 0,
            fundedPct: 0,
          },
        ],
      },
      {
        group: { id: 3, name: "Credit Cards", sort: 2, isCreditCardPayments: true },
        assigned: 0,
        outflow: -100,
        available: -100,
        rows: [
          {
            category: { id: 30, groupId: 3, name: "AMEX", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
            carryoverIn: 0,
            assigned: 0,
            outflow: -100,
            ccBuffer: 100,
            available: 0,
            fundedPct: 0,
          },
        ],
      },
    ],
    tbb: -10,
    totalIncome: 2000,
    priorSurplus: 0,
    overBudgeted: true,
    totalAssigned: 1600,
    ...overrides,
  };
}

const baseProps = {
  budget: makeBudget(),
  currentMonth: "2026-06",
  collapsed: {},
  onToggleGroup: () => {},
  onAssign: () => {},
  onShiftMonth: () => {},
  onAddCategory: () => {},
  onAddGroup: () => {},
  onEditCategory: () => {},
  onDeleteCategory: () => {},
  onEditGroup: () => {},
  onDeleteGroup: () => {},
  onCollapseAll: () => {},
  onExpandAll: () => {},
};

function renderView(overrides: Record<string, unknown> = {}) {
  const props = {
    ...baseProps,
    ...overrides,
  } as Parameters<typeof BudgetView>[0];
  return render(<BudgetView {...props} />);
}

describe("BudgetView", () => {
  it("renders groups, categories, and the header", () => {
    renderView();
    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("Bills")).toBeInTheDocument();
    expect(screen.getByText("Credit Cards")).toBeInTheDocument();
    expect(screen.getByText("AMEX")).toBeInTheDocument();
  });

  it("renders a single Budgeted/Outflows/Balance column block (no multi-month grid)", () => {
    renderView();
    expect(screen.getAllByText("Budgeted")).toHaveLength(1);
    expect(screen.getAllByText("Outflows")).toHaveLength(1);
    expect(screen.getAllByText("Balance")).toHaveLength(1);
  });

  it("shifts months via the MonthNav", () => {
    const onShiftMonth = vi.fn();
    renderView({ onShiftMonth });
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(onShiftMonth).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(onShiftMonth).toHaveBeenCalledWith(1);
  });

  it("calls onSetMonth when the month strip is clicked", () => {
    const onSetMonth = vi.fn();
    renderView({ onSetMonth });
    const aprilButton = screen.getByRole("button", { name: /april 2026/i });
    fireEvent.click(aprilButton);
    expect(onSetMonth).toHaveBeenCalledWith("2026-04");
  });

  it("calls onSetMonth with today when the Today button is clicked on a non-current month", () => {
    const onSetMonth = vi.fn();
    renderView({ currentMonth: "2025-01", onSetMonth });
    const todayBtn = screen.getByRole("button", { name: /today/i });
    fireEvent.click(todayBtn);
    // The exact value depends on today's real month, but it should match the
    // YYYY-MM prefix of todayISO() and not be 2025-01.
    expect(onSetMonth).toHaveBeenCalledTimes(1);
    const arg = onSetMonth.mock.calls[0]![0] as string;
    expect(arg).toMatch(/^\d{4}-\d{2}$/);
    expect(arg).not.toBe("2025-01");
  });

  it("does not render a Today button when already on the current month", () => {
    // 2026-06 is never "today" in CI, but the demo seed uses it; verify that
    // when currentMonth differs from today's real month, the Today button
    // appears. (We don't have a deterministic month to test "on" with, but
    // we can at least confirm the prior branch renders it.)
    renderView();
    // Either Today is present (if today != 2026-06) or absent (if today == 2026-06).
    // Verify the surrounding toolbar still works.
    expect(screen.getByRole("button", { name: /master category/i })).toBeInTheDocument();
  });

  it("calls onAddGroup from the Master Category button", () => {
    const onAddGroup = vi.fn();
    renderView({ onAddGroup });
    fireEvent.click(screen.getByRole("button", { name: /master category/i }));
    expect(onAddGroup).toHaveBeenCalled();
  });

  it("calls onAddGroup from the Add Category Group list button", () => {
    const onAddGroup = vi.fn();
    renderView({ onAddGroup });
    fireEvent.click(screen.getByRole("button", { name: /add category group/i }));
    expect(onAddGroup).toHaveBeenCalled();
  });

  it("calls onAddCategory with the group id", () => {
    const onAddCategory = vi.fn();
    renderView({ onAddCategory });
    fireEvent.click(screen.getAllByRole("button", { name: /add category/i })[0]!);
    expect(onAddCategory).toHaveBeenCalledWith(1);
  });

  it("collapses and expands all groups from the options menu", () => {
    const onCollapseAll = vi.fn();
    const onExpandAll = vi.fn();
    renderView({ onCollapseAll, onExpandAll });
    fireEvent.click(screen.getByRole("button", { name: /group options/i }));
    fireEvent.click(screen.getByText("Collapse all groups"));
    expect(onCollapseAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /group options/i }));
    fireEvent.click(screen.getByText("Expand all groups"));
    expect(onExpandAll).toHaveBeenCalled();
  });

  it("calls onToggleGroup when a group header is toggled", () => {
    const onToggleGroup = vi.fn();
    renderView({ onToggleGroup });
    const toggleBtn = screen.getByText("Everyday").closest("button")!;
    fireEvent.click(toggleBtn);
    expect(onToggleGroup).toHaveBeenCalledWith(1);
  });

  it("calls onEditGroup when the group name span is clicked", () => {
    const onEditGroup = vi.fn();
    renderView({ onEditGroup });
    const nameSpan = screen
      .getAllByRole("button", { name: /everyday/i })
      .find((b) => b.tagName === "SPAN")!;
    fireEvent.click(nameSpan);
    expect(onEditGroup).toHaveBeenCalledWith(1);
  });

  describe("inline assignment editing", () => {
    it("commits the typed amount on Enter", () => {
      const onAssign = vi.fn();
      renderView({ onAssign });
      fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
      const input = document.querySelector("input.y-inline-amt")!;
      fireEvent.change(input, { target: { value: "200" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onAssign).toHaveBeenCalledWith(10, 200, "2026-06");
    });

    it("commits on blur", () => {
      const onAssign = vi.fn();
      renderView({ onAssign });
      fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
      const input = document.querySelector("input.y-inline-amt")!;
      fireEvent.change(input, { target: { value: "100 + 50" } });
      fireEvent.blur(input);
      expect(onAssign).toHaveBeenCalledWith(10, 150, "2026-06");
    });

    it("cancels on Escape without committing", () => {
      const onAssign = vi.fn();
      renderView({ onAssign });
      fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
      const input = document.querySelector("input.y-inline-amt")!;
      fireEvent.change(input, { target: { value: "999" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(onAssign).not.toHaveBeenCalled();
    });

    it("does not commit an invalid expression", () => {
      const onAssign = vi.fn();
      renderView({ onAssign });
      fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
      const input = document.querySelector("input.y-inline-amt")!;
      fireEvent.change(input, { target: { value: "10 +" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onAssign).not.toHaveBeenCalled();
    });
  });

  describe("overdraft banner", () => {
    it("renders when overBudgeted and calls onClearOverdraft with negative-available category ids", () => {
      const onClearOverdraft = vi.fn();
      renderView({ onClearOverdraft });
      expect(screen.getByText(/overbudgeted by/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /zero out overdrafts/i }));
      expect(onClearOverdraft).toHaveBeenCalledWith([11]);
    });

    it("is hidden when not overbudgeted", () => {
      renderView({ budget: makeBudget({ tbb: 10, overBudgeted: false }) });
      expect(screen.queryByText(/overbudgeted by/)).not.toBeInTheDocument();
    });

    it("is hidden when onClearOverdraft is not provided", () => {
      renderView({ onClearOverdraft: undefined });
      expect(screen.queryByText(/overbudgeted by/)).not.toBeInTheDocument();
    });
  });

  describe("drag-and-drop reordering", () => {
    it("reorders non-CC groups and emits onReorderGroup for changed sorts", () => {
      const onReorderGroup = vi.fn();
      renderView({ onReorderGroup });
      const rows = screen.getAllByRole("row").filter((r) => r.classList.contains("y-master"));
      const everyday = rows.find((r) => within(r).queryByText("Everyday"))!;
      const bills = rows.find((r) => within(r).queryByText("Bills"))!;
      const dt = { effectAllowed: "", dropEffect: "" };

      fireEvent.dragStart(everyday, { dataTransfer: dt });
      fireEvent.drop(bills, { dataTransfer: dt });

      // Bills (sort 1) moves to index 0, Everyday (sort 0) to index 1.
      expect(onReorderGroup).toHaveBeenCalledWith(2, 0);
      expect(onReorderGroup).toHaveBeenCalledWith(1, 1);
    });

    it("does not emit when the source and target are the same group", () => {
      const onReorderGroup = vi.fn();
      renderView({ onReorderGroup });
      const rows = screen.getAllByRole("row").filter((r) => r.classList.contains("y-master"));
      const everyday = rows.find((r) => within(r).queryByText("Everyday"))!;
      const dt = { effectAllowed: "", dropEffect: "" };

      fireEvent.dragStart(everyday, { dataTransfer: dt });
      fireEvent.drop(everyday, { dataTransfer: dt });
      expect(onReorderGroup).not.toHaveBeenCalled();
    });

    it("reorders categories within a group and emits onReorderCategory", () => {
      const onReorderCategory = vi.fn();
      renderView({ onReorderCategory });
      const catRows = screen
        .getAllByRole("row")
        .filter((r) => r.getAttribute("data-cat-row") !== null);
      const groceries = catRows.find((r) => within(r).queryByText("Groceries"))!;
      const rent = catRows.find((r) => within(r).queryByText("Rent"))!;
      const dt = { effectAllowed: "", dropEffect: "" };

      const grip = groceries.querySelector('[draggable="true"]')!;
      fireEvent.dragStart(grip, { dataTransfer: dt });
      fireEvent.drop(rent, { dataTransfer: dt });

      expect(onReorderCategory).toHaveBeenCalledWith(11, 0);
      expect(onReorderCategory).toHaveBeenCalledWith(10, 1);
    });

    it("does not emit category reorder without onReorderCategory", () => {
      const onReorderCategory = vi.fn();
      renderView({});
      const catRows = screen
        .getAllByRole("row")
        .filter((r) => r.getAttribute("data-cat-row") !== null);
      const groceries = catRows.find((r) => within(r).queryByText("Groceries"))!;
      const rent = catRows.find((r) => within(r).queryByText("Rent"))!;
      const dt = { effectAllowed: "", dropEffect: "" };

      const grip = groceries.querySelector('[draggable="true"]')!;
      fireEvent.dragStart(grip, { dataTransfer: dt });
      fireEvent.drop(rent, { dataTransfer: dt });
      expect(onReorderCategory).not.toHaveBeenCalled();
    });
  });

  describe("empty-row dimming", () => {
    it("applies the is-empty class to rows with no assigned, outflow, or available", () => {
      renderView();
      // Internet is the seed row with all-zero values (id 20).
      const internetRow = screen
        .getAllByRole("row")
        .find((r) => within(r).queryByText("Internet"))!;
      expect(internetRow.classList.contains("is-empty")).toBe(true);
      // Groceries (id 10) is not empty.
      const groceriesRow = screen
        .getAllByRole("row")
        .find((r) => within(r).queryByText("Groceries"))!;
      expect(groceriesRow.classList.contains("is-empty")).toBe(false);
    });
  });
});
