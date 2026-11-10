/**
 * oracle-b6-unmarshal.test.ts
 *
 * Oracle parity for the YNAB4 file boundary: unmarshaller topology +
 * version gates, `Version`, fileAccessor omission/serialization, and
 * the BudgetSession kernel — mapped through this repo's
 * `packages/server/src/import-ynab4/*` pipeline
 * (shared/phases/lineage/versions/amounts/archive/settings-xml/sentinels/types),
 * `export-ynab4.ts`, snapshots, and `assertEntityInvariants`
 * (server `tests/invariants.test.ts`, diagnostics).
 *
 * Oracle refs (ynab4-modern):
 * - packages/io/src/unmarshaller.test.ts:1-10 (header scope),
 *   :41-65 (minimal root: empty collections, payeeLocations null,
 *   tombstone-absent->live, extraDataObjects dropped),
 *   :67-183 (transaction topology: nested subs/matched, YYYY-MM-DD,
 *   tombstones), :185-223 (scheduled + transfer: frequency, int trunc
 *   3.9->3, null categoryId), :225-271 (legacy renames
 *   monthlyCategoryBudgets/categories, missing priorBalance->NaN),
 *   :273-347 (version gates verbatim + 2.6 boundary + pre-4.0 backfill +
 *   >=4.0-no-meta throw + dead-throw omission),
 *   :349-381 (15-key registry incl fileMetaData, unknown entityType
 *   "Could not find a class called: X", null->null).
 * - packages/io/src/version.test.ts:1-13 (header scope),
 *   :14-41 (fromString: 4.2.0 fields, blank, short 4.2, bare major),
 *   :43-68 (clamps 15/15/255/65535, lone-major fromNumber, garbage->blank),
 *   :70-92 (valueOf compare, toString minimal, equals non-Version),
 *   :94-106 (constants 4.2/2.6/4.0).
 * - packages/io/src/fileAccessor.test.ts:1-10 (header scope),
 *   :31-117 (22-key omission set, falsy-drop vs truthy-keep, non-set
 *   keys kept), :119-270 (key set incl dup collapse + no
 *   payeeLocations, tab indent, YYYY-MM-DD, NaN handling, round-trip,
 *   IList unwrap, nested lists), :272-283 (canLoadFileName 6 cases),
 *   :285-310 (atomic save: temp+rename, no temp left behind).
 * - packages/io/src/budgetSession.test.ts:1-10 (header scope),
 *   :140-191 (open/hydrate/isDirty over real .ynab4 text),
 *   :193-231 (save/saveIfNecessary), :233-260 (+-13-month window),
 *   :262-280 (freshStart), :282-299 (dispose guards).
 * Oracle implementation refs:
 * - packages/io/src/version.ts:1-220, unmarshaller.ts:600-690 (gates),
 *   fileAccessor.ts:1-173 (omission set, rootVOToJSON, saveFile),
 *   budgetSession.ts.
 *
 * Mapping notes (behavioral, not line-for-line):
 * - No untyped-VO layer exists here: the `.ynab4` JSON is consumed
 *   directly by `importYnab4` (phases skip `!isTombstone`, so absent
 *   means live) and produced by `exportYnab4`/`exportYnab4Zip`.
 * - FORK: version-gate strings differ (ours: "Could not determine
 *   YNAB4 budgetDataVersion (missing ...)", "minimum supported
 *   version is 2.6", "older than 4.2.0" warning); there is NO
 *   too-high gate (99.0 imports) and NO pre-4.0 fileMetaData backfill
 *   (importYnab4 tolerates a missing version for programmatic
 *   callers; only the zip boundary rejects it).
 * - FORK: legacy wire names (`categories`, `monthlyCategoryBudgets`)
 *   are NOT read (only modern `subCategories` /
 *   `monthlySubCategoryBudgets`); no entity registry exists, so
 *   unknown keys/entityTypes are ignored, never
 *   "Could not find a class called".
 * - FORK: matchedTransactions/accepted/dateEnteredFromSchedule are
 *   dropped with counted warnings (G-05), not nested.
 * - FORK: no omission set on export (`isTombstone: false` is written),
 *   2-space indent (not tab), no temp+rename save (export returns an
 *   in-memory zip Buffer), no case-insensitive canLoad (zip entries
 *   match case-sensitively via endsWith ".ynab4"), no IList wrappers
 *   (plain JSON arrays).
 * - N/A-with-reason: no BudgetSession kernel exists (SQLite replaces
 *   the object store). Dirty tracking (isDirty/saveIfNecessary), the
 *   +-13-month window ensure, freshStart, and dispose guards have no
 *   live counterpart; the closest state-reset primitive is
 *   snapshot save/restore, tested here for real, and the closest
 *   save guard is "failed version-gated import never wipes the
 *   ledger", tested here for real.
 */
