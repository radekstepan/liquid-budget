import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultDb, resetDefaultDb } from "../src/client.js";
import {
  __resetSnapshotRateLimitForTests,
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  SnapshotError,
  suggestSnapshotName,
  MAX_SNAPSHOT_NAME_LENGTH,
} from "../src/snapshots.js";
import * as schema from "../src/schema.js";

describe("snapshots", () => {
  let tmpRoot: string;
  let snapsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ynab-snapshots-test-"));
    snapsDir = path.join(tmpRoot, "snaps");
    vi.stubEnv("DATABASE_URL", path.join(tmpRoot, "budget.db"));
    vi.stubEnv("SNAPSHOTS_DIR", snapsDir);
    resetDefaultDb();
    __resetSnapshotRateLimitForTests();
  });

  afterEach(() => {
    resetDefaultDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function seedAccount(name = "Checking") {
    const db = getDefaultDb();
    const [account] = await db
      .insert(schema.accounts)
      .values({ name, kind: "liquid", groupLabel: "Budget Accounts" })
      .returning();
    return account!;
  }

  async function seedTransaction(
    accountId: number,
    over: { payee?: string; memo?: string; amount?: number; date?: string } = {}
  ) {
    const db = getDefaultDb();
    const [row] = await db
      .insert(schema.transactions)
      .values({
        accountId,
        payee: over.payee ?? "Whole Foods",
        memo: over.memo ?? "",
        amount: over.amount ?? -8420,
        date: over.date ?? "2026-09-06",
      })
      .returning();
    return row!;
  }

  async function countTransactions(): Promise<number> {
    return (await getDefaultDb().select().from(schema.transactions)).length;
  }

  describe("suggestSnapshotName", () => {
    it("returns 'Empty budget' when there are no transactions", async () => {
      await seedAccount();
      expect(await suggestSnapshotName(getDefaultDb())).toBe("Empty budget");
    });

    it("names the snapshot after the latest transaction", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id, { payee: "Old Shop", amount: -100, date: "2026-09-01" });
      await seedTransaction(account.id, { payee: "Whole Foods", amount: -8420, date: "2026-09-06" });
      expect(await suggestSnapshotName(getDefaultDb())).toBe("Whole Foods -$84.20 (2026-09-06)");
    });

    it("breaks date ties by newest id and signs positive amounts with +", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id, { payee: "First", amount: -100, date: "2026-09-06" });
      await seedTransaction(account.id, { payee: "Employer", amount: 500000, date: "2026-09-06" });
      expect(await suggestSnapshotName(getDefaultDb())).toBe("Employer +$5000.00 (2026-09-06)");
    });

    it("falls back to memo, then Untitled, when payee is blank", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id, { payee: "   ", memo: "side hustle", amount: 2000 });
      expect(await suggestSnapshotName(getDefaultDb())).toBe("side hustle +$20.00 (2026-09-06)");
      await seedTransaction(account.id, { payee: "", memo: "", amount: 100, date: "2026-09-07" });
      expect(await suggestSnapshotName(getDefaultDb())).toBe("Untitled +$1.00 (2026-09-07)");
    });
  });

  describe("createSnapshot / listSnapshots", () => {
    it("stores an explicit name and lists the snapshot with its size", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id);
      const snap = await createSnapshot(getDefaultDb(), { name: "before import" });
      expect(snap.name).toBe("before import");
      expect(snap.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(snap.sizeBytes).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(snapsDir, `${snap.id}.db`))).toBe(true);
      expect(fs.existsSync(path.join(snapsDir, `${snap.id}.json`))).toBe(true);

      const listed = listSnapshots();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: snap.id, name: "before import" });
    });

    it("prefills the suggestion when no name is given", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id);
      const snap = await createSnapshot(getDefaultDb(), {});
      expect(snap.name).toBe("Whole Foods -$84.20 (2026-09-06)");
    });

    it("falls back to the suggestion for blank names and truncates long names", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id);
      const blank = await createSnapshot(getDefaultDb(), { name: "   " });
      expect(blank.name).toBe("Whole Foods -$84.20 (2026-09-06)");

      const long = await createSnapshot(getDefaultDb(), { name: "x".repeat(500) });
      expect(long.name).toHaveLength(MAX_SNAPSHOT_NAME_LENGTH);
    });

    it("lists newest first and falls back to the id when the sidecar is missing", async () => {
      await seedAccount();
      const first = await createSnapshot(getDefaultDb(), { name: "older" });
      const second = await createSnapshot(getDefaultDb(), { name: "newer" });
      fs.writeFileSync(
        path.join(snapsDir, `${first.id}.json`),
        JSON.stringify({ name: "older", createdAt: "2020-01-01T00:00:00.000Z" })
      );
      fs.writeFileSync(
        path.join(snapsDir, `${second.id}.json`),
        JSON.stringify({ name: "newer", createdAt: "2021-01-01T00:00:00.000Z" })
      );
      expect(listSnapshots().map((s) => s.id)).toEqual([second.id, first.id]);

      fs.unlinkSync(path.join(snapsDir, `${second.id}.json`));
      const relisted = listSnapshots().find((s) => s.id === second.id)!;
      expect(relisted.name).toBe(second.id);
    });

    it("returns [] when the snapshots directory does not exist", () => {
      expect(listSnapshots(path.join(tmpRoot, "nope"))).toEqual([]);
    });

    it("rejects creation past the snapshot quota with 429", async () => {
      await seedAccount();
      fs.mkdirSync(snapsDir, { recursive: true });
      const { MAX_SNAPSHOTS } = await import("../src/snapshots.js");
      for (let i = 0; i < MAX_SNAPSHOTS; i++) {
        fs.writeFileSync(path.join(snapsDir, `qtest-${String(i).padStart(4, "0")}.db`), "x");
      }
      await expect(createSnapshot(getDefaultDb(), { name: "one too many" })).rejects.toMatchObject({
        name: "SnapshotError",
        status: 429,
      });
    });

    it("throttles rapid creation with 429", async () => {
      const { __resetSnapshotRateLimitForTests, MAX_SNAPSHOT_CREATES_PER_MINUTE } = await import(
        "../src/snapshots.js"
      );
      __resetSnapshotRateLimitForTests();
      await seedAccount();
      for (let i = 0; i < MAX_SNAPSHOT_CREATES_PER_MINUTE; i++) {
        await createSnapshot(getDefaultDb(), { name: `burst ${i}` });
      }
      await expect(createSnapshot(getDefaultDb(), { name: "over the line" })).rejects.toMatchObject({
        name: "SnapshotError",
        status: 429,
      });
    });
  });

  describe("restoreSnapshot", () => {
    it("brings back the snapshotted data", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id, { payee: "Original" });
      expect(await countTransactions()).toBe(1);
      const snap = await createSnapshot(getDefaultDb(), { name: "before mess" });

      await seedTransaction(account.id, { payee: "Messy", date: "2026-09-07" });
      expect(await countTransactions()).toBe(2);

      const restored = await restoreSnapshot(snap.id);
      expect(restored).toMatchObject({ id: snap.id, name: "before mess" });
      const rows = await getDefaultDb().select().from(schema.transactions);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payee).toBe("Original");
    });

    it("rejects unknown ids with 404 and traversal ids with 400", async () => {
      await expect(restoreSnapshot("does-not-exist")).rejects.toMatchObject({
        name: "SnapshotError",
        status: 404,
      });
      await expect(restoreSnapshot("../evil")).rejects.toMatchObject({ status: 400 });
      await expect(restoreSnapshot("")).rejects.toMatchObject({ status: 400 });
    });

    it("rejects a truncated snapshot with 422 and leaves the live DB untouched", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id, { payee: "Original" });
      const snap = await createSnapshot(getDefaultDb(), { name: "good" });
      const before = await getDefaultDb().select().from(schema.transactions);

      const corruptId = "corruptintegrity1";
      fs.copyFileSync(path.join(snapsDir, `${snap.id}.db`), path.join(snapsDir, `${corruptId}.db`));
      const size = fs.statSync(path.join(snapsDir, `${corruptId}.db`)).size;
      fs.truncateSync(path.join(snapsDir, `${corruptId}.db`), Math.floor(size / 2));
      fs.writeFileSync(
        path.join(snapsDir, `${corruptId}.json`),
        JSON.stringify({ name: "corrupt", createdAt: new Date().toISOString() })
      );

      await expect(restoreSnapshot(corruptId)).rejects.toMatchObject({
        name: "SnapshotError",
        status: 422,
      });
      const after = await getDefaultDb().select().from(schema.transactions);
      expect(after).toEqual(before);
    });

    it("rejects a non-database file with 422 without touching the live DB", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id, { payee: "Original" });
      const before = await getDefaultDb().select().from(schema.transactions);

      const badId = "notadbfile1";
      fs.mkdirSync(snapsDir, { recursive: true });
      fs.writeFileSync(path.join(snapsDir, `${badId}.db`), "this is not sqlite");
      fs.writeFileSync(
        path.join(snapsDir, `${badId}.json`),
        JSON.stringify({ name: "bad", createdAt: new Date().toISOString() })
      );

      await expect(restoreSnapshot(badId)).rejects.toMatchObject({
        name: "SnapshotError",
        status: 422,
      });
      expect(await getDefaultDb().select().from(schema.transactions)).toEqual(before);
    });

    it("leaves no staging or pre-restore files behind after a successful restore", async () => {
      const account = await seedAccount();
      await seedTransaction(account.id, { payee: "Original" });
      const snap = await createSnapshot(getDefaultDb(), { name: "before mess" });
      await seedTransaction(account.id, { payee: "Messy", date: "2026-09-07" });

      await restoreSnapshot(snap.id);
      const leftovers = fs
        .readdirSync(tmpRoot)
        .filter((f) => f.includes("pre-restore") || f.includes("restore-tmp") || f.includes("rollback-tmp"));
      expect(leftovers).toEqual([]);
    });
  });

  describe("deleteSnapshot", () => {
    it("removes the snapshot files", async () => {
      await seedAccount();
      const snap = await createSnapshot(getDefaultDb(), { name: "temp" });
      deleteSnapshot(snap.id);
      expect(listSnapshots()).toEqual([]);
      expect(fs.existsSync(path.join(snapsDir, `${snap.id}.db`))).toBe(false);
    });

    it("rejects unknown ids with 404 and traversal ids with 400", async () => {
      expect(() => deleteSnapshot("does-not-exist")).toThrowError(
        expect.objectContaining({ name: "SnapshotError", status: 404 })
      );
      expect(() => deleteSnapshot("../../budget")).toThrowError(
        expect.objectContaining({ status: 400 })
      );
    });

    it("SnapshotError carries its status for the API error mapper", () => {
      const err = new SnapshotError("nope", 404);
      expect(err.status).toBe(404);
      expect(new SnapshotError("bad").status).toBe(400);
    });
  });
});
