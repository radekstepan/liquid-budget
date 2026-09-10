import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
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
  it("renders the settings cog", () => {
    render(<Inspector {...baseProps} />);
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
  });

  it("opens the settings menu when the gear is clicked", () => {
    render(<Inspector {...baseProps} />);
    expect(screen.queryByText("Import YNAB4 Backup")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByText("Import YNAB4 Backup")).toBeInTheDocument();
  });

  describe("ATB banner", () => {
    it("is no longer rendered in the Inspector", () => {
      const { container } = render(
        <Inspector
          {...baseProps}
          tbb={-50000}
          overBudgeted={true}
          priorSurplus={100000}
          totalIncome={200000}
          totalAssigned={350000}
        />
      );
      expect(container.querySelector(".y-atb")).toBeNull();
      expect(screen.queryByText(/To Be Budgeted|Overbudgeted/i)).toBeNull();
    });

    it("renders deferred income indicator when income originates from future transaction dates (BUG-13)", () => {
      render(
        <Inspector
          {...baseProps}
          tbb={100000}
          overBudgeted={false}
          priorSurplus={0}
          totalIncome={100000}
          totalAssigned={0}
          incomeFromFuture={100000}
        />
      );
      const indicator = screen.getByTestId("deferred-income-indicator");
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveTextContent("$1,000.00 of income originated from future transaction dates.");
    });

    it("renders deferred income indicator when income originates from past transaction dates (BUG-13)", () => {
      render(
        <Inspector
          {...baseProps}
          tbb={150000}
          overBudgeted={false}
          priorSurplus={0}
          totalIncome={150000}
          totalAssigned={0}
          incomeFromPast={150000}
        />
      );
      const indicator = screen.getByTestId("deferred-income-indicator");
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveTextContent("$1,500.00 of income originated from past transaction dates.");
    });
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

    it("labels negative outflow as categorized inflow instead of expenses (BUG-11)", () => {
      render(
        <Inspector
          {...baseProps}
          cashFlow={{
            month: "2026-06",
            income: 50000,
            outflow: -10000,
            net: 60000,
            savingsRate: 100,
          }}
        />
      );
      expect(screen.getByText("Categorized inflow (net)")).toBeInTheDocument();
      expect(screen.queryByText("Expenses (Outflow)")).not.toBeInTheDocument();
      expect(screen.getByText("+$100.00")).toBeInTheDocument();
      expect(screen.getByText("+$600.00")).toBeInTheDocument();
      expect(screen.queryByText(/--\$100\.00/)).not.toBeInTheDocument();
    });

    it("shows 'No income' instead of a savings rate when income is zero", () => {
      render(
        <Inspector
          {...baseProps}
          cashFlow={{
            month: "2026-09",
            income: 0,
            outflow: -194967,
            net: 194967,
            savingsRate: 100,
          }}
        />
      );
      expect(screen.getByText("No income")).toBeInTheDocument();
      expect(screen.queryByText(/% saved/)).not.toBeInTheDocument();
      expect(screen.getByText("Categorized inflow (net)")).toBeInTheDocument();
      // Net cash flow and categorized inflow are the same value this month
      expect(screen.getAllByText("+$1,949.67")).toHaveLength(2);
    });
  });

  describe("12-Month Net Worth Card", () => {
    it("renders current net worth, 12-month change, and interactive month buttons", () => {
      const onSelectMonth = vi.fn();
      render(<Inspector {...baseProps} onSelectMonth={onSelectMonth} />);

      expect(screen.getByText("Net Worth (12 mo)")).toBeInTheDocument();
      expect(screen.getByText("$16,000.00")).toBeInTheDocument();
      // No native tooltips: the badge hint renders as a custom tooltip on hover.
      const badge = screen.getByTestId("net-worth-delta");
      expect(badge).toHaveTextContent("$6,000.00");
      expect(badge).not.toHaveAttribute("title");
      fireEvent.mouseOver(badge.closest(".y-tip-wrap")!);
      expect(screen.getByRole("tooltip")).toHaveTextContent("12-Month Change");

      const mayBtn = screen.getByRole("button", { name: /jump to may 2026/i });
      expect(mayBtn).toBeInTheDocument();
      fireEvent.click(mayBtn);
      expect(onSelectMonth).toHaveBeenCalledWith("2026-05");
    });

    it("snaps to closest month when moving across the SVG line chart and resets on leave", () => {
      const onSelectMonth = vi.fn();
      render(<Inspector {...baseProps} onSelectMonth={onSelectMonth} />);

      const getRectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        right: 224,
        bottom: 64,
        width: 224,
        height: 64,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      // Move to X=8 (padX), which corresponds to index 0: 2025-07, net: $10,000
      fireEvent.mouseMove(screen.getByLabelText("12-Month Net Worth Sparkline"), { clientX: 8 });
      expect(screen.getByText("$10,000.00")).toBeInTheDocument();
      expect(screen.getByText("Jul 2025")).toBeInTheDocument();

      // Move to X=216 (W - padX = 224 - 8 = 216), index 11: 2026-06, net: $16,000
      fireEvent.mouseMove(screen.getByLabelText("12-Month Net Worth Sparkline"), { clientX: 216 });
      expect(screen.getByText("$16,000.00")).toBeInTheDocument();
      expect(screen.getByText("Jun 2026")).toBeInTheDocument();

      // Mouse leave resets to Current Net Worth
      fireEvent.mouseLeave(screen.getByLabelText("12-Month Net Worth Sparkline"));
      expect(screen.getByText("Current Net Worth")).toBeInTheDocument();
      expect(screen.getByText("$16,000.00")).toBeInTheDocument();

      getRectSpy.mockRestore();
    });

    it("selects the closest month when clicking directly on the SVG line chart", () => {
      const onSelectMonth = vi.fn();
      render(<Inspector {...baseProps} onSelectMonth={onSelectMonth} />);

      const getRectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        right: 224,
        bottom: 64,
        width: 224,
        height: 64,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      // Click around X=8 (index 0: 2025-07)
      fireEvent.click(screen.getByLabelText("12-Month Net Worth Sparkline"), { clientX: 8 });
      expect(onSelectMonth).toHaveBeenCalledWith("2025-07");

      getRectSpy.mockRestore();
    });
  });

  describe("Import YNAB4 Error Handling (UNI-43 / BUG-36)", () => {
    it("displays in-app modal on import failure without calling alert", async () => {
      const onImportYnab4 = vi.fn().mockRejectedValue(new Error("Invalid backup ZIP format"));
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      const { container } = render(
        <Inspector {...baseProps} onImportYnab4={onImportYnab4} />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      const testFile = new File(["dummy content"], "test.y4backup", { type: "application/zip" });
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [testFile] } });
      });

      expect(onImportYnab4).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
      expect(screen.getByText("Import Failed")).toBeInTheDocument();
      expect(screen.getByText("Invalid backup ZIP format")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
      expect(screen.queryByText("Import Failed")).not.toBeInTheDocument();

      alertSpy.mockRestore();
    });
  });

  describe("Duplicate analysis (settings)", () => {
    it("runs the analysis from the settings menu and shows the result", async () => {
      const onAnalyzeDuplicates = vi.fn().mockResolvedValue({
        groups: [
          {
            fingerprint: "x",
            keeper: {
              id: 1,
              accountId: 1,
              accountName: "Chequing",
              date: "2026-06-01",
              payee: "Store",
              memo: "",
              amount: -1000,
            },
            duplicates: [
              {
                id: 2,
                accountId: 1,
                accountName: "Chequing",
                date: "2026-06-01",
                payee: "Store",
                memo: "",
                amount: -1000,
                flagColor: null,
                status: "c",
              },
            ],
          },
        ],
        duplicateCount: 1,
        flaggedCount: 1,
        alreadyFlaggedCount: 0,
        lockedCount: 0,
        clearedCount: 0,
      });
      render(<Inspector {...baseProps} onAnalyzeDuplicates={onAnalyzeDuplicates} />);

      fireEvent.click(screen.getByRole("button", { name: /settings/i }));
      fireEvent.click(screen.getByText("Flag Duplicates"));

      await waitFor(() =>
        expect(screen.getByText("Duplicate Analysis")).toBeInTheDocument()
      );
      expect(onAnalyzeDuplicates).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/1 duplicate entry in 1 group/)).toBeInTheDocument();
      expect(screen.getByText(/1 marked duplicate/)).toBeInTheDocument();
    });

    it("hides the analyze menu item when the callback is not provided", () => {
      render(<Inspector {...baseProps} />);
      fireEvent.click(screen.getByRole("button", { name: /settings/i }));
      expect(screen.queryByText("Flag Duplicates")).not.toBeInTheDocument();
    });
  });

  describe("Rename rules shortcut", () => {
    it("opens the settings page when the menu item is clicked", () => {
      const onOpenRenameRules = vi.fn();
      render(<Inspector {...baseProps} onOpenRenameRules={onOpenRenameRules} />);
      fireEvent.click(screen.getByRole("button", { name: /settings/i }));
      fireEvent.click(screen.getByText("Rename Rules"));
      expect(onOpenRenameRules).toHaveBeenCalledTimes(1);
    });

    it("hides the menu item when the callback is not provided", () => {
      render(<Inspector {...baseProps} />);
      fireEvent.click(screen.getByRole("button", { name: /settings/i }));
      expect(screen.queryByText("Rename Rules")).not.toBeInTheDocument();
    });
  });

  describe("Page Visibility shortcut", () => {
    it("opens the page when the menu item is clicked", () => {
      const onOpenPageVisibility = vi.fn();
      render(<Inspector {...baseProps} onOpenPageVisibility={onOpenPageVisibility} />);
      fireEvent.click(screen.getByRole("button", { name: /settings/i }));
      const item = screen.getByRole("button", { name: /page visibility/i });
      expect(item.querySelector("svg path")).not.toBeNull();
      fireEvent.click(item);
      expect(onOpenPageVisibility).toHaveBeenCalledTimes(1);
    });

    it("hides the menu item when the callback is not provided", () => {
      render(<Inspector {...baseProps} />);
      fireEvent.click(screen.getByRole("button", { name: /settings/i }));
      expect(screen.queryByText("Page Visibility")).not.toBeInTheDocument();
    });
  });

  describe("Quick Budget", () => {
    it("is no longer rendered in the Inspector (moved to the month header)", () => {
      render(<Inspector {...baseProps} />);
      expect(screen.queryByTestId("quick-budget-panel")).not.toBeInTheDocument();
      expect(screen.queryByText("Quick Budget")).not.toBeInTheDocument();
    });
  });

  describe("Global search", () => {
    const searchData = {
      accounts: [
        { id: 1, name: "Checking", kind: "liquid" as const, groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 },
      ],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [],
      recurring: [],
    };

    it("shows no search box without searchData", () => {
      render(<Inspector {...baseProps} />);
      expect(screen.queryByLabelText("Global search")).not.toBeInTheDocument();
    });

    it("shows the search box next to Settings when searchData is provided", () => {
      render(<Inspector {...baseProps} searchData={searchData} scopeAccountId={null} onSearchJump={() => {}} />);
      expect(screen.getByLabelText("Global search")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
    });
  });
});
