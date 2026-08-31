import { describe, expect, it } from "vitest";
import {
  detectDateFormat,
  detectDateFormatDetailed,
  parseAmount,
  parseCsv,
  parseCsvImport,
  parseDate,
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

  it("throws an error on unclosed quotes with affected line number (BUG-51)", () => {
    expect(() => parseCsv('Date,Payee,"Amount\n2026-08-01,Store,-10.00')).toThrow(
      "Unclosed quote in CSV on line 1"
    );
    expect(() => parseCsv('Date,Payee,Amount\n2026-08-01,"Store\ncontinued,-10.00')).toThrow(
      "Unclosed quote in CSV on line 2"
    );
    expect(() => parseCsv('Date,Payee,Amount\n2026-08-01,Store,-10.00\n2026-08-02,"Unclosed')).toThrow(
      "Unclosed quote in CSV on line 3"
    );
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

  it("handles European and British currency symbols and accounting formats in CSV import (BUG-28)", () => {
    const csv = [
      "Date,Payee,Amount",
      '2026-08-01,Berlin Market,"€123.45"',
      '2026-08-02,London Pub,"-£50.00"',
      '2026-08-03,Paris Bistro,"€(75.50)"',
      '2026-08-04,Tokyo Shop,"¥500"',
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows[0]!.amountCents).toBe(12345);
    expect(rows[0]!.error).toBeNull();
    expect(rows[1]!.amountCents).toBe(-5000);
    expect(rows[1]!.error).toBeNull();
    expect(rows[2]!.amountCents).toBe(-7550);
    expect(rows[2]!.error).toBeNull();
    expect(rows[3]!.amountCents).toBe(50000);
    expect(rows[3]!.error).toBeNull();
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

  it("maps Description to payee and retains Memo as memo when both exist (BUG-29)", () => {
    const csv = [
      "Date,Description,Memo,Amount",
      "2026-08-01,Whole Foods,Weekly groceries,-5.00",
    ].join("\n");
    const { headerError, rows } = parseCsvImport(csv);
    expect(headerError).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-08-01",
      payee: "Whole Foods",
      memo: "Weekly groceries",
      amountCents: -500,
      error: null,
    });
  });

  it("maps Description to payee and Note to memo when both exist (BUG-29)", () => {
    const csv = [
      "Date,Description,Note,Amount",
      "2026-08-01,Whole Foods,Weekly groceries,-5.00",
    ].join("\n");
    const { headerError, rows } = parseCsvImport(csv);
    expect(headerError).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payee: "Whole Foods",
      memo: "Weekly groceries",
      amountCents: -500,
      error: null,
    });
  });

  it("maps Payee to payee and prefers Memo over Description for memo when all three exist", () => {
    const csv = [
      "Date,Payee,Description,Memo,Amount",
      "2026-08-01,Supermarket,POS 1234,Weekly groceries,-5.00",
    ].join("\n");
    const { headerError, rows } = parseCsvImport(csv);
    expect(headerError).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payee: "Supermarket",
      memo: "Weekly groceries",
      amountCents: -500,
      error: null,
    });
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

  it("falls through from a 0.00 outflow cell to the inflow column", () => {
    const csv = [
      "Date,Payee,Category,Memo,Outflow,Inflow",
      "13/08/2026,PAYROLL,,,0.00,1908.03",
      "13/08/2026,RESTAURANT,,,28.08,0.00",
      "13/08/2026,ZERO BOTH,,,0.00,0.00",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      date: "2026-08-13",
      payee: "PAYROLL",
      amountCents: 190803,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      date: "2026-08-13",
      payee: "RESTAURANT",
      amountCents: -2808,
      error: null,
    });
    expect(rows[2]).toMatchObject({
      date: "2026-08-13",
      payee: "ZERO BOTH",
      amountCents: 0,
    });
    expect(rows[2]!.error).toMatch(/zero/);
  });

  it("falls through to amount column when outflow and inflow are 0.00", () => {
    const csv = [
      "Date,Payee,Outflow,Inflow,Amount",
      "13/08/2026,TRANSFER,0.00,0.00,-50.00",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payee: "TRANSFER",
      amountCents: -5000,
      error: null,
    });
  });

  it("returns a header error for a missing Payee column", () => {
    const { headerError } = parseCsvImport("Date,Outflow\n2026-08-01,5.00\n");
    expect(headerError).toMatch(/Payee/);
  });

  it("returns a header error for an empty file", () => {
    const { headerError } = parseCsvImport("");
    expect(headerError).toBe("The file is empty");
  });

  it("decides date convention once per file for US MM/DD files without mixing conventions", () => {
    // In US MM/DD files:
    // 08/13/2026 -> August 13 (second number > 12 implies MM/DD)
    // 08/05/2026 -> August 5 (must NOT be parsed as May 8)
    const csv = [
      "Date,Payee,Amount",
      "08/13/2026,Store A,-10.00",
      "08/05/2026,Store B,-20.00",
    ].join("\n");
    const { rows, detectedDateFormat } = parseCsvImport(csv);
    expect(detectedDateFormat).toBe("mdy");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("2026-08-13");
    expect(rows[1]!.date).toBe("2026-08-05");
  });

  it("does not let calendar-invalid dates corrupt date format detection in parseCsvImport (BUG-30)", () => {
    const csv = [
      "Date,Payee,Amount",
      "31/02/2026,Store Invalid,-10.00",
      "08/13/2026,Store A,-20.00",
      "08/05/2026,Store B,-30.00",
    ].join("\n");
    const { rows, detectedDateFormat } = parseCsvImport(csv);
    expect(detectedDateFormat).toBe("mdy");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.error).toMatch(/Invalid date/);
    expect(rows[0]!.date).toBeNull();
    expect(rows[1]!.error).toBeNull();
    expect(rows[1]!.date).toBe("2026-08-13");
    expect(rows[2]!.error).toBeNull();
    expect(rows[2]!.date).toBe("2026-08-05");
  });

  it("decides date convention once per file for DD/MM files without mixing conventions", () => {
    // In DD/MM files:
    // 13/08/2026 -> August 13 (first number > 12 implies DD/MM)
    // 05/08/2026 -> August 5 (must NOT be parsed as May 8)
    const csv = [
      "Date,Payee,Amount",
      "13/08/2026,Store A,-10.00",
      "05/08/2026,Store B,-20.00",
    ].join("\n");
    const { rows, detectedDateFormat } = parseCsvImport(csv);
    expect(detectedDateFormat).toBe("dmy");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("2026-08-13");
    expect(rows[1]!.date).toBe("2026-08-05");
  });

  it("defaults ambiguous files to DD/MM unless overridden by options", () => {
    const csv = [
      "Date,Payee,Amount",
      "03/05/2026,Store A,-10.00",
      "04/06/2026,Store B,-20.00",
    ].join("\n");
    const defaultResult = parseCsvImport(csv);
    expect(defaultResult.detectedDateFormat).toBe("dmy");
    expect(defaultResult.rows[0]!.date).toBe("2026-05-03"); // 3rd of May
    expect(defaultResult.rows[1]!.date).toBe("2026-06-04"); // 4th of June

    const mdyResult = parseCsvImport(csv, { dateFormat: "mdy" });
    expect(mdyResult.detectedDateFormat).toBe("mdy");
    expect(mdyResult.rows[0]!.date).toBe("2026-03-05"); // March 5th
    expect(mdyResult.rows[1]!.date).toBe("2026-04-06"); // April 6th
  });

  it("surfaces dateAmbiguous when auto-detection had no disambiguating dates (BUG-15)", () => {
    const ambiguousCsv = [
      "Date,Payee,Amount",
      "01/02/2026,Store A,-10.00",
      "05/06/2026,Store B,-20.00",
    ].join("\n");
    const auto = parseCsvImport(ambiguousCsv);
    expect(auto.detectedDateFormat).toBe("dmy");
    expect(auto.dateAmbiguous).toBe(true);

    const forced = parseCsvImport(ambiguousCsv, { dateFormat: "mdy" });
    expect(forced.detectedDateFormat).toBe("mdy");
    expect(forced.dateAmbiguous).toBe(false);

    const clearCsv = [
      "Date,Payee,Amount",
      "13/08/2026,Store A,-10.00",
      "01/02/2026,Store B,-20.00",
    ].join("\n");
    expect(parseCsvImport(clearCsv).dateAmbiguous).toBe(false);
  });

  it("marks rows violating the chosen file convention as invalid date", () => {
    // If file is detected as DD/MM because of 14/08/2026, then 08/14/2026 (month 14) is invalid
    const csv = [
      "Date,Payee,Amount",
      "14/08/2026,Store A,-10.00",
      "15/08/2026,Store B,-20.00",
      "08/14/2026,Store C,-30.00",
    ].join("\n");
    const { rows, detectedDateFormat } = parseCsvImport(csv);
    expect(detectedDateFormat).toBe("dmy");
    expect(rows[0]!.error).toBeNull();
    expect(rows[0]!.date).toBe("2026-08-14");
    expect(rows[1]!.error).toBeNull();
    expect(rows[1]!.date).toBe("2026-08-15");
    expect(rows[2]!.error).toMatch(/Invalid date/);
    expect(rows[2]!.date).toBeNull();
  });

  it("treats a single 'Payment Amount' column as a signed amount, preserving debit and credit signs", () => {
    const csv = [
      "Date,Payee,Payment Amount",
      "2026-08-01,Store,-10.50",
      "2026-08-02,Salary,500.00",
    ].join("\n");
    const { headerError, rows } = parseCsvImport(csv);
    expect(headerError).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      payee: "Store",
      amountCents: -1050,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      payee: "Salary",
      amountCents: 50000,
      error: null,
    });
  });

  it("skips 'Type of Payment' header and uses the 'Amount' column", () => {
    const csv = [
      "Date,Payee,Type of Payment,Amount",
      "2026-08-01,Store,Direct Debit,-10.50",
      "2026-08-02,Salary,Direct Deposit,500.00",
    ].join("\n");
    const { headerError, rows } = parseCsvImport(csv);
    expect(headerError).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      payee: "Store",
      amountCents: -1050,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      payee: "Salary",
      amountCents: 50000,
      error: null,
    });
  });

  it("skips headers containing 'type' or 'method'", () => {
    const csv1 = [
      "Date,Payee,Payment Method,Amount",
      "2026-08-01,Store,Credit Card,-15.00",
    ].join("\n");
    const res1 = parseCsvImport(csv1);
    expect(res1.headerError).toBeNull();
    expect(res1.rows[0]!.amountCents).toBe(-1500);

    const csv2 = [
      "Date,Payee,Transaction Type,Amount",
      "2026-08-01,Store,POS,-25.00",
    ].join("\n");
    const res2 = parseCsvImport(csv2);
    expect(res2.headerError).toBeNull();
    expect(res2.rows[0]!.amountCents).toBe(-2500);
  });

  it("keeps accounting-style negatives in Outflow columns as negative outflows", () => {
    const csv = [
      "Date,Payee,Outflow",
      "2026-08-01,Store A,(28.08)",
      "2026-08-02,Store B,-18.63",
      "2026-08-03,Store C,25.00",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.amountCents).toBe(-2808);
    expect(rows[1]!.amountCents).toBe(-1863);
    expect(rows[2]!.amountCents).toBe(-2500);
  });

  it("falls back to amount column when outflow column cell is non-numeric text", () => {
    const csv = [
      "Date,Payee,Outflow,Amount",
      "2026-08-01,Store,N/A,-10.50",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(-1050);
    expect(rows[0]!.error).toBeNull();
  });

  it("handles Debit Amount and Credit Amount columns", () => {
    const csv = [
      "Date,Payee,Debit Amount,Credit Amount",
      "2026-08-01,Store,10.50,",
      "2026-08-02,Salary,,500.00",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amountCents).toBe(-1050);
    expect(rows[1]!.amountCents).toBe(50000);
  });

  it("handles Payment and Deposit columns as Outflow and Inflow", () => {
    const csv = [
      "Date,Payee,Payment,Deposit",
      "2026-08-01,Store,10.50,",
      "2026-08-02,Salary,,500.00",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amountCents).toBe(-1050);
    expect(rows[1]!.amountCents).toBe(50000);
  });

  it("parses CSV files with text month date formats", () => {
    const csv = [
      "Date,Payee,Amount",
      "15-Aug-2026,Store A,-10.00",
      '"Aug 15, 2026",Store B,-20.00',
      "Aug 15 2026,Store C,-25.00",
      "15-AUG-2026,Store D,-30.00",
      "2026-Aug-15,Store E,-40.00",
    ].join("\n");
    const { rows, headerError } = parseCsvImport(csv);
    expect(headerError).toBeNull();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ date: "2026-08-15", amountCents: -1000, error: null });
    expect(rows[1]).toMatchObject({ date: "2026-08-15", amountCents: -2000, error: null });
    expect(rows[2]).toMatchObject({ date: "2026-08-15", amountCents: -2500, error: null });
    expect(rows[3]).toMatchObject({ date: "2026-08-15", amountCents: -3000, error: null });
    expect(rows[4]).toMatchObject({ date: "2026-08-15", amountCents: -4000, error: null });
  });

  it("flags missing payee when swap is enabled and memo is empty (BUG-31)", () => {
    const csv = [
      "Date,Payee,Memo,Outflow",
      "2026-08-01,Store,,10.00",
      "2026-08-02,,Real Payee,20.00",
    ].join("\n");
    const unswapped = parseCsvImport(csv, { swap: false });
    expect(unswapped.rows[0]!.error).toBeNull();
    expect(unswapped.rows[1]!.error).toBe("Missing payee");

    const swapped = parseCsvImport(csv, { swap: true });
    expect(swapped.rows[0]!.error).toBe("Missing payee");
    expect(swapped.rows[0]!.payee).toBe("");
    expect(swapped.rows[0]!.memo).toBe("Store");
    expect(swapped.rows[1]!.error).toBeNull();
    expect(swapped.rows[1]!.payee).toBe("Real Payee");
    expect(swapped.rows[1]!.memo).toBe("");
  });
});

