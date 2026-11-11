import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createTransaction,
  getDefaultDb,
  resetAndSeedDatabase,
} from "@ynab/server";
import { parseSearchResponse } from "@ynab/logic";
import { GET } from "../src/app/api/search/route";

vi.stubEnv("DATABASE_URL", ":memory:");

function get(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: "GET", headers });
}

describe("GET /api/search (P1 search-perf)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("returns ranked hits validating against the search contract", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });
    const group = await createCategoryGroup(db, { name: "Living" });
    const groceries = await createCategory(db, { groupId: group!.id, name: "SearchProbe Groceries" });

    await createTransaction(db, {
      accountId: account!.id,
      categoryId: groceries!.id,
      amount: -5000,
      date: "2026-08-01",
      payee: "SearchProbe Market",
      memo: "probe memo",
    });

    const res = await GET(get("http://localhost:3000/api/search?query=searchprobe"));
    expect(res.status).toBe(200);
    const page = parseSearchResponse(await res.json());
    expect(page.transactions.length).toBeGreaterThan(0);
    expect(page.transactions[0]!.payee).toBe("SearchProbe Market");
    expect(page.categories.map((c) => c.name)).toContain("SearchProbe Groceries");
    expect(page.payees.map((p) => p.name)).toContain("SearchProbe Market");
    expect(page.payeeOptions.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("honours scope and facet filters", async () => {
    const db = getDefaultDb();
    const a1 = await createAccount(db, { name: "ScopeA", kind: "liquid" });
    const a2 = await createAccount(db, { name: "ScopeB", kind: "liquid" });
    await createTransaction(db, { accountId: a1!.id, amount: -100, date: "2026-08-01", payee: "Scoped Txn" });
    await createTransaction(db, { accountId: a2!.id, amount: -200, date: "2026-08-02", payee: "Scoped Txn" });

    const scoped = await GET(
      get(`http://localhost:3000/api/search?query=scop&scopeAccountId=${a1!.id}&searchAll=false`)
    );
    expect(scoped.status).toBe(200);
    const page = parseSearchResponse(await scoped.json());
    expect(page.transactions.length).toBeGreaterThan(0);
    for (const t of page.transactions) expect(t.accountId).toBe(a1!.id);
  });

  it("rejects bad limit, ids, and cursors with 400", async () => {
    for (const url of [
      "http://localhost:3000/api/search?limit=0",
      "http://localhost:3000/api/search?limit=101",
      "http://localhost:3000/api/search?limit=abc",
      "http://localhost:3000/api/search?categoryId=abc",
      "http://localhost:3000/api/search?before=garbage",
    ]) {
      const res = await GET(get(url));
      expect(res.status).toBe(400);
    }
  });

  it("reads stay open off-loopback (P0 guard covers mutations only)", async () => {
    const res = await GET(get("http://192.168.1.10:3000/api/search?query=x"));
    expect(res.status).toBe(200);
  });
});
