import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Btn } from "../src/ui.js";

describe("Btn", () => {
  it("renders children and applies default ghost variant", () => {
    render(<Btn>Click me</Btn>);
    const btn = screen.getByRole("button", { name: /click me/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Btn onClick={onClick}>Go</Btn>);
    fireEvent.click(screen.getByRole("button", { name: /go/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders primary and danger variants with distinct classes", () => {
    const { rerender } = render(<Btn variant="primary">P</Btn>);
    const primary = screen.getByRole("button", { name: /p/i });
    expect(primary.className).toMatch(/y-btn/);
    expect(primary.className).toMatch(/y-btn--primary/);

    rerender(<Btn variant="danger">D</Btn>);
    const danger = screen.getByRole("button", { name: /d/i });
    expect(danger.className).toMatch(/y-btn/);
    expect(danger.className).toMatch(/y-btn--danger/);
  });

  it("respects disabled prop", () => {
    render(<Btn disabled>X</Btn>);
    expect(screen.getByRole("button", { name: /x/i })).toBeDisabled();
  });
});
