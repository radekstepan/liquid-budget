import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MonthQuickBudget } from "../src/MonthQuickBudget.js";

const VALUES = { lastMonth: 10000, spentLastMonth: 8000, avgBudgeted: 9000 };

function renderMenu(overrides: Record<string, unknown> = {}) {
  const onQuickBudget = vi.fn();
  const onClose = vi.fn();
  const onOpen = vi.fn();
  render(
    <MonthQuickBudget
      month="2024-01"
      values={VALUES}
      selectedCategory={null}
      onQuickBudget={onQuickBudget}
      open
      onOpen={onOpen}
      onClose={onClose}
      {...overrides}
    />
  );
  return { onQuickBudget, onClose, onOpen };
}

describe("MonthQuickBudget (ui-split slice 3)", () => {
  it("stays hidden until open", () => {
    render(
      <MonthQuickBudget
        month="2024-01"
        onQuickBudget={() => {}}
        open={false}
        onOpen={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Quick budget options for Jan 2024" })).toBeDefined();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows formatted quick-budget values for the whole budget", () => {
    renderMenu();
    expect(screen.getByRole("menu", { name: "Quick Budget for Jan 2024" })).toBeDefined();
    expect(screen.getByText("Entire Budget")).toBeDefined();
    expect(screen.getByTestId("quick-budget-last-month-2024-01").textContent).toContain("$100.00");
    expect(screen.getByTestId("quick-budget-spent-last-month-2024-01").textContent).toContain("$80.00");
    expect(screen.getByTestId("quick-budget-avg-budgeted-2024-01").textContent).toContain("$90.00");
  });

  it("dispatches the chosen type with category + month, then closes", () => {
    const { onQuickBudget, onClose } = renderMenu({
      selectedCategory: { id: 10, name: "Groceries" },
    });
    fireEvent.click(screen.getByTestId("quick-budget-spent-last-month-2024-01"));
    expect(onQuickBudget).toHaveBeenCalledTimes(1);
    expect(onQuickBudget).toHaveBeenCalledWith("spentLastMonth", 10, "2024-01");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers deselecting the scoped category", () => {
    const onClearSelectedCategory = vi.fn();
    renderMenu({
      selectedCategory: { id: 10, name: "Groceries" },
      onClearSelectedCategory,
    });
    fireEvent.click(screen.getByTestId("quick-budget-deselect-2024-01"));
    expect(onClearSelectedCategory).toHaveBeenCalledTimes(1);
  });
});

describe("MonthQuickBudget focus (a11y slice 2)", () => {
  function renderControlled(initialOpen = false) {
    const onQuickBudget = vi.fn();
    const onClose = vi.fn();
    const onOpen = vi.fn();
    const utils = render(
      <MonthQuickBudget
        month="2024-01"
        values={VALUES}
        selectedCategory={null}
        onQuickBudget={onQuickBudget}
        open={initialOpen}
        onOpen={onOpen}
        onClose={onClose}
      />
    );
    const setOpen = (open: boolean) =>
      utils.rerender(
        <MonthQuickBudget
          month="2024-01"
          values={VALUES}
          selectedCategory={null}
          onQuickBudget={onQuickBudget}
          open={open}
          onOpen={onOpen}
          onClose={onClose}
        />
      );
    return { ...utils, setOpen, onQuickBudget, onClose, onOpen };
  }

  const trigger = () =>
    screen.getByRole("button", { name: "Quick budget options for Jan 2024" });
  const firstItem = () => screen.getByTestId("quick-budget-last-month-2024-01");
  const lastItem = () => screen.getByTestId("quick-budget-clear-2024-01");

  it("moves focus into the menu on open", () => {
    const { setOpen } = renderControlled(false);
    act(() => {
      trigger().focus();
    });
    setOpen(true);
    expect(document.activeElement).toBe(firstItem());
  });

  it("returns focus to the trigger when Escape closes the menu", () => {
    const { setOpen, onClose } = renderControlled(false);
    setOpen(true);
    expect(document.activeElement).toBe(firstItem());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    setOpen(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("returns focus to the trigger after choosing an item", () => {
    const { setOpen, onQuickBudget, onClose } = renderControlled(false);
    setOpen(true);
    const item = screen.getByTestId("quick-budget-spent-last-month-2024-01");
    act(() => {
      item.focus();
    });
    fireEvent.click(item);
    expect(onQuickBudget).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    setOpen(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves focus alone when an outside interaction closes the menu", () => {
    const { setOpen, onClose } = renderControlled(false);
    render(<button data-testid="outside">outside</button>);
    setOpen(true);
    const outside = screen.getByTestId("outside");
    act(() => {
      outside.focus();
    });
    expect(document.activeElement).toBe(outside);

    fireEvent.mouseDown(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
    setOpen(false);
    expect(document.activeElement).toBe(outside);
  });

  it("traps Tab inside the menu, wrapping both ends", () => {
    const { setOpen } = renderControlled(false);
    setOpen(true);

    act(() => {
      lastItem().focus();
    });
    const wrapped = fireEvent.keyDown(lastItem(), { key: "Tab" });
    expect(wrapped).toBe(false);
    expect(document.activeElement).toBe(firstItem());

    act(() => {
      firstItem().focus();
    });
    const wrappedBack = fireEvent.keyDown(firstItem(), { key: "Tab", shiftKey: true });
    expect(wrappedBack).toBe(false);
    expect(document.activeElement).toBe(lastItem());
  });

  it("lets Tab pass through between middle items", () => {
    const { setOpen } = renderControlled(false);
    setOpen(true);
    const middle = screen.getByTestId("quick-budget-spent-last-month-2024-01");
    act(() => {
      middle.focus();
    });
    expect(fireEvent.keyDown(middle, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(middle, { key: "Enter" })).toBe(true);
    expect(document.activeElement).toBe(middle);
  });
});