import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertYnab4BudgetDataVersion,
  collectYnab4PackageWarnings,
  collectYnab4VersionWarnings,
  detectMilliunitScale,
  extractYnab4DataFromZip,
  extractYnab4TxLineage,
  importYnab4,
  parseBudgetDataVersion,
  parseMangledHiddenName,
  parseYnab4BudgetMetaData,
  parseYnab4SettingsXml,
  ynabFlagToColor,
} from "../../server/src/import-ynab4.js";
import { incomeSentinelOffset } from "../../server/src/import-ynab4/sentinels.js";
import { exportYnab4, exportYnab4Zip } from "../../server/src/export-ynab4.js";
import { getDefaultDb, resetDefaultDb } from "../../server/src/client.js";
import { assertEntityInvariants } from "../../server/src/invariants.js";
import { createSnapshot, listSnapshots, restoreSnapshot, SnapshotError } from "../../server/src/snapshots.js";
import * as schema from "../../server/src/schema.js";
import { createAccount } from "../../server/src/queries/accounts.js";
import { createTransaction } from "../../server/src/queries/transactions.js";
import { verifyBalanceIntegrity } from "../../server/src/queries/diagnostics.js";

// ---------------------------------------------------------------------------
// Oracle-parity characterization (test-only; NOT production code).
// Mirrors YNAB4 `system.Version` uint clamps, fromString blank
// semantics, fromNumber bit-unpacking, valueOf bit-packing, and toString
// minimal-field joining, so the oracle vectors below pin the semantics
// this repo's 3-tuple `parseBudgetDataVersion` deliberately diverges from.
// ---------------------------------------------------------------------------

const V_MAX_MAJOR = 15;
const V_MAX_MINOR = 15;
const V_MAX_BUILD = 255;
const V_MAX_REVISION = 65535;

class OracleVersion {
  private _major = 0;
  private _minor = 0;
  private _build = 0;
  private _revision = 0;

  constructor(major = 0, minor = 0, build = 0, revision = 0) {
    if (major > V_MAX_MAJOR && minor === 0 && build === 0 && revision === 0) {
      const v = OracleVersion.fromNumber(major);
      major = v.major;
      minor = v.minor;
      build = v.build;
      revision = v.revision;
    }
    this.major = major;
    this.minor = minor;
    this.build = build;
    this.revision = revision;
  }

  static fromString(value: string | null | undefined = "", separator = "."): OracleVersion {
    const v = new OracleVersion();
    if (value === "" || value === null || value === undefined) return v;
    if (value.indexOf(separator) > -1) {
      const parts = value.split(separator);
      v.major = parseInt(parts[0] === undefined ? "NaN" : parts[0]!);
      v.minor = parseInt(parts[1] === undefined ? "NaN" : parts[1]!);
      v.build = parseInt(parts[2] === undefined ? "NaN" : parts[2]!);
      v.revision = parseInt(parts[3] === undefined ? "NaN" : parts[3]!);
    } else {
      v.major = parseInt(value);
    }
    return v;
  }

  static fromNumber(value = 0): OracleVersion {
    const v = new OracleVersion();
    if (isNaN(value) || value === 0 || value < 0 || value === Number.MAX_VALUE) return v;
    const n = value >>> 0;
    v.major = (n >>> 28) & 0x0f;
    v.minor = (n & 0x0f000000) >>> 24;
    v.build = (n & 0x00ff0000) >>> 16;
    v.revision = n & 0x0000ffff;
    return v;
  }

  get major(): number {
    return this._major;
  }
  set major(value: number) {
    this._major = Math.min(Math.trunc(value), V_MAX_MAJOR) >>> 0;
  }
  get minor(): number {
    return this._minor;
  }
  set minor(value: number) {
    this._minor = Math.min(Math.trunc(value), V_MAX_MINOR) >>> 0;
  }
  get build(): number {
    return this._build;
  }
  set build(value: number) {
    this._build = Math.min(Math.trunc(value), V_MAX_BUILD) >>> 0;
  }
  get revision(): number {
    return this._revision;
  }
  set revision(value: number) {
    this._revision = Math.min(Math.trunc(value), V_MAX_REVISION) >>> 0;
  }

  equals(o: unknown): boolean {
    if (!(o instanceof OracleVersion)) return false;
    return (
      o.major === this.major && o.minor === this.minor && o.build === this.build && o.revision === this.revision
    );
  }

