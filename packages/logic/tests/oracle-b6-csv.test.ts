/**
 * oracle-b6-csv.test.ts
 *
 * Oracle port: CSV import mapped through `packages/logic/src/csv-import.ts`
 * (`parseCsv` / `parseCsvImport` / `parseDate` / `parseAmount` /
 * `detectDateFormatDetailed` / `swapPayeeMemo`), `packages/logic/src/format.ts`
 * (`dollarsToCents` / `evalAmount`), `packages/logic/src/duplicates.ts`
 * (`duplicateFingerprint`), and `packages/server/src/import-csv.ts`
 * (`resolveImportCategory` / `importCsvTransactions`).
 *
 * Sources (42 tests):
 * - ynab4-modern/packages/io/src/importerCSV.test.ts:37-61 (splitCSVLine:
 *   plain split, commas-in-quotes, doubled-quote collapse, trim, empty fields).
 * - importerCSV.test.ts:63-90 (parseCSVContent: header mapping, blank skip,
 *   CRLF/CR, missing-column undefined + extras dropped, header-only []).
 * - importerCSV.test.ts:92-153 (convertCSVObjectsToImportTransactionVOs:
 *   Category/Payee/Memo/Check/Date mapping, drop no-Date, drop no-amounts,
 *   Inflow-Outflow, Amount precedence incl empty-Amount -> 0).
 * - importerCSV.test.ts:155-186 (parseCurrencyStringWithUnknownDecimalSeparator:
 *   grouped US, European last-sep-decimal, symbol strip + 2dp round, NaN
 *   passthrough).
 * - importerCSV.test.ts:188-237 (parseQIFDate/parseDateWithSequence: MDY/DMY/YMD
 *   slash, .-separators + 70 pivot, bare 6/8-digit + 2-part default + time-suffix
 *   quirk, verbatim "Invalid date: X", "Unknown date sequence").
 * - importerCSV.test.ts:239-267 (getValidDateSequencesForDateStrings +
 *   selectImportDateSequence: null/empty, order, garbage elimination,
 *   preferred-pick).
 * - importerCSV.test.ts:269-290 (formatCurrencyNoSymbol + assignYNABIDs:
 *   thousands grouping + 2dp, YNAB:amt:date:counter).
 * - importerCSV.test.ts:292-322 (buildCSVImport: resolve/pick/IDs, verbatim
 *   "Could not parse the dates in this file").
 * - importerCSV.test.ts:324-344 (getYNABFriendlyCategoryName: Misc prefix,
 *   colon collapse, blank -> null).
 * - importerCSV.test.ts:346-468 (applyCSVImport: assemble, payee/memo flip,
 *   importMemos=false + YNABID-dup skip + counts, Transfer rewrite).
 * - importerCSV.test.ts:470-478 (canImportFileExtension + "*.csv;" filter).
 * - importerCSV.test.ts:480-493 (createCSVObject positional, convert blank skip).
 * - packages/logic/tests/repro-csv-malformed.test.ts (NBSP grouping gap).
 * - packages/logic/tests/csv-import.test.ts (existing parseCsv/parseCsvImport/
 *   parseDate/parseAmount/swap coverage this file must not duplicate verbatim).
 *
 * Mapping: `splitCSVLine` -> `parseCsv` (whole-file grammar, not per-line);
 * `parseCSVContent` -> `parseCsv` + `parseCsvImport` header analysis;
 * `convertCSVObjects*` -> `parseCsvImport` row mapping + `error` rows;
 * `parseCurrencyString*` -> `parseAmount` + `dollarsToCents`/`evalAmount`;
 * `parseQIFDate`/`parseDateWithSequence` -> `parseDate` (+ `convention`
 * arg ~ sequence); `getValidDateSequences*`/`selectImportDateSequence` ->
 * `detectDateFormatDetailed` + `opts.dateFormat`; `formatCurrencyNoSymbol` ->
 * `fmt`; `assignYNABIDs` -> `duplicateFingerprint` (role, not format);
 * `buildCSVImport` -> `parseCsvImport` header/detection result;
 * `getYNABFriendlyCategoryName` -> `parseCsvImport` category passthrough +
 * server `resolveImportCategory`; `applyCSVImport` -> server
 * `importCsvTransactions` (documented, DB-backed, not executed here) +
 * `swapPayeeMemo`; `canImportFileExtension`/`CSV_FILE_FILTER` -> N/A
 * (UI `accept=".csv,text/csv,.txt"`); `createCSVObject`/convert skips ->
 * `parseCsv` + blank-skip in `parseCsvImport`.
 * // FORK: quote handling (RFC4180 `""` -> `"` vs oracle strip-all-quotes;
 * no trim in `parseCsv`, trim at import); pivot is `<70 -> 2000s`
 * (oracle `70 -> 2070`, ours `70 -> 1970`); integer-cents everywhere
 * (`parseAmount` -> `number|null`, `dollarsToCents` throws `TypeError` on
 * corrupt input, no NaN passthrough, no 2dp float layer); row drops become
 * `error` rows; `Amount` does NOT beat Outflow/Inflow (outflow wins) and
 * empty-Amount falls through (oracle: present-but-empty Amount -> 0);
 * Inflow+Outflow are alternatives, never combined; bare 6/8-digit dates,
 * 2-part default-year, and time-suffix quirk unsupported (-> null); text-month
 * dates like "June 7 2011" parse (oracle throws); no sequence param /
 * verbatim throws; no `checkNumber`, `importMemos`, Transfer-rewrite,
 * `*.csv;` filter, or store-assembly counts here.
 */
