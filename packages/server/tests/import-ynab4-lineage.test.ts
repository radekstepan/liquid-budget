/**
 * import-ynab4-lineage.test.ts (G-05 + G-08)
 *
 * G-05 — per-transaction fidelity on import:
 *   - `checkNumber` (`BaseTransactionVO`) + OFX lineage (`FITID`,
 *     `YNABID`, `importedPayee`, `source` on `MatchableTransactionVO`)
 *     persist on plain, split-parent, and split-child rows and
 *     round-trip through the exporter.
 *   - Match-workflow fields (`accepted`, `matchedTransactions`,
 *     `parentTransactionIdIfMatched`, `dateEnteredFromSchedule`) are
 *     intentionally dropped (our match workflow differs; export
 *     hardcodes `accepted: true`) but surface as aggregated warnings,
 *     never silently.
 *
 * G-08 — scheduled-transaction fidelity on import:
 *   - `twiceAMonthStartDay` persists on `recurring.second_anchor_day`
 *     and round-trips through the exporter.
 *   - Unknown frequency strings fall back to monthly with a warning
 *     (not silently).
 *   - Single-child scheduled splits collapse to plain rows with a
 *     warning (behavior kept, now visible).
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { exportYnab4 } from "../src/export-ynab4.js";
import { importYnab4 } from "../src/import-ynab4.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb(): Db {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

// All amounts are milliunits (x1000) so the scale detector divides by 10:
// e.g. -45250 -> -4525 cents.
const ynabData = {
  accounts: [{ entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true }],
  payees: [{ entityId: "p1", name: "Grocery Store" }],
  masterCategories: [],
  transactions: [
    {
      // Carries all six G-05 fields plus every dropped match-link field.
      entityId: "t-full",
      accountId: "acc1",
      date: "2026-06-01",
      amount: -45250,
      cleared: "Cleared",
      payeeId: "p1",
      checkNumber: "1042",
      FITID: "FIT-001",
      YNABID: "YNAB-001",
      importedPayee: "SAFEWAY #123",
      source: "OFX",
      accepted: false,
      matchedTransactions: [{ entityId: "m1", accountId: "acc1", date: "2026-06-01", amount: -45250 }],
      parentTransactionIdIfMatched: "other-tx",
      dateEnteredFromSchedule: "2026-05-30",
    },
    {
      entityId: "t-split",
      accountId: "acc1",
      date: "2026-06-02",
      amount: -30000,
      cleared: "Cleared",
      payeeId: "p1",
      checkNumber: "1043",
      FITID: "FIT-SPLIT",
      accepted: false,
      subTransactions: [
        { entityId: "st-1", amount: -20000, memo: "part a", checkNumber: "1043-A" },
        { entityId: "st-2", amount: -10000, memo: "part b" },
      ],
    },
  ],
  monthlyBudgets: [],
  scheduledTransactions: [
    {
      entityId: "sched-twice",
      accountId: "acc1",
      date: "2026-07-01",
      amount: -50000,
      frequency: "TwiceAMonth",
      anchorDay: 1,
      twiceAMonthStartDay: 15,
      payeeId: "p1",
    },
    {
      entityId: "sched-weird",
      accountId: "acc1",
      date: "2026-07-05",
      amount: -10000,
      frequency: "Fortnightly",
      payeeId: "p1",
    },
    {
      entityId: "sched-single",
      accountId: "acc1",
      date: "2026-07-10",
      amount: -20000,
      frequency: "Monthly",
      payeeId: "p1",
      subTransactions: [{ entityId: "ss-1", amount: -20000, memo: "only child" }],
    },
  ],
};

describe("G-05 transaction lineage + match-state warnings", () => {
  it("persists checkNumber and OFX lineage, warns on dropped match state, and round-trips export", async () => {
    const db = openMigratedDb();
    const summary = await importYnab4(db, structuredClone(ynabData), "");

    // Plain row keeps all five persisted fields (milliunits -> cents).
    const rows = await db.select().from(schema.transactions);
    const full = rows.find((r) => r.entityId === "t-full");
    expect(full).toBeDefined();
    expect(Number(full!.amount)).toBe(-4525);
    expect(full!.checkNumber).toBe("1042");
    expect(full!.fitid).toBe("FIT-001");
    expect(full!.ynabId).toBe("YNAB-001");
    expect(full!.importedPayee).toBe("SAFEWAY #123");
    expect(full!.source).toBe("OFX");

    // Split parent + children.
    const parent = rows.find((r) => r.entityId === "t-split");
    expect(parent).toBeDefined();
    expect(parent!.checkNumber).toBe("1043");
    expect(parent!.fitid).toBe("FIT-SPLIT");
    expect(parent!.ynabId).toBeNull();
    const kids = rows.filter((r) => r.parentId === parent!.id);
    expect(kids).toHaveLength(2);
    expect(kids.find((k) => k.entityId === "st-1")!.checkNumber).toBe("1043-A");
    expect(kids.find((k) => k.entityId === "st-2")!.checkNumber).toBeNull();

    // Match-workflow drops are reported, never silent.
    expect(summary.warnings.some((w) => /accepted === false/.test(w))).toBe(true);
    expect(summary.warnings.some((w) => /matchedTransactions/.test(w))).toBe(true);
    expect(summary.warnings.some((w) => /dateEnteredFromSchedule/.test(w))).toBe(true);

    // Export round-trips the lineage and still hardcodes accepted:true.
    const { ynabData: out } = await exportYnab4(db);
    const outFull = out.transactions.find((t: any) => t.entityId === "t-full");
    expect(outFull).toBeDefined();
    expect(outFull.checkNumber).toBe("1042");
    expect(outFull.FITID).toBe("FIT-001");
    expect(outFull.YNABID).toBe("YNAB-001");
    expect(outFull.importedPayee).toBe("SAFEWAY #123");
    expect(outFull.source).toBe("OFX");
    expect(outFull.accepted).toBe(true);

    const outParent = out.transactions.find((t: any) => t.entityId === "t-split");
    expect(outParent).toBeDefined();
    expect(outParent.checkNumber).toBe("1043");
    expect(outParent.FITID).toBe("FIT-SPLIT");
    expect(outParent.accepted).toBe(true);
    expect(outParent.subTransactions.find((s: any) => s.entityId === "st-1").checkNumber).toBe("1043-A");
    expect(outParent.subTransactions.find((s: any) => s.entityId === "st-2").checkNumber).toBeNull();
  });
});

describe("G-08 scheduled twice-a-month + unknown frequencies", () => {
  it("persists second anchor day, warns on unknown frequencies and collapsed single-child splits", async () => {
    const db = openMigratedDb();
    const summary = await importYnab4(db, structuredClone(ynabData), "");

    const recs = await db.select().from(schema.recurring);
    const twice = recs.find((r) => r.entityId === "sched-twice");
    expect(twice).toBeDefined();
    expect(twice!.frequency).toBe("twiceamonth");
    expect(twice!.anchorDay).toBe(1);
    expect(twice!.secondAnchorDay).toBe(15);

    const weird = recs.find((r) => r.entityId === "sched-weird");
    expect(weird).toBeDefined();
    expect(weird!.frequency).toBe("monthly");
    expect(weird!.secondAnchorDay).toBeNull();

    // Single-child split collapses to a plain row (no sub rows stored).
    const single = recs.find((r) => r.entityId === "sched-single");
    expect(single).toBeDefined();
    const subs = await db.select().from(schema.recurringSubTransactions);
    expect(subs.filter((s) => s.recurringId === single!.id)).toHaveLength(0);

    expect(summary.warnings.some((w) => /Unknown scheduled frequency "Fortnightly"/.test(w))).toBe(true);
    expect(
      summary.warnings.some((w) => /Collapsed 1 single-child scheduled split/.test(w))
    ).toBe(true);

    const { ynabData: out } = await exportYnab4(db);
    const outTwice = out.scheduledTransactions.find((s: any) => s.entityId === "sched-twice");
    expect(outTwice).toBeDefined();
    expect(outTwice.frequency).toBe("TwiceAMonth");
    expect(outTwice.twiceAMonthStartDay).toBe(15);
    expect(outTwice.anchorDay).toBe(1);
    const outWeird = out.scheduledTransactions.find((s: any) => s.entityId === "sched-weird");
    expect(outWeird.frequency).toBe("Monthly");
    expect(outWeird.twiceAMonthStartDay).toBeNull();
  });
});
