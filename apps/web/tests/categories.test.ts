import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createCategory, createCategoryGroup, getDefaultDb, resetAndSeedDatabase } from "@ynab/server";
import { PATCH } from "../src/app/api/categories/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("PATCH /api/categories (BUG-5.2 / BUG-04)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
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

  it("handles empty patch for category without throwing 'No values to set' (BUG-04)", async () => {
    const db = getDefaultDb();
    const group = await createCategoryGroup(db, { name: "Test Group" });
    const cat = await createCategory(db, { groupId: group!.id, name: "Dining Out" });

    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cat!.id }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(cat!.id);
    expect(json.name).toBe("Dining Out");
  });

  it("resets carryover to 0 when carryover: 0 is sent in PATCH (BUG-05)", async () => {
    const db = getDefaultDb();
    const group = await createCategoryGroup(db, { name: "Test Group" });
    const cat = await createCategory(db, {
      groupId: group!.id,
      name: "Emergency Fund",
      carryover: 5000,
    });
    expect(cat!.carryover).toBe(5000);

    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cat!.id, carryover: 0 }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.carryover).toBe(0);
  });

  it("resets carryover to 0 when carryover: null is sent in PATCH (BUG-05)", async () => {
    const db = getDefaultDb();
    const group = await createCategoryGroup(db, { name: "Test Group" });
    const cat = await createCategory(db, {
      groupId: group!.id,
      name: "Emergency Fund",
      carryover: 5000,
    });
    expect(cat!.carryover).toBe(5000);

    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cat!.id, carryover: null }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.carryover).toBe(0);
  });

  it("BUG-19: preserves goalTarget, carryover, and overspendCarriesOver when updating sort or name", async () => {
    const db = getDefaultDb();
    const group = await createCategoryGroup(db, { name: "Test Group" });
    const cat = await createCategory(db, {
      groupId: group!.id,
      name: "Emergency Fund",
      goalTarget: 100000,
      carryover: 5000,
      overspendCarriesOver: true,
    });
    expect(cat!.goalTarget).toBe(100000);
    expect(cat!.overspendCarriesOver).toBe(true);

    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cat!.id, sort: 10 }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sort).toBe(10);
    expect(json.name).toBe("Emergency Fund");
    expect(json.goalTarget).toBe(100000);
    expect(json.carryover).toBe(5000);
    expect(json.overspendCarriesOver).toBe(true);
  });

  it("BUG-43: returns 404 when patching non-existent category", async () => {
    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 99999, name: "Ghost Category" }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Category not found");
  });

  it("BUG-43: returns 404 when patching non-existent category group", async () => {
    const req = new NextRequest("http://localhost:3000/api/categories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "group", id: 99999, name: "Ghost Group" }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Category group not found");
  });
});
