import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, renderHook } from "@testing-library/react";
import { monthKey, parseMonthKey, todayISO } from "@ynab/logic";
import {
  useBudgetMonthScroll,
  type BudgetMonthScrollArgs,
} from "../src/useBudgetMonthScroll.js";

const thisMonth = todayISO().slice(0, 7);

/** Newest shiftable month: one past today (mirrors the hook's clamp). */
function maxAllowedMonth(todayMonth: string): string {
  const { year, month0 } = parseMonthKey(todayMonth);
  const total = year * 12 + month0 + 1;
  return monthKey(Math.floor(total / 12), ((total % 12) + 12) % 12);
}

function args(overrides: Partial<BudgetMonthScrollArgs> = {}): BudgetMonthScrollArgs {
  return {
    showMulti: false,
    visibleMonths: ["2000-01"],
    currentMonth: "2000-01",
    onShiftMonth: () => {},
    ...overrides,
  };
}

function Harness({ hookArgs }: { hookArgs: BudgetMonthScrollArgs }) {
  const scroll = useBudgetMonthScroll(hookArgs);
  return (
    <div
      ref={scroll.scrollContainerRef}
      data-testid="scroller"
      data-hscrolled={String(scroll.isHScrolled)}
      data-inview={String(scroll.hasThisMonthInView)}
    >
      <table>
        <thead>
          <tr>
            <th ref={scroll.currentMonthThRef}>Month</th>
          </tr>
        </thead>
      </table>
    </div>
  );
}

describe("useBudgetMonthScroll (ui-split slice 8)", () => {
  it("derives todayMonth/isOnThisMonth from the real clock", () => {
    const { result } = renderHook(() =>
      useBudgetMonthScroll(args({ currentMonth: thisMonth, visibleMonths: [thisMonth] }))
    );
    expect(result.current.todayMonth).toBe(thisMonth);
    expect(result.current.isOnThisMonth).toBe(true);

    const { result: past } = renderHook(() => useBudgetMonthScroll(args()));
    expect(past.current.todayMonth).toBe(thisMonth);
    expect(past.current.isOnThisMonth).toBe(false);
  });

  it("mirrors isOnThisMonth as hasThisMonthInView in single-month mode", () => {
    const { result } = renderHook(() =>
      useBudgetMonthScroll(args({ currentMonth: thisMonth, visibleMonths: [thisMonth] }))
    );
    expect(result.current.hasThisMonthInView).toBe(true);

    const { result: past } = renderHook(() => useBudgetMonthScroll(args()));
    expect(past.current.hasThisMonthInView).toBe(false);
  });

  it("reports out of view when multi-month excludes today", () => {
    const { result } = renderHook(() =>
      useBudgetMonthScroll(
        args({ showMulti: true, visibleMonths: ["2000-01", "2000-02"], currentMonth: "2000-02" })
      )
    );
    expect(result.current.hasThisMonthInView).toBe(false);
  });

  it("reports in view when multi-month includes today (detached refs)", () => {
    const { result } = renderHook(() =>
      useBudgetMonthScroll(
        args({ showMulti: true, visibleMonths: ["2000-01", thisMonth], currentMonth: thisMonth })
      )
    );
    expect(result.current.hasThisMonthInView).toBe(true);
  });

  it("shifts right via Next when older months exist", () => {
    const onShiftMonth = vi.fn();
    const { result } = renderHook(() => useBudgetMonthScroll(args({ onShiftMonth })));
    expect(result.current.canGoRight).toBe(true);
    result.current.handleNext();
    expect(onShiftMonth).toHaveBeenCalledWith(1);
  });

  it("disables Next at the clamp boundary and no-ops without a container", () => {
    const max = maxAllowedMonth(thisMonth);
    const onShiftMonth = vi.fn();
    const { result } = renderHook(() =>
      useBudgetMonthScroll(args({ currentMonth: max, visibleMonths: [max], onShiftMonth }))
    );
    expect(result.current.canGoRight).toBe(false);
    result.current.handleNext();
    expect(onShiftMonth).not.toHaveBeenCalled();
  });

  it("honors the explicit canShiftRight override both ways", () => {
    const { result: forcedOff } = renderHook(() =>
      useBudgetMonthScroll(args({ canShiftRight: false }))
    );
    expect(forcedOff.current.canGoRight).toBe(false);

    const max = maxAllowedMonth(thisMonth);
    const onShiftMonth = vi.fn();
    const { result: forcedOn } = renderHook(() =>
      useBudgetMonthScroll(
        args({ currentMonth: max, visibleMonths: [max], canShiftRight: true, onShiftMonth })
      )
    );
    expect(forcedOn.current.canGoRight).toBe(true);
    forcedOn.current.handleNext();
    expect(onShiftMonth).toHaveBeenCalledWith(1);
  });

  it("reveals remaining grid via scrollBy when shifting is clamped", () => {
    const onShiftMonth = vi.fn();
    const { result } = renderHook(() =>
      useBudgetMonthScroll(args({ canShiftRight: false, onShiftMonth }))
    );
    const el = document.createElement("div");
    const scrollBy = vi.fn();
    Object.defineProperty(el, "scrollBy", { value: scrollBy, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 500, configurable: true });
    result.current.scrollContainerRef.current = el;

    result.current.handleNext();

    expect(onShiftMonth).not.toHaveBeenCalled();
    expect(scrollBy).toHaveBeenCalledWith({ left: 400, behavior: "smooth" });
  });

  it("tracks horizontal scroll on the attached container", () => {
    render(<Harness hookArgs={args()} />);
    const el = screen.getByTestId("scroller");
    expect(el.dataset.hscrolled).toBe("false");

    Object.defineProperty(el, "scrollLeft", { value: 10, configurable: true });
    fireEvent.scroll(el);

    expect(el.dataset.hscrolled).toBe("true");
  });

  it("treats zero-geometry containers as in view (headless fallback)", () => {
    render(
      <Harness
        hookArgs={args({
          showMulti: true,
          visibleMonths: ["2000-01", thisMonth],
          currentMonth: thisMonth,
        })}
      />
    );
    // jsdom reports zero rects, so the visibility check takes the fallback.
    expect(screen.getByTestId("scroller").dataset.inview).toBe("true");
  });

  it("smooth-scrolls the current-month header in multi-month mode", () => {
    const { result } = renderHook(() =>
      useBudgetMonthScroll(
        args({ showMulti: true, visibleMonths: ["2000-01", thisMonth], currentMonth: thisMonth })
      )
    );
    const th = document.createElement("th");
    const scrollIntoView = vi.fn();
    Object.defineProperty(th, "scrollIntoView", { value: scrollIntoView, configurable: true });
    result.current.currentMonthThRef.current = th;

    result.current.scrollTodayIntoView();

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  });

  it("does not scroll in single-month mode", () => {
    const { result } = renderHook(() => useBudgetMonthScroll(args()));
    const th = document.createElement("th");
    const scrollIntoView = vi.fn();
    Object.defineProperty(th, "scrollIntoView", { value: scrollIntoView, configurable: true });
    result.current.currentMonthThRef.current = th;

    result.current.scrollTodayIntoView();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
