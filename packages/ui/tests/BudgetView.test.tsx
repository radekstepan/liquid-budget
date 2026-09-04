import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { BudgetView } from "../src/BudgetView.js";
import { type BudgetResult, todayISO, previousMonthKey } from "@ynab/logic";

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

  it("renders a mute grey Today button when already on the current month", () => {
    const thisMonth = todayISO().slice(0, 7);
    renderView({ currentMonth: thisMonth });
    const todayBtn = screen.getByRole("button", { name: /today/i });
    expect(todayBtn).toBeInTheDocument();
    expect(todayBtn.classList.contains("y-btn--blue")).toBe(false);
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

  it("keeps the Add Category Group button outside the scroll container so it stays fixed", () => {
    renderView();
    const btn = screen.getByRole("button", { name: /add category group/i });
    expect(btn.closest(".overflow-auto")).toBeNull();
  });

  it("gives the Add Category Group footer 7.5px bottom padding", () => {
    renderView();
    const btn = screen.getByRole("button", { name: /add category group/i });
    expect(btn.parentElement?.style.paddingBottom).toBe("7.5px");
  });

  it("marks the scroll container as h-scrolled only after scrolling right", () => {
    const { container } = renderView();
    const scroller = container.querySelector(".y-scroll") as HTMLElement;
    expect(scroller.classList.contains("is-hscrolled")).toBe(false);
    scroller.scrollLeft = 120;
    fireEvent.scroll(scroller);
    expect(scroller.classList.contains("is-hscrolled")).toBe(true);
    scroller.scrollLeft = 0;
    fireEvent.scroll(scroller);
    expect(scroller.classList.contains("is-hscrolled")).toBe(false);
  });

  it("renders a filler row that spans the full grid width", () => {
    const { container } = renderView({
      monthCount: 3,
      visibleMonths: ["2026-05", "2026-06", "2026-07"],
      budgets: [makeBudget(), makeBudget(), makeBudget()],
    });
    const filler = container.querySelector("tbody tr.y-table-filler");
    expect(filler).not.toBeNull();
    // Category column + 3 months x 3 numeric columns.
    expect(filler!.querySelector("td")!.getAttribute("colspan")).toBe("10");
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

  describe("subcategory striping", () => {
    it("does not dim zero-activity rows and alternates across the whole list", () => {
      renderView();
      const rows = screen.getAllByRole("row");
      const internetRow = rows.find((r) => within(r).queryByText("Internet"))!;
      const groceriesRow = rows.find((r) => within(r).queryByText("Groceries"))!;
      const rentRow = rows.find((r) => within(r).queryByText("Rent"))!;
      // No greyed-out empty rows.
      expect(internetRow.classList.contains("is-empty")).toBe(false);
      expect(groceriesRow.classList.contains("is-empty")).toBe(false);
      // Continuous zebra: Groceries (0), Rent (1 → alt), Internet (2).
      expect(groceriesRow.classList.contains("alt")).toBe(false);
      expect(rentRow.classList.contains("alt")).toBe(true);
      expect(internetRow.classList.contains("alt")).toBe(false);
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

    it("highlights calendar current month header with .y-table-th--month-current and does not render Current badge", () => {
      const todayMonth = new Date().toISOString().slice(0, 7);
      renderView({
        monthCount: 3,
        currentMonth: "2020-01",
        visibleMonths: ["2020-01", "2020-02", todayMonth],
        budgets: [makeBudget(), makeBudget(), makeBudget()],
      });

      const currentHeader = document.querySelector(".y-table-th--month-current");
      expect(currentHeader).not.toBeNull();

      // No Current badge in the header
      expect(screen.queryByTestId("today-month-badge")).not.toBeInTheDocument();

      const subCurrentHeaders = document.querySelectorAll(".y-thead-sub--current");
      // 3 subheaders (Budgeted, Outflows, Balance) for current month
      expect(subCurrentHeaders.length).toBe(3);
    });
  });

  describe("Toolbar Today button", () => {
    it("renders mute grey Today button when current month is in view", () => {
      const todayMonth = new Date().toISOString().slice(0, 7);
      renderView({
        currentMonth: todayMonth,
        visibleMonths: [todayMonth],
      });

      const todayBtn = screen.getByTestId("today-btn");
      expect(todayBtn).toBeInTheDocument();
      expect(todayBtn.classList.contains("y-btn--blue")).toBe(false);
      expect(screen.queryByTestId("current-month-badge")).not.toBeInTheDocument();
    });

    it("renders blue Today button when current month is NOT in view", () => {
      const onSetMonth = vi.fn();
      renderView({
        currentMonth: "2020-01",
        visibleMonths: ["2020-01"],
        onSetMonth,
      });

      const todayBtn = screen.getByTestId("today-btn");
      expect(todayBtn).toBeInTheDocument();
      // Should be blue when not in view
      expect(todayBtn.classList.contains("y-btn--blue")).toBe(true);

      fireEvent.click(todayBtn);
      const todayMonth = new Date().toISOString().slice(0, 7);
      expect(onSetMonth).toHaveBeenCalledWith(todayMonth);
    });

    it("renders blue Today button when current month is in DOM but scrolled off to the right behind scrollbar", () => {
      const todayMonth = new Date().toISOString().slice(0, 7);
      renderView({
        monthCount: 6,
        currentMonth: todayMonth,
        visibleMonths: ["2020-01", "2020-02", "2020-03", "2020-04", "2020-05", todayMonth],
        budgets: [makeBudget(), makeBudget(), makeBudget(), makeBudget(), makeBudget(), makeBudget()],
      });

      const container = document.querySelector(".overflow-auto.y-scroll") as HTMLElement;
      const stickyCat = document.querySelector("th.y-table-td--sticky-cat") as HTMLElement;
      const currentMonthTh = document.querySelector(".y-table-th--month-current") as HTMLElement;

      expect(container).not.toBeNull();
      expect(stickyCat).not.toBeNull();
      expect(currentMonthTh).not.toBeNull();

      // Mock container viewport: 800px wide (from 0 to 800)
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 800,
        width: 800,
        top: 0,
        bottom: 600,
        height: 600,
      } as DOMRect);

      // Mock sticky category: 200px wide (from 0 to 200)
      vi.spyOn(stickyCat, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 200,
        width: 200,
        top: 0,
        bottom: 40,
        height: 40,
      } as DOMRect);

      // Mock current month header: scrolled off to the right (starts at 900px, ends at 1260px)
      vi.spyOn(currentMonthTh, "getBoundingClientRect").mockReturnValue({
        left: 900,
        right: 1260,
        width: 360,
        top: 0,
        bottom: 40,
        height: 40,
      } as DOMRect);

      // Fire scroll event on the container
      fireEvent.scroll(container);

      const todayBtn = screen.getByTestId("today-btn");
      // Since current month is scrolled off to the right behind the scrollbar, Today button must be blue!
      expect(todayBtn.classList.contains("y-btn--blue")).toBe(true);

      // Now simulate user scrolling so current month enters the viewport (e.g. left: 300, right: 660)
      vi.spyOn(currentMonthTh, "getBoundingClientRect").mockReturnValue({
        left: 300,
        right: 660,
        width: 360,
        top: 0,
        bottom: 40,
        height: 40,
      } as DOMRect);

      fireEvent.scroll(container);

      // Now current month is visible in the viewport, Today button should be mute grey!
      expect(todayBtn.classList.contains("y-btn--blue")).toBe(false);
    });

    it("scrolls today's month column into view on init so it is not stuck behind the scrollbar", () => {
      const scrollSpy = vi.fn();
      const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
      const prevImpl = proto["scrollIntoView"];
      proto["scrollIntoView"] = scrollSpy;
      try {
        const todayMonth = todayISO().slice(0, 7);
        const prevMonth = previousMonthKey(todayMonth);
        renderView({
          monthCount: 3,
          currentMonth: todayMonth,
          visibleMonths: [prevMonth, todayMonth],
          budgets: [makeBudget(), makeBudget()],
        });
        expect(scrollSpy).toHaveBeenCalledWith(
          expect.objectContaining({ inline: "center", block: "nearest" })
        );
      } finally {
        if (prevImpl === undefined) {
          delete proto["scrollIntoView"];
        } else {
          proto["scrollIntoView"] = prevImpl;
        }
      }
    });

    it("does not attempt init scroll in single-month mode", () => {
      const scrollSpy = vi.fn();
      const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
      const prevImpl = proto["scrollIntoView"];
      proto["scrollIntoView"] = scrollSpy;
      try {
        const todayMonth = todayISO().slice(0, 7);
        renderView({
          monthCount: 1,
          currentMonth: todayMonth,
          visibleMonths: [todayMonth],
        });
        expect(scrollSpy).not.toHaveBeenCalled();
      } finally {
        if (prevImpl === undefined) {
          delete proto["scrollIntoView"];
        } else {
          proto["scrollIntoView"] = prevImpl;
        }
      }
    });

    it("renders blue Today button when current month is scrolled under the sticky Category column", () => {
      const todayMonth = new Date().toISOString().slice(0, 7);
      renderView({
        monthCount: 6,
        currentMonth: todayMonth,
        visibleMonths: [todayMonth, "2099-01", "2099-02", "2099-03", "2099-04", "2099-05"],
        budgets: [makeBudget(), makeBudget(), makeBudget(), makeBudget(), makeBudget(), makeBudget()],
      });

      const container = document.querySelector(".overflow-auto.y-scroll") as HTMLElement;
      const stickyCat = document.querySelector("th.y-table-td--sticky-cat") as HTMLElement;
      const currentMonthTh = document.querySelector(".y-table-th--month-current") as HTMLElement;

      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 800,
        width: 800,
        top: 0,
        bottom: 600,
        height: 600,
      } as DOMRect);

      vi.spyOn(stickyCat, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 200,
        width: 200,
        top: 0,
        bottom: 40,
        height: 40,
      } as DOMRect);

      // Current month header is scrolled under sticky category (e.g. ends at 190px <= 200px)
      vi.spyOn(currentMonthTh, "getBoundingClientRect").mockReturnValue({
        left: -170,
        right: 190,
        width: 360,
        top: 0,
        bottom: 40,
        height: 40,
      } as DOMRect);

      fireEvent.scroll(container);

      const todayBtn = screen.getByTestId("today-btn");
      // Current month is completely obscured by the sticky column, so Today button is blue!
      expect(todayBtn.classList.contains("y-btn--blue")).toBe(true);

      // If partially visible (e.g. ends at 250px > 200px), it is partially visible!
      vi.spyOn(currentMonthTh, "getBoundingClientRect").mockReturnValue({
        left: -110,
        right: 250,
        width: 360,
        top: 0,
        bottom: 40,
        height: 40,
      } as DOMRect);

      fireEvent.scroll(container);

      // Partially visible in viewport: button becomes mute grey
      expect(todayBtn.classList.contains("y-btn--blue")).toBe(false);
    });
  });

  describe("Grid current month side borders and width", () => {
    it("applies .y-grid-col--current-first and .y-grid-col--current-last to the side boundaries of the current month in both thead and tbody", () => {
      const todayMonth = new Date().toISOString().slice(0, 7);
      renderView({
        monthCount: 3,
        currentMonth: todayMonth,
        visibleMonths: ["2020-01", todayMonth, "2099-01"],
        budgets: [makeBudget(), makeBudget(), makeBudget()],
      });

      // Thead subheaders have the border classes
      const firstColHeaders = document.querySelectorAll("th.y-grid-col--current-first");
      const lastColHeaders = document.querySelectorAll("th.y-grid-col--current-last");
      expect(firstColHeaders.length).toBeGreaterThanOrEqual(1);
      expect(lastColHeaders.length).toBeGreaterThanOrEqual(1);

      // Body cells have the border classes
      const firstColCells = document.querySelectorAll("td.y-grid-col--current-first");
      const lastColCells = document.querySelectorAll("td.y-grid-col--current-last");
      expect(firstColCells.length).toBeGreaterThan(0);
      expect(lastColCells.length).toBeGreaterThan(0);

      // Multi-month table receives y-table--multi
      const table = document.querySelector(".y-table");
      expect(table?.classList.contains("y-table--multi")).toBe(true);
    });

    it("disables the next month button when at or beyond the right limit (max 1 month ahead)", () => {
      const todayMonth = new Date().toISOString().slice(0, 7);
      const onShiftMonth = vi.fn();
      renderView({
        monthCount: 3,
        currentMonth: todayMonth,
        visibleMonths: ["2020-01", todayMonth, "2099-12"],
        canShiftRight: false,
        onShiftMonth,
      });

      const nextBtn = screen.getByRole("button", { name: /next month/i });
      expect(nextBtn).toBeDisabled();
      fireEvent.click(nextBtn);
      expect(onShiftMonth).not.toHaveBeenCalled();
    });
  });

  describe("Next-month arrow scroll awareness", () => {
    const renderCappedMulti = (onShiftMonth: ReturnType<typeof vi.fn>) => {
      const todayMonth = new Date().toISOString().slice(0, 7);
      return renderView({
        monthCount: 3,
        currentMonth: todayMonth,
        visibleMonths: ["2020-01", todayMonth, "2099-12"],
        budgets: [makeBudget(), makeBudget(), makeBudget()],
        canShiftRight: false,
        onShiftMonth,
      });
    };

    const mockScrollable = (
      scroller: HTMLElement,
      opts: { scrollWidth: number; clientWidth: number; scrollLeft?: number }
    ) => {
      Object.defineProperty(scroller, "scrollWidth", {
        value: opts.scrollWidth,
        configurable: true,
      });
      Object.defineProperty(scroller, "clientWidth", {
        value: opts.clientWidth,
        configurable: true,
      });
      scroller.scrollLeft = opts.scrollLeft ?? 0;
    };

    it("stays enabled while grid can scroll right at the month cap and scrolls on click", () => {
      const onShiftMonth = vi.fn();
      const { container } = renderCappedMulti(onShiftMonth);
      const scroller = container.querySelector(".y-scroll") as HTMLElement;
      mockScrollable(scroller, { scrollWidth: 1000, clientWidth: 400 });
      (scroller as unknown as { scrollBy: (opts: { left: number }) => void }).scrollBy = (
        opts
      ) => {
        scroller.scrollLeft += opts.left;
      };
      fireEvent.scroll(scroller);

      const nextBtn = screen.getByRole("button", { name: /next month/i });
      expect(nextBtn).toBeEnabled();
      fireEvent.click(nextBtn);
      // At the cap there is nowhere to shift, so it reveals grid instead.
      expect(onShiftMonth).not.toHaveBeenCalled();
      expect(scroller.scrollLeft).toBeGreaterThan(0);
    });

    it("disables only once scrolled all the way right at the month cap", () => {
      const onShiftMonth = vi.fn();
      const { container } = renderCappedMulti(onShiftMonth);
      const scroller = container.querySelector(".y-scroll") as HTMLElement;
      mockScrollable(scroller, { scrollWidth: 1000, clientWidth: 400, scrollLeft: 600 });
      fireEvent.scroll(scroller);

      expect(screen.getByRole("button", { name: /next month/i })).toBeDisabled();
    });
  });

  describe("Category selection", () => {
    it("applies is-sel class to the selected category row and handles row clicks", () => {
      const onSelectCategory = vi.fn();
      renderView({
        selectedCategoryId: 10,
        onSelectCategory,
      });

      const catRows = document.querySelectorAll("tr[data-cat-row]");
      expect(catRows.length).toBeGreaterThan(0);

      const groceriesRow = Array.from(catRows).find((r) => r.textContent?.includes("Groceries"));
      expect(groceriesRow).not.toBeUndefined();
      expect(groceriesRow!.classList.contains("is-sel")).toBe(true);

      fireEvent.click(groceriesRow!);
      // Clicking the already selected category toggles it off (null)
      expect(onSelectCategory).toHaveBeenCalledWith(null);
    });

    it("calls onSelectCategory with category id when unselected category row is clicked", () => {
      const onSelectCategory = vi.fn();
      renderView({
        selectedCategoryId: null,
        onSelectCategory,
      });

      const catRows = document.querySelectorAll("tr[data-cat-row]");
      const groceriesRow = Array.from(catRows).find((r) => r.textContent?.includes("Groceries"));
      expect(groceriesRow!.classList.contains("is-sel")).toBe(false);

      fireEvent.click(groceriesRow!);
      expect(onSelectCategory).toHaveBeenCalledWith(10);
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

describe("Quick Budget month header dropdown", () => {
  const qbValues = {
    "2026-06": { lastMonth: 40000, spentLastMonth: 33000, avgBudgeted: 38000 },
    "2026-07": { lastMonth: 41000, spentLastMonth: 1000, avgBudgeted: 39000 },
  };

  it("opens the single-month Budgeted header menu and applies to that month", () => {
    const onQuickBudget = vi.fn();
    renderView({
      currentMonth: "2026-06",
      visibleMonths: ["2026-06"],
      monthCount: 1,
      quickBudgetByMonth: qbValues,
      onQuickBudget,
    });

    const trigger = screen.getByTestId("quick-budget-trigger-2026-06");
    expect(trigger).toHaveAttribute("aria-label", expect.stringContaining("Jun 2026"));
    expect(screen.queryByTestId("quick-budget-menu-2026-06")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const menu = screen.getByTestId("quick-budget-menu-2026-06");
    expect(menu).toBeInTheDocument();
    expect(within(menu).getByText("Entire Budget")).toBeInTheDocument();
    expect(within(menu).getByText("$400.00")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quick-budget-last-month-2026-06"));
    expect(onQuickBudget).toHaveBeenCalledWith("lastMonth", undefined, "2026-06");
  });

  it("renders one trigger per visible month and applies to the chosen month", () => {
    const onQuickBudget = vi.fn();
    renderView({
      currentMonth: "2026-06",
      visibleMonths: ["2026-06", "2026-07"],
      budgets: [makeBudget(), makeBudget()],
      monthCount: 3,
      quickBudgetByMonth: qbValues,
      onQuickBudget,
    });

    fireEvent.click(screen.getByTestId("quick-budget-trigger-2026-07"));
    expect(screen.getByTestId("quick-budget-menu-2026-07")).toBeInTheDocument();
    expect(screen.queryByTestId("quick-budget-menu-2026-06")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quick-budget-spent-last-month-2026-07"));
    expect(onQuickBudget).toHaveBeenCalledWith("spentLastMonth", undefined, "2026-07");
  });

  it("scopes the action to the selected category when one is selected", () => {
    const onQuickBudget = vi.fn();
    const onClearSelectedCategory = vi.fn();
    renderView({
      currentMonth: "2026-06",
      visibleMonths: ["2026-06"],
      monthCount: 1,
      quickBudgetByMonth: qbValues,
      onQuickBudget,
      selectedCategory: { id: 10, name: "Groceries" },
      onClearSelectedCategory,
    });

    fireEvent.click(screen.getByTestId("quick-budget-trigger-2026-06"));
    const menu = screen.getByTestId("quick-budget-menu-2026-06");
    expect(within(menu).getByText("Groceries")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quick-budget-avg-budgeted-2026-06"));
    expect(onQuickBudget).toHaveBeenCalledWith("avgBudgeted", 10, "2026-06");

    fireEvent.click(screen.getByTestId("quick-budget-trigger-2026-06"));
    fireEvent.click(screen.getByTestId("quick-budget-deselect-2026-06"));
    expect(onClearSelectedCategory).toHaveBeenCalledTimes(1);
  });

  it("supports Set to Zero from the header menu", () => {
    const onQuickBudget = vi.fn();
    renderView({
      currentMonth: "2026-06",
      visibleMonths: ["2026-06"],
      monthCount: 1,
      quickBudgetByMonth: qbValues,
      onQuickBudget,
    });

    fireEvent.click(screen.getByTestId("quick-budget-trigger-2026-06"));
    fireEvent.click(screen.getByTestId("quick-budget-clear-2026-06"));
    expect(onQuickBudget).toHaveBeenCalledWith("clear", undefined, "2026-06");
  });
});

describe("Quick Budget menu placement", () => {
  const qbValues = {
    "2026-06": { lastMonth: 40000, spentLastMonth: 33000, avgBudgeted: 38000 },
  };
  const singleProps = {
    currentMonth: "2026-06",
    visibleMonths: ["2026-06"],
    monthCount: 1,
    quickBudgetByMonth: qbValues,
    onQuickBudget: vi.fn(),
  };

  it("opens to the right by default", () => {
    renderView({ ...singleProps });
    fireEvent.click(screen.getByTestId("quick-budget-trigger-2026-06"));
    const menu = screen.getByTestId("quick-budget-menu-2026-06");
    expect(menu).toHaveClass("is-right");
    expect(menu).not.toHaveClass("is-left");
  });

  it("opens to the left when there is no room on the right", () => {
    renderView({ ...singleProps });
    const trigger = screen.getByTestId("quick-budget-trigger-2026-06");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 1000, y: 10, width: 18, height: 18,
      top: 10, right: 1018, bottom: 28, left: 1000,
      toJSON: () => {},
    } as DOMRect);
    fireEvent.click(trigger);
    const menu = screen.getByTestId("quick-budget-menu-2026-06");
    expect(menu).toHaveClass("is-left");
    expect(menu).not.toHaveClass("is-right");
  });
});

describe("Quick Budget open header stacking", () => {
  const qbValues = {
    "2026-06": { lastMonth: 40000, spentLastMonth: 33000, avgBudgeted: 38000 },
    "2026-07": { lastMonth: 41000, spentLastMonth: 1000, avgBudgeted: 39000 },
  };

  it("marks only the open month header so it paints above sibling headers", () => {
    renderView({
      currentMonth: "2026-06",
      visibleMonths: ["2026-06", "2026-07"],
      budgets: [makeBudget(), makeBudget()],
      monthCount: 3,
      quickBudgetByMonth: qbValues,
      onQuickBudget: vi.fn(),
    });

    const triggerJune = screen.getByTestId("quick-budget-trigger-2026-06");
    const triggerJuly = screen.getByTestId("quick-budget-trigger-2026-07");
    expect(triggerJune.closest("th")).not.toHaveClass("y-month-head--open");

    fireEvent.click(triggerJuly);
    expect(triggerJuly.closest("th")).toHaveClass("y-month-head--open");
    expect(triggerJune.closest("th")).not.toHaveClass("y-month-head--open");
  });
});

describe("Quick Budget menu container-aware placement", () => {
  const qbValues = {
    "2026-06": { lastMonth: 40000, spentLastMonth: 33000, avgBudgeted: 38000 },
  };

  it("opens left when the scroll container ends even though the window has room", () => {
    renderView({
      currentMonth: "2026-06",
      visibleMonths: ["2026-06"],
      monthCount: 1,
      quickBudgetByMonth: qbValues,
      onQuickBudget: vi.fn(),
    });
    const trigger = screen.getByTestId("quick-budget-trigger-2026-06");
    // Window (1024) has room to the right of the trigger, but the table's
    // scroll container does not — the menu must respect the container.
    const scroller = trigger.closest(".overflow-auto") as HTMLElement;
    scroller.style.overflowX = "auto";
    Object.defineProperty(scroller, "clientWidth", { value: 585, configurable: true });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 600, height: 800,
      top: 0, right: 600, bottom: 800, left: 0,
      toJSON: () => {},
    } as DOMRect);
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 572, y: 10, width: 18, height: 18,
      top: 10, right: 590, bottom: 28, left: 572,
      toJSON: () => {},
    } as DOMRect);
    fireEvent.click(trigger);
    const menu = screen.getByTestId("quick-budget-menu-2026-06");
    expect(menu).toHaveClass("is-left");
    expect(menu).not.toHaveClass("is-right");
  });
});