describe("detectDateFormat", () => {
  it("detects MDY when second number > 12", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["08/13/2026", "Store", "-10.00"],
      ["08/05/2026", "Store", "-20.00"],
    ];
    expect(detectDateFormat(rows, 0, 0)).toBe("mdy");
  });

  it("detects DMY when first number > 12", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["13/08/2026", "Store", "-10.00"],
      ["05/08/2026", "Store", "-20.00"],
    ];
    expect(detectDateFormat(rows, 0, 0)).toBe("dmy");
  });

  it("detects MDY from month-first text month dates", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["Aug 15, 2026", "Store", "-10.00"],
      ["08/05/2026", "Store", "-20.00"],
    ];
    expect(detectDateFormat(rows, 0, 0)).toBe("mdy");
  });

  it("detects DMY from day-first text month dates", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["15-Aug-2026", "Store", "-10.00"],
      ["05/08/2026", "Store", "-20.00"],
    ];
    expect(detectDateFormat(rows, 0, 0)).toBe("dmy");
  });

  it("defaults to DMY when ambiguous or ISO", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["01/02/2026", "Store", "-10.00"],
      ["2026-08-01", "Store", "-20.00"],
    ];
    expect(detectDateFormat(rows, 0, 0)).toBe("dmy");
  });

  it("does not count calendar-invalid dates (e.g. 31/02/2026) towards date format voting (BUG-30)", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["31/02/2026", "Invalid", "-10.00"], // Feb 31 is invalid calendar date (should not vote for DMY)
      ["03/15/2026", "Valid MDY", "-20.00"], // March 15 (votes for MDY)
      ["01/02/2026", "Ambiguous", "-30.00"], // Ambiguous
    ];
    expect(detectDateFormat(rows, 0, 0)).toBe("mdy");
  });

  it("does not count calendar-invalid leap years or month boundaries towards date format voting (BUG-30)", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["29/02/2025", "Invalid non-leap Feb 29", "-10.00"], // Invalid, 0 votes
      ["31/04/2026", "Invalid April 31", "-10.00"], // Invalid, 0 votes
      ["31/06/2026", "Invalid June 31", "-10.00"], // Invalid, 0 votes
      ["15/08/2026", "Valid DMY", "-20.00"], // 1 vote for DMY
    ];
    expect(detectDateFormat(rows, 0, 0)).toBe("dmy");
  });
});

