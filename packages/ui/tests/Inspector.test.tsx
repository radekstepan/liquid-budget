import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
  theme: "light" as const,
  accent: "liquid",
  onToggleTheme: () => {},
  onSetAccent: () => {},
};

describe("Inspector", () => {
  it("renders the budget name header", () => {
    render(<Inspector {...baseProps} />);
    expect(screen.getByText("Demo Budget")).toBeInTheDocument();
  });

  it("opens the settings menu when the hamburger is clicked", () => {
    render(<Inspector {...baseProps} />);
    // Menu is closed by default
    expect(screen.queryByText("Switch to dark")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(screen.getByText("Switch to dark")).toBeInTheDocument();
  });

  it("calls onToggleTheme when the dark/light menu item is clicked", () => {
    const onToggleTheme = vi.fn();
    render(<Inspector {...baseProps} onToggleTheme={onToggleTheme} />);

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    fireEvent.click(screen.getByText("Switch to dark"));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    // Menu should close after action
    expect(screen.queryByText("Switch to dark")).not.toBeInTheDocument();
  });

  it("calls onResetDemo (after confirm) when Reset demo data is clicked", () => {
    const onResetDemo = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Inspector {...baseProps} onResetDemo={onResetDemo} />);

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    fireEvent.click(screen.getByText("Reset demo data"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onResetDemo).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("does not call onResetDemo if the confirm is cancelled", () => {
    const onResetDemo = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Inspector {...baseProps} onResetDemo={onResetDemo} />);

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    fireEvent.click(screen.getByText("Reset demo data"));
    expect(onResetDemo).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("hides the Reset menu item when onResetDemo is not provided", () => {
    render(<Inspector {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
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
  });
});
