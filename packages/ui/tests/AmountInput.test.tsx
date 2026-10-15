import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AmountFieldError,
  AmountFieldWithCalculator,
  amountValidationMessage,
} from "../src/AmountInput.js";

describe("amountValidationMessage", () => {
  it("returns null for empty and valid input", () => {
    expect(amountValidationMessage("")).toBeNull();
    expect(amountValidationMessage("   ")).toBeNull();
    expect(amountValidationMessage("45.50")).toBeNull();
    expect(amountValidationMessage("10+5")).toBeNull();
  });

  it("explains unparseable input", () => {
    expect(amountValidationMessage("abc")).toMatch(/valid amount/i);
  });

  it("explains zero amounts", () => {
    expect(amountValidationMessage("0")).toMatch(/zero/i);
  });
});

describe("AmountFieldError", () => {
  it("renders nothing for empty and valid input", () => {
    const { rerender } = render(<AmountFieldError value="" />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<AmountFieldError value="12.50" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an alert for invalid and zero input", () => {
    const { rerender } = render(<AmountFieldError value="abc" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/valid amount/i);
    rerender(<AmountFieldError value="0" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/zero/i);
  });
});

function CalculatorHarness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <AmountFieldWithCalculator
      value={value}
      onChange={setValue}
      ariaLabel="Amount"
    />
  );
}

describe("AmountFieldWithCalculator", () => {
  it("renders the amount input with a calculator toggle and no open popover", () => {
    render(<CalculatorHarness initial="12.50" />);
    expect(screen.getByLabelText("Amount")).toHaveValue("12.50");
    expect(
      screen.getByRole("button", { name: "Open calculator" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog", { name: "Calculator" })).toBeNull();
  });

  it("opens an expression popover seeded with the current value", () => {
    render(<CalculatorHarness initial="12.50" />);
    fireEvent.click(screen.getByRole("button", { name: "Open calculator" }));
    expect(screen.getByRole("dialog", { name: "Calculator" })).toBeInTheDocument();
    expect(screen.getByLabelText("Math expression")).toHaveValue("12.50");
    expect(screen.getByText("= $12.50")).toBeInTheDocument();
  });

  it("evaluates an expression live and applies the formatted result", () => {
    render(<CalculatorHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open calculator" }));
    fireEvent.change(screen.getByLabelText("Math expression"), {
      target: { value: "10 + 5 * 2" },
    });
    expect(screen.getByText("= $20.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByLabelText("Amount")).toHaveValue("20.00");
    expect(screen.queryByRole("dialog", { name: "Calculator" })).toBeNull();
  });

  it("applies with Enter and closes with Escape without changing the value", () => {
    render(<CalculatorHarness initial="7.00" />);
    fireEvent.click(screen.getByRole("button", { name: "Open calculator" }));
    const expr = screen.getByLabelText("Math expression");
    fireEvent.change(expr, { target: { value: "1 + 2" } });
    fireEvent.keyDown(expr, { key: "Enter" });
    expect(screen.getByLabelText("Amount")).toHaveValue("3.00");

    fireEvent.click(screen.getByRole("button", { name: "Open calculator" }));
    const reopened = screen.getByLabelText("Math expression");
    fireEvent.change(reopened, { target: { value: "100" } });
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Calculator" })).toBeNull();
    expect(screen.getByLabelText("Amount")).toHaveValue("3.00");
  });

  it("disables Apply for invalid expressions", () => {
    render(<CalculatorHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open calculator" }));
    fireEvent.change(screen.getByLabelText("Math expression"), {
      target: { value: "10 +" },
    });
    expect(screen.getByText("Enter a valid expression")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("keeps the last valid number visible greyed out while mid-typing", () => {
    render(<CalculatorHarness initial="12.50" />);
    fireEvent.click(screen.getByRole("button", { name: "Open calculator" }));
    const expr = screen.getByLabelText("Math expression");
    fireEvent.change(expr, { target: { value: "12.50 +" } });
    const stale = screen.getByText("= $12.50");
    expect(stale).toHaveStyle("opacity: 0.65");
    expect(screen.queryByText("Enter a valid expression")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    // The result goes live again once the expression parses.
    fireEvent.change(expr, { target: { value: "12.50 + 1" } });
    expect(screen.getByText("= $13.50")).toHaveStyle("opacity: 1");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("never evaluates expressions with eval() or new Function()", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(here, "../src/AmountInput.tsx"), "utf8");
    // Ignore the doc comment naming the banned APIs in backticks.
    const withoutParser = src
      .replaceAll("evalAmount", "")
      .replaceAll("`eval()`", "")
      .replaceAll("`new Function()`", "");
    expect(withoutParser).not.toMatch(/[^A-Za-z0-9_$]eval\s*\(/);
    expect(withoutParser).not.toMatch(/new\s+Function\s*\(/);
  });
});
