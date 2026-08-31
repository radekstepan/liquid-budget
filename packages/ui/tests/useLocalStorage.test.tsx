import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLocalStorage } from "../src/useLocalStorage.js";

describe("useLocalStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the initial value when no stored value exists", () => {
    const { result } = renderHook(() => useLocalStorage("test-key", "default"));
    expect(result.current[0]).toBe("default");
  });

  it("returns a stored value when one exists", () => {
    window.localStorage.setItem("test-key", JSON.stringify("stored"));
    const { result } = renderHook(() => useLocalStorage("test-key", "default"));
    expect(result.current[0]).toBe("stored");
  });

  it("uses a lazy initializer", () => {
    const init = vi.fn(() => "computed");
    const { result } = renderHook(() => useLocalStorage("test-key", init));
    expect(result.current[0]).toBe("computed");
    // Called once in useState and once in the useEffect sync
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("persists a set value to localStorage", () => {
    const { result } = renderHook(() => useLocalStorage("test-key", "default"));
    act(() => result.current[1]("updated"));
    expect(result.current[0]).toBe("updated");
    expect(JSON.parse(window.localStorage.getItem("test-key")!)).toBe("updated");
  });

  it("supports functional updates", () => {
    window.localStorage.setItem("test-key", JSON.stringify(5));
    const { result } = renderHook(() => useLocalStorage("test-key", 0));
    act(() => result.current[1]((prev) => prev + 1));
    expect(result.current[0]).toBe(6);
    expect(JSON.parse(window.localStorage.getItem("test-key")!)).toBe(6);
  });

  it("falls back to the initial value and removes key when stored JSON is corrupt", () => {
    window.localStorage.setItem("test-key", "not-json");
    const { result } = renderHook(() => useLocalStorage("test-key", "fallback"));
    expect(result.current[0]).toBe("fallback");
    expect(window.localStorage.getItem("test-key")).toBeNull();
  });

  it("falls back to initial value and removes key when stored JSON fails validation", () => {
    window.localStorage.setItem("test-key", JSON.stringify(null));
    const isRecord = (v: unknown): v is Record<string, boolean> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const { result } = renderHook(() =>
      useLocalStorage<Record<string, boolean>>("test-key", { default: true }, isRecord)
    );
    expect(result.current[0]).toEqual({ default: true });
    expect(window.localStorage.getItem("test-key")).toBeNull();
  });

  it("accepts valid stored value when validation succeeds", () => {
    window.localStorage.setItem("test-key", JSON.stringify({ a: true }));
    const isRecord = (v: unknown): v is Record<string, boolean> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const { result } = renderHook(() =>
      useLocalStorage<Record<string, boolean>>("test-key", { default: true }, isRecord)
    );
    expect(result.current[0]).toEqual({ a: true });
    expect(window.localStorage.getItem("test-key")).toBe(JSON.stringify({ a: true }));
  });

  it("rejects invalid setValue and does not persist when validation fails", () => {
    const isPositiveNumber = (v: unknown): v is number =>
      typeof v === "number" && v > 0;
    const { result } = renderHook(() =>
      useLocalStorage<number>("test-key", 10, isPositiveNumber)
    );
    act(() => {
      result.current[1](-5);
    });
    expect(result.current[0]).toBe(10);
    expect(window.localStorage.getItem("test-key")).toBeNull();
  });

  it("updates internal React state without throwing and logs a console warning when localStorage.setItem throws QuotaExceededError", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });

    const { result } = renderHook(() => useLocalStorage("test-key", "initial"));

    expect(() => {
      act(() => {
        result.current[1]("new-val");
      });
    }).not.toThrow();

    expect(result.current[0]).toBe("new-val");
    expect(warnSpy).toHaveBeenCalledWith(
      'Error setting localStorage key "test-key":',
      expect.any(DOMException)
    );

    setItemSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("supports functional update when localStorage.setItem throws QuotaExceededError", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });

    const { result } = renderHook(() => useLocalStorage("test-key", 10));

    expect(() => {
      act(() => {
        result.current[1]((prev) => prev + 5);
      });
    }).not.toThrow();

    expect(result.current[0]).toBe(15);

    setItemSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
