import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { buildSearchIndex, searchBudget } from "@ynab/logic";
import type { SearchFacets, SearchScope } from "@ynab/logic";
import * as schema from "../src/schema.js";
import { getBudgetData } from "../src/queries/budget.js";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchGlobal,
  type SearchGlobalInput,
} from "../src/queries/search.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

type TestDb = ReturnType<typeof openMigratedDb>;

function openMigratedDb() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, raw };
}

async function seedFixture(db: TestDb["db"]) {
  const [checking] = await db
    .insert(schema.accounts)
    .values({ name: "Checking", kind: "liquid", groupLabel: "Cash", balance: 0, onBudget: true, sort: 0 })
    .returning();
  const [savings] = await db
    .insert(schema.accounts)
    .values({ name: "Savings", kind: "liquid", groupLabel: "Cash", balance: 0, onBudget: true, sort: 1 })
    .returning();
  const [food] = await db
    .insert(schema.categoryGroups)
    .values({ name: "Food", sort: 0, isCreditCardPayments: false })
    .returning();
  const [groceries] = await db
    .insert(schema.categories)
    .values({ groupId: food!.id, name: "Groceries", sort: 0 })
    .returning();
  const [rent] = await db
    .insert(schema.categories)
    .values({ groupId: food!.id, name: "Rent", sort: 1 })
    .returning();

  const t = async (row: typeof schema.transactions.$inferInsert) => {
    const [r] = await db.insert(schema.transactions).values(row).returning();
    return r!;
  };

  await t({ accountId: checking!.id, categoryId: groceries!.id, date: "2026-09-01", payee: "Whole Foods", memo: "weekly shop", amount: -5000 });
  await t({ accountId: checking!.id, categoryId: groceries!.id, date: "2026-09-03", payee: "Whole Foods Market", memo: "", amount: -2000 });
  await t({ accountId: savings!.id, categoryId: rent!.id, date: "2026-09-02", payee: "Landlord", memo: "september", amount: -100000 });
  await t({ accountId: checking!.id, categoryId: null, date: "2026-09-04", payee: "Transfer : Savings", memo: "", amount: -10000, transferAccountId: savings!.id });
  await t({ accountId: checking!.id, categoryId: null, date: "2026-09-05", payee: "100% Legit", memo: "under_score deal", amount: -100 });
  const parent = await t({ accountId: checking!.id, categoryId: null, date: "2026-09-06", payee: "Split Store", memo: "", amount: -3000 });
  await t({ accountId: checking!.id, categoryId: groceries!.id, date: "2026-09-06", payee: "Split Store", memo: "", amount: -2000, parentId: parent.id });
  await t({ accountId: checking!.id, categoryId: rent!.id, date: "2026-09-06", payee: "Split Store", memo: "", amount: -1000, parentId: parent.id });
  return { checking: checking!.id, savings: savings!.id, groceries: groceries!.id, rent: rent!.id };
}

