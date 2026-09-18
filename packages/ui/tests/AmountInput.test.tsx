import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AmountFieldError, amountValidationMessage } from "../src/AmountInput.js";

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
