import { describe, expect, it, vi, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../src/app/api/export/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("GET /api/export (UNI-37 / F-18)", () => {
  beforeAll(async () => {
    const { getDefaultDb } = await import("@ynab/server");
    getDefaultDb();
  }, 20000);

  it("exports CSV by default", async () => {
    const req = new NextRequest("http://localhost:3000/api/export");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain(".csv");
    const text = await res.text();
    expect(text).toContain("Type,ID,Name");
  });

  it("exports JSON when ?format=json is passed", async () => {
    const req = new NextRequest("http://localhost:3000/api/export?format=json");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Content-Disposition")).toContain(".json");
    const data = await res.json();
    expect(data).toHaveProperty("accounts");
    expect(data).toHaveProperty("categories");
    expect(data).toHaveProperty("transactions");
  });

  it("exports raw SQLite database binary when ?format=sqlite is passed", async () => {
    const req = new NextRequest("http://localhost:3000/api/export?format=sqlite");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-sqlite3");
    expect(res.headers.get("Content-Disposition")).toContain(".db");
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
    // SQLite header starts with "SQLite format 3\0"
    const header = new TextDecoder().decode(buffer.slice(0, 15));
    expect(header).toBe("SQLite format 3");
  });
});