const COMBOS: { facets: SearchFacets; scope: SearchScope }[] = [
  { facets: { query: "", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "whole foods", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "whole", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "shop", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "gro", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "sav", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "100%", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "under_score", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "%", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "split", payee: null, categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
  { facets: { query: "", payee: "whole foods", categoryId: null, accountId: null }, scope: { scopeAccountId: null, searchAll: true } },
];

function toInput(facets: SearchFacets, scope: SearchScope): SearchGlobalInput {
  return {
    query: facets.query,
    payee: facets.payee ?? undefined,
    categoryId: facets.categoryId ?? undefined,
    accountId: facets.accountId ?? undefined,
    scopeAccountId: scope.scopeAccountId ?? undefined,
    searchAll: scope.searchAll,
    limit: 30,
  };
}

describe("searchGlobal (P1 search-perf)", () => {
  it("matches the client index row-for-row across facet combos", async () => {
    const { db } = openMigratedDb();
    const ids = await seedFixture(db);
    const data = await getBudgetData(db);
    const index = buildSearchIndex(data);

    const combos: { facets: SearchFacets; scope: SearchScope }[] = [
      ...COMBOS,
      {
        facets: { query: "", payee: null, categoryId: ids.groceries, accountId: null },
        scope: { scopeAccountId: null, searchAll: true },
      },
      {
        facets: { query: "store", payee: null, categoryId: null, accountId: null },
        scope: { scopeAccountId: ids.checking, searchAll: false },
      },
      {
        facets: { query: "", payee: null, categoryId: null, accountId: null },
        scope: { scopeAccountId: ids.savings, searchAll: false },
      },
      {
        facets: { query: "", payee: null, categoryId: null, accountId: ids.checking },
        scope: { scopeAccountId: ids.savings, searchAll: false },
      },
    ];

    for (const { facets, scope } of combos) {
      const expected = searchBudget(index, facets, scope);
      const actual = await searchGlobal(db, toInput(facets, scope));
      expect(
        actual.transactions.map((t) => ({ id: t.id, rank: t.rank })),
        JSON.stringify({ facets, scope })
      ).toEqual(expected.transactions.map((t) => ({ id: t.id, rank: t.rank })));
      expect(actual.payees, JSON.stringify({ facets, scope })).toEqual(expected.payees);
      expect(actual.categories, JSON.stringify({ facets, scope })).toEqual(
        expected.categories
      );
    }
  });

  it("ranks exact before prefix before substring, then newest first", async () => {
    const { db } = openMigratedDb();
    await seedFixture(db);
    const exact = await searchGlobal(db, { query: "whole foods" });
    expect(exact.transactions.map((t) => t.payee)).toEqual(["Whole Foods", "Whole Foods Market"]);
    expect(exact.transactions.map((t) => t.rank)).toEqual([0, 1]);
  });

  it("LIKE metacharacters stay literal (no wildcard expansion)", async () => {
    const { db } = openMigratedDb();
    await seedFixture(db);
    const pct = await searchGlobal(db, { query: "%" });
    expect(pct.transactions.map((t) => t.payee)).toEqual(["100% Legit"]);
    const under = await searchGlobal(db, { query: "under_score" });
    expect(under.transactions.map((t) => t.payee)).toEqual(["100% Legit"]);
  });

  it("transfer payees never surface as payee hits but their legs stay in scope", async () => {
    const { db } = openMigratedDb();
    const ids = await seedFixture(db);
    const all = await searchGlobal(db, { query: "" });
    expect(all.payees.some((p) => p.name.startsWith("Transfer : "))).toBe(false);
    expect(all.payeeOptions.some((p) => p.value.startsWith("Transfer : "))).toBe(false);

    const scoped = await searchGlobal(db, {
      query: "",
      scopeAccountId: ids.savings,
      searchAll: false,
    });
    // The Checking -> Savings transfer leg counts for Savings scope.
    expect(scoped.transactions.some((t) => t.payee === "Transfer : Savings")).toBe(true);
  });

  it("walks every match in rank-then-date order with no dupes or skips", async () => {
    const { db } = openMigratedDb();
    const ids = await seedFixture(db);
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.transactions).values({
        accountId: ids.checking,
        date: `2026-09-${String(10 + i).padStart(2, "0")}`,
        payee: `Whole Store ${i}`,
        amount: -100,
      });
    }
    const seen: number[] = [];
    let before: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await searchGlobal(db, { query: "whole", limit: 2, before });
      for (const t of page.transactions) seen.push(t.id);
      pages++;
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      before = page.nextCursor!;
      if (pages > 50) throw new Error("search pagination did not terminate");
    }
    const first = await searchGlobal(db, { query: "whole", limit: 100 });
    expect(seen).toEqual(first.transactions.map((t) => t.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("returns empty hits on an empty budget", async () => {
    const { db } = openMigratedDb();
    const res = await searchGlobal(db, { query: "whole" });
    expect(res).toEqual({
      payees: [],
      categories: [],
      transactions: [],
      payeeOptions: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("clamps oversized limits instead of building an unbounded SELECT", async () => {
    const { db } = openMigratedDb();
    await seedFixture(db);
    const res = await searchGlobal(db, { query: "", limit: 100000 });
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
    expect(res.transactions.length).toBeGreaterThan(0);
  });

  it("rejects malformed cursors, limits, and ids with 400", async () => {
    const { db } = openMigratedDb();
    await seedFixture(db);
    await expect(searchGlobal(db, { before: "garbage" })).rejects.toMatchObject({ status: 400 });
    await expect(
      searchGlobal(db, { before: encodeSearchCursor(9, "2026-09-01", 1) })
    ).rejects.toMatchObject({ status: 400 });
    await expect(searchGlobal(db, { limit: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(searchGlobal(db, { categoryId: -2 })).rejects.toMatchObject({ status: 400 });
    await expect(searchGlobal(db, { accountId: -2 })).rejects.toMatchObject({ status: 400 });
    await expect(searchGlobal(db, { query: "x".repeat(201) })).rejects.toMatchObject({ status: 400 });
  });

  it("cursor encode/decode round-trips and rejects tampering", () => {
    const cursor = encodeSearchCursor(1, "2026-09-15", 42);
    expect(decodeSearchCursor(cursor)).toEqual({ rank: 1, date: "2026-09-15", id: 42 });
    expect(() => decodeSearchCursor("")).toThrow();
    expect(() => decodeSearchCursor(cursor.slice(0, -2))).toThrow();
  });

  it("runs a bounded number of statements per search (no per-row queries)", async () => {
    const { db, raw } = openMigratedDb();
    await seedFixture(db);
    const origPrepare = raw.prepare.bind(raw);
    let selects = 0;
    (raw as { prepare: unknown }).prepare = (sqlText: string, ...rest: unknown[]) => {
      const stmt = (origPrepare as (...a: unknown[]) => Record<string, unknown>)(sqlText, ...rest);
      const head = sqlText.trim().split(/\s+/)[0]?.toUpperCase();
      if (head === "SELECT") {
        for (const method of ["all", "get", "run"] as const) {
          const orig = (stmt[method] as (...a: unknown[]) => unknown).bind(stmt);
          stmt[method] = (...args: unknown[]) => {
            selects++;
            return orig(...args);
          };
        }
      }
      return stmt;
    };
    await searchGlobal(db, { query: "whole" });
    // One statement each for transactions, payees (+options from the same
    // rows), and categories — never one per row.
    expect(selects).toBe(3);
  });
});
