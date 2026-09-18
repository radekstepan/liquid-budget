import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { todayISO } from "@ynab/logic";
import { msUntilNextMidnight, useTodayISO } from "../src/useTodayISO.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("msUntilNextMidnight", () => {
  it("returns ~12h + buffer at noon", () => {
    const from = new Date(2026, 5, 15, 12, 0, 0, 0);
    expect(msUntilNextMidnight(from)).toBe(12 * 60 * 60 * 1000 + 500);
  });

  it("returns a small positive delay just before midnight", () => {
    const from = new Date(2026, 5, 15, 23, 59, 59, 0);
    const ms = msUntilNextMidnight(from);
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThanOrEqual(2000);
  });

  it("never returns less than 1s", () => {
    const from = new Date(2026, 5, 15, 23, 59, 59, 900);
    expect(msUntilNextMidnight(from)).toBeGreaterThanOrEqual(1000);
  });
});

describe("useTodayISO", () => {
  it("returns today's date on mount", () => {
    const { result } = renderHook(() => useTodayISO());
    expect(result.current).toBe(todayISO());
  });

  it("ticks over at midnight via timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 23, 59, 58, 0));
    const { result } = renderHook(() => useTodayISO());
    expect(result.current).toBe("2026-06-15");

    act(() => {
      vi.setSystemTime(new Date(2026, 5, 16, 0, 0, 2, 0));
      vi.runOnlyPendingTimers();
    });

    expect(result.current).toBe("2026-06-16");
  });

  it("re-checks on window focus (covers sleep / throttled timers)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0, 0));
    const { result } = renderHook(() => useTodayISO());
    expect(result.current).toBe("2026-06-15");

    act(() => {
      vi.setSystemTime(new Date(2026, 5, 16, 9, 0, 0, 0));
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current).toBe("2026-06-16");
  });
});
