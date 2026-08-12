import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Inspector } from "../src/Inspector.js";

const baseProps = {
  groups: [],
  summary: { assigned: 0, outflow: 0, available: 0, totalAvailable: 0 },
  month: "2026-06",
  history: [],
  avg: 0,
  tbb: 0,
  overBudgeted: false,
  priorSurplus: 0,
  onSelectMonth: () => {},
};

describe("Inspector", () => {
  it("renders the budget name header", () => {
    render(<Inspector {...baseProps} />);
    expect(screen.getByText("Demo Budget")).toBeInTheDocument();
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

  describe("12-Month History", () => {
    const history = [
      { key: "2026-02", assigned: 0, real: false },
      { key: "2026-03", assigned: 0, real: false },
      { key: "2026-04", assigned: 1000, real: true },
      { key: "2026-05", assigned: 1200, real: true },
      { key: "2026-06", assigned: 1500, real: true },
    ];

    it("calls onSelectMonth with the clicked month's key", () => {
      const onSelectMonth = vi.fn();
      render(<Inspector {...baseProps} history={history} onSelectMonth={onSelectMonth} />);
      fireEvent.click(screen.getByRole("button", { name: /jump to may 2026/i }));
      expect(onSelectMonth).toHaveBeenCalledWith("2026-05");
    });

    it("disables the button for months with no real data", () => {
      const onSelectMonth = vi.fn();
      render(<Inspector {...baseProps} history={history} onSelectMonth={onSelectMonth} />);
      const feb = screen.getByRole("button", { name: /jump to feb 2026/i });
      expect(feb).toBeDisabled();
      fireEvent.click(feb);
      expect(onSelectMonth).not.toHaveBeenCalled();
    });

    it("renders non-real months as visible (>=10px) bars so empty slots are obvious", () => {
      render(<Inspector {...baseProps} history={history} onSelectMonth={() => {}} />);
      const feb = screen.getByRole("button", { name: /jump to feb 2026/i });
      // jsdom returns px values verbatim from the inline style.
      const heightPx = parseFloat(feb.style.height);
      expect(heightPx).toBeGreaterThanOrEqual(10);
    });
  });
});
