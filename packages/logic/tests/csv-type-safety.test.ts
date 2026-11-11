import { describe, expect, it } from "vitest";
import {
  atOrThrow,
  getOrThrow,
  matchGroup,
  parseCsv,
  parseCsvImport,
  parseDate,
} from "../src/csv-import.js";

describe("getOrThrow", () => {
  it("returns the hit and throws on a miss", () => {
    const m = new Map([["a", 1]]);
    expect(getOrThrow(m, "a", "letter")).toBe(1);
    expect(() => getOrThrow(m, "b", "letter")).toThrow("missing letter");
  });
});

describe("atOrThrow", () => {
  it("returns the element and throws out of bounds", () => {
    expect(atOrThrow(["x", "y"], 0, "row")).toBe("x");
    expect(atOrThrow(["x", "y"], 1, "row")).toBe("y");
    expect(() => atOrThrow(["x"], 1, "row")).toThrow("row index 1 out of bounds");
    expect(() => atOrThrow(["x"], -1, "row")).toThrow("row index -1 out of bounds");
    expect(() => atOrThrow([], 0, "row")).toThrow("out of bounds");
  });
});

describe("matchGroup", () => {
  it("returns the group and throws when absent", () => {
    const m = /^(\d+)-(\d+)$/.exec("12-34")!;
    expect(matchGroup(m, 1)).toBe("12");
    expect(matchGroup(m, 2)).toBe("34");
    expect(() => matchGroup(m, 3)).toThrow("capture group 3");
  });
});

describe("month-name lookup without assertions", () => {
  it("resolves full, long, sept, and prefix forms", () => {
    expect(parseDate("2026-September-15")).toBe("2026-09-15");
    expect(parseDate("2026-Sept-15")).toBe("2026-09-15");
    expect(parseDate("15-sep-2026")).toBe("2026-09-15");
    expect(parseDate("Sept 5, 2026")).toBe("2026-09-05");
  });

  it("returns null for unknown months", () => {
    expect(parseDate("15-Foo-2026")).toBeNull();
    expect(parseDate("Foo 5, 2026")).toBeNull();
  });
});

describe("parseCsv char-index restructure", () => {
  it("preserves CRLF inside quoted fields", () => {
    const rows = parseCsv('"a\r\nb",c\r\n1,2\r\n');
    expect(rows).toEqual([['"a\r\nb"'.slice(1, -1), "c"], ["1", "2"]]);
  });

  it("handles a trailing bare CR inside quotes", () => {
    const rows = parseCsv('"a\rb",c\n');
    expect(rows).toEqual([["a\rb", "c"]]);
  });
});

describe("headerless column mapping without assertions", () => {
  it("swaps amount-before-payee layouts", () => {
    const res = parseCsvImport("2026-04-05,-50.00,Refund Store\n");
    expect(res.headerError).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      date: "2026-04-05",
      payee: "Refund Store",
      amountCents: -5000,
    });
  });

  it("maps two trailing columns as outflow/inflow", () => {
    const res = parseCsvImport("2026-04-05,Store,50.00,20.00\n");
    expect(res.headerError).toBeNull();
    expect(res.rows[0]).toMatchObject({
      date: "2026-04-05",
      payee: "Store",
      amountCents: -5000,
    });
  });

  it("maps two trailing columns as memo/amount when text is present", () => {
    const res = parseCsvImport("2026-04-05,Store,Note,50.00\n");
    expect(res.headerError).toBeNull();
    expect(res.rows[0]).toMatchObject({
      date: "2026-04-05",
      payee: "Store",
      memo: "Note",
      amountCents: 5000,
    });
  });

  it("maps memo/category/amount over three trailing columns", () => {
    const res = parseCsvImport("2026-04-05,Store,Note,Groceries,50.00\n");
    expect(res.headerError).toBeNull();
    expect(res.rows[0]).toMatchObject({
      date: "2026-04-05",
      payee: "Store",
      memo: "Note",
      category: "Groceries",
      amountCents: 5000,
    });
  });

  it("maps memo/category/outflow/inflow over four trailing columns", () => {
    const res = parseCsvImport("2026-04-05,Store,Note,Food,50.00,10.00\n");
    expect(res.headerError).toBeNull();
    expect(res.rows[0]).toMatchObject({
      date: "2026-04-05",
      payee: "Store",
      memo: "Note",
      category: "Food",
      amountCents: -5000,
    });
  });
});

describe("header scan without assertions", () => {
  it("skips leading blank lines to find the header", () => {
    const res = parseCsvImport("\n\nDate,Payee,Amount\n2026-04-05,Store,-50.00\n");
    expect(res.headerError).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      date: "2026-04-05",
      payee: "Store",
      amountCents: -5000,
    });
  });
});
