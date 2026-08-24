import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createCategoryGroup, getDefaultDb, resetDatabase, seedDatabase } from "@ynab/server";
import { PATCH } from "../src/app/api/categories/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("PATCH /api/categories (BUG-5.2)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetDatabase(db);
    await seedDatabase(db);
  });

  it("rejects group PATCH with no fields (400 Bad Request)", async () => {
    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group", id: 1 }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("At least one of name or sort must be provided");
  });

  it("rejects group PATCH with empty name (400 Bad Request)", async () => {
    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group", id: 1, name: "" }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("renames group when only name is provided, preserving sort", async () => {
    const db = getDefaultDb();
    const group = await createCategoryGroup(db, { name: "Original Group" });

    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group", id: group!.id, name: "Renamed Group" }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("Renamed Group");
    expect(json.sort).toBe(group!.sort);
  });

  it("updates sort when only sort is provided, preserving name", async () => {
    const db = getDefaultDb();
    const group = await createCategoryGroup(db, { name: "Sort Only Group" });

    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group", id: group!.id, sort: 88 }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("Sort Only Group");
    expect(json.sort).toBe(88);
  });

  it("updates both name and sort together when both are provided", async () => {
    const db = getDefaultDb();
    const group = await createCategoryGroup(db, { name: "Before Both" });

    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group", id: group!.id, name: "After Both", sort: 99 }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("After Both");
    expect(json.sort).toBe(99);
  });
});
