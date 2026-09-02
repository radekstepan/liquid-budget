import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { BudgetView } from "../src/BudgetView.js";
import { type BudgetResult, todayISO } from "@ynab/logic";

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
    const thisMonth = todayISO().slice(0, 7);
    const nonCurrentMonth = thisMonth === "2025-01" ? "2025-02" : "2025-01";
    renderView({ currentMonth: nonCurrentMonth, onSetMonth });
    const todayBtn = screen.getByRole("button", { name: /today/i });
    fireEvent.click(todayBtn);
    expect(onSetMonth).toHaveBeenCalledTimes(1);
    const arg = onSetMonth.mock.calls[0]![0] as string;
    expect(arg).toMatch(/^\d{4}-\d{2}$/);
    expect(arg).toBe(thisMonth);
  });

  it("does not render a Today button when already on the current month", () => {
    const thisMonth = todayISO().slice(0, 7);
    renderView({ currentMonth: thisMonth });
    expect(screen.queryByRole("button", { name: /today/i })).not.toBeInTheDocument();
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

  it("does not render the dots menu in the toolbar", () => {
    renderView();
    expect(screen.queryByRole("button", { name: /group options/i })).not.toBeInTheDocument();
  });

  it("calls onToggleGroup when a group header is toggled", () => {
    const onToggleGroup = vi.fn();
    renderView({ onToggleGroup });
    fireEvent.click(screen.getByRole("button", { name: /toggle everyday/i }));
    expect(onToggleGroup).toHaveBeenCalledWith(1);
  });

  it("calls onEditGroup when the group name span is clicked", () => {
    const onEditGroup = vi.fn();
    renderView({ onEditGroup });
    fireEvent.click(screen.getByRole("button", { name: /^everyday$/i }));
    expect(onEditGroup).toHaveBeenCalledWith(1);
  });

  describe("inline assignment editing", () => {
    it("renders input with size=1 in fixed width column without resizing", () => {
      renderView();
      const cellBtn = screen.getByRole("button", { name: "$100.00" });
      const parentTd = cellBtn.closest("td");
      expect(parentTd).toHaveClass("w-[120px]");
      fireEvent.click(cellBtn);
      const input = document.querySelector("input.y-inline-amt");
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute("size", "1");
      expect(input?.closest("td")).toHaveClass("w-[120px]");
    });

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

  describe("inline overdraft fix", () => {
    it("shows Unassign button on overdrafted category with assigned > 0", () => {
      const onAssign = vi.fn();
      renderView({ onAssign });
      const btn = screen.getByRole("button", { name: /unassign.*from rent/i });
      expect(btn).toBeInTheDocument();
    });

    it("calls onAssign with 0 when Unassign is clicked", () => {
      const onAssign = vi.fn();
      renderView({ onAssign });
      const btn = screen.getByRole("button", { name: /unassign.*from rent/i });
      fireEvent.click(btn);
      expect(onAssign).toHaveBeenCalledWith(11, 0, "2026-06");
    });

    it("shows overspent text on overdrafted category with assigned === 0", () => {
      const budgetWithZeroAssigned = makeBudget({
        groups: [
          {
            group: { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
            assigned: 0,
            outflow: -5000,
            available: -5000,
            rows: [
              {
                category: { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
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
      renderView({ budget: budgetWithZeroAssigned, budgets: [budgetWithZeroAssigned] });
      expect(screen.getByText("overspent")).toBeInTheDocument();
    });

    it("does not show fix text on non-overdrafted categories", () => {
      renderView();
      const groceriesRow = screen
        .getAllByRole("row")
        .find((r) => within(r).queryByText("Groceries"))!;
      expect(within(groceriesRow).queryByText(/unassign/i)).not.toBeInTheDocument();
      expect(within(groceriesRow).queryByText("overspent")).not.toBeInTheDocument();
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

    it("makes every visible month's Budgeted cell editable", () => {
      renderView({
        monthCount: 3,
        visibleMonths: ["2026-05", "2026-06", "2026-07"],
        budgets: [monthBudget(), monthBudget(), monthBudget()],
        currentMonth: "2026-06",
      });
      // All three months render the editable amount button now — the
      // Budgeted column is editable for any month in the window.
      const groceriesRow = screen
        .getAllByRole("row")
        .find((r) => r.getAttribute("data-cat-row") !== null && within(r).queryByText("Groceries"))!;
      const editableBtns = within(groceriesRow).getAllByRole("button", { name: /\$100\.00/ });
      expect(editableBtns).toHaveLength(3);
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
      // Every visible month is editable — index 1 is the anchor (Jun),
      // index 2 is the neighbour month (Jul).
      const editBtns = within(groceriesRow).getAllByRole("button", { name: "$100.00" });
      expect(editBtns).toHaveLength(3);

      fireEvent.click(editBtns[1]!);
      let input = groceriesRow.querySelector("input.y-inline-amt")!;
      fireEvent.change(input, { target: { value: "250" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onAssign).toHaveBeenCalledWith(10, 25000, "2026-06");

      fireEvent.click(editBtns[2]!);
      input = groceriesRow.querySelector("input.y-inline-amt")!;
      fireEvent.change(input, { target: { value: "300" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onAssign).toHaveBeenCalledWith(10, 30000, "2026-07");
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

    it("allows clicking budget cell to edit amount without popover (UNI-19)", () => {
      const onAssign = vi.fn();

      renderView({
        onAssign,
      });

      // No popover dots button should exist in the cell
      const dotsBtns = screen.queryAllByRole("button", { name: /quick budget options/i });
      expect(dotsBtns.length).toBe(0);

      // Clicking an amount button shows input field
      const cellBtn = screen.getByRole("button", { name: "$100.00" });
      fireEvent.click(cellBtn);

      const input = screen.getByRole("textbox");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("100.00");
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

    it("renders user-created group named 'Hidden Categories' with isHidden: false in visible budget grid (BUG-30)", () => {
      const budgetWithCustomHiddenName = makeBudget({
        groups: [
          {
            group: { id: 1, name: "Hidden Categories", sort: 0, isCreditCardPayments: false, isHidden: false },
            assigned: 10000,
            outflow: 0,
            available: 10000,
            rows: [
              {
                category: {
                  id: 10,
                  groupId: 1,
                  name: "Mystery Fund",
                  sort: 0,
                  carryover: "0",
                  goalTarget: null,
                  linkedAccountId: null,
                },
                carryoverIn: 0,
                assigned: 10000,
                outflow: 0,
                ccBuffer: 0,
                available: 10000,
                fundedPct: 1,
              },
            ],
          },
        ],
      });

      renderView({ budget: budgetWithCustomHiddenName, budgets: [budgetWithCustomHiddenName] });
      // Group header should be in document and category visible in normal budget grid
      expect(screen.getByText("Hidden Categories")).toBeInTheDocument();
      expect(screen.getByText("Mystery Fund")).toBeInTheDocument();
      // Should not render as the collapsed special hidden group section at bottom
      expect(screen.queryByText(/unhide/i)).not.toBeInTheDocument();
    });
  });
});
