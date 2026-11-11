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
import { parseReportAggregatesResponse } from "@ynab/logic";
import { GET } from "../src/app/api/reports/route";

vi.stubEnv("DATABASE_URL", ":memory:");

function get(url: string) {
  return new NextRequest(url);
}

describe("GET /api/reports (P1 sql-aggregation)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("returns SQL aggregates matching the seeded budget", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });
    const group = await createCategoryGroup(db, { name: "Living" });
    const groceries = await createCategory(db, { groupId: group!.id, name: "Groceries" });

    // Far-future month: the demo seed posts nothing here, so GROUP BY
    // buckets hold exactly our rows.
    await createTransaction(db, {
      accountId: account!.id,
      categoryId: groceries!.id,
      amount: -5000,
      date: "2031-07-03",
      payee: "Store",
    });
    await createTransaction(db, {
      accountId: account!.id,
      amount: 90000,
      date: "2031-07-05",
      payee: "Employer",
    });

    const res = await GET(get("http://localhost:3000/api/reports?startMonth=2031-07&endMonth=2031-07"));
    expect(res.status).toBe(200);
    const json = await res.json();
    const parsed = parseReportAggregatesResponse(json);
    expect(parsed.outflow).toEqual([{ month: "2031-07", categoryId: groceries!.id, total: -5000 }]);
    expect(parsed.income).toEqual([{ month: "2031-07", incomeMonth: "2031-07", total: 90000 }]);
    expect(parsed.accountDeltas).toEqual([{ month: "2031-07", accountId: account!.id, total: 85000 }]);
  });

  it("unfiltered GET validates against the aggregates contract", async () => {
    const res = await GET(get("http://localhost:3000/api/reports"));
    expect(res.status).toBe(200);
    parseReportAggregatesResponse(await res.json());
  });

  it("rejects malformed months with 400", async () => {
    const res = await GET(get("http://localhost:3000/api/reports?startMonth=june"));
    expect(res.status).toBe(400);
  });
});
