import { describe, expect, it } from "vitest";
import {
  arrayField,
  asRecord,
  assertYnab4BudgetDataVersion,
  collectYnab4VersionWarnings,
  detectMilliunitScale,
  extractYnab4TxLineage,
  recordField,
} from "../src/import-ynab4.js";
import { reportDroppedOfxMappings } from "../src/import-ynab4/phases/ofx.js";
import type { Ynab4ImportContext } from "../src/import-ynab4/types.js";

describe("asRecord", () => {
  it("passes objects through and rejects non-records", () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    expect(asRecord(5)).toBeNull();
    expect(asRecord("row")).toBeNull();
    // Arrays are collections, not rows.
    expect(asRecord([{ a: 1 }])).toBeNull();
  });
});

describe("recordField", () => {
  it("reads fields null-safely", () => {
    expect(recordField({ a: { b: 2 } }, "a")).toEqual({ b: 2 });
    expect(recordField({ a: 1 }, "missing")).toBeUndefined();
    expect(recordField(null, "a")).toBeUndefined();
    expect(recordField([1, 2], "length")).toBeUndefined();
    expect(recordField("text", "length")).toBeUndefined();
  });
});

describe("arrayField", () => {
  it("returns the collection and [] otherwise", () => {
    const arr = [{ x: 1 }];
    expect(arrayField({ items: arr }, "items")).toBe(arr);
    expect(arrayField({}, "items")).toEqual([]);
    expect(arrayField(null, "items")).toEqual([]);
    // Hardening over `holder.key || []`: a truthy non-array no longer
    // iterates as characters.
    expect(arrayField({ items: "abc" }, "items")).toEqual([]);
    expect(arrayField({ items: 5 }, "items")).toEqual([]);
  });
});

describe("boundary readers on hostile documents", () => {
  it("version gate rejects non-record roots like a missing version", () => {
    expect(() => assertYnab4BudgetDataVersion([])).toThrow("Could not determine");
    expect(() => assertYnab4BudgetDataVersion("nope")).toThrow("Could not determine");
    expect(() => assertYnab4BudgetDataVersion(null)).toThrow("Could not determine");
    expect(collectYnab4VersionWarnings([])).toEqual([]);
  });

  it("scale detection ignores non-row and non-array collections", () => {
    expect(detectMilliunitScale({ transactions: "abc" })).toBe(false);
    expect(detectMilliunitScale({ transactions: [5, "x", null] })).toBe(false);
    expect(detectMilliunitScale({ monthlyBudgets: [{ monthlySubCategoryBudgets: "junk" }] })).toBe(false);
  });

  it("scale detection still sees live rows", () => {
    expect(detectMilliunitScale({ transactions: [{ amount: 45000 }] })).toBe(true);
    expect(
      detectMilliunitScale({
        transactions: [{ amount: 45.25 }, { amount: 45000, isTombstone: true }],
      })
    ).toBe(false);
  });

  it("lineage extraction tolerates non-records", () => {
    expect(extractYnab4TxLineage(null)).toEqual({
      checkNumber: null,
      fitid: null,
      ynabId: null,
      importedPayee: null,
      source: null,
    });
    expect(extractYnab4TxLineage("row")).toEqual({
      checkNumber: null,
      fitid: null,
      ynabId: null,
      importedPayee: null,
      source: null,
    });
  });

  it("ofx mapping report skips non-array accounts", () => {
    const ctx = { warnings: [] } as unknown as Ynab4ImportContext;
    reportDroppedOfxMappings(
      {
        accounts: "nope",
        accountMappings: [
          { isTombstone: true, targetYNABAccountId: "x" },
          { targetYNABAccountId: "acc-1", skipImport: true },
        ],
      },
      ctx
    );
    expect(ctx.warnings).toHaveLength(2);
    expect(ctx.warnings[0]).toContain("Dropped 1 OFX account mapping(s)");
    expect(ctx.warnings[1]).toContain("targetYNABAccountId acc-1");
  });
});