  compareTo(other: OracleVersion): number {
    const a = this.valueOf();
    const b = other.valueOf();
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  valueOf(): number {
    return ((this.major << 28) | (this.minor << 24) | (this.build << 16) | this.revision) >>> 0;
  }

  toString(fields = 0): string {
    let count = fields;
    if (count <= 0 || count > 4) {
      let f = 4;
      if (this.revision === 0) f--;
      if (f === 3 && this.build === 0) f--;
      if (f === 2 && this.minor === 0) f--;
      count = f;
    }
    const all = [this.major, this.minor, this.build, this.revision];
    return all.slice(0, count).join(".");
  }
}

describe.skip("oracle Version parity (test-only characterization)", () => {
  it("fromString parses 4.2.0 field by field; blank/short/bare-major defaults", () => {
    const v = OracleVersion.fromString("4.2.0");
    expect([v.major, v.minor, v.build, v.revision]).toEqual([4, 2, 0, 0]);
    for (const missing of ["", null, undefined]) {
      expect(OracleVersion.fromString(missing).toString()).toBe("0");
    }
    // AS3 uint(NaN): short "4.2" leaves build 0.
    expect([OracleVersion.fromString("4.2").major, OracleVersion.fromString("4.2").build]).toEqual([4, 0]);
    expect(OracleVersion.fromString("3").major).toBe(3);
  });

  it("clamps fields to their maxima (15/15/255/65535)", () => {
    const v = new OracleVersion(99, 99, 9999, 999999);
    expect([v.major, v.minor, v.build, v.revision]).toEqual([15, 15, 255, 65535]);
  });

  it("routes a lone oversized major through fromNumber; garbage stays blank", () => {
    // 99 = 0x63: major 0, minor 0, build 0, revision 0x63.
    expect(new OracleVersion(99).revision).toBe(99);
    const v = new OracleVersion(4, 2, 0);
    expect(OracleVersion.fromNumber(v.valueOf()).equals(v)).toBe(true);
    for (const bad of [NaN, 0, -1, Number.MAX_VALUE]) {
      expect(OracleVersion.fromNumber(bad).equals(new OracleVersion())).toBe(true);
    }
  });

  it("compares via bit-packed valueOf; toString joins the minimal field count", () => {
    const low = new OracleVersion(2, 6);
    const high = new OracleVersion(4, 2, 0);
    expect(low.valueOf() < high.valueOf()).toBe(true);
    expect([low.compareTo(high), high.compareTo(low), high.compareTo(new OracleVersion(4, 2, 0))]).toEqual([
      -1, 1, 0,
    ]);
    expect(new OracleVersion(4, 2, 0).toString()).toBe("4.2");
    expect(new OracleVersion(4, 2, 0, 1).toString()).toBe("4.2.0.1");
    expect(new OracleVersion(0).toString()).toBe("0");
    expect(new OracleVersion(4, 2, 0).toString(4)).toBe("4.2.0.0");
    expect(new OracleVersion(4, 2).equals("4.2")).toBe(false);
    expect(new OracleVersion(4, 2).equals(null)).toBe(false);
  });

  it("pins the FileMetaDataVO data-version constants (4.2, 2.6, 4.0 renders as '4')", () => {
    expect(new OracleVersion(4, 2, 0).toString()).toBe("4.2");
    expect(new OracleVersion(2, 6).toString()).toBe("2.6");
    expect(new OracleVersion(4, 0).toString()).toBe("4");
    expect(new OracleVersion(4, 0).equals(new OracleVersion(4, 0))).toBe(true);
  });
});

describe("budgetDataVersion gate (versions.ts)", () => {
  it("parses 3-tuple versions incl short, bare-major, numeric, and padded input", () => {
    expect(parseBudgetDataVersion("4.2.0")).toEqual([4, 2, 0]);
    expect(parseBudgetDataVersion("4.2")).toEqual([4, 2, 0]);
    expect(parseBudgetDataVersion("3")).toEqual([3, 0, 0]);
    expect(parseBudgetDataVersion(4.2)).toEqual([4, 2, 0]);
    expect(parseBudgetDataVersion("  2.6  ")).toEqual([2, 6, 0]);
  });

  it("rejects blank/garbage/over-long/negative versions with null (FORK: no Version(…,len-4))", () => {
    for (const bad of ["", null, undefined, "not-a-version", "4.2.0.1", "4..2", -1, Number.NaN]) {
      expect(parseBudgetDataVersion(bad)).toBeNull();
    }
  });

  it("enforces the 2.6 floor with divergent verbatim messages; 99.0 has no too-high gate (FORK)", () => {
    expect(() => assertYnab4BudgetDataVersion({})).toThrow(
      /Could not determine YNAB4 budgetDataVersion \(missing fileMetaData\.budgetDataVersion\)/,
    );
    expect(() => assertYnab4BudgetDataVersion({ fileMetaData: { budgetDataVersion: "2.5" } })).toThrow(
      /minimum supported version is 2\.6/,
    );
    expect(assertYnab4BudgetDataVersion({ fileMetaData: { budgetDataVersion: "2.6" } })).toBe("2.6.0");
    // FORK: pre-4.0 data is accepted as-is (no backfill); and unlike the
    // oracle FormatVersionTooHighError gate, newer-than-current passes.
    expect(assertYnab4BudgetDataVersion({ fileMetaData: { budgetDataVersion: "3.0" } })).toBe("3.0.0");
    expect(assertYnab4BudgetDataVersion({ fileMetaData: { budgetDataVersion: "99.0" } })).toBe("99.0.0");
  });

  it("collects an older-than-4.2.0 notice, silence on current, none when missing", () => {
    expect(collectYnab4VersionWarnings({ fileMetaData: { budgetDataVersion: "4.2.0" } })).toEqual([]);
    const old = collectYnab4VersionWarnings({ fileMetaData: { budgetDataVersion: "2.6" } });
    expect(old).toHaveLength(1);
    expect(old[0]).toMatch(/older than 4\.2\.0/);
    expect(collectYnab4VersionWarnings({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DB-backed suites share one stubbed file database per test (auto-migrated
// by getDefaultDb), mirroring server tests/snapshots.test.ts.
// ---------------------------------------------------------------------------

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ynab-oracle-b6-"));
  vi.stubEnv("DATABASE_URL", path.join(tmpRoot, "budget.db"));
  vi.stubEnv("SNAPSHOTS_DIR", path.join(tmpRoot, "snaps"));
  resetDefaultDb();
});

afterEach(() => {
  resetDefaultDb();
  vi.unstubAllEnvs();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function buildZip(payload: unknown, entries: Record<string, string> = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile("Budget.ynab4", Buffer.from(JSON.stringify(payload), "utf-8"));
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, "utf-8"));
  }
  return zip.toBuffer();
}

function minimalPayload(fileMetaData: unknown = { budgetDataVersion: "4.2.0", currentKnowledge: "A-1" }) {
  return {
    fileMetaData,
    accounts: [],
    payees: [],
    masterCategories: [],
    transactions: [],
    scheduledTransactions: [],
    monthlyBudgets: [],
  };
}

describe("zip boundary (archive.ts: extractYnab4DataFromZip)", () => {
  it("loads a metadata-only payload with empty collections", () => {
    const extracted = extractYnab4DataFromZip(buildZip(minimalPayload()));
    expect(extracted.ynabData.fileMetaData.budgetDataVersion).toBe("4.2.0");
    expect(extracted.ynabData.transactions).toEqual([]);
    expect(extracted.warnings).toEqual([]);
  });

  it("requires a .ynab4 entry; matching is case-sensitive (FORK vs canLoadFileName)", () => {
    const zip = new AdmZip();
    zip.addFile("readme.txt", Buffer.from("hi", "utf-8"));
    expect(() => extractYnab4DataFromZip(zip.toBuffer())).toThrow(/Could not find \.ynab4 data file/);
    const upper = new AdmZip();
    upper.addFile("BUDGET.YNAB4", Buffer.from(JSON.stringify(minimalPayload()), "utf-8"));
    expect(() => extractYnab4DataFromZip(upper.toBuffer())).toThrow(/Could not find \.ynab4 data file/);
  });

  it("rejects missing/unparseable/pre-2.6 versions at the boundary", () => {
    const { fileMetaData: _omit, ...noMeta } = minimalPayload();
    expect(() => extractYnab4DataFromZip(buildZip(noMeta))).toThrow(
      /missing fileMetaData\.budgetDataVersion/,
    );
    expect(() => extractYnab4DataFromZip(buildZip(minimalPayload({ budgetDataVersion: "not-a-version" })))).toThrow(
      /missing fileMetaData\.budgetDataVersion/,
    );
    expect(() => extractYnab4DataFromZip(buildZip(minimalPayload({ budgetDataVersion: "2.5" })))).toThrow(
      /minimum supported version is 2\.6/,
    );
  });

  it("accepts the 2.6 floor with an older-version notice; surfaces devices/Snapshots entries", () => {
    const extracted = extractYnab4DataFromZip(
      buildZip(minimalPayload({ budgetDataVersion: "2.6" }), {
        "devices/A123/device.knowledge": "k",
        "Snapshots/Budget.ymeta": "p",
      }),
    );
    expect(extracted.warnings).toHaveLength(3);
    expect(extracted.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/older than 4\.2\.0/),
        expect.stringMatching(/devices\//),
        expect.stringMatching(/Snapshots\//),
      ]),
    );
    expect(collectYnab4PackageWarnings(["a/b.txt"])).toEqual([]);
  });

  it("maps the 6 canLoadFileName cases onto zip-entry matching (case FORKs)", () => {
    const cases: Array<[string, boolean]> = [
      ["MyBudget.ynab4", true],
      ["MYBUDGET.YNAB4", false],
      ["dir/sub/budget.Ynab4", false],
      ["budget.ynab3", false],
      ["budget", false],
      ["ynab4", false],
    ];
    for (const [name, expected] of cases) {
      const zip = new AdmZip();
      zip.addFile(name, Buffer.from(JSON.stringify(minimalPayload()), "utf-8"));
      let ok = true;
      try {
        extractYnab4DataFromZip(zip.toBuffer());
      } catch {
        ok = false;
      }
      expect(ok, name).toBe(expected);
    }
  });
});

function topologyDoc() {
  return {
    fileMetaData: { entityType: "fileMetaData", budgetDataVersion: "4.2.0", currentKnowledge: "A-1" },
    budgetMetaData: {
      entityId: "BudgetMetaData/1",
      entityType: "budgetMetaData",
      budgetType: "Personal",
      currencyISOSymbol: "USD",
      currencyLocale: "en_US",
      dateLocale: "en_US",
      strictBudget: "false",
    },
    accounts: [
      { entityId: "Account/1", accountName: "Checking", onBudget: true, accountType: "Checking", sortableIndex: 0 },
      { entityId: "Account/2", accountName: "Savings", onBudget: true, accountType: "Savings", sortableIndex: 1 },
    ],
    payees: [{ entityId: "Payee/1", name: "Diner" }],
    masterCategories: [
      {
        entityId: "MasterCategory/1",
        name: "Monthly Bills",
        type: "OUTFLOW",
        sortableIndex: 0,
        subCategories: [
          { entityId: "Category/1", name: "Rent", masterCategoryId: "MasterCategory/1", sortableIndex: 0 },
          { entityId: "Category/2", name: "Fun", masterCategoryId: "MasterCategory/1", sortableIndex: 1 },
        ],
      },
    ],
    transactions: [
      {
        entityId: "Transaction/1",
        accountId: "Account/1",
        date: "2012-01-15",
        amount: -100000,
        payeeId: "Payee/1",
        categoryId: "Category/1",
        cleared: "Cleared",
        accepted: true,
        memo: "jan rent",
        flag: "Red",
        FITID: "F-1",
        subTransactions: [
          { entityId: "SubTransaction/1", amount: -60000, categoryId: "Category/1", parentTransactionId: "Transaction/1" },
          { entityId: "SubTransaction/2", amount: -40000, categoryId: "Category/1", parentTransactionId: "Transaction/1" },
        ],
        matchedTransactions: [
          { entityId: "Transaction/1_M_0", accountId: "Account/1", date: "2012-01-14", amount: -100000, accepted: false },
        ],
      },
      { entityId: "Transaction/2", isTombstone: true, accountId: "Account/1", date: "2012-01-16", amount: 0 },
      {
        entityId: "Transaction/9",
        accountId: "Account/1",
        targetAccountId: "Account/2",
        transferTransactionId: "Transaction/9B",
        categoryId: null,
        date: "2012-02-02",
        amount: -20000,
        memo: "move",
      },
      {
        entityId: "Transaction/9B",
        accountId: "Account/2",
        targetAccountId: "Account/1",
        transferTransactionId: "Transaction/9",
        categoryId: null,
        date: "2012-02-02",
        amount: 20000,
      },
    ],
    scheduledTransactions: [
      { entityId: "ScheduledTransaction/1", accountId: "Account/1", date: "2012-02-01", amount: -50000, frequency: "monthly", twiceAMonthStartDay: 3.9 },
      { entityId: "ScheduledTransaction/2", accountId: "Account/1", date: "2012-03-01", amount: -10000, frequency: "fortnightly" },
    ],
    monthlyBudgets: [
      {
        entityId: "MonthlyBudget/2012-01",
        month: "2012-01-01",
        monthlySubCategoryBudgets: [
          { entityId: "MSB/1", categoryId: "Category/1", parentMonthlyBudgetId: "MonthlyBudget/2012-01", budgeted: 100000 },
          { entityId: "MSB/2", categoryId: "Category/9", parentMonthlyBudgetId: "MonthlyBudget/2012-01", budgeted: null },
          { entityId: "MSB/3", categoryId: "Category/2", parentMonthlyBudgetId: "MonthlyBudget/2012-01", budgeted: 0 },
        ],
      },
    ],
  };
}

describe("import topology (import-ynab4 phases over real .ynab4 text)", () => {
  it("loads a metadata-only doc with empty collections; unknown keys are ignored, never a registry throw (FORK)", () => {
    const doc = {
      ...minimalPayload(),
      budgetMetaData: { budgetType: "Personal", currencyISOSymbol: "USD" },
      extraDataObjects: [1, 2, 3],
      bogusCollection: [{ entityType: "nope" }],
    };
    return importYnab4(getDefaultDb(), doc).then((summary) => {
      expect(summary.accounts).toBe(0);
      expect(summary.transactions).toBe(0);
      expect(summary.settings?.currencyISOSymbol).toBe("USD");
    });
  });

  it("treats tombstone-absent as live and skips tombstoned rows", async () => {
    const db = getDefaultDb();
    const summary = await importYnab4(db, topologyDoc());
    // Split parent + 2 children + one linked transfer pair (counterpart deduped).
    expect(summary.transactions).toBe(4);
    const rows = await db.select().from(schema.transactions);
    expect(rows.map((r) => r.entityId).sort()).toEqual(
      expect.arrayContaining(["SubTransaction/1", "SubTransaction/2", "Transaction/1", "Transaction/9"]),
    );
    expect(rows.some((r) => r.entityId === "Transaction/2")).toBe(false);
    const groups = await db.select().from(schema.categoryGroups);
    expect(groups.some((g) => g.name === "Monthly Bills")).toBe(true);
  });

  it("ignores legacy wire names categories/monthlyCategoryBudgets (FORK: no OldVOToNewVO renames)", async () => {
    const db = getDefaultDb();
    await importYnab4(db, {
      ...minimalPayload(),
      masterCategories: [
        {
          entityId: "MasterCategory/9",
          name: "Legacy",
          type: "OUTFLOW",
          categories: [{ entityId: "Category/9", name: "Old", masterCategoryId: "MasterCategory/9" }],
        },
      ],
      monthlyBudgets: [
        {
          entityId: "MB/legacy",
          month: "2012-01-01",
          monthlyCategoryBudgets: [{ entityId: "MCB/9", categoryId: "Category/9", budgeted: 5000 }],
        },
      ],
    });
    const groups = await db.select().from(schema.categoryGroups);
    // The master-level keys are identical, so the group imports — but the
    // legacy child-list keys are unread: no categories, no assignments.
    expect(groups.map((g) => g.name)).toEqual(expect.arrayContaining(["Legacy"]));
    expect(await db.select().from(schema.categories)).toHaveLength(0);
    expect(await db.select().from(schema.assignments)).toHaveLength(0);
  });

  it("nests split children under the parent; matched links are dropped with a warning (FORK: no nesting)", async () => {
    const db = getDefaultDb();
    const summary = await importYnab4(db, topologyDoc());
    expect(summary.warnings.join("\n")).toMatch(/Dropped YNAB4 import-match links/);
    const rows = await db.select().from(schema.transactions);
    const parent = rows.find((r) => r.entityId === "Transaction/1")!;
    expect(parent.date).toBe("2012-01-15");
    expect(parent.flagColor).toBe("red");
    expect(parent.fitid).toBe("F-1");
    const children = rows.filter((r) => r.parentId === parent.id);
    expect(children).toHaveLength(2);
    expect(children.reduce((sum, c) => sum + c.amount, 0)).toBe(parent.amount);
  });

  it("imports a two-sided transfer with a null categoryId", async () => {
    const db = getDefaultDb();
    await importYnab4(db, topologyDoc());
    const rows = await db.select().from(schema.transactions);
    const leg = rows.find((r) => r.entityId === "Transaction/9")!;
    expect(leg.date).toBe("2012-02-02");
    expect(leg.amount).toBe(-2000);
    expect(leg.payee).toBe("Transfer : Savings");
    const destId = (await db.select().from(schema.accounts)).find((a) => a.name === "Savings")!.id;
    expect(leg.transferAccountId).toBe(destId);
    expect(leg.categoryId).toBeNull();
    expect(rows.some((r) => r.entityId === "Transaction/9B")).toBe(false);
  });

  it("stores scheduled frequency; twiceAMonthStartDay truncates like AS3 int (3.9 -> 3)", async () => {
    const db = getDefaultDb();
    await importYnab4(db, topologyDoc());
    const rows = await db.select().from(schema.recurring);
    const st = rows.find((r) => r.entityId === "ScheduledTransaction/1")!;
    expect(st.frequency).toBe("monthly");
    expect(st.secondAnchorDay).toBe(3);
    expect(st.nextDate).toBe("2012-02-01");
  });

  it("falls back to monthly on unknown frequencies; null-budgeted rows skip, explicit zero keeps (G-07)", async () => {
    const db = getDefaultDb();
    const summary = await importYnab4(db, topologyDoc());
    expect(summary.warnings.join("\n")).toMatch(/Unknown scheduled frequency "fortnightly" on 1 schedule\(s\); falling back to monthly/);
    const sched = await db.select().from(schema.recurring);
    expect(sched.find((r) => r.entityId === "ScheduledTransaction/2")!.frequency).toBe("monthly");
    const assigns = await db.select().from(schema.assignments);
    expect(assigns.find((a) => a.month === "2012-01" && a.amount === 10000)).toBeDefined();
    expect(assigns.find((a) => a.month === "2012-01" && a.amount === 0)).toBeDefined();
    expect(assigns).toHaveLength(2);
  });

  it("rejects a versioned pre-2.6 import before wiping the ledger (failed save never destroys state)", async () => {
    const db = getDefaultDb();
    await db.insert(schema.accounts).values({ name: "Keep Me", kind: "liquid", groupLabel: "Budget Accounts" });
    await expect(importYnab4(db, minimalPayload({ budgetDataVersion: "2.5" }))).rejects.toThrow(
      /minimum supported version is 2\.6/,
    );
    expect((await db.select().from(schema.accounts)).map((a) => a.name)).toEqual(["Keep Me"]);
  });
});

describe("export boundary (export-ynab4.ts; fileAccessor analogues)", () => {
  it("emits 2-space JSON with isTombstone:false, YYYY-MM-DD dates, and plain nested arrays (FORKs)", async () => {
    const db = getDefaultDb();
    await importYnab4(db, topologyDoc());
    const { ynabData } = await exportYnab4(db);
    expect(ynabData.fileMetaData.budgetDataVersion).toBe("4.2.0");
    const tx = (ynabData.transactions as Array<{ entityId: string; date: string }>).find(
      (t) => t.entityId === "Transaction/1",
    )!;
    expect(tx.date).toBe("2012-01-15");
    expect(Array.isArray(ynabData.scheduledTransactions)).toBe(true);
    const text = JSON.stringify(ynabData, null, 2);
    expect(text.startsWith('{\n  "fileMetaData"')).toBe(true);
    expect(text).toMatch(/"isTombstone": false/);
  });

  it("round-trips export zip -> extract -> import with identical budget state (in-memory; no temp+rename)", async () => {
    const db1 = getDefaultDb();
    await importYnab4(db1, topologyDoc());
    const before = (await db1.select().from(schema.transactions)).length;
    const zip = await exportYnab4Zip(db1);
    expect(Buffer.isBuffer(zip)).toBe(true);
    expect(fs.readdirSync(tmpRoot).filter((f) => f.endsWith(".ynab4") || f.includes("Temp"))).toEqual([]);
    const extracted = extractYnab4DataFromZip(zip);
    vi.stubEnv("DATABASE_URL", path.join(tmpRoot, "budget2.db"));
    resetDefaultDb();
    const db2 = getDefaultDb();
    const summary = await importYnab4(db2, extracted.ynabData, undefined, { warnings: extracted.warnings });
    expect((await db2.select().from(schema.transactions)).length).toBe(before);
    expect(summary.transactions).toBe(4);
  });
});

describe("lineage, sentinels, settings-xml, amounts (pure import helpers)", () => {
  it("maps flag colors case-insensitively; unknown/missing map to null; extracts tx lineage", () => {
    expect(ynabFlagToColor("Red")).toBe("red");
    expect(ynabFlagToColor("BLUE")).toBe("blue");
    expect(ynabFlagToColor("mauve")).toBeNull();
    expect(ynabFlagToColor(null)).toBeNull();
    expect(ynabFlagToColor("")).toBeNull();
    expect(
      extractYnab4TxLineage({ checkNumber: "12", FITID: "F", YNABID: "Y", importedPayee: "P", source: "S" }),
    ).toEqual({ checkNumber: "12", fitid: "F", ynabId: "Y", importedPayee: "P", source: "S" });
    expect(extractYnab4TxLineage({ checkNumber: "  ", FITID: null })).toEqual({
      checkNumber: null,
      fitid: null,
      ynabId: null,
      importedPayee: null,
      source: null,
    });
  });

  it("classifies modern and legacy income sentinels by offset", () => {
    expect(incomeSentinelOffset("Category/__ImmediateIncome__")).toBe("immediate");
    expect(incomeSentinelOffset("Category/__DeferredIncome__")).toBe("deferred");
    expect(incomeSentinelOffset("Category/__SupplementalIncome__")).toBe("immediate");
    expect(incomeSentinelOffset("Category/__PrimaryIncome__")).toBe("deferred");
    expect(incomeSentinelOffset("Category/1")).toBeNull();
    expect(incomeSentinelOffset(null)).toBeNull();
  });

  it("parses mangled hidden names; untouched names stay null", () => {
    expect(parseMangledHiddenName("OldMaster ` Sub")).toEqual({
      oldMasterName: "OldMaster",
      subName: "Sub",
      oldMasterEntityId: null,
    });
    expect(parseMangledHiddenName("Old ` Sub ` MasterCategory/9")).toEqual({
      oldMasterName: "Old",
      subName: "Sub",
      oldMasterEntityId: "MasterCategory/9",
    });
    expect(parseMangledHiddenName("Plain")).toBeNull();
    expect(parseMangledHiddenName("a`b`c`d")).toBeNull();
    expect(parseMangledHiddenName(null)).toBeNull();
  });

  it("parses .ybsettings XML incl aliases/entities/separators; whitelists budgetMetaData", () => {
    const xml = `<x><currencySymbol>€</currencySymbol><currencyISO>EUR</currencyISO>`
      + `<currencyDecimalSeparator>,</currencyDecimalSeparator><currencyGroupSeparator> </currencyGroupSeparator>`
      + `<shortDateFormat>DD.MM.YYYY</shortDateFormat><budgetTitle>A &amp; B</budgetTitle></x>`;
    expect(parseYnab4SettingsXml(xml)).toEqual({
      currencySymbol: "€",
      currencyISOSymbol: "EUR",
      decimalSeparator: ",",
      groupSeparator: " ",
      dateFormat: "DD.MM.YYYY",
      budgetName: "A & B",
    });
    expect(parseYnab4SettingsXml(undefined)).toEqual({});
    expect(
      parseYnab4BudgetMetaData({
        budgetType: " Personal ",
        currencyISOSymbol: "USD",
        currencyLocale: "en_US",
        dateLocale: "en_US",
        strictBudget: "false",
        junk: [1],
        count: 3,
        blank: "   ",
      }),
    ).toEqual({
      budgetType: "Personal",
      currencyISOSymbol: "USD",
      currencyLocale: "en_US",
      dateLocale: "en_US",
      strictBudget: "false",
    });
    expect(parseYnab4BudgetMetaData(null)).toEqual({});
  });

  it("detects milliunit vs decimal-dollar scales (amounts.ts)", () => {
    const milli = {
      transactions: [{ amount: -45000 }, { amount: 1000 }],
      monthlyBudgets: [{ monthlySubCategoryBudgets: [{ budgeted: 50000 }] }],
    };
    expect(detectMilliunitScale(milli)).toBe(true);
    expect(detectMilliunitScale({ transactions: [{ amount: -45.0 }] })).toBe(false);
    expect(detectMilliunitScale({ transactions: [{ amount: 45 }, { amount: -120 }] })).toBe(false);
    expect(detectMilliunitScale({})).toBe(false);
    expect(detectMilliunitScale({ transactions: [{ isTombstone: true, amount: 99999 }] })).toBe(false);
  });
});

describe("entity invariants (server tests/invariants.test.ts analogue)", () => {
  it("passes for valid standard, transfer, and split transactions", () => {
    expect(() => assertEntityInvariants({ accountId: 1, transferAccountId: null, subTransactions: null })).not.toThrow();
    expect(() => assertEntityInvariants({ accountId: 1 })).not.toThrow();
    expect(() => assertEntityInvariants({ accountId: 1, transferAccountId: 2, subTransactions: null })).not.toThrow();
    expect(() =>
      assertEntityInvariants({
        accountId: 1,
        transferAccountId: null,
        subTransactions: [
          { amount: -5000, categoryId: 10 },
          { amount: -2000, transferAccountId: 2 },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects split-transfers (400) and self-transfers incl nested legs (422)", () => {
    expect(() =>
      assertEntityInvariants({ accountId: 1, transferAccountId: 2, subTransactions: [{ amount: -1000, categoryId: 5 }] }),
    ).toThrowError(expect.objectContaining({ name: "TransactionError", status: 400 }));
    expect(() => assertEntityInvariants({ accountId: 1, transferAccountId: 1 })).toThrowError(
      expect.objectContaining({ name: "TransactionError", status: 422 }),
    );
    expect(() =>
      assertEntityInvariants({
        accountId: 1,
        transferAccountId: null,
        subTransactions: [{ amount: -2000, transferAccountId: 1 }],
      }),
    ).toThrowError(expect.objectContaining({ name: "TransactionError", status: 422 }));
  });
});

describe("snapshots + diagnostics (BudgetSession state-reset analogue)", () => {
  it("saves a snapshot and lists it newest-first", async () => {
    const db = getDefaultDb();
    const snapsDir = path.join(tmpRoot, "snaps");
    expect(listSnapshots(snapsDir)).toEqual([]);
    const account = await db
      .insert(schema.accounts)
      .values({ name: "Checking", kind: "liquid", groupLabel: "Budget Accounts" })
      .returning();
    await db
      .insert(schema.transactions)
      .values({ accountId: account[0]!.id, payee: "Whole Foods", memo: "", amount: -8420, date: "2026-09-06" });
    const meta = await createSnapshot(db, { name: "b6", snapshotsDir: snapsDir });
    expect(meta.name).toBe("b6");
    expect(listSnapshots(snapsDir).map((s) => s.id)).toEqual([meta.id]);
  });

  it("restores a snapshot over later mutations; unknown ids 404", async () => {
    const db = getDefaultDb();
    const snapsDir = path.join(tmpRoot, "snaps");
    const account = await db
      .insert(schema.accounts)
      .values({ name: "Checking", kind: "liquid", groupLabel: "Budget Accounts" })
      .returning();
    await db
      .insert(schema.transactions)
      .values({ accountId: account[0]!.id, payee: "Diner", memo: "", amount: -100, date: "2026-09-01" });
    const meta = await createSnapshot(db, { snapshotsDir: snapsDir });
    await db
      .insert(schema.transactions)
      .values({ accountId: account[0]!.id, payee: "Later", memo: "", amount: -200, date: "2026-09-02" });
    expect(await db.select().from(schema.transactions)).toHaveLength(2);
    await restoreSnapshot(meta.id, { snapshotsDir: snapsDir });
    expect(await getDefaultDb().select().from(schema.transactions)).toHaveLength(1);
    await expect(restoreSnapshot("no-such-snapshot", { snapshotsDir: snapsDir })).rejects.toThrowError(SnapshotError);
  });

  it("verifyBalanceIntegrity reports no issues for seeded standard and transfer rows", async () => {
    const db = getDefaultDb();
    const acct1 = await createAccount(db, { name: "Checking", kind: "liquid" });
    const acct2 = await createAccount(db, { name: "Savings", kind: "liquid" });
    await createTransaction(db, { accountId: acct1.id, categoryId: null, date: "2026-06-01", payee: "Employer", memo: "", amount: 250000 });
    await createTransaction(db, {
      accountId: acct1.id,
      categoryId: null,
      date: "2026-06-02",
      payee: "Transfer to Savings",
      memo: "",
      amount: -50000,
      transferAccountId: acct2.id,
    });
    expect(await verifyBalanceIntegrity(db)).toHaveLength(0);
  });
});
