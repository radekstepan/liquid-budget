import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Inspector } from "../src/Inspector.js";

const baseProps = {
  groups: [],
  summary: { assigned: 0, outflow: 0, available: 0, totalAvailable: 0 },
  month: "2026-06",
  tbb: 0,
  overBudgeted: false,
  priorSurplus: 0,
  cashFlow: {
    month: "2026-06",
    income: 500000,
    outflow: 350000,
    net: 150000,
    savingsRate: 30,
  },
  trailingNetWorth: {
    points: [
      { month: "2025-07", assets: 1000000, debts: 0, net: 1000000 },
      { month: "2025-08", assets: 1050000, debts: 0, net: 1050000 },
      { month: "2025-09", assets: 1100000, debts: 0, net: 1100000 },
      { month: "2025-10", assets: 1150000, debts: 0, net: 1150000 },
      { month: "2025-11", assets: 1200000, debts: 0, net: 1200000 },
      { month: "2025-12", assets: 1250000, debts: 0, net: 1250000 },
      { month: "2026-01", assets: 1300000, debts: 0, net: 1300000 },
      { month: "2026-02", assets: 1350000, debts: 0, net: 1350000 },
      { month: "2026-03", assets: 1400000, debts: 0, net: 1400000 },
      { month: "2026-04", assets: 1450000, debts: 0, net: 1450000 },
      { month: "2026-05", assets: 1500000, debts: 0, net: 1500000 },
      { month: "2026-06", assets: 1600000, debts: 0, net: 1600000 },
    ],
    currentNet: 1600000,
    startNet: 1000000,
    delta: 600000,
    pctDelta: 60,
  },
  insights: [
    {
      id: "trend-1",
      type: "trend" as const,
      categoryName: "Dining Out",
      amount: 45000,
      avgAmount: 32000,
      pctChange: 41,
      message: "Dining Out: $450 (+41% vs 3-mo avg)",
    },
    {
      id: "trend-2",
      type: "trend" as const,
      categoryName: "Groceries",
      amount: 60000,
      avgAmount: 50000,
      pctChange: 20,
      message: "Groceries: $600 (+20% vs 3-mo avg)",
    },
  ],
  onSelectMonth: () => {},
};

describe("Inspector", () => {
  it("renders the budget name header and month", () => {
    render(<Inspector {...baseProps} />);
    expect(screen.getByText("Demo Budget")).toBeInTheDocument();
    expect(screen.getByText("Jun 2026")).toBeInTheDocument();
  });

  it("opens the settings menu when the gear is clicked", () => {
    render(<Inspector {...baseProps} />);
    expect(screen.queryByText("Reset demo data")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByText("Import YNAB4 Backup")).toBeInTheDocument();
  });

  it("calls onResetDemo when the modal is confirmed", async () => {
    const onResetDemo = vi.fn().mockResolvedValue(undefined);
    render(<Inspector {...baseProps} onResetDemo={onResetDemo} />);

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByText("Reset demo data"));

    expect(screen.getByText("Reset demo data?")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, reset it/i }));
    });
    expect(onResetDemo).toHaveBeenCalledTimes(1);
  });

  it("does not call onResetDemo when the modal is cancelled", () => {
    const onResetDemo = vi.fn();
    render(<Inspector {...baseProps} onResetDemo={onResetDemo} />);

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByText("Reset demo data"));

    expect(screen.getByText("Reset demo data?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onResetDemo).not.toHaveBeenCalled();
  });

  it("hides the Reset menu item when onResetDemo is not provided", () => {
    render(<Inspector {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.queryByText("Reset demo data")).not.toBeInTheDocument();
  });

  describe("Net Monthly Card", () => {
    it("renders income, outflow, net savings, and savings rate", () => {
      render(<Inspector {...baseProps} />);
      expect(screen.getByText("Net Monthly")).toBeInTheDocument();
      expect(screen.getByText("+$1,500.00")).toBeInTheDocument();
      expect(screen.getByText("30% saved")).toBeInTheDocument();
      expect(screen.getByText("+$5,000.00")).toBeInTheDocument();
      expect(screen.getByText("-$3,500.00")).toBeInTheDocument();
    });
  });

  describe("12-Month Net Worth Card", () => {
    it("renders current net worth, 12-month change, and interactive month buttons", () => {
      const onSelectMonth = vi.fn();
      render(<Inspector {...baseProps} onSelectMonth={onSelectMonth} />);

      expect(screen.getByText("Net Worth (12 mo)")).toBeInTheDocument();
      expect(screen.getByText("$16,000.00")).toBeInTheDocument();
      expect(screen.getByTitle("12-Month Change")).toHaveTextContent("$6,000.00");

      const mayBtn = screen.getByRole("button", { name: /jump to may 2026/i });
      expect(mayBtn).toBeInTheDocument();
      fireEvent.click(mayBtn);
      expect(onSelectMonth).toHaveBeenCalledWith("2026-05");
    });
  });

  describe("Trends & Insights Card", () => {
    it("renders 3-month average category trends sorted by % without yellow highlight or icons", () => {
      render(<Inspector {...baseProps} />);
      expect(screen.getByText("Trends & Insights")).toBeInTheDocument();
      expect(screen.getByText("Dining Out")).toBeInTheDocument();
      expect(screen.getByText("+41%")).toBeInTheDocument();
      expect(screen.getByText("Groceries")).toBeInTheDocument();
      expect(screen.getByText("+20%")).toBeInTheDocument();
    });
  });
});
