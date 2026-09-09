import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  categories,
  getDefaultDb,
  resetAndSeedDatabase,
} from "@ynab/server";
import { DELETE, GET, PATCH, POST } from "../src/app/api/payees/route";

vi.stubEnv("DATABASE_URL", ":memory:");

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createPayee(name: string): Promise<any> {
  const res = await POST(req("http://localhost:3000/api/payees", "POST", { name }));
  expect(res.status).toBe(200);
  return res.json();
}

describe("Payees API routes", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("creates a payee and lists it", async () => {
    await createPayee("Test Cafe");

    const getRes = await GET();
    expect(getRes.status).toBe(200);
    const list = await getRes.json();
    expect(list.some((p: any) => p.name === "Test Cafe")).toBe(true);
  });

  it("renames a payee and sets its default category", async () => {
    const created = await createPayee("Test Cafe");
    const db = getDefaultDb();
    const cat = db.select().from(categories).all()[0]!;

    const patchRes = await PATCH(
      req("http://localhost:3000/api/payees", "PATCH", {
        id: created.id,
        name: "Test Cafe Downtown",
        autoCategoryId: cat.id,
      })
    );
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.name).toBe("Test Cafe Downtown");
    expect(patched.autoCategoryId).toBe(cat.id);
  });

  it("rejects transfer payee names", async () => {
    const res = await POST(
      req("http://localhost:3000/api/payees", "POST", { name: "Transfer : Savings" })
    );
    expect(res.status).toBe(400);
  });

  it("merges source payees into the target", async () => {
    const target = await createPayee("Keeper");
    const source = await createPayee("Duplicate");

    const mergeRes = await POST(
      req("http://localhost:3000/api/payees?action=merge", "POST", {
        targetId: target.id,
        sourceIds: [source.id],
      })
    );
    expect(mergeRes.status).toBe(200);

    const list = await (await GET()).json();
    expect(list.some((p: any) => p.name === "Keeper")).toBe(true);
    expect(list.some((p: any) => p.name === "Duplicate")).toBe(false);
  });

  it("returns 404 for unknown payees", async () => {
    const patchRes = await PATCH(
      req("http://localhost:3000/api/payees", "PATCH", { id: 424242, name: "Ghost" })
    );
    expect(patchRes.status).toBe(404);

    const created = await createPayee("Keeper");
    const mergeRes = await POST(
      req("http://localhost:3000/api/payees?action=merge", "POST", {
        targetId: 424242,
        sourceIds: [created.id],
      })
    );
    expect(mergeRes.status).toBe(404);
  });

  it("deletes a payee", async () => {
    const created = await createPayee("Temporary");

    const delRes = await DELETE(
      req(`http://localhost:3000/api/payees?id=${created.id}`, "DELETE")
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });

    const list = await (await GET()).json();
    expect(list.some((p: any) => p.name === "Temporary")).toBe(false);
  });
});