import { describe, expect, it } from "vitest";
import {
  detectDateFormat,
  detectDateFormatDetailed,
  parseAmount,
  parseCsv,
  parseCsvImport,
  parseDate,
} from "../src/csv-import.js";
import { duplicateFingerprint } from "../src/duplicates.js";
import { dollarsToCents, evalAmount, fmt } from "../src/format.js";

describe("oracle B6 splitCSVLine -> parseCsv quoting/trim/empty", () => {
  it("keeps commas inside quotes (oracle importerCSV.test.ts:46-48)", () => {
    expect(parseCsv('"Doe, John",12.50')).toEqual([["Doe, John", "12.50"]]);
  });

  it("unescapes RFC4180 doubled quotes (FORK: oracle :50-52 strips all -> 'Say hi')", () => {
    // Oracle `splitCSVLine('"Say ""hi""",x')` -> ["Say hi", "x"]
    // (AS3 replaceAll collapses every quote). Ours keeps the escaped quote.
    expect(parseCsv('"Say ""hi""",x')).toEqual([['Say "hi"', "x"]]);
  });

  it("treats mid-field quotes as literal characters (no strip)", () => {
    expect(parseCsv('2023-01-01,Store "A",50.00')).toEqual([
      ["2023-01-01", 'Store "A"', "50.00"],
    ]);
  });

  it("preserves surrounding whitespace at parseCsv level, trims at import level (FORK: oracle :54-56 trims in split)", () => {
    expect(parseCsv("  a  ,  b ")).toEqual([["  a  ", "  b "]]);
    const { rows } = parseCsvImport("Date,Payee,Amount\n 2026-08-01 , Store , -5.00 \n");
    expect(rows[0]).toMatchObject({ date: "2026-08-01", payee: "Store", amountCents: -500 });
  });

  it("keeps empty fields and throws unclosed quotes with line number", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
    expect(() => parseCsv('a,b\n"unclosed,c')).toThrow("Unclosed quote in CSV on line 2");
  });
});

