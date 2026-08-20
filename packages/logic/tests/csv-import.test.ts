import { describe, expect, it } from "vitest";
import {
  parseCsv,
  parseCsvImport,
  swapPayeeMemo,
} from "../src/csv-import.js";

describe("parseCsv", () => {
  it("parses a simple CSV with a BOM", () => {
    const rows = parseCsv("\uFEFFDate,Payee,Amount\n2026-08-01,Store,-10.00\n");
    expect(rows).toEqual([
      ["Date", "Payee", "Amount"],
      ["2026-08-01", "Store", "-10.00"],
    ]);
  });

  it("handles quoted fields with commas, quotes, and newlines", () => {
    const rows = parseCsv('a,"b, c",d\n"he said ""hi""",e,f\n');
    expect(rows).toEqual([
      ["a", "b, c", "d"],
      ['he said "hi"', "e", "f"],
    ]);
  });

  it("handles CRLF line endings", () => {
    const rows = parseCsv("a,b\r\nc,d\r\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseCsvImport", () => {
  const sample = [
    "Date,Payee,Category,Memo,Outflow,Inflow",
    "13/08/2026,PHNOM PENH RESTAURANT,,,28.08,",
    "13/08/2026,UBER TRIP,,Toronto,18.63,",
    "03/08/2026,PAYMENT RECEIVED - THANK YOU,,,,1908.03",
  ].join("\n");

  it("maps the sample columns and signs amounts correctly", () => {
    const { headerError, rows } = parseCsvImport(sample);
    expect(headerError).toBeNull();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      date: "2026-08-13",
      payee: "PHNOM PENH RESTAURANT",
      memo: "",
      amountCents: -2808,
      error: null,
    });
    expect(rows[1]).toMatchObject({ date: "2026-08-13", amountCents: -1863 });
    expect(rows[2]).toMatchObject({
      date: "2026-08-03",
      payee: "PAYMENT RECEIVED - THANK YOU",
      amountCents: 190803,
    });
  });

  it("parses ISO and year-first dates", () => {
    const csv = [
      "Date,Payee,Outflow",
      "2026-08-01,A,-1.00",
      "2026/08/02,B,-2.00",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows[0]!.date).toBe("2026-08-01");
    expect(rows[1]!.date).toBe("2026-08-02");
  });

  it("handles US thousands separators and currency symbols", () => {
    const csv = ["Date,Payee,Amount", '2026-08-01,Store,"$1,234.56"'].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows[0]!.amountCents).toBe(123456);
  });

  it("treats a single Amount column as signed", () => {
    const csv = [
      "Date,Payee,Amount",
      "2026-08-01,Store,-10.50",
      "2026-08-02,Income,500.00",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows[0]!.amountCents).toBe(-1050);
    expect(rows[1]!.amountCents).toBe(50000);
  });

  it("maps a Description-only header to payee", () => {
    const csv = ["Date,Description,Amount", "2026-08-01,Whole Foods,-5.00"].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows[0]!.payee).toBe("Whole Foods");
    expect(rows[0]!.memo).toBe("");
  });

  it("parses a wider slice of the sample export", () => {
    const csv = [
      "Date,Payee,Category,Memo,Outflow,Inflow",
      "31/07/2026,HOTELCOM73510218885810  CA.HOTELS.COM,,,135.98,",
      "23/07/2026,WHITE SPOT - 141 - COQU COQUITLAM,,,82.68,",
      "21/07/2026,PAYPAL *EBAY CA         0015125826083,,,,12.31",
      "20/07/2026,JAK'S WINE BEER SPIRITS COQUITLAM,,,348.95,",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      date: "2026-07-31",
      payee: "HOTELCOM73510218885810  CA.HOTELS.COM",
      amountCents: -13598,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      date: "2026-07-23",
      payee: "WHITE SPOT - 141 - COQU COQUITLAM",
      amountCents: -8268,
    });
    expect(rows[2]).toMatchObject({
      date: "2026-07-21",
      payee: "PAYPAL *EBAY CA         0015125826083",
      amountCents: 1231,
    });
    expect(rows[3]).toMatchObject({
      date: "2026-07-20",
      payee: "JAK'S WINE BEER SPIRITS COQUITLAM",
      amountCents: -34895,
    });
  });

  it("flags invalid dates, zero amounts, and empty rows", () => {
    const csv = [
      "Date,Payee,Outflow",
      "13/13/2026,Store,10.00",
      "2026-08-01,Store,0.00",
      "2026-08-01,Store,5.00",
      ",,,",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.error).toMatch(/Invalid date/);
    expect(rows[1]!.error).toMatch(/zero/);
    expect(rows[2]!.error).toBeNull();
  });

  it("returns a header error for a missing Payee column", () => {
    const { headerError } = parseCsvImport("Date,Outflow\n2026-08-01,5.00\n");
    expect(headerError).toMatch(/Payee/);
  });

  it("returns a header error for an empty file", () => {
    const { headerError } = parseCsvImport("");
    expect(headerError).toBe("The file is empty");
  });
});

describe("swapPayeeMemo", () => {
  const rows = parseCsvImport(
    "Date,Payee,Memo,Outflow\n2026-08-01,A,B,-1.00\n2026-08-02,C,, -2.00\n"
  ).rows;

  it("leaves rows unchanged when swap is false", () => {
    expect(swapPayeeMemo(rows, false)).toBe(rows);
  });

  it("swaps payee and memo when both are present", () => {
    const swapped = swapPayeeMemo(rows, true);
    expect(swapped[0]!.payee).toBe("B");
    expect(swapped[0]!.memo).toBe("A");
  });

  it("swaps unconditionally, leaving an empty payee when memo is empty", () => {
    const swapped = swapPayeeMemo(rows, true);
    expect(swapped[1]!.payee).toBe("");
    expect(swapped[1]!.memo).toBe("C");
  });
});