describe("detectDateFormatDetailed (BUG-15)", () => {
  it("flags ambiguity when every numeric date is day/month ambiguous (all values <= 12)", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["01/02/2026", "Store", "-10.00"],
      ["05/06/2026", "Store", "-20.00"],
      ["11/12/2026", "Store", "-30.00"],
    ];
    const detail = detectDateFormatDetailed(rows, 0, 0);
    expect(detail.convention).toBe("dmy");
    expect(detail.dmyVotes).toBe(0);
    expect(detail.mdyVotes).toBe(0);
    expect(detail.ambiguous).toBe(true);
  });

  it("does not flag ambiguity when numeric dates disambiguate the convention", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["13/08/2026", "Store", "-10.00"],
      ["01/02/2026", "Store", "-20.00"],
    ];
    const detail = detectDateFormatDetailed(rows, 0, 0);
    expect(detail.convention).toBe("dmy");
    expect(detail.ambiguous).toBe(false);
  });

  it("does not flag ambiguity when there are no numeric date candidates", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["2026-08-01", "Store", "-10.00"],
      ["15-Aug-2026", "Store", "-20.00"],
    ];
    const detail = detectDateFormatDetailed(rows, 0, 0);
    expect(detail.convention).toBe("dmy");
    expect(detail.ambiguous).toBe(false);
  });

  it("flags ambiguity on a tied vote", () => {
    const rows = [
      ["Date", "Payee", "Amount"],
      ["13/08/2026", "Store", "-10.00"],
      ["05/13/2026", "Store", "-20.00"],
    ];
    const detail = detectDateFormatDetailed(rows, 0, 0);
    expect(detail.dmyVotes).toBe(1);
    expect(detail.mdyVotes).toBe(1);
    expect(detail.convention).toBe("dmy");
    expect(detail.ambiguous).toBe(true);
  });
});

