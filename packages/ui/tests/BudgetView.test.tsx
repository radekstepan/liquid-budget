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

  it("shifts months via the MonthNav", () => {
    const onShiftMonth = vi.fn();
    renderView({ onShiftMonth });
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(onShiftMonth).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(onShiftMonth).toHaveBeenCalledWith(1);
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
    // The group name is an inner span (role=button) that opens the edit
    // modal; the wrapping <button> is the collapse toggle.
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
});
