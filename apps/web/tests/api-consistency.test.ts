import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createRecurring,
  createTransaction,
  getDefaultDb,
  resetAndSeedDatabase,
  resetDefaultDb,
  transactions,
} from "@ynab/server";
import { resolveAction } from "../src/app/api/action";
import { POST as TransactionsPOST, PATCH as TransactionsPATCH } from "../src/app/api/transactions/route";
import { POST as SnapshotsPOST } from "../src/app/api/snapshots/route";
import { POST as PayeesPOST } from "../src/app/api/payees/route";
import { POST as RecurringPOST } from "../src/app/api/recurring/route";
import { POST as SuggestPOST } from "../src/app/api/rename-rules/suggest/route";
import { POST as ReconcilePOST } from "../src/app/api/reconcile/route";

vi.stubEnv("DATABASE_URL", ":memory:");

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("api-consistency: canonical body {action} + deprecated ?action= alias", () => {
  beforeEach(async () => {
    await resetAndSeedDatabase(getDefaultDb());
  });

  it("resolveAction prefers body over query and maps legacy aliases", () => {
    const r = (url: string, body?: unknown) =>
      resolveAction(new Request(url), body, ["delete", "merge", "bulk-update"], {
        "bulk-delete": "delete",
      });
    expect(r("http://x/", { action: "delete" })).toBe("delete");
    expect(r("http://x/?action=bulk-delete", { ids: [1] })).toBe("delete");
    expect(r("http://x/?action=merge", { action: "delete", ids: [1] })).toBe("delete");
    expect(r("http://x/", { ids: [1] })).toBeNull();
    expect(r("http://x/?action=nope", { action: "nope" })).toBeNull();
  });

  it("transactions bulk-delete: body canonical and query alias both delete", async () => {
    const db = getDefaultDb();
    const account = (await createAccount(db, { name: "Checking", kind: "liquid" }))!;
    const mk = () =>
      createTransaction(db, { accountId: account.id, amount: -100, date: "2026-08-01", payee: "S" });
    const a = (await mk())!;
    const b = (await mk())!;

    const canonical = await TransactionsPOST(req("http://localhost/api/transactions", "POST", { action: "delete", ids: [a.id] }));
    expect(canonical.status).toBe(200);
    expect((await canonical.json()).count).toBe(1);

    const legacy = await TransactionsPOST(
      req("http://localhost/api/transactions?action=bulk-delete", "POST", { ids: [b.id] })
    );
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).count).toBe(1);
  });

  it("transactions merge: body canonical and query alias both merge", async () => {
    const db = getDefaultDb();
    const account = (await createAccount(db, { name: "Checking", kind: "liquid" }))!;
    const mkPair = () =>
      Promise.all([
        createTransaction(db, { accountId: account.id, amount: -100, date: "2026-08-01", payee: "Store A" }),
        createTransaction(db, { accountId: account.id, amount: -100, date: "2026-08-01", payee: "STORE A #1" }),
      ]);
    const [a1, a2] = (await mkPair()) as [{ id: number }, { id: number }];
    const canonical = await TransactionsPOST(
      req("http://localhost/api/transactions", "POST", { action: "merge", ids: [a1.id, a2.id] })
    );
    expect(canonical.status).toBe(200);
    expect((await canonical.json()).ok).toBe(true);

    const [b1, b2] = (await mkPair()) as [{ id: number }, { id: number }];
    const legacy = await TransactionsPOST(
      req("http://localhost/api/transactions?action=merge", "POST", { ids: [b1.id, b2.id] })
    );
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).ok).toBe(true);
  });

  it("transactions PATCH: body action and bare-ids fallback both bulk-update", async () => {
    const db = getDefaultDb();
    const account = (await createAccount(db, { name: "Checking", kind: "liquid" }))!;
    const t1 = (await createTransaction(db, { accountId: account.id, amount: -100, date: "2026-08-01", payee: "A" }))!;
    const t2 = (await createTransaction(db, { accountId: account.id, amount: -200, date: "2026-08-01", payee: "B" }))!;

    const canonical = await TransactionsPATCH(
      req("http://localhost/api/transactions", "PATCH", { action: "bulk-update", ids: [t1.id], patch: { memo: "x" } })
    );
    expect(canonical.status).toBe(200);

    const legacy = await TransactionsPATCH(
      req("http://localhost/api/transactions", "PATCH", { ids: [t2.id], patch: { memo: "y" } })
    );
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).count).toBe(1);
  });

  it("snapshots: create validates name; restore dispatch works via body and query", async () => {
    const badName = await SnapshotsPOST(req("http://localhost/api/snapshots", "POST", { name: 42 }));
    expect(badName.status).toBe(400);

    // Both spellings reach the restore branch (in-memory DB cannot restore).
    const viaBody = await SnapshotsPOST(
      req("http://localhost/api/snapshots", "POST", { action: "restore", id: "whatever" })
    );
    expect(viaBody.status).toBe(400);
    expect((await viaBody.json()).error).toMatch(/in-memory/i);

    const viaQuery = await SnapshotsPOST(
      req("http://localhost/api/snapshots?action=restore", "POST", { id: "whatever" })
    );
    expect(viaQuery.status).toBe(400);
    expect((await viaQuery.json()).error).toMatch(/in-memory/i);

    // Missing id is a restore validation 400, while a bare body creates.
    const missingId = await SnapshotsPOST(req("http://localhost/api/snapshots", "POST", { action: "restore" }));
    expect(missingId.status).toBe(400);
  });

  it("payees merge: body canonical and query alias both merge", async () => {
    const mk = async (name: string) => {
      const res = await PayeesPOST(req("http://localhost/api/payees", "POST", { name }));
      expect(res.status).toBe(200);
      return (await res.json()).id as number;
    };
    const t1 = await mk("Cafe Alpha");
    const s1 = await mk("Cafe Alphaa");
    const canonical = await PayeesPOST(
      req("http://localhost/api/payees", "POST", { action: "merge", targetId: t1, sourceIds: [s1] })
    );
    expect(canonical.status).toBe(200);

    const t2 = await mk("Cafe Beta");
    const s2 = await mk("Cafe Betaa");
    const legacy = await PayeesPOST(
      req("http://localhost/api/payees?action=merge", "POST", { targetId: t2, sourceIds: [s2] })
    );
    expect(legacy.status).toBe(200);
  });

  it("recurring post/autopost: body canonical and query alias share one dispatch", async () => {
    const db = getDefaultDb();
    const account = (await createAccount(db, { name: "Checking", kind: "liquid" }))!;
    const rec = (await createRecurring(db, {
      accountId: account.id,
      categoryId: null,
      amount: -1500,
      frequency: "monthly",
      nextDate: "2026-09-01",
      payee: "Gym",
    }))!;

    const viaBody = await RecurringPOST(
      req("http://localhost/api/recurring", "POST", { action: "post", id: rec.id })
    );
    expect(viaBody.status).toBe(200);

    const rec2 = (await createRecurring(db, {
      accountId: account.id,
      categoryId: null,
      amount: -500,
      frequency: "monthly",
      nextDate: "2026-09-01",
      payee: "Music",
    }))!;
    const viaQuery = await RecurringPOST(
      new NextRequest(`http://localhost/api/recurring?action=post&id=${rec2.id}`, { method: "POST" })
    );
    expect(viaQuery.status).toBe(200);

    const autoBody = await RecurringPOST(
      req("http://localhost/api/recurring", "POST", { action: "autopost" })
    );
    expect(autoBody.status).toBe(200);
  });

  it("suggest accept: body canonical and query alias both validate", async () => {
    const badBody = await SuggestPOST(
      req("http://localhost/api/rename-rules/suggest", "POST", { action: "accept", suggestions: [] })
    );
    expect(badBody.status).toBe(400);

    const badQuery = await SuggestPOST(
      req("http://localhost/api/rename-rules/suggest?action=accept", "POST", { suggestions: [] })
    );
    expect(badQuery.status).toBe(400);

    const unknownBody = await SuggestPOST(
      req("http://localhost/api/rename-rules/suggest", "POST", { action: "nope" })
    );
    expect(unknownBody.status).toBe(400);
  });

  it("reconcile unreconcile: body canonical and query alias both dispatch", async () => {
    const db = getDefaultDb();
    const account = (await createAccount(db, { name: "Checking", kind: "liquid" }))!;
    const group = (await createCategoryGroup(db, { name: "Living" }))!;
    const category = (await createCategory(db, { groupId: group.id, name: "Groceries" }))!;

    const reconcileBody = {
      action: "reconcile",
      accountId: account.id,
      statementBalance: 0,
      statementDate: "2026-09-06",
      adjustmentCategoryId: category.id,
    };
    const reconciled = await ReconcilePOST(req("http://localhost/api/reconcile", "POST", reconcileBody));
    expect(reconciled.status).toBe(200);

    const viaBody = await ReconcilePOST(
      req("http://localhost/api/reconcile", "POST", { action: "unreconcile", accountId: account.id })
    );
    expect(viaBody.status).toBe(200);

    // Reconcile again so the query-alias unreconcile has something to undo.
    expect((await ReconcilePOST(req("http://localhost/api/reconcile", "POST", reconcileBody))).status).toBe(200);
    const viaQuery = await ReconcilePOST(
      req("http://localhost/api/reconcile?action=unreconcile", "POST", { accountId: account.id })
    );
    expect(viaQuery.status).toBe(200);
  });
});

