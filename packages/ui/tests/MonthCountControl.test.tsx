import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MonthCountControl } from "../src/MonthCountControl.js";

describe("MonthCountControl (ui-split slice 2)", () => {
  it("renders four options with singular/plural labels", () => {
    render(<MonthCountControl value={3} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "1 month" })).toBeDefined();
    expect(screen.getByRole("button", { name: "3 months" })).toBeDefined();
    expect(screen.getByRole("button", { name: "6 months" })).toBeDefined();
    expect(screen.getByRole("button", { name: "12 months" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Months shown" })).toBeDefined();
  });

  it("marks only the current value pressed", () => {
    render(<MonthCountControl value={6} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "6 months" }).getAttribute("aria-pressed")).toBe("true");
    for (const name of ["1 month", "3 months", "12 months"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("calls onChange with the clicked option", () => {
    const onChange = vi.fn();
    render(<MonthCountControl value={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "12 months" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(12);
  });
});
