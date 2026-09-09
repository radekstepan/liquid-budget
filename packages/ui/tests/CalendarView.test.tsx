import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CalendarView } from "../src/CalendarView.js";
import type { BudgetData, Transaction } from "@ynab/logic";

function txn(day: number, payee: string, amountInDollars: number): Transaction {
  const amountCents = Math.round(amountInDollars * 100);
  return {
    id: day * 100 + Math.abs(amountCents),
    accountId: 1,
    categoryId: 10,
    date: `2026-06-${String(day).padStart(2, "0")}`,
    payee,
    memo: "",
    amount: String(amountCents),
    status: "u",
  };
}

function makeData(txns: Transaction[], accounts?: BudgetData["accounts"]): BudgetData {
  return {
    accounts: accounts ?? [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 0 },
    ],
    groups: [],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: txns,
    recurring: [],
  };
}

function renderView(overrides: Record<string, unknown> = {}) {
  const onPrev = vi.fn();
  const onNext = vi.fn();
  const onAdd = vi.fn();
  const props = {
    data: makeData([]),
    month: "2026-06",
    onPrev,
    onNext,
    onAdd,
    ...overrides,
  } as Parameters<typeof CalendarView>[0];
  render(<CalendarView {...props} />);
  return { onPrev, onNext, onAdd };
}

