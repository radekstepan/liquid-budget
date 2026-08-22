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

  it("falls back to the initial value when stored JSON is corrupt", () => {
    window.localStorage.setItem("test-key", "not-json");
    const { result } = renderHook(() => useLocalStorage("test-key", "fallback"));
    expect(result.current[0]).toBe("fallback");
  });
});
