import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  createScopedLogger,
  getLogger,
  logger,
  resetLogger,
  setLogger,
  toLogDetails,
  type Logger,
} from "../src/lib/logger";
import { reportBudgetReloadFailure } from "../src/components/api/optimistic-mutation";

function makeRecorder(): Logger & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  return {
    calls,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

describe("logger abstraction (@/lib/logger)", () => {
  beforeEach(() => {
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
    vi.restoreAllMocks();
  });

  it("delegates to the matching console method with identical args", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.debug("d", 1);
    logger.info("i", { a: 1 });
    logger.warn("w");
    const err = new Error("boom");
    logger.error("e", err);

    expect(debug).toHaveBeenCalledWith("d", 1);
    expect(info).toHaveBeenCalledWith("i", { a: 1 });
    expect(warn).toHaveBeenCalledWith("w");
    expect(error).toHaveBeenCalledWith("e", err);
  });

  it("setLogger swaps the sink and resetLogger restores the console transport", () => {
    const recorder = makeRecorder();
    setLogger(recorder);
    expect(getLogger()).toBe(recorder);

    logger.error("hello", 42);
    expect(recorder.calls).toEqual([{ method: "error", args: ["hello", 42] }]);

    resetLogger();
    expect(getLogger()).not.toBe(recorder);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("back on console");
    expect(error).toHaveBeenCalledWith("back on console");
  });

  it("createScopedLogger prefixes the scope on every method", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const scoped = createScopedLogger("duplicates");

    scoped.error("Error:", { status: 500 });
    scoped.info("audit");

    expect(error).toHaveBeenCalledWith("[duplicates]", "Error:", { status: 500 });
    expect(info).toHaveBeenCalledWith("[duplicates]", "audit");
  });

  it("toLogDetails keeps only name/message/status/code (no payee/memo/row payloads)", () => {
    const err = Object.assign(new Error("payee WHOLE FOODS broke"), {
      status: 500,
      code: "SQLITE_BUSY",
      payee: "WHOLE FOODS",
      memo: "downtown secret",
      rows: [{ id: 1 }],
    });
    expect(toLogDetails(err)).toEqual({
      name: "Error",
      message: "payee WHOLE FOODS broke",
      status: 500,
      code: "SQLITE_BUSY",
    });

    expect(toLogDetails({ message: "m", payee: "P", status: 400 })).toEqual({
      message: "m",
      status: 400,
    });
    expect(toLogDetails("boom")).toEqual({ message: "boom" });
    expect(toLogDetails(undefined)).toEqual({ message: "" });
  });

  it("reportBudgetReloadFailure routes through the logger sink (no direct console)", () => {
    const recorder = makeRecorder();
    setLogger(recorder);
    const addToast = vi.fn();
    const err = new Error("stale");

    reportBudgetReloadFailure(err, addToast as never);

    expect(recorder.calls).toEqual([
      { method: "error", args: ["Budget reload failed after successful mutation:", err] },
    ]);
    expect(addToast).toHaveBeenCalledWith(
      "Saved changes, but failed to refresh latest budget data.",
      "warn"
    );
  });
});

describe("P2 logging remediation: app code funnels through @/lib/logger", () => {
  const funneled = [
    "components/BudgetAppShell.tsx",
    "components/api/optimistic-mutation.ts",
    "app/api/duplicates/route.ts",
    "app/api/duplicates/dismiss/route.ts",
    "app/api/import/route.ts",
    "app/api/import/csv/route.ts",
    "app/api/export/route.ts",
    "app/api/reset/route.ts",
    "app/api/rename-rules/suggest/route.ts",
  ];

  it.each(funneled)("%s has no direct console.* calls or logging TODO", (rel) => {
    const src = readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
    expect(src).not.toMatch(/\bconsole\.(debug|info|warn|error|log)\b/);
    expect(src).not.toContain("TODO(P2) [logging]");
  });
});