describe("parseDate", () => {
  it("parses dates with explicit convention", () => {
    expect(parseDate("08/05/2026", "mdy")).toBe("2026-08-05");
    expect(parseDate("08/05/2026", "dmy")).toBe("2026-05-08");
    expect(parseDate("13/08/2026", "dmy")).toBe("2026-08-13");
    expect(parseDate("13/08/2026", "mdy")).toBeNull(); // month 13 invalid
  });

  it("parses 2-digit years", () => {
    expect(parseDate("08/05/26", "mdy")).toBe("2026-08-05");
    expect(parseDate("05/08/26", "dmy")).toBe("2026-08-05");
  });

  it("applies a two-digit year pivot: <70 to 2000s, otherwise 1900s (BUG-15)", () => {
    expect(parseDate("31/12/99", "dmy")).toBe("1999-12-31");
    expect(parseDate("02/01/50", "dmy")).toBe("2050-01-02");
    expect(parseDate("12/31/68", "mdy")).toBe("2068-12-31");
    expect(parseDate("01/12/70", "dmy")).toBe("1970-12-01");
    expect(parseDate("15-Aug-26")).toBe("2026-08-15");
    expect(parseDate("Aug 15, 99")).toBe("1999-08-15");
  });

  it("parses ISO dates regardless of convention", () => {
    expect(parseDate("2026-08-05", "mdy")).toBe("2026-08-05");
    expect(parseDate("2026-08-05", "dmy")).toBe("2026-08-05");
  });

  it("parses standard text month abbreviations and names in Day-Month-Year format", () => {
    expect(parseDate("15-Aug-2026")).toBe("2026-08-15");
    expect(parseDate("15-AUG-2026")).toBe("2026-08-15");
    expect(parseDate("15-aug-2026")).toBe("2026-08-15");
    expect(parseDate("15 Aug 2026")).toBe("2026-08-15");
    expect(parseDate("15/Aug/2026")).toBe("2026-08-15");
    expect(parseDate("15.Aug.2026")).toBe("2026-08-15");
    expect(parseDate("15. Aug. 2026")).toBe("2026-08-15");
    expect(parseDate("15-Aug-26")).toBe("2026-08-15");
    expect(parseDate("15 August 2026")).toBe("2026-08-15");
    expect(parseDate("15th August 2026")).toBe("2026-08-15");
    expect(parseDate("1st Jan 2026")).toBe("2026-01-01");
  });

  it("parses standard text month abbreviations and names in Month-Day-Year format", () => {
    expect(parseDate("Aug 15, 2026")).toBe("2026-08-15");
    expect(parseDate("Aug 15 2026")).toBe("2026-08-15");
    expect(parseDate("AUG 15, 2026")).toBe("2026-08-15");
    expect(parseDate("aug 15, 2026")).toBe("2026-08-15");
    expect(parseDate("Aug-15-2026")).toBe("2026-08-15");
    expect(parseDate("Aug/15/2026")).toBe("2026-08-15");
    expect(parseDate("Aug. 15, 2026")).toBe("2026-08-15");
    expect(parseDate("August 15, 2026")).toBe("2026-08-15");
    expect(parseDate("August 15th, 2026")).toBe("2026-08-15");
    expect(parseDate("Aug 15, 26")).toBe("2026-08-15");
    expect(parseDate("Sept 4, 2026")).toBe("2026-09-04");
  });

  it("parses Year-Month-Day text formats", () => {
    expect(parseDate("2026-Aug-15")).toBe("2026-08-15");
    expect(parseDate("2026 Aug 15")).toBe("2026-08-15");
    expect(parseDate("2026/AUG/15")).toBe("2026-08-15");
    expect(parseDate("2026-August-15")).toBe("2026-08-15");
  });

  it("handles leap years and month boundaries with text dates", () => {
    expect(parseDate("29-Feb-2024")).toBe("2024-02-29"); // leap year
    expect(parseDate("29-Feb-2025")).toBeNull(); // non-leap year
    expect(parseDate("31-Sep-2026")).toBeNull(); // Sep has 30 days
    expect(parseDate("31-Aug-2026")).toBe("2026-08-31"); // Aug has 31 days
  });

  it("rejects invalid date strings", () => {
    expect(parseDate("invalid")).toBeNull();
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("32/01/2026", "dmy")).toBeNull();
    expect(parseDate("15-Foo-2026")).toBeNull();
    expect(parseDate("Foo 15, 2026")).toBeNull();
  });
});

