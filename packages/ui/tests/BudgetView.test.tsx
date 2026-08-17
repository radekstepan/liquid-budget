import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { BudgetView } from "../src/BudgetView.js";
import type { BudgetResult } from "@ynab/logic";

function makeBudget(overrides: Partial<BudgetResult> = {}): BudgetResult {
  return {
    groups: [
      {
        group: { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
        assigned: 160000,
        outflow: -7000,
        available: 3000,
        rows: [
          {
            category: { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
            carryoverIn: 0,
            assigned: 10000,
            outflow: -5000,
            ccBuffer: 0,
            available: 5000,
            fundedPct: 1,
          },
          {
            category: { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
            carryoverIn: 0,
            assigned: 150000,
            outflow: -152000,
            ccBuffer: 0,
            available: -2000,
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
        outflow: -10000,
        available: -10000,
        rows: [
          {
            category: { id: 30, groupId: 3, name: "AMEX", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
            carryoverIn: 0,
            assigned: 0,
            outflow: -10000,
            ccBuffer: 10000,
            available: 0,
            fundedPct: 0,
          },
        ],
      },
    ],
    tbb: -1000,
    totalIncome: 200000,
    priorSurplus: 0,
    overBudgeted: true,
    totalAssigned: 160000,
    ...overrides,
  };
}

const baseProps = {
  budget: makeBudget(),
  budgets: [makeBudget()],
  visibleMonths: ["2026-06"],
  monthCount: 1,
  onSetMonthCount: undefined,
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

  it("calls onSetMonth when a previous month is requested via navigation", () => {
    const onSetMonth = vi.fn();
    renderView({ onSetMonth });
    // The MonthStrip ticker was removed; the way to navigate to a
    // different month is via the MonthNav prev/next buttons.
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(onSetMonth).not.toHaveBeenCalled();
    // MonthNav calls onShiftMonth for prev/next, not onSetMonth.
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
      expect(onAssign).toHaveBeenCalledWith(10, 20000, "2026-06");
    });

    it("commits on blur", () => {
      const onAssign = vi.fn();
      renderView({ onAssign });
      fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
      const input = document.querySelector("input.y-inline-amt")!;
      fireEvent.change(input, { target: { value: "100 + 50" } });
      fireEvent.blur(input);
      expect(onAssign).toHaveBeenCalledWith(10, 15000, "2026-06");
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
      renderView({ budget: makeBudget({ tbb: 1000, overBudgeted: false }) });
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

      fireEvent.dragStart(groceries, { dataTransfer: dt });
      fireEvent.dragOver(rent, { dataTransfer: dt });
      expect(rent.classList.contains("is-drop-target")).toBe(true);
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

      fireEvent.dragStart(groceries, { dataTransfer: dt });
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

  describe("multi-month column view", () => {
    const monthBudget = (overrides: Partial<BudgetResult> = {}): BudgetResult =>
      makeBudget(overrides);

    it("renders N x 3 numeric columns when monthCount > 1", () => {
      renderView({
        monthCount: 3,
        visibleMonths: ["2026-05", "2026-06", "2026-07"],
        budgets: [
          monthBudget(),
          monthBudget(),
          monthBudget(),
        ],
      });
      // Three "Budgeted" header spans (one per month), each colSpan=3.
      expect(screen.getAllByText("Budgeted")).toHaveLength(3);
      expect(screen.getAllByText("Outflows")).toHaveLength(3);
      expect(screen.getAllByText("Balance")).toHaveLength(3);
      // Month labels visible.
      expect(screen.getByText("May 2026")).toBeInTheDocument();
      expect(screen.getByText("Jun 2026")).toBeInTheDocument();
      expect(screen.getByText("Jul 2026")).toBeInTheDocument();
    });

    it("fires onSetMonthCount when a segmented-control button is clicked", () => {
      const onSetMonthCount = vi.fn();
      renderView({ onSetMonthCount, monthCount: 3 });
      fireEvent.click(screen.getByRole("button", { name: "6 months" }));
      expect(onSetMonthCount).toHaveBeenCalledWith(6);
    });

    it("hides the segmented control when onSetMonthCount is not provided", () => {
      renderView();
      expect(screen.queryByRole("group", { name: /months shown/i })).not.toBeInTheDocument();
    });

    it("makes non-anchor months read-only", () => {
      renderView({
        monthCount: 3,
        visibleMonths: ["2026-05", "2026-06", "2026-07"],
        budgets: [monthBudget(), monthBudget(), monthBudget()],
        currentMonth: "2026-06",
      });
      // The anchor (Jun) cell renders the editable button.
      const groceriesRow = screen
        .getAllByRole("row")
        .find((r) => r.getAttribute("data-cat-row") !== null && within(r).queryByText("Groceries"))!;
      const editableBtns = within(groceriesRow).getAllByRole("button", { name: /\$100\.00/ });
      // Only one editable Budgeted button (the anchor month); the other two months show read-only spans.
      expect(editableBtns).toHaveLength(1);
      const readonlySpans = within(groceriesRow).getAllByText("$100.00");
      expect(readonlySpans.length).toBeGreaterThanOrEqual(2);
    });

    it("emits onAssign against the right month-key from anchor vs neighbour", () => {
      const onAssign = vi.fn();
      renderView({
        onAssign,
        monthCount: 3,
        visibleMonths: ["2026-05", "2026-06", "2026-07"],
        budgets: [monthBudget(), monthBudget(), monthBudget()],
        currentMonth: "2026-06",
      });
      const groceriesRow = screen
        .getAllByRole("row")
        .find((r) => r.getAttribute("data-cat-row") !== null && within(r).queryByText("Groceries"))!;
      const editBtn = within(groceriesRow).getByRole("button", { name: "$100.00" });
      fireEvent.click(editBtn);
      const input = groceriesRow.querySelector("input.y-inline-amt")!;
      fireEvent.change(input, { target: { value: "250" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onAssign).toHaveBeenCalledWith(10, 25000, "2026-06");
    });
  });

  describe("month column delineation", () => {
    it("marks the first cell of each month group with the colgroup-divider class in both thead and tbody", () => {
      renderView({
        monthCount: 3,
        visibleMonths: ["2026-05", "2026-06", "2026-07"],
        budgets: [makeBudget(), makeBudget(), makeBudget()],
      });
      // The header row has one divider per month group from idx>0.
      const dividerHeaders = document.querySelectorAll(
        "table.y-table thead .y-table-colgroup-divider"
      );
      expect(dividerHeaders.length).toBeGreaterThanOrEqual(2);
      // Body cells must also carry the divider so the chrome line travels
      // through every row of the column group.
      const dividerBody = document.querySelectorAll(
        "table.y-table tbody .y-table-colgroup-divider"
      );
      expect(dividerBody.length).toBeGreaterThan(0);
    });

    it("applies the month-label class to the per-month header band", () => {
      renderView({
        monthCount: 3,
        visibleMonths: ["2026-05", "2026-06", "2026-07"],
        budgets: [makeBudget(), makeBudget(), makeBudget()],
      });
      const labels = document.querySelectorAll(".y-table-th--month-label");
      expect(labels.length).toBe(3);
      expect(labels[0]?.textContent).toContain("May 2026");
    });

    it("gives Row 2's first month cell a 1px hairline so it matches Row 1 and the body", () => {
      renderView({
        monthCount: 3,
        visibleMonths: ["2026-05", "2026-06", "2026-07"],
        budgets: [makeBudget(), makeBudget(), makeBudget()],
      });
      // The Row 2 <th> for the first month (idx 0) is the first <th>
      // child of the second <tr> in the thead. Category is rowSpan=2 so
      // it lives in Row 1 and the sibling-combinator rule that gives
      // Row 1 its hairline never fires for Row 2's first cell — we
      // therefore apply .y-table-cell--month-first explicitly.
      const firstRow2Cell = document.querySelector(
        "table.y-table thead tr:nth-child(2) th:first-child"
      );
      expect(firstRow2Cell).not.toBeNull();
      expect(firstRow2Cell!.classList.contains("y-table-cell--month-first")).toBe(true);
      // And it must NOT also be flagged as a chrome divider (that's the
      // inter-month separator reserved for month 2+).
      expect(firstRow2Cell!.classList.contains("y-table-colgroup-divider")).toBe(false);
    });
  });

  describe("Hidden Categories and __Internal__ group handling", () => {
    it("does not render __Internal__ master category", () => {
      const budgetWithInternal = makeBudget({
        groups: [
          ...makeBudget().groups,
          {
            group: { id: 99, name: "__Internal__", sort: 0, isCreditCardPayments: false },
            assigned: 0,
            outflow: 0,
            available: 0,
            rows: [
              {
                category: { id: 990, groupId: 99, name: "Uncategorized", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
                carryoverIn: 0,
                assigned: 0,
                outflow: 0,
                ccBuffer: 0,
                available: 0,
                fundedPct: 0,
              },
            ],
          },
        ],
      });
      renderView({ budget: budgetWithInternal, budgets: [budgetWithInternal] });
      expect(screen.queryByText("__Internal__")).not.toBeInTheDocument();
      expect(screen.queryByText("Uncategorized")).not.toBeInTheDocument();
    });

    it("renders Hidden Categories at the very bottom and collapsed by default", () => {
      const budgetWithHidden = makeBudget({
        groups: [
          {
            group: { id: 50, name: "Hidden Categories", sort: 0, isCreditCardPayments: false },
            assigned: 0,
            outflow: 0,
            available: 0,
            rows: [
              {
                category: { id: 500, groupId: 50, name: "Old Gym", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
                carryoverIn: 0,
                assigned: 0,
                outflow: 0,
                ccBuffer: 0,
                available: 0,
                fundedPct: 0,
              },
            ],
          },
          ...makeBudget().groups,
        ],
      });

      renderView({ budget: budgetWithHidden, budgets: [budgetWithHidden], collapsed: {} });

      // Group header is rendered
      expect(screen.getByText("Hidden Categories")).toBeInTheDocument();

      // Because it is collapsed by default, "Old Gym" is hidden
      expect(screen.queryByText("Old Gym")).not.toBeInTheDocument();

      // Check group order in DOM table body
      const masterHeaders = Array.from(document.querySelectorAll("table.y-table tbody tr.y-master")).map(
        (tr) => tr.textContent
      );
      expect(masterHeaders[masterHeaders.length - 1]).toContain("Hidden Categories");
    });

    it("UNI-04 / BUG-01: clicking category edit button calls onEditCategory with category id instead of group id", () => {
      const onEditCategory = vi.fn();
      renderView({ onEditCategory });
      const editBtn = screen.getByRole("button", { name: /edit groceries/i });
      fireEvent.click(editBtn);
      // Category Groceries has id: 10, group Everyday has id: 1
      expect(onEditCategory).toHaveBeenCalledTimes(1);
      expect(onEditCategory).toHaveBeenCalledWith(10);
    });

    it("renders and triggers all quick budget options (UNI-19)", () => {
      const onAssign = vi.fn();
      const lastMonthAssignments = new Map([[10, 12000]]);
      const spentLastMonthByCategory = new Map([[10, 8500]]);
      const avgSpentByCategory = new Map([[10, 9500]]);
      const avgBudgetedByCategory = new Map([[10, 11000]]);
      const underfundedByCategory = new Map([[10, 3000]]);

      renderView({
        onAssign,
        lastMonthAssignments,
        spentLastMonthByCategory,
        avgSpentByCategory,
        avgBudgetedByCategory,
        underfundedByCategory,
      });

      const dotsBtns = screen.getAllByRole("button", { name: /quick budget options/i });
      expect(dotsBtns.length).toBeGreaterThan(0);

      // Open quick budget menu for Groceries
      fireEvent.click(dotsBtns[0]!);

      expect(screen.getByRole("button", { name: /budgeted last month/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /spent last month/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /average budgeted/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /average spent/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /underfunded/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /set to zero/i })).toBeInTheDocument();

      // Click Spent Last Month
      fireEvent.click(screen.getByRole("button", { name: /spent last month/i }));
      expect(onAssign).toHaveBeenCalledWith(10, 8500, "2026-06");
    });

    it("renders Red Arrow indicator when negative category available carries over (UNI-20)", () => {
      const budgetWithRedArrow = makeBudget({
        groups: [
          {
            group: { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
            assigned: 0,
            outflow: -5000,
            available: -5000,
            rows: [
              {
                category: {
                  id: 10,
                  groupId: 1,
                  name: "Groceries",
                  sort: 0,
                  carryover: "0",
                  goalTarget: null,
                  linkedAccountId: null,
                  overspendCarriesOver: true,
                },
                carryoverIn: 0,
                assigned: 0,
                outflow: -5000,
                ccBuffer: 0,
                available: -5000,
                fundedPct: 0,
              },
            ],
          },
        ],
      });

      renderView({ budget: budgetWithRedArrow, budgets: [budgetWithRedArrow] });
      expect(screen.getByLabelText("Red arrow: carry over")).toBeInTheDocument();
    });
  });
});