describe("api-consistency: snapshot restore canonical body on a file-backed DB", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ynab-api-consistency-"));
    vi.stubEnv("SNAPSHOTS_DIR", path.join(tmpRoot, "snaps"));
    const dbFile = path.join(tmpRoot, "budget.db");
    vi.stubEnv("DATABASE_URL", dbFile);
    resetDefaultDb();
    await resetAndSeedDatabase(getDefaultDb());
  });

  afterEach(() => {
    resetDefaultDb();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", ":memory:");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("POST body {action:restore,id} round-trips snapshotted data", async () => {
    const db = getDefaultDb();
    const [account] = await db
      .insert((await import("@ynab/server")).accounts)
      .values({ name: "Checking", kind: "liquid", groupLabel: "Budget Accounts" })
      .returning();
    await db.insert(transactions).values({ accountId: account!.id, payee: "Original", amount: -100, date: "2026-09-06" });

    const snap = await (await SnapshotsPOST(req("http://localhost/api/snapshots", "POST", { name: "before" }))).json();
    const atSnap = (await db.select().from(transactions)).length;
    await db.insert(transactions).values({ accountId: account!.id, payee: "Messy", amount: -200, date: "2026-09-07" });
    expect(await db.select().from(transactions)).toHaveLength(atSnap + 1);

    const restored = await SnapshotsPOST(
      req("http://localhost/api/snapshots", "POST", { action: "restore", id: snap.snapshot.id })
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).ok).toBe(true);
    expect(await getDefaultDb().select().from(transactions)).toHaveLength(atSnap);
  });
});
