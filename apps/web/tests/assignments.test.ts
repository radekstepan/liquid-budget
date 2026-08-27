import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  createCategory,
  createCategoryGroup,
  getDefaultDb,
  resetAndSeedDatabase,
} from "@ynab/server";
import { PUT } from "../src/app/api/assignments/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("PUT /api/assignments (BUG-43)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("upserts assignment for existing category", async () => {
    const db = getDefaultDb();
    const group = await createCategoryGroup(db, { name: "Living" });
    const category = await createCategory(db, { groupId: group!.id, name: "Rent" });

    const req = new NextRequest("http://localhost:3000/api/assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryId: category!.id,
        month: "2026-08",
        amount: 150000,
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categoryId).toBe(category!.id);
    expect(json.amount).toBe(150000);
  });

  it("returns 400 when upserting assignment with non-existent category (FK constraint handled cleanly)", async () => {
    const req = new NextRequest("http://localhost:3000/api/assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryId: 99999,
        month: "2026-08",
        amount: 150000,
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });
});
