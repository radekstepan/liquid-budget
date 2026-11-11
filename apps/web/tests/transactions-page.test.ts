import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  createAccount,
  createTransaction,
  getDefaultDb,
  resetAndSeedDatabase,
} from "@ynab/server";
import { parseTransactionsPageResponse } from "@ynab/logic";
import { GET } from "../src/app/api/transactions/route";

vi.stubEnv("DATABASE_URL", ":memory:");

function get(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: "GET", headers });
}

describe("GET /api/transactions (P1 pagination)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("returns a page envelope that validates against the contract", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Paging", kind: "liquid" });
    for (const [date, payee] of [["2026-08-01", "a"], ["2026-08-02", "b"], ["2026-08-03", "c"]] as const) {
      await createTransaction(db, { accountId: account!.id, amount: -100, date, payee });
    }

    const res = await GET(get("http://localhost:3000/api/transactions?limit=2"));
    expect(res.status).toBe(200);
    const page = parseTransactionsPageResponse(await res.json());
    expect(page.transactions).toHaveLength(2);
    expect(page.transactions.map((t) => t.payee)).toEqual(["c", "b"]);
    expect(page.hasMore).toBe(true);
    expect(typeof page.nextCursor).toBe("string");

    // Walk the rest; the seeded demo rows follow our three newest txns.
    const rows = page.transactions.map((t) => ({ id: t.id, payee: t.payee }));
    let cursor: string | null = page.nextCursor;
    let guard = 0;
    while (cursor !== null && guard++ < 100) {
      const next = await GET(
        get(`http://localhost:3000/api/transactions?limit=2&before=${cursor}`)
      );
      expect(next.status).toBe(200);
      const p = parseTransactionsPageResponse(await next.json());
      rows.push(...p.transactions.map((t) => ({ id: t.id, payee: t.payee })));
      cursor = p.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(rows.slice(0, 3).map((r) => r.payee)).toEqual(["c", "b", "a"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("filters by accountId", async () => {
    const db = getDefaultDb();
    const a1 = await createAccount(db, { name: "A1", kind: "liquid" });
    const a2 = await createAccount(db, { name: "A2", kind: "liquid" });
    await createTransaction(db, { accountId: a1!.id, amount: -100, date: "2026-08-01", payee: "one" });
    await createTransaction(db, { accountId: a2!.id, amount: -200, date: "2026-08-02", payee: "two" });

    const res = await GET(get(`http://localhost:3000/api/transactions?accountId=${a2!.id}`));
    expect(res.status).toBe(200);
    const page = parseTransactionsPageResponse(await res.json());
    expect(page.transactions.length).toBeGreaterThan(0);
    for (const t of page.transactions) expect(t.accountId).toBe(a2!.id);
  });

  it("rejects bad limit, accountId, and cursor values with 400", async () => {
    for (const url of [
      "http://localhost:3000/api/transactions?limit=0",
      "http://localhost:3000/api/transactions?limit=501",
      "http://localhost:3000/api/transactions?limit=abc",
      "http://localhost:3000/api/transactions?accountId=abc",
      "http://localhost:3000/api/transactions?before=garbage",
    ]) {
      const res = await GET(get(url));
      expect(res.status).toBe(400);
    }
  });

  it("reads stay open off-loopback (P0 guard covers mutations only)", async () => {
    const res = await GET(get("http://192.168.1.10:3000/api/transactions?limit=1"));
    expect(res.status).toBe(200);
  });
});
