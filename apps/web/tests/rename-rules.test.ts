import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  createRenameRule,
  getDefaultDb,
  resetAndSeedDatabase,
} from "@ynab/server";
import { DELETE, GET, PATCH, POST } from "../src/app/api/rename-rules/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("Rename rules API routes (BUG-43)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("creates and retrieves rename rules", async () => {
    const postReq = new NextRequest("http://localhost:3000/api/rename-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcePattern: "AMZN*123",
        targetPayee: "Amazon",
      }),
    });
    const postRes = await POST(postReq);
    expect(postRes.status).toBe(200);
    const postJson = await postRes.json();
    expect(postJson.sourcePattern).toBe("AMZN*123");
    expect(postJson.targetPayee).toBe("Amazon");

    const getRes = await GET();
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.some((r: any) => r.sourcePattern === "AMZN*123")).toBe(true);
  });

  it("returns 409 when creating duplicate rename rule", async () => {
    const db = getDefaultDb();
    await createRenameRule(db, {
      sourcePattern: "SPOTIFY*",
      targetPayee: "Spotify",
    });

    const postReq = new NextRequest("http://localhost:3000/api/rename-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcePattern: "SPOTIFY*",
        targetPayee: "Spotify",
      }),
    });
    const postRes = await POST(postReq);
    expect(postRes.status).toBe(409);
    const json = await postRes.json();
    expect(json.error).toContain("already exists");
  });

  it("returns 404 when patching non-existent rename rule", async () => {
    const patchReq = new NextRequest("http://localhost:3000/api/rename-rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 99999,
        targetPayee: "Nonexistent",
      }),
    });
    const patchRes = await PATCH(patchReq);
    expect(patchRes.status).toBe(404);
  });

  it("validates id parameter on delete", async () => {
    const delReq = new NextRequest("http://localhost:3000/api/rename-rules?id=invalid", {
      method: "DELETE",
    });
    const delRes = await DELETE(delReq);
    expect(delRes.status).toBe(400);
  });
});