describe("swapPayeeMemo (BUG-31)", () => {
  const rows = parseCsvImport(
    "Date,Payee,Memo,Outflow\n2026-08-01,A,B,-1.00\n2026-08-02,C,, -2.00\n2026-08-03,,D,-3.00\n"
  ).rows;

  it("leaves rows unchanged when swap is false", () => {
    expect(swapPayeeMemo(rows, false)).toBe(rows);
  });

  it("swaps payee and memo when both are present", () => {
    const swapped = swapPayeeMemo(rows, true);
    expect(swapped[0]!.payee).toBe("B");
    expect(swapped[0]!.memo).toBe("A");
    expect(swapped[0]!.error).toBeNull();
  });

  it("flags swapped row as Missing payee when memo is empty (BUG-31)", () => {
    expect(rows[1]!.error).toBeNull();
    const swapped = swapPayeeMemo(rows, true);
    expect(swapped[1]!.payee).toBe("");
    expect(swapped[1]!.memo).toBe("C");
    expect(swapped[1]!.error).toBe("Missing payee");
  });

  it("clears Missing payee when swapping a row with empty payee and non-empty memo (BUG-31)", () => {
    expect(rows[2]!.error).toBe("Missing payee");
    const swapped = swapPayeeMemo(rows, true);
    expect(swapped[2]!.payee).toBe("D");
    expect(swapped[2]!.memo).toBe("");
    expect(swapped[2]!.error).toBeNull();
  });
});

