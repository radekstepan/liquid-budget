import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const logCalls = vi.hoisted(() => [] as { method: string; args: unknown[] }[]);

vi.mock("@/lib/logger", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/logger")>();
  const scoped = (scope: string) => ({
    debug: (...args: unknown[]) => {
      logCalls.push({ method: "debug", args: [`[${scope}]`, ...args] });
    },
    info: (...args: unknown[]) => {
      logCalls.push({ method: "info", args: [`[${scope}]`, ...args] });
    },
    warn: (...args: unknown[]) => {
      logCalls.push({ method: "warn", args: [`[${scope}]`, ...args] });
    },
    error: (...args: unknown[]) => {
      logCalls.push({ method: "error", args: [`[${scope}]`, ...args] });
    },
  });
  return {
    ...real,
    logger: scoped("test"),
    createScopedLogger: scoped,
  };
});

const serverMocks = vi.hoisted(() => ({
  analyzeUnflaggedDuplicates: vi.fn(),
  dismissDuplicateGroup: vi.fn(),
  importYnab4FromArchive: vi.fn(),
  importCsvTransactions: vi.fn(),
  exportYnab4ZipToFile: vi.fn(),
  resetAndSeedDatabase: vi.fn(),
  getDefaultDb: vi.fn(() => ({})),
}));

vi.mock("@ynab/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ynab/server")>();
  return { ...real, ...serverMocks };
});

import { POST as duplicatesPOST } from "../src/app/api/duplicates/route";
import { POST as dismissPOST } from "../src/app/api/duplicates/dismiss/route";
import { POST as importPOST } from "../src/app/api/import/route";
import { POST as importCsvPOST } from "../src/app/api/import/csv/route";
import { GET as exportGET } from "../src/app/api/export/route";
import { POST as resetPOST } from "../src/app/api/reset/route";

function loggedError(scope: string): unknown[] | undefined {
  return logCalls.find((c) => c.method === "error" && c.args[0] === `[${scope}]`)?.args;
}

describe("P2 logging: server 500s log sanitized details and return generic envelopes", () => {
  beforeEach(() => {
    logCalls.length = 0;
    vi.clearAllMocks();
  });

  it("POST /api/duplicates: unknown failure -> generic 500 + sanitized log (no payee/memo)", async () => {
    serverMocks.analyzeUnflaggedDuplicates.mockRejectedValueOnce(
      Object.assign(new Error("no such table: transactions"), {
        payee: "LEAK-PAYEE",
        memo: "LEAK-MEMO",
      })
    );
    const res = await duplicatesPOST(
      new Request("http://localhost:3000/api/duplicates", { method: "POST" })
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });

    const args = loggedError("duplicates");
    expect(args).toBeDefined();
    const logged = JSON.stringify(args);
    expect(logged).not.toContain("LEAK-PAYEE");
    expect(logged).not.toContain("LEAK-MEMO");
  });

  it("POST /api/duplicates/dismiss: unknown failure -> generic 500 + scoped log", async () => {
    serverMocks.dismissDuplicateGroup.mockRejectedValueOnce(new Error("db gone"));
    const req = new NextRequest("http://localhost:3000/api/duplicates/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: "abc123" }),
    });
    const res = await dismissPOST(req);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(loggedError("duplicates/dismiss")).toBeDefined();
  });

  it("POST /api/import/csv: unknown failure -> generic 500 + scoped log", async () => {
    serverMocks.importCsvTransactions.mockRejectedValueOnce(new Error("kaboom"));
    const req = new NextRequest("http://localhost:3000/api/import/csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: 1,
        csv: "Date,Payee,Amount\n2026-08-01,Store,-10.00\n",
      }),
    });
    const res = await importCsvPOST(req);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(loggedError("import/csv")).toBeDefined();
  });

  it("GET /api/export: unknown failure -> generic 500 + scoped log", async () => {
    serverMocks.exportYnab4ZipToFile.mockRejectedValueOnce(new Error("disk gone"));
    const res = await exportGET(
      new NextRequest("http://localhost:3000/api/export")
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(loggedError("export")).toBeDefined();
  });

  it("POST /api/import: unparseable body -> generic 500 + scoped log", async () => {
    const req = new NextRequest("http://localhost:3000/api/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-form-data",
    });
    const res = await importPOST(req);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(loggedError("import")).toBeDefined();
  });

  it("POST /api/reset: seed failure keeps its envelope but logs via the abstraction", async () => {
    serverMocks.resetAndSeedDatabase.mockRejectedValueOnce(
      new Error("Injected seed trigger failure")
    );
    const res = await resetPOST();
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
    expect(loggedError("reset")).toBeDefined();
  });
});
