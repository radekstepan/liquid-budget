import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accounts, getDefaultDb, resetAndSeedDatabase, resetDefaultDb, transactions } from "@ynab/server";
import { GET, POST, DELETE } from "../src/app/api/snapshots/route";

describe("/api/snapshots", () => {
  let tmpRoot: string;
  let snapsDir: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ynab-snapshots-route-"));
    snapsDir = path.join(tmpRoot, "snaps");
    vi.stubEnv("SNAPSHOTS_DIR", snapsDir);
    vi.stubEnv("DATABASE_URL", ":memory:");
    resetDefaultDb();
    await resetAndSeedDatabase(getDefaultDb());
  });

  afterEach(() => {
    resetDefaultDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function post(body: unknown, action?: string) {
    const url = action ? `http://localhost/api/snapshots?action=${action}` : "http://localhost/api/snapshots";
    return POST(new Request(url, { method: "POST", body: JSON.stringify(body) }));
  }

  it("GET returns an empty list plus a suggested name", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.snapshots).toEqual([]);
    expect(typeof json.suggestedName).toBe("string");
    expect(json.suggestedName.length).toBeGreaterThan(0);
  });

  it("POST creates a snapshot with an explicit name and GET lists it", async () => {
    const created = await post({ name: "before import" });
    expect(created.status).toBe(200);
    const createdJson = await created.json();
    expect(createdJson.ok).toBe(true);
    expect(createdJson.snapshot.name).toBe("before import");

    const listed = await (await GET()).json();
    expect(listed.snapshots).toHaveLength(1);
    expect(listed.snapshots[0].name).toBe("before import");
    expect(listed.snapshots[0].sizeBytes).toBeGreaterThan(0);
  });

  it("POST without a name falls back to the suggestion", async () => {
    const res = await post({});
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.snapshot.name.length).toBeGreaterThan(0);
  });

  it("POST rejects a non-string name", async () => {
    const res = await post({ name: 42 });
    expect(res.status).toBe(400);
  });

  it("DELETE removes the snapshot; unknown ids 404 and traversal ids 400", async () => {
    const created = await (await post({ name: "temp" })).json();
    const del = await DELETE(
      new Request(`http://localhost/api/snapshots?id=${created.snapshot.id}`, { method: "DELETE" })
    );
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);
    expect((await (await GET()).json()).snapshots).toEqual([]);

    const missing = await DELETE(new Request("http://localhost/api/snapshots?id=nope", { method: "DELETE" }));
    expect(missing.status).toBe(404);

    const traversal = await DELETE(
      new Request("http://localhost/api/snapshots?id=../evil", { method: "DELETE" })
    );
    expect(traversal.status).toBe(400);
  });

  it("restore refuses an in-memory database and requires an id", async () => {
    const res = await post({ id: "whatever" }, "restore");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/in-memory/i);

    const noId = await post({}, "restore");
    expect(noId.status).toBe(400);
  });

  it("restore brings back snapshotted data on a file-backed database", async () => {
    const dbFile = path.join(tmpRoot, "budget.db");
    vi.stubEnv("DATABASE_URL", dbFile);
    resetDefaultDb();
    const db = getDefaultDb();
    const [account] = await db
      .insert(accounts)
      .values({ name: "Checking", kind: "liquid", groupLabel: "Budget Accounts" })
      .returning();
    await db.insert(transactions).values({
      accountId: account!.id,
      payee: "Original",
      amount: -100,
      date: "2026-09-06",
    });

    const snap = await (await post({ name: "before mess" })).json();
    await db.insert(transactions).values({
      accountId: account!.id,
      payee: "Messy",
      amount: -200,
      date: "2026-09-07",
    });
    expect(await db.select().from(transactions)).toHaveLength(2);

    const restored = await post({ id: snap.snapshot.id }, "restore");
    expect(restored.status).toBe(200);
    expect((await restored.json()).ok).toBe(true);
    const rows = await getDefaultDb().select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payee).toBe("Original");
  });
});
