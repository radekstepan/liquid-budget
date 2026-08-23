import { describe, expect, it, vi, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { extractYnab4DataFromZip, getDefaultDb, seedDatabase } from "@ynab/server";
import { GET } from "../src/app/api/export/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("GET /api/export", () => {
  beforeAll(async () => {
    const db = getDefaultDb();
    await seedDatabase(db);
  }, 20000);

  it("exports YNAB4 backup archive (.y4backup) by default", async () => {
    const req = new NextRequest("http://localhost:3000/api/export");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toContain(".y4backup");

    const arrayBuf = await res.arrayBuffer();
    expect(arrayBuf.byteLength).toBeGreaterThan(100);

    const extracted = extractYnab4DataFromZip(arrayBuf);
    expect(extracted.ynabData).toBeDefined();
    expect(extracted.settingsXml).toBeDefined();
    expect(extracted.ynabData.accounts.length).toBeGreaterThan(0);
    expect(extracted.ynabData.transactions.length).toBeGreaterThan(0);
  });
});