describe("parseAmount (BUG-20)", () => {
  it("parses valid integers, decimals, and negative amounts", () => {
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("0.00")).toBe(0);
    expect(parseAmount("-0.00")).toBe(0);
    expect(parseAmount("123")).toBe(123);
    expect(parseAmount("123.45")).toBe(123.45);
    expect(parseAmount("-123.45")).toBe(-123.45);
    expect(parseAmount("+123.45")).toBe(123.45);
    expect(parseAmount("(123.45)")).toBe(-123.45);
  });

  it("parses currency symbols and accounting formats ($ € £ ¥) (BUG-28)", () => {
    expect(parseAmount("$123.45")).toBe(123.45);
    expect(parseAmount("-$123.45")).toBe(-123.45);
    expect(parseAmount("$-123.45")).toBe(-123.45);
    expect(parseAmount("($123.45)")).toBe(-123.45);
    expect(parseAmount("$(123.45)")).toBe(-123.45);
    expect(parseAmount("$ (123.45)")).toBe(-123.45);
    expect(parseAmount("123.45$")).toBe(123.45);
    expect(parseAmount("€123.45")).toBe(123.45);
    expect(parseAmount("-€123.45")).toBe(-123.45);
    expect(parseAmount("€-123.45")).toBe(-123.45);
    expect(parseAmount("€(123.45)")).toBe(-123.45);
    expect(parseAmount("(€123.45)")).toBe(-123.45);
    expect(parseAmount("€ (123.45)")).toBe(-123.45);
    expect(parseAmount("€ 123.45")).toBe(123.45);
    expect(parseAmount("123.45 €")).toBe(123.45);
    expect(parseAmount("123.45€")).toBe(123.45);
    expect(parseAmount("(123.45 €)")).toBe(-123.45);
    expect(parseAmount("(123.45) €")).toBe(-123.45);
    expect(parseAmount("£2,500.00")).toBe(2500);
    expect(parseAmount("-£2,500.00")).toBe(-2500);
    expect(parseAmount("£-2,500.00")).toBe(-2500);
    expect(parseAmount("£(2,500.00)")).toBe(-2500);
    expect(parseAmount("(£2,500.00)")).toBe(-2500);
    expect(parseAmount("£ (2,500.00)")).toBe(-2500);
    expect(parseAmount("¥500")).toBe(500);
    expect(parseAmount("-¥500")).toBe(-500);
    expect(parseAmount("¥-500")).toBe(-500);
    expect(parseAmount("¥(500)")).toBe(-500);
    expect(parseAmount("(¥500)")).toBe(-500);
  });

  it("parses US and European thousands groupings and decimal commas", () => {
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("1,234,567.89")).toBe(1234567.89);
    expect(parseAmount("1,000")).toBe(1000);
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1.234.567,89")).toBe(1234567.89);
    expect(parseAmount("12,50")).toBe(12.5);
    expect(parseAmount(",50")).toBe(0.5);
    expect(parseAmount(".50")).toBe(0.5);
    expect(parseAmount("1 234.56")).toBe(1234.56);
    expect(parseAmount("1 234,56")).toBe(1234.56);
  });

  it("parses single dot-thousands group like European 1.500 as 1500 not 1.5 (BUG-10)", () => {
    expect(parseAmount("1.500")).toBe(1500);
    expect(parseAmount("1,500")).toBe(1500);
    expect(parseAmount("1.500,50")).toBe(1500.5);
  });

  it("rejects malformed numbers and unsupported suffixes (BUG-20)", () => {
    expect(parseAmount("12abc")).toBeNull();
    expect(parseAmount("123.45 USD")).toBeNull();
    expect(parseAmount("1,23,4")).toBeNull();
    expect(parseAmount("1-")).toBeNull();
    expect(parseAmount("1.2.3")).toBeNull();
    expect(parseAmount("1,,2")).toBeNull();
    expect(parseAmount("1..2")).toBeNull();
    expect(parseAmount("1,234,5")).toBeNull();
    expect(parseAmount("1.234.5")).toBeNull();
    expect(parseAmount("--123")).toBeNull();
    expect(parseAmount("(123")).toBeNull();
    expect(parseAmount("123)")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
  });

  it("flags malformed amount rows with an error in parseCsvImport (BUG-20)", () => {
    const csv = [
      "Date,Payee,Amount",
      "2026-08-01,Store A,12abc",
      "2026-08-02,Store B,123.45 USD",
      '2026-08-03,Store C,"1,23,4"',
      "2026-08-04,Store D,1-",
      "2026-08-05,Store E,10.00",
    ].join("\n");
    const { rows } = parseCsvImport(csv);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.error).toMatch(/Invalid amount/);
    expect(rows[0]!.amountCents).toBeNull();
    expect(rows[1]!.error).toMatch(/Invalid amount/);
    expect(rows[1]!.amountCents).toBeNull();
    expect(rows[2]!.error).toMatch(/Invalid amount/);
    expect(rows[2]!.amountCents).toBeNull();
    expect(rows[3]!.error).toMatch(/Invalid amount/);
    expect(rows[3]!.amountCents).toBeNull();
    expect(rows[4]!.error).toBeNull();
    expect(rows[4]!.amountCents).toBe(1000);
  });

  it("returns headerError on unclosed CSV quotes (BUG-51)", () => {
    const csv = 'Date,Payee,Amount\n2026-08-01,"Store,-10.00\n';
    const result = parseCsvImport(csv);
    expect(result.headerError).toBe("Unclosed quote in CSV on line 2");
    expect(result.rows).toEqual([]);
  });

  it("parses multi-section CSV database export directly into transaction rows (BUG-50)", () => {
    const multiSectionCsv = [
      "Type,ID,Name,Kind,Group,Balance,On Budget,Archived",
      "Account,1,Checking,checking,Budget Accounts,100.00,Y,N",
      "Account,2,Savings,savings,Budget Accounts,500.00,Y,N",
      "",
      "Type,ID,Name,Sort,CC Payments",
      "Group,1,Everyday Expenses,1,N",
      "",
      "Type,ID,GroupID,Name,Sort,Carryover,Goal,LinkedAccountID",
      "Category,1,1,Groceries,1,0.00,,",
      "",
      "Type,ID,CategoryID,Month,Amount",
      "Assignment,1,1,2026-08,50.00",
      "",
      "Type,ID,AccountID,CategoryID,Date,Payee,Memo,Amount,Status,Flag,TransferAccountID,ParentID,IsIncome",
      "Transaction,1,1,1,2026-08-01,Supermarket,Weekly food,-25.50,cleared,Red,,,N",
      "Transaction,2,1,,2026-08-02,Employer,Paycheck,2000.00,cleared,,,,,Y",
      "Transaction,3,2,,2026-08-03,Transfer : Checking,,100.00,cleared,,1,,N",
      "",
      "Type,ID,AccountID,CategoryID,Payee,Amount,Frequency,NextDate,Active,TransferAccountID",
      "Recurring,1,1,1,Landlord,-500.00,monthly,2026-09-01,Y,",
    ].join("\n");

    const result = parseCsvImport(multiSectionCsv);
    expect(result.headerError).toBeNull();
    expect(result.rows).toHaveLength(3);

    expect(result.rows[0]).toEqual({
      rowNumber: 15,
      date: "2026-08-01",
      payee: "Supermarket",
      memo: "Weekly food",
      category: "1",
      amountCents: -2550,
      error: null,
    });

    expect(result.rows[1]).toEqual({
      rowNumber: 16,
      date: "2026-08-02",
      payee: "Employer",
      memo: "Paycheck",
      category: "",
      amountCents: 200000,
      error: null,
    });

    expect(result.rows[2]).toEqual({
      rowNumber: 17,
      date: "2026-08-03",
      payee: "Transfer : Checking",
      memo: "",
      category: "",
      amountCents: 10000,
      error: null,
    });
  });

  it("imports single-row headerless CSV starting directly with data without losing row 1 (BUG-13)", () => {
    const csv = "01/05/2026,Shell,-42.10\n";
    const result = parseCsvImport(csv);
    expect(result.headerError).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      rowNumber: 1,
      date: "2026-05-01",
      payee: "Shell",
      memo: "",
      category: "",
      amountCents: -4210,
      error: null,
    });
  });

  it("imports multi-row headerless CSV with 3, 4, and 5 columns (BUG-13)", () => {
    // 3 columns: Date, Payee, Amount
    const csv3 = [
      "2026-08-01,Shell,-42.10",
      "2026-08-02,Starbucks,-5.50",
      "2026-08-03,Employer,2500.00",
    ].join("\n");
    const res3 = parseCsvImport(csv3);
    expect(res3.headerError).toBeNull();
    expect(res3.rows).toHaveLength(3);
    expect(res3.rows[0]).toMatchObject({ rowNumber: 1, date: "2026-08-01", payee: "Shell", amountCents: -4210 });
    expect(res3.rows[1]).toMatchObject({ rowNumber: 2, date: "2026-08-02", payee: "Starbucks", amountCents: -550 });
    expect(res3.rows[2]).toMatchObject({ rowNumber: 3, date: "2026-08-03", payee: "Employer", amountCents: 250000 });

    // 4 columns: Date, Payee, Memo, Amount
    const csv4 = [
      "2026-08-01,Shell,Gas station,-42.10",
      "2026-08-02,Starbucks,Coffee,-5.50",
    ].join("\n");
    const res4 = parseCsvImport(csv4);
    expect(res4.headerError).toBeNull();
    expect(res4.rows).toHaveLength(2);
    expect(res4.rows[0]).toMatchObject({
      rowNumber: 1,
      date: "2026-08-01",
      payee: "Shell",
      memo: "Gas station",
      amountCents: -4210,
    });

    // 5 columns: Date, Payee, Memo, Outflow, Inflow
    const csv5 = [
      "2026-08-01,Shell,Gas station,42.10,",
      "2026-08-02,Employer,Payroll,,2500.00",
    ].join("\n");
    const res5 = parseCsvImport(csv5);
    expect(res5.headerError).toBeNull();
    expect(res5.rows).toHaveLength(2);
    expect(res5.rows[0]).toMatchObject({
      rowNumber: 1,
      date: "2026-08-01",
      payee: "Shell",
      memo: "Gas station",
      amountCents: -4210,
    });
    expect(res5.rows[1]).toMatchObject({
      rowNumber: 2,
      date: "2026-08-02",
      payee: "Employer",
      memo: "Payroll",
      amountCents: 250000,
    });
  });
});