describe("CalendarView", () => {
  it("renders the month grid and shifts months", () => {
    const { onPrev, onNext } = renderView();
    expect(screen.getByText("Calendar")).toBeInTheDocument();
    for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      expect(screen.getByText(d)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(onPrev).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(onNext).toHaveBeenCalled();
  });

  it("shows Net this month as the signed sum of the month's transactions", () => {
    renderView({ data: makeData([txn(1, "Payroll", 2000), txn(3, "Shop", -50.5)]) });
    expect(screen.getByText("$1,949.50")).toBeInTheDocument();
  });

  it("calls onAdd with the ISO date when an empty day is clicked", () => {
    const { onAdd } = renderView({ data: makeData([txn(5, "Shop", -10)]) });
    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-10/i });
    fireEvent.click(dayCell);
    expect(onAdd).toHaveBeenCalledWith("2026-06-10");
  });

  it("shows up to three pills per day and expands via the overflow button", () => {
    const txns = [1, 2, 3, 4, 5].map((i) => txn(6, `Payee ${i}`, -i * 10));
    renderView({ data: makeData(txns) });

    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-06/i });
    const cell = within(dayCell);

    expect(cell.getByText("Payee 1")).toBeInTheDocument();
    expect(cell.getByText("Payee 2")).toBeInTheDocument();
    expect(cell.getByText("Payee 3")).toBeInTheDocument();
    expect(cell.queryByText("Payee 4")).not.toBeInTheDocument();

    fireEvent.click(cell.getByRole("button", { name: /\+2 more/i }));
    expect(cell.getByText("Payee 4")).toBeInTheDocument();
    expect(cell.getByText("Payee 5")).toBeInTheDocument();
    // "+N more" is replaced by the expanded pill list; the cell itself
    // toggles the expansion back.
    expect(cell.queryByRole("button", { name: /\+2 more/i })).not.toBeInTheDocument();
  });

  it("toggles expansion by clicking a populated day cell", () => {
    const txns = [1, 2, 3, 4].map((i) => txn(12, `Payee ${i}`, -i * 10));
    renderView({ data: makeData(txns) });

    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-12/i });
    expect(within(dayCell).queryByText("Payee 4")).not.toBeInTheDocument();

    fireEvent.click(dayCell);
    expect(within(dayCell).getByText("Payee 4")).toBeInTheDocument();

    fireEvent.click(dayCell);
    expect(within(dayCell).queryByText("Payee 4")).not.toBeInTheDocument();
  });

  it("shows the day net for days with transactions", () => {
    renderView({ data: makeData([txn(15, "Shop", -25), txn(15, "Coffee", -5)]) });
    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-15/i });
    expect(within(dayCell).getByText("-$30.00")).toBeInTheDocument();
  });

  it("does not call onAdd for a populated day when clicking cell background", () => {
    const { onAdd } = renderView({ data: makeData([txn(20, "Shop", -10)]) });
    fireEvent.click(screen.getByRole("button", { name: /add transaction on 2026-06-20/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("calls onAdd when clicking plus button on a populated day (BUG-15)", () => {
    const { onAdd } = renderView({ data: makeData([txn(20, "Shop", -10)]) });
    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-20/i });
    const plusBtn = within(dayCell).getByRole("button", { name: /^add transaction$/i });
    fireEvent.click(plusBtn);
    expect(onAdd).toHaveBeenCalledWith("2026-06-20");
  });

  it("calls onAdd when clicking plus button on an empty day (BUG-15)", () => {
    const { onAdd } = renderView({ data: makeData([]) });
    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-05/i });
    const plusBtn = within(dayCell).getByRole("button", { name: /^add transaction$/i });
    fireEvent.click(plusBtn);
    expect(onAdd).toHaveBeenCalledWith("2026-06-05");
  });

  it("shows empty-state banner when month has no transactions or events (UNI-42 / BUG-35)", () => {
    renderView({ data: makeData([]) });
    expect(
      screen.getByText("No transactions or scheduled events for this month. Click any day to add a transaction.")
    ).toBeInTheDocument();
  });

  it("excludes internal on-budget transfers from monthTotal and dayNet (BUG-10)", () => {
    const accounts: BudgetData["accounts"] = [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "50000", onBudget: true, sort: 1 },
    ];
    const transferTxn: Transaction = {
      id: 101,
      accountId: 1,
      transferAccountId: 2,
      categoryId: null,
      date: "2026-06-10",
      payee: "Transfer : Savings",
      memo: "",
      amount: "-100000",
      status: "u",
    };
    renderView({ data: makeData([transferTxn], accounts) });

    expect(screen.getByText("Net this month:")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();

    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-10/i });
    expect(within(dayCell).getByText("Transfer : Savings")).toBeInTheDocument();
    expect(within(dayCell).getByText("-$1,000.00")).toBeInTheDocument();

    // dayNet is 0, so the day net badge is not rendered
    expect(within(dayCell).queryByText("-$1,000.00", { selector: "span.text-\\[10\\.5px\\]" })).not.toBeInTheDocument();
  });

  it("factors boundary transfers into monthTotal and dayNet", () => {
    const accounts: BudgetData["accounts"] = [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 0 },
      { id: 3, name: "Investments", kind: "offbudget", groupLabel: "Tracking", balance: "500000", onBudget: false, sort: 2 },
    ];
    const boundaryOutflow: Transaction = {
      id: 201,
      accountId: 1,
      transferAccountId: 3,
      categoryId: 10,
      date: "2026-06-15",
      payee: "Transfer : Investments",
      memo: "",
      amount: "-50000",
      status: "u",
    };
    renderView({ data: makeData([boundaryOutflow], accounts) });

    const netToolbar = screen.getByText("Net this month:").closest("span")!;
    expect(within(netToolbar).getByText("-$500.00")).toBeInTheDocument();

    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-15/i });
    expect(within(dayCell).getByText("Transfer : Investments")).toBeInTheDocument();
    expect(within(dayCell).getByText("-$500.00", { selector: "span.text-\\[10\\.5px\\]" })).toBeInTheDocument();
  });

  it("stacks one pill per line with single-line ellipsis overflow (no side-by-side pills)", () => {
    const accounts: BudgetData["accounts"] = [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "50000", onBudget: true, sort: 1 },
    ];
    const transferTxn: Transaction = {
      id: 401,
      accountId: 1,
      transferAccountId: 2,
      categoryId: null,
      date: "2026-06-10",
      payee: "Transfer : Savings With A Very Long Account Name",
      memo: "",
      amount: "-100000",
      status: "u",
    };
    renderView({ data: makeData([transferTxn, txn(10, "Coffee", -5)], accounts) });

    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-10/i });
    // One block-level wrapper per pill: pills stack vertically instead of
    // sitting next to each other and overflowing the day cell.
    const wraps = within(dayCell).getAllByText(/Transfer : Savings|Coffee/);
    expect(wraps.length).toBe(2);
    for (const pill of wraps) {
      const wrap = pill.closest(".y-tip-wrap")!;
      const classes = wrap.className.split(/\s+/);
      expect(classes).toContain("block");
      expect(classes).not.toContain("inline-flex");
      // Single line with ellipsis overflow for long transfer names.
      expect(pill.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["truncate", "flex-1", "min-w-0"])
      );
    }
  });

  it("excludes internal transfer from dayNet when mixed with standard expense", () => {
    const accounts: BudgetData["accounts"] = [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "100000", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "50000", onBudget: true, sort: 1 },
    ];
    const transferTxn: Transaction = {
      id: 301,
      accountId: 1,
      transferAccountId: 2,
      categoryId: null,
      date: "2026-06-20",
      payee: "Transfer : Savings",
      memo: "",
      amount: "-50000",
      status: "u",
    };
    const coffeeTxn = txn(20, "Coffee", -5);

    renderView({ data: makeData([transferTxn, coffeeTxn], accounts) });

    const netToolbar = screen.getByText("Net this month:").closest("span")!;
    expect(within(netToolbar).getByText("-$5.00")).toBeInTheDocument();

    const dayCell = screen.getByRole("button", { name: /add transaction on 2026-06-20/i });
    expect(within(dayCell).getByText("-$5.00", { selector: "span.text-\\[10\\.5px\\]" })).toBeInTheDocument();
  });
});