describe("oracle B6 parseCSVContent -> header/blank/CRLF/missing/header-only", () => {
  it("maps header to rows and skips blank lines, keeping source rowNumbers (oracle :64-72)", () => {
    const { headerError, rows } = parseCsvImport(
      "Date,Payee,Amount\n06/07/2011,Store,12.50\n\n06/08/2011,Mall,3.00\n"
    );
    expect(headerError).toBeNull();
    expect(rows.map((r) => [r.rowNumber, r.payee])).toEqual([[2, "Store"], [4, "Mall"]]);
  });

  it("normalizes CRLF and CR newlines (oracle :74-80)", () => {
    expect(parseCsv("A,B\r\n1,2\r3,4")).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
  });

  it("maps short rows to Invalid-amount error rows and drops extras (FORK: oracle :82-85 yields undefined/dropped cells)", () => {
    const { rows } = parseCsvImport("Date,Payee,Amount\n2026-08-01,S\n2026-08-02,T,1.00,EXTRA\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amountCents: null, error: "Invalid amount" });
    expect(rows[1]).toMatchObject({ amountCents: 100, error: null });
  });

  it("returns no rows for header-only content; empty file is a headerError", () => {
    const headerOnly = parseCsvImport("Date,Payee,Amount\n");
    expect(headerOnly.headerError).toBeNull();
    expect(headerOnly.rows).toEqual([]);
    expect(parseCsvImport("").headerError).toBe("The file is empty");
  });
});

describe("oracle B6 convertCSVObjects -> amountCents/outflow-inflow/date mapping", () => {
  it("maps Category/Payee/Memo/Date and signs Amount in cents (oracle :93-113)", () => {
    const { rows } = parseCsvImport(
      "Date,Payee,Category,Memo,Amount\n06/07/2011,Store,Food : Groceries,weekly,12.50\n"
    );
    expect(rows).toHaveLength(1);
    // Single ambiguous date defaults to dmy (detection needs a disambiguating row).
    expect(rows[0]).toMatchObject({
      date: "2011-07-06",
      payee: "Store",
      memo: "weekly",
      category: "Food : Groceries",
      amountCents: 1250,
      error: null,
    });
  });

  it("drops the Check/Check-number column: no analogue on CsvImportRow (FORK)", () => {
    const { rows } = parseCsvImport("Date,Payee,Check,Amount\n06/07/2011,Store,101,12.50\n");
    expect(rows[0]).toMatchObject({ payee: "Store", amountCents: 1250 });
    expect(rows[0]).not.toHaveProperty("checkNumber");
  });

  it("keeps no-Date rows with an Invalid-date error (FORK: oracle :115-122 drops them)", () => {
    const { rows } = parseCsvImport("Date,Payee,Amount\n,NoDate,5.00\n2026-08-01,S,5.00\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: null, amountCents: 500, error: "Invalid date" });
    expect(rows[1]!.error).toBeNull();
  });

  it("keeps no-amount rows with an Invalid-amount error (FORK: oracle :124-131 drops them)", () => {
    const { rows } = parseCsvImport("Date,Payee,Amount\n2026-08-01,S,\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCents: null, error: "Invalid amount" });
  });

  it("signs Inflow-only positive and Outflow-only negative; both present -> outflow wins (FORK: oracle :133-140 computes Inflow-Outflow = -7)", () => {
    const { rows } = parseCsvImport(
      "Date,Payee,Outflow,Inflow\n2026-08-01,A,,7.25\n2026-08-02,B,4.50,\n2026-08-03,C,10.00,3.00\n"
    );
    expect(rows[0]).toMatchObject({ amountCents: 725, error: null });
    expect(rows[1]).toMatchObject({ amountCents: -450, error: null });
    // Oracle: 3.00 - 10.00 = -7.00. Ours never combines the columns.
    expect(rows[2]).toMatchObject({ amountCents: -1000, error: null });
  });

  it("prefers Outflow over Amount and falls through on empty cells (FORK: oracle :142-152 prefers Amount; empty Amount -> 0 beats Inflow)", () => {
    const { rows } = parseCsvImport(
      "Date,Payee,Amount,Outflow,Inflow\n2026-08-01,A,5.00,100.00,100.00\n2026-08-02,B,,,7.00\n"
    );
    // Oracle row 1 -> 5 (Amount wins). Ours: outflow wins.
    expect(rows[0]).toMatchObject({ amountCents: -10000, error: null });
    // Oracle row 2 -> 0 (present-but-empty Amount parses via Number("")). Ours falls through.
    expect(rows[1]).toMatchObject({ amountCents: 700, error: null });
  });
});

describe("oracle B6 parseCurrencyString* -> parseAmount/dollarsToCents matrix", () => {
  it("parses plain and grouped US amounts (oracle :156-161)", () => {
    expect(parseAmount("12.50")).toBe(12.5);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(dollarsToCents("1,234.56")).toBe(123456);
  });

  it("treats the last separator as decimal for European input (oracle :163-174)", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1234,56")).toBe(1234.56);
    expect(dollarsToCents("1.234,56")).toBe(123456);
  });

  it("strips currency symbols and spaces then rounds at the cents boundary (oracle :176-181)", () => {
    expect(parseAmount("$1 234.56")).toBe(1234.56);
    expect(parseAmount("-5.00")).toBe(-5);
    // Oracle parseCurrencyString rounds to 2dp (1234.57); parseAmount keeps
    // full precision and the rounding lands in dollarsToCents instead.
    expect(parseAmount("1 234.567")).toBe(1234.567);
    expect(dollarsToCents(1234.567)).toBe(123457);
  });

  it("returns null / throws on garbage (FORK: oracle :183-185 passes NaN through)", () => {
    expect(parseAmount("abc")).toBeNull();
    expect(evalAmount("abc")).toBeNull();
    expect(() => dollarsToCents("abc")).toThrow(TypeError);
  });
});

describe("oracle B6 parseQIFDate/parseDateWithSequence -> parseDate matrix", () => {
  it("parses MDY/DMY slash dates and YMD regardless of convention (oracle :189-199)", () => {
    expect(parseDate("06/07/2011", "mdy")).toBe("2011-06-07");
    expect(parseDate("06/07/2011", "dmy")).toBe("2011-07-06");
    expect(parseDate("2011/06/07", "mdy")).toBe("2011-06-07");
  });

  it("folds dot/dash separators and pivots 2-digit years (oracle :201-206)", () => {
    expect(parseDate("06.07.11", "mdy")).toBe("2011-06-07");
    expect(parseDate("06-07-71", "mdy")).toBe("1971-06-07");
    expect(parseDate("06-07-69", "mdy")).toBe("2069-06-07");
  });

  it("pivots 70 to 1900s (FORK: oracle :204 maps 70 -> 2070)", () => {
    // Ours (csv-import.ts:195-200): y < 70 -> 2000s, else 1900s.
    expect(parseDate("06-07-70", "mdy")).toBe("1970-06-07");
    expect(parseDate("01/12/70", "dmy")).toBe("1970-12-01");
  });

  it("rejects bare 6/8-digit forms, 2-part dates, and time suffixes (FORK: oracle :208-221 parses/defaults/quirk-parses)", () => {
    expect(parseDate("060711", "mdy")).toBeNull();
    expect(parseDate("20110607", "mdy")).toBeNull();
    expect(parseDate("06/07", "mdy")).toBeNull();
    expect(parseDate("06/07/201 10:00", "mdy")).toBeNull();
  });

  it("parses text-month dates that the oracle rejects, and returns null (never throws) on garbage (FORK: oracle :223-236 verbatim 'Invalid date: X' / 'Unknown date sequence')", () => {
    expect(parseDate("June 7 2011", "mdy")).toBe("2011-06-07");
    expect(parseDate("not a date", "mdy")).toBeNull();
    expect(parseDate("", "mdy")).toBeNull();
    expect(parseDate("6071", "mdy")).toBeNull();
    // No sequence param exists: convention is the "dmy" | "mdy" union, so
    // there is no "Unknown date sequence" analogue.
  });
});

describe("oracle B6 sequences -> detectDateFormatDetailed + dateFormat option", () => {
  it("votes per file and flags ties/ambiguity like getValidDateSequences (oracle :239-260)", () => {
    const rows = [["Date", "Payee", "Amount"], ["13/08/2026", "S", "-1.00"], ["05/13/2026", "T", "-2.00"]];
    const detail = detectDateFormatDetailed(rows, 0, 0);
    expect(detail.dmyVotes).toBe(1);
    expect(detail.mdyVotes).toBe(1);
    expect(detail.convention).toBe("dmy");
    expect(detail.ambiguous).toBe(true);
  });

  it("prefers the explicit dateFormat option over auto-detection (oracle selectImportDateSequence :262-267)", () => {
    const csv = "Date,Payee,Amount\n03/05/2026,A,-10.00\n04/06/2026,B,-20.00\n";
    expect(parseCsvImport(csv).detectedDateFormat).toBe("dmy");
    expect(parseCsvImport(csv, { dateFormat: "mdy" }).detectedDateFormat).toBe("mdy");
    expect(parseCsvImport(csv, { dateFormat: "mdy" }).rows[0]!.date).toBe("2026-03-05");
  });

  it("detects MDY from month-first text dates and ignores ISO rows when voting", () => {
    const rows = [["Date", "Payee", "Amount"], ["Aug 15, 2026", "S", "-1.00"], ["08/05/2026", "T", "-2.00"]];
    expect(detectDateFormat(rows, 0, 0)).toBe("mdy");
  });
});

describe("oracle B6 formatCurrencyNoSymbol/assignYNABIDs -> fmt + duplicateFingerprint", () => {
  it("groups thousands with a symbol (FORK: oracle :270-274 formatCurrencyNoSymbol has no symbol; NaN -> '')", () => {
    expect(fmt(123450)).toBe("$1,234.50");
    expect(fmt(-700)).toBe("-$7.00");
    // No NaN -> "" analogue: fmt coerces via Math.round (fmt(NaN) -> "$NaN").
  });

  it("builds an exact-match identity per account+date+amount+payee+memo (role analogue of YNAB:amt:date:counter, oracle :276-289)", () => {
    const fp = (payee: string) =>
      duplicateFingerprint({ accountId: 1, date: "2011-06-07", amount: 1250, payee, memo: "" });
    expect(fp("a")).toBe(fp("A "));
    expect(fp("a")).not.toBe(fp("b"));
    // No per-amount:date counter or thousands-formatted amount: identity is
    // a JSON array and server matching is rename-rule-aware matchAndConsume.
  });
});

describe("oracle B6 buildCSVImport -> headerError mapping", () => {
  it("resolves dates per file convention and reports per-column headerErrors (FORK: no verbatim 'Could not parse the dates in this file', oracle :314-321)", () => {
    const built = parseCsvImport("Date,Payee,Amount\n06/07/2011,Store,12.50\n06/08/2011,Mall,-4.00\n");
    expect(built.headerError).toBeNull();
    expect(built.rows.map((r) => r.date)).toEqual(["2011-07-06", "2011-08-06"]);
    expect(parseCsvImport("Payee,Amount\nS,5.00\n").headerError).toMatch(/Date/);
    expect(parseCsvImport("Date,Amount\n2026-08-01,5.00\n").headerError).toMatch(/Payee/);
    expect(parseCsvImport("Date,Payee\n2026-08-01,S\n").headerError).toMatch(/Amount|Outflow/);
  });
});

describe("oracle B6 getYNABFriendlyCategoryName -> category passthrough", () => {
  it("keeps compound category names verbatim for server resolution (FORK: no Misc-prefix or colon collapse, oracle :324-344)", () => {
    const { rows } = parseCsvImport("Date,Payee,Category,Amount\n2026-08-01,S,Food : Groceries,-5.00\n");
    expect(rows[0]!.category).toBe("Food : Groceries");
    // Server resolveImportCategory (server/src/import-csv.ts:39-103) matches
    // exact / "Group: Cat" compound / case-insensitive or null when ambiguous;
    // it never synthesizes a "Misc : X" prefix, never rewrites "A:B:C", and
    // blank input resolves to null (uncategorized), not to a friendly name.
    const { rows: blank } = parseCsvImport("Date,Payee,Amount\n2026-08-01,S,-5.00\n");
    expect(blank[0]!.category).toBe("");
  });
});

describe("oracle B6 applyCSVImport -> server import behavior + swap", () => {
  it("flips payee/memo only when explicitly asked (FORK: oracle :409-415 flips automatically when the batch has memos but no payees)", () => {
    const csv = "Date,Payee,Memo,Amount\n2026-08-01,,Store,-5.00\n";
    expect(parseCsvImport(csv).rows[0]).toMatchObject({ payee: "", memo: "Store" });
    const { rows } = parseCsvImport(csv, { swap: true });
    expect(rows[0]).toMatchObject({ payee: "Store", memo: "" });
    expect(rows[0]!.error).toBeNull();
  });

  it("always keeps memos and transfer-style payees verbatim (FORK: no importMemos=false, no 'Transfer (X)' rewrite, oracle :417-467)", () => {
    const { rows } = parseCsvImport(
      "Date,Payee,Memo,Amount\n2026-08-01,Transfer : Savings,note,-5.00\n"
    );
    expect(rows[0]).toMatchObject({ payee: "Transfer : Savings", memo: "note" });
    // Server importCsvTransactions (server/src/import-csv.ts:105-300): skips
    // error/zero-amount rows into `skipped`, dedups via fingerprint
    // ("Matches an existing transaction"), inserts the rest as status "u"
    // with needsReview — returning {count, skipped}, not YNAB4's
    // {numTransactions, numNew, numMatched, numSkippedDuplicate}.
  });
});

describe("oracle B6 canImportFileExtension/filter + createCSVObject units", () => {
  it("parses the same text regardless of file extension (FORK: no canImport helper or '*.csv;' filter, oracle :470-478)", () => {
    // The only extension gate in-repo is the UI accept list
    // (Inspector.tsx:265 `accept=".csv,text/csv,.txt"`); the parser itself
    // is extension-agnostic.
    const a = parseCsvImport("Date,Payee,Amount\n2026-08-01,S,-5.00\n");
    expect(a.headerError).toBeNull();
    expect(a.rows[0]).toMatchObject({ amountCents: -500 });
  });

  it("maps short rows positionally and skips blank lines (oracle :480-493)", () => {
    expect(parseCsv("1\n")[0]).toEqual(["1"]);
    const { rows } = parseCsvImport("Date,Payee,Amount\n   \n2026-08-01,S,-5.00\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rowNumber: 3, payee: "S" });
  });
});
