import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tooltip } from "@ynab/theme";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockTriggerRect(rect: { top: number; bottom: number; left: number; right: number }) {
  vi.spyOn(window.HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => {},
  } as DOMRect);
}

// The custom <Tooltip> is the only tooltip in the app: native `title`
// attributes are banned (unstyleable, slow, keyboard-inaccessible).
describe("Tooltip", () => {
  it("renders no native title attribute", () => {
    const { container } = render(
      <Tooltip tip="Jump to current month">
        <button type="button">Today</button>
      </Tooltip>
    );
    expect(container.querySelectorAll("[title]").length).toBe(0);
  });

  it("shows the tip on hover and hides on leave", () => {
    render(
      <Tooltip tip="Jump to current month">
        <button type="button">Today</button>
      </Tooltip>
    );
    const wrap = screen.getByRole("button", { name: "Today" }).closest(".y-tip-wrap")!;
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseOver(wrap);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Jump to current month");
    fireEvent.mouseOut(wrap);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows the tip on keyboard focus and hides on blur", () => {
    render(
      <Tooltip tip="Jump to current month">
        <button type="button">Today</button>
      </Tooltip>
    );
    const btn = screen.getByRole("button", { name: "Today" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(btn);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Jump to current month");
    fireEvent.blur(btn);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("dismisses an open tip on Escape", () => {
    render(
      <Tooltip tip="Jump to current month">
        <button type="button">Today</button>
      </Tooltip>
    );
    const wrap = screen.getByRole("button", { name: "Today" }).closest(".y-tip-wrap")!;
    fireEvent.mouseOver(wrap);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("portals the bubble to document.body so overflow ancestors cannot clip it", () => {
    const { container } = render(
      <Tooltip tip="Edit account">
        <button type="button">E</button>
      </Tooltip>
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "E" }).closest(".y-tip-wrap")!);
    const tip = screen.getByRole("tooltip");
    // Not inside the trigger wrapper — a direct child of <body>, fixed-positioned
    // (Tailwind classes have no computed style in jsdom, so check the class).
    expect(container.contains(tip)).toBe(false);
    expect(tip.parentElement).toBe(document.body);
    expect(tip.className.split(/\s+/)).toContain("fixed");
  });

  it("flips below the trigger when there is no room above", () => {
    // Trigger hugging the top edge; the tip itself measures 0x0 in jsdom.
    mockTriggerRect({ top: 5, bottom: 25, left: 100, right: 140 });
    render(
      <Tooltip tip="Edit account">
        <button type="button">E</button>
      </Tooltip>
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "E" }).closest(".y-tip-wrap")!);
    // 25 (trigger bottom) + 7 (gap), not above the trigger.
    expect(screen.getByRole("tooltip")).toHaveStyle({ top: "32px" });
  });

  it("stays above the trigger when there is room", () => {
    mockTriggerRect({ top: 200, bottom: 220, left: 100, right: 140 });
    render(
      <Tooltip tip="Edit account">
        <button type="button">E</button>
      </Tooltip>
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "E" }).closest(".y-tip-wrap")!);
    // 200 (trigger top) - 0 (tip height in jsdom) - 7 (gap).
    expect(screen.getByRole("tooltip")).toHaveStyle({ top: "193px" });
  });

  it("clamps wide tips horizontally inside the viewport", () => {
    mockTriggerRect({ top: 200, bottom: 220, left: 990, right: 1010 });
    // A 200px-wide tip centered on x=1000 would run off a 1024px viewport.
    vi.spyOn(window.HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    render(
      <Tooltip tip="Edit account">
        <button type="button">E</button>
      </Tooltip>
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "E" }).closest(".y-tip-wrap")!);
    // 1024 - 8 (pad) - 100 (half width).
    expect(screen.getByRole("tooltip")).toHaveStyle({ left: "916px" });
  });

  it("keeps the inline-flex default when no display class is passed", () => {
    render(
      <Tooltip tip="Jump to current month">
        <button type="button">Today</button>
      </Tooltip>
    );
    const wrap = screen.getByRole("button", { name: "Today" }).closest(".y-tip-wrap")!;
    expect(wrap.className.split(/\s+/)).toContain("inline-flex");
  });

  it("lets a caller display class win over the inline-flex default", () => {
    // Tailwind emits `inline-flex` after `block`, so keeping both would
    // silently keep the wrapper inline (calendar pills sat next to each
    // other and overflowed the day cell).
    render(
      <Tooltip tip="Transfer : Savings" className="block">
        <span>Transfer : Savings</span>
      </Tooltip>
    );
    const wrap = screen.getByText("Transfer : Savings").closest(".y-tip-wrap")!;
    const classes = wrap.className.split(/\s+/);
    expect(classes).toContain("block");
    expect(classes).not.toContain("inline-flex");
  });

  it("renders no bubble when the tip is empty (wrapper stays for DOM stability)", () => {
    // The wrapper span is always rendered — even with an empty tip — so
    // stateful children (e.g. BudgetView's inline amount input) keep a
    // stable DOM identity when a tip appears mid-interaction (expression
    // preview). Conditionally switching between a fragment and a span
    // remounted the input, dropping focus and breaking blur-commit.
    const { container } = render(
      <Tooltip tip={undefined}>
        <span data-testid="plain">hi</span>
      </Tooltip>
    );
    expect(screen.getByTestId("plain")).toBeInTheDocument();
    expect(container.querySelector(".y-tip-wrap")).not.toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
