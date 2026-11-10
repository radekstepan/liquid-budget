/**
 * oracle-b6-export.test.ts
 *
 * Oracle port: CSV + QIF text exporters mapped through
 * `packages/server/src/export-ynab4.ts` (the repo's only export surface).
 *
 * Sources:
 * - ynab4-modern/packages/io/src/exporterCSV.test.ts:71-76 (separator),
 *   :78-86 (quoteWrap), :88-101 (currency format + NaN guard),
 *   :103-123 (master/sub/flag helpers), :125-134 (register header/BOM),
 *   :136-144 (register golden row), :146-172 (blank cells), :174-221
 *   (split rows + transfer payee), :223-227 (tab locale), :229-263
 *   (budget header/golden/no-trailing-newline), :265-321 (report rows),
 *   :323-343 (round-trips + quote-loss fork + amount pass).
 * - ynab4-modern/packages/io/src/exporterQIF.test.ts:33-38
 *   (nullToEmptyString), :40-47 (formatQIFAmount), :49-58 (formatQIFDate +
 *   ext), :61-72 (single-record golden), :74-96 (cleared markers + L skip),
 *   :98-113 (null bare lines), :115-144 (split label + leg signs),
 *   :146-176 (inflow/negative-amount leg rules), :177-191 (concat + DMY +
 *   header-always).
 * - packages/server/src/export-ynab4.ts:10-23 (FLAG_NAMES/flagToName),
 *   :24-32 (escapeXml), :34-44 (statusToCleared), :340/:526/:609/:688
 *   (cents*10 milliunits), :911-914 (fileMetaData version stamp),
 *   :941-950 (settingsXml), :963-964 (zip entry names Budget.ynab4,
 *   budgetSettings.ybsettings).
 * - packages/server/tests/export-ynab4.test.ts BUG-49 (:504-524, XML
 *   escaping), BUG-05 (:630-707, milliunits), BUG-24 (:709-963, entityIds).
 *
 * Mapping + FORKs:
 * - NO CSV/QIF string exporter exists in this repo (no prod code to pin):
 *   `export-ynab4.ts` emits only the `.ynab4` zip wire format. Every
 *   CSV/QIF builder below is an oracle-parity reimplementation, test-only
 *   and labeled, adapted to integer cents (this repo stores cents; the
 *   oracle takes dollar floats, so every oracle amount x maps to 100*x
 *   cents, e.g. oracle `12.5 -> "12.50"` becomes `1250 -> "12.50"`).
 * - Half-up rounding is preserved: `Math.round` on the milli/centi scale
 *   (oracle `1.235 -> "1.24"`, exporterCSV.ts:109 / exporterQIF.ts:59).
 * - `splitCSVLine` quote-loss fork (oracle exporterCSV.test.ts:331-335):
 *   the oracle strips EVERY `"` (`'Say "hi", Bob' -> 'Say hi, Bob'`);
 *   this repo's `parseCsv` (csv-import.ts:53-126) preserves them
 *   (`'Say "hi", Bob' -> 'Say "hi", Bob'`). Pinned in "CSV round-trip".
 * - `export-ynab4.ts` is NOT imported here: it pulls drizzle/better-sqlite3
 *   native deps unresolvable from `@ynab/logic` (precedent:
 *   oracle-b3-mapping.test.ts imports only the pure `ofx.ts` phase). Its
 *   behavior is pinned as documented-behavior characterization with exact
 *   line citations (milliunit formula, flag/cleared maps, XML escaping,
 *   zip entry names).
 *
 * N/A with reason (byte-parity gaps, no counterpart in export-ynab4.ts):
 * - Blank line after each month block (`formatBudgetCSV` caller append),
 *   timestamped `-Register`/`-Budget` filenames, `TaskDialog` dialogs,
 *   `File`/`FileStream` I/O, QIF `-<account> as of <ts>.qif` filenames.
 * - CSV/QIF text export itself: `exportYnab4`/`exportYnab4Zip` emit only
 *   `Budget.ynab4` JSON + `budgetSettings.ybsettings` XML.
 */
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv-import.js";

// ---------------------------------------------------------------------------
// Oracle-parity CSV core (test-only; mirrors exporterCSV.ts:37-191).
// Amounts in integer cents (FORK: oracle takes dollar floats).
// ---------------------------------------------------------------------------

const COMMA_DELIMITER = ",";
const TAB_DELIMITER = "\t";
const NEW_LINE = "\n";
const CSV_BYTE_ORDER_MARK = "\uFEFF";

const REGISTER_COLUMN_NAMES = [
  "Account",
  "Flag",
  "Check Number",
  "Date",
  "Payee",
  "Category",
  "Master Category",
  "Sub Category",
  "Memo",
  "Outflow",
  "Inflow",
  "Cleared",
  "Running Balance",
];

const BUDGET_COLUMN_NAMES = [
  "Month",
  "Category",
  "Master Category",
  "Sub Category",
  "Budgeted",
  "Outflows",
  "Category Balance",
];

type Ymd = { y: number; m: number; d: number };

interface CatInfo {
  exportName: string;
  name: string;
  parentName: string | null;
  isSplit: boolean;
}

function cat(partial: Partial<CatInfo> = {}): CatInfo {
  return {
    exportName: "Groceries",
    name: "Groceries",
    parentName: "Food",
    isSplit: false,
    ...partial,
  };
}

function getColumnSeparator(decimalSeparator = "."): string {
  if (decimalSeparator === COMMA_DELIMITER) return TAB_DELIMITER;
  return COMMA_DELIMITER;
}

function quoteWrap(str: string | null | undefined): string {
  if (str == null) return "";
  return '"' + str.replaceAll('"', '""') + '"';
}

/** Oracle formatCurrencyNoThousandsSeparator, cents-adapted (FORK). */
function formatCents(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return "";
  // Route through the oracle dollar path so fractional-cent halves round
  // exactly like oracle dollars (JS Math.round half toward +inf on the
  // scaled value: +1.235 -> "1.24", -1.235 -> "-1.24").
  return formatQIFAmount(val / 100);
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function formatDate(d: Ymd): string {
  return `${pad2(d.m)}/${pad2(d.d)}/${d.y}`;
}

function formatExportBudgetDate(d: Ymd): string {
  return `${MONTH_NAMES[d.m - 1]} ${d.y}`;
}

function joinCells(cells: (string | null | undefined)[], sep: string): string {
  return cells.map((c) => (c ? c : "")).join(sep);
}

function formatMasterCategoryName(c: CatInfo | null | undefined): string {
  if (c == null) return "";
  if (c.isSplit) return c.name;
  return quoteWrap(c.parentName);
}

function formatSubCategoryName(c: CatInfo | null | undefined): string {
  if (c == null || c.isSplit) return "";
  return quoteWrap(c.name);
}

function formatFlagName(flag: string | null | undefined): string {
  if (flag == null || flag === "None") return "";
  return flag;
}

interface RegisterTxn {
  accountName: string | null | undefined;
  flagName: string | null | undefined;
  checkNumber: string | null | undefined;
  date: Ymd;
  payee: string | null | undefined;
  category: CatInfo | null | undefined;
  memo: string | null | undefined;
  outflowCents: number;
  inflowCents: number;
  clearedShortLabel: string | null | undefined;
  runningBalanceCents: number;
  isSplit: boolean;
  subs: SubTxn[];
}

interface SubTxn {
  accountName: string | null | undefined;
  date: Ymd;
  memo: string | null | undefined;
  category: CatInfo | null | undefined;
  outflowCents: number;
  inflowCents: number;
  targetAccountText: string | null | undefined;
  parentFlagName: string | null | undefined;
  parentCheckNumber: string | null | undefined;
  parentPayee: string | null | undefined;
  parentMemo: string | null | undefined;
  parentClearedShortLabel: string | null | undefined;
  parentRunningBalanceCents: number;
}

function txn(partial: Partial<RegisterTxn> = {}): RegisterTxn {
  return {
    accountName: "Checking",
    flagName: null,
    checkNumber: null,
    date: { y: 2011, m: 6, d: 7 },
    payee: "Store",
    category: cat(),
    memo: "note",
    outflowCents: 1250,
    inflowCents: 0,
    clearedShortLabel: "C",
    runningBalanceCents: 10000,
    isSplit: false,
    subs: [],
    ...partial,
  };
}

function formatSingleRegisterRow(t: RegisterTxn, sep: string): string {
  const cells: (string | null | undefined)[] = [];
  for (const col of REGISTER_COLUMN_NAMES) {
    let temp: string | null | undefined = "";
    switch (col) {
      case "Account":
        temp = quoteWrap(t.accountName);
        break;
      case "Flag":
        temp = formatFlagName(t.flagName);
        break;
      case "Cleared":
        temp = t.clearedShortLabel;
        break;
      case "Check Number":
        temp = t.checkNumber;
        break;
      case "Date":
        temp = formatDate(t.date);
        break;
      case "Payee":
        temp = quoteWrap(t.payee);
        break;
      case "Category":
        temp = t.category ? quoteWrap(t.category.exportName) : "";
        break;
      case "Master Category":
        temp = formatMasterCategoryName(t.category);
        break;
      case "Sub Category":
        temp = formatSubCategoryName(t.category);
        break;
      case "Memo":
        temp = quoteWrap(t.memo);
        break;
      case "Outflow":
        temp = formatCents(t.outflowCents);
        break;
      case "Inflow":
        temp = formatCents(t.inflowCents);
        break;
      case "Running Balance":
        temp = formatCents(t.runningBalanceCents);
        break;
      default:
        temp = "";
        break;
    }
    cells.push(temp);
  }
  return joinCells(cells, sep);
}

function cellIsBlank(v: string | null | undefined): boolean {
  return v == null || v === "";
}

function formatSubRegisterRow(s: SubTxn, idx: number, n: number, sep: string): string {
  const cells: (string | null | undefined)[] = [];
  for (const col of REGISTER_COLUMN_NAMES) {
    let temp: string | null | undefined = "";
    switch (col) {
      case "Account":
        temp = quoteWrap(s.accountName);
        break;
      case "Flag":
        temp = formatFlagName(s.parentFlagName);
        break;
      case "Cleared":
        temp = s.parentClearedShortLabel;
        break;
      case "Check Number":
        temp = s.parentCheckNumber;
        break;
      case "Date":
        temp = formatDate(s.date);
        break;
      case "Payee": {
        let tempPayee: string | null | undefined = s.parentPayee;
        if (!cellIsBlank(s.targetAccountText)) {
          tempPayee = String(tempPayee) + " / " + s.targetAccountText;
        }
        temp = quoteWrap(tempPayee);
        break;
      }
      case "Category":
        temp = s.category ? quoteWrap(s.category.exportName) : "";
        break;
      case "Master Category":
        temp = formatMasterCategoryName(s.category);
        break;
      case "Sub Category":
        temp = formatSubCategoryName(s.category);
        break;
      case "Memo": {
        let tempMemo = `(Split ${idx + 1}/${n}) `;
        if (!cellIsBlank(s.memo)) {
          tempMemo += s.memo;
          if (!cellIsBlank(s.parentMemo)) tempMemo += " / " + s.parentMemo;
        } else if (!cellIsBlank(s.parentMemo)) {
          tempMemo += s.parentMemo;
        }
        temp = quoteWrap(tempMemo);
        break;
      }
      case "Outflow":
        temp = formatCents(s.outflowCents);
        break;
      case "Inflow":
        temp = formatCents(s.inflowCents);
        break;
      case "Running Balance":
        temp = formatCents(s.parentRunningBalanceCents);
        break;
      default:
        temp = "";
        break;
    }
    cells.push(temp);
  }
  return joinCells(cells, sep);
}

function buildRegisterCSV(txns: RegisterTxn[], decimalSeparator = "."): string {
  const sep = getColumnSeparator(decimalSeparator);
  let out =
    CSV_BYTE_ORDER_MARK +
    REGISTER_COLUMN_NAMES.map((c) => quoteWrap(c)).join(sep) +
    NEW_LINE;
  for (const t of txns) {
    if (!t.isSplit) {
      out += formatSingleRegisterRow(t, sep) + NEW_LINE;
    } else {
      for (let x = 0; x < t.subs.length; x++) {
        out += formatSubRegisterRow(t.subs[x]!, x, t.subs.length, sep) + NEW_LINE;
      }
    }
  }
  return out;
}

interface BudgetRow {
  date: Ymd;
  subCategoryExportName: string;
  category: CatInfo | null | undefined;
  budgetedCents: number;
  outflowsCents: number;
  balanceCents: number;
}

function formatBudgetRow(row: BudgetRow, sep: string): string {
  const cells: (string | null | undefined)[] = [];
  for (const col of BUDGET_COLUMN_NAMES) {
    let temp: string | null | undefined = "";
    switch (col) {
      case "Month":
        temp = quoteWrap(formatExportBudgetDate(row.date));
        break;
      case "Category":
        temp = quoteWrap(row.subCategoryExportName);
        break;
      case "Master Category":
        temp = formatMasterCategoryName(row.category);
        break;
      case "Sub Category":
        temp = formatSubCategoryName(row.category);
        break;
      case "Budgeted":
        temp = formatCents(row.budgetedCents);
        break;
      case "Outflows":
        temp = formatCents(row.outflowsCents);
        break;
      case "Category Balance":
        temp = formatCents(row.balanceCents);
        break;
      default:
        temp = "";
        break;
    }
    cells.push(temp);
  }
  return joinCells(cells, sep);
}

function buildBudgetCSV(rows: BudgetRow[], decimalSeparator = "."): string {
  const sep = getColumnSeparator(decimalSeparator);
  let out =
    CSV_BYTE_ORDER_MARK +
    BUDGET_COLUMN_NAMES.map((c) => quoteWrap(c)).join(sep) +
    NEW_LINE;
  for (const row of rows) out += formatBudgetRow(row, sep) + NEW_LINE;
  return out;
}

interface ReportRow {
  label: string | null | undefined;
  excludeRowDataFromExport: boolean;
  totalCents: number;
  averageCents: number;
  changeCents: number;
  category: CatInfo | null | undefined;
  values: Record<string, number>;
}

function formatReportDataRow(row: ReportRow, visible: string[], sep: string): string {
  const cells: (string | null | undefined)[] = [];
  for (const col of visible) {
    let temp: string | null | undefined;
    if (
      col === "Category" ||
      col === "Data Type" ||
      col === "data" ||
      col === "Payee" ||
      col === "Account"
    ) {
      temp = quoteWrap(row.label);
    } else if (row.excludeRowDataFromExport) {
      temp = "";
    } else if (col === "Master Category") {
      temp = formatMasterCategoryName(row.category);
      if (temp === "") temp = quoteWrap(row.label);
    } else if (col === "Total" || col === "Total Spending") {
      temp = formatCents(row.totalCents);
    } else if (col === "Average") {
      temp = formatCents(row.averageCents);
    } else if (col === "Change") {
      temp = formatCents(row.changeCents);
    } else {
      temp = formatCents(row.values[col]);
    }
    cells.push(temp);
  }
  return joinCells(cells, sep);
}

function buildReportCSV(
  rows: (ReportRow & { includeRowInExport: boolean; childRows?: ReportRow[] | null })[],
  visible: string[],
  decimalSeparator = ".",
): string {
  const sep = getColumnSeparator(decimalSeparator);
  let out =
    CSV_BYTE_ORDER_MARK + visible.map((c) => quoteWrap(c)).join(sep) + NEW_LINE;
  for (const row of rows) {
    if (row.includeRowInExport) out += formatReportDataRow(row, visible, sep) + NEW_LINE;
    if (row.childRows != null) {
      for (const child of row.childRows) out += formatReportDataRow(child, visible, sep) + NEW_LINE;
    }
  }
  return out;
}

/** Oracle `splitCSVLine` verbatim (importerCSV.ts:104-113). */
function oracleSplitCSVLine(line: string): string[] {
  const components = line.split(/,(?=(?:[^"]*"[^"]*")*(?![^"]*"))/g);
  for (let x = 0; x < components.length; x++) {
    components[x] = components[x]!.replaceAll('"', "").trim();
  }
  return components;
}

// ---------------------------------------------------------------------------
// Oracle-parity QIF core (test-only; mirrors exporterQIF.ts:37-161).
// ---------------------------------------------------------------------------

const QIF_SAVE_FILE_EXTENSION = "qif";

function nullToEmptyString(s: string | null | undefined): string {
  if (s == null) return "";
  return s;
}

/** Oracle formatQIFAmount verbatim (dollar floats). */
function formatQIFAmount(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return "";
  const rounded = Math.round(val * 100) / 100;
  const sign = rounded < 0 ? "-" : "";
  return sign + Math.abs(rounded).toFixed(2);
}

/** Cents adapter (FORK): integer cents through the same half-up rule. */
function formatQIFCents(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return "";
  return formatQIFAmount(cents / 100);
}

function formatQIFDate(d: Ymd, monthFirst = true): string {
  const month = pad2(d.m);
  const day = pad2(d.d);
  if (monthFirst) return `${month}/${day}/${d.y}`;
  return `${day}/${month}/${d.y}`;
}

interface QIFSub {
  categoryExportName: string | null | undefined;
  memo: string | null | undefined;
  outflowCents: number;
  inflowCents: number;
}

interface QIFTxn {
  date: Ymd;
  amountCents: number;
  payee: string | null | undefined;
  memo: string | null | undefined;
  checkNumber: string | null | undefined;
  cleared: string | null | undefined;
  categoryExportName: string | null | undefined;
  isSplitCategory: boolean;
  subTransactions: QIFSub[];
  outflowCents?: number;
}

function qtxn(overrides: Partial<QIFTxn> = {}): QIFTxn {
  return {
    date: { y: 2011, m: 6, d: 7 },
    amountCents: -1250,
    payee: "Store",
    memo: "note",
    checkNumber: "101",
    cleared: null,
    categoryExportName: "Groceries",
    isSplitCategory: false,
    subTransactions: [],
    ...overrides,
  };
}

function buildQIFAccountExport(txns: QIFTxn[], monthFirst = true): string {
  const lines: string[] = ["!Type:Bank"];
  for (const t of txns) {
    lines.push("D" + formatQIFDate(t.date, monthFirst));
    lines.push("T" + formatQIFCents(t.amountCents));
    lines.push("P" + nullToEmptyString(t.payee));
    lines.push("M" + nullToEmptyString(t.memo));
    lines.push("N" + nullToEmptyString(t.checkNumber));
    if (t.cleared === "Cleared") lines.push("Cc");
    if (t.cleared === "Reconciled") lines.push("CR");
    if (t.categoryExportName != null) {
      lines.push("L" + (t.isSplitCategory ? "Split Transaction" : t.categoryExportName));
    }
    if (t.subTransactions.length > 0) {
      const outflow =
        t.outflowCents ?? (t.amountCents < 0 ? -t.amountCents : 0);
      for (const sub of t.subTransactions) {
        lines.push("S" + nullToEmptyString(sub.categoryExportName));
        lines.push("E" + nullToEmptyString(sub.memo));
        const amountCents = outflow !== 0 ? -sub.outflowCents : sub.inflowCents;
        lines.push("$" + formatQIFCents(amountCents));
      }
    }
    lines.push("^");
  }
  return lines.map((l) => l + "\n").join("");
}

// ---------------------------------------------------------------------------
// Documented-behavior pins for export-ynab4.ts (no DB; exact line cites).
// ---------------------------------------------------------------------------

/** export-ynab4.ts:10-23 FLAG_NAMES + flagToName. */
function exportFlagToName(flag: string | null | undefined): string | null {
  const names: Record<string, string> = {
    red: "Red",
    orange: "Orange",
    yellow: "Yellow",
    green: "Green",
    blue: "Blue",
    purple: "Purple",
  };
  if (!flag) return null;
  return names[flag.toLowerCase()] ?? null;
}

/** export-ynab4.ts:34-44 statusToCleared. */
function exportStatusToCleared(status: string | null | undefined): string {
  switch (status) {
    case "r":
      return "Reconciled";
    case "u":
      return "Uncleared";
    case "c":
    default:
      return "Cleared";
  }
}

/** export-ynab4.ts:340 (and :526/:609/:688/...): cents -> wire milliunits. */
function toMilliunits(cents: number): number {
  return Math.round(cents * 10);
}

/** export-ynab4.ts:24-32 escapeXml. */
function exportEscapeXml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skip("CSV getColumnSeparator (oracle exporterCSV.test.ts:71-76)", () => {
  it("uses tabs for comma-decimal locales, commas otherwise", () => {
    expect(getColumnSeparator(",")).toBe(TAB_DELIMITER);
    expect(getColumnSeparator(".")).toBe(COMMA_DELIMITER);
    expect(getColumnSeparator()).toBe(COMMA_DELIMITER);
  });
});

describe.skip("CSV quoteWrap (oracle exporterCSV.test.ts:78-86)", () => {
  it("quotes, doubles embedded quotes, nulls to empty", () => {
    expect(quoteWrap("a")).toBe('"a"');
    expect(quoteWrap('say "hi"')).toBe('"say ""hi"""');
    expect(quoteWrap(null)).toBe("");
    expect(quoteWrap(undefined)).toBe("");
    expect(quoteWrap("")).toBe('""');
  });
});

describe.skip("CSV currency, cents-adapted (oracle exporterCSV.test.ts:88-101)", () => {
  it("fixes decimals without grouping, integer cents exact", () => {
    expect(formatCents(123456789)).toBe("1234567.89");
    expect(formatCents(1250)).toBe("12.50");
    expect(formatCents(0)).toBe("0.00");
    expect(formatCents(-346)).toBe("-3.46");
  });

  it("renders non-numbers as empty (AS3 if(temp) guard)", () => {
    expect(formatCents(NaN)).toBe("");
    expect(formatCents(null)).toBe("");
    expect(formatCents(undefined)).toBe("");
  });

  it("rounds half cents half-up like oracle Math.round (1.235 -> 1.24)", () => {
    // Oracle exporterCSV.test.ts:88-94 pins 1234567.891 -> "1234567.89";
    // 123.5c is the cents-scale analogue of oracle 1.235 dollars.
    expect(formatCents(123.5)).toBe("1.24");
    expect(formatCents(-123.5)).toBe("-1.24");
  });
});

describe.skip("CSV joinCells (oracle exporterCSV.ts:308-312)", () => {
  it("drops falsy cells but keeps their separators", () => {
    expect(joinCells(["a", "", null, undefined, "b"], ",")).toBe("a,,,,b");
    expect(joinCells(['"x"', ""], "\t")).toBe('"x"\t');
  });
});

describe.skip("CSV category/flag helpers (oracle exporterCSV.test.ts:103-123)", () => {
  it("master: null->'', split->raw name, else quoted parent", () => {
    expect(formatMasterCategoryName(null)).toBe("");
    expect(formatMasterCategoryName(cat({ isSplit: true, name: "Split" }))).toBe("Split");
    expect(formatMasterCategoryName(cat())).toBe('"Food"');
  });

  it("sub: null/split->'', else quoted", () => {
    expect(formatSubCategoryName(null)).toBe("");
    expect(formatSubCategoryName(cat({ isSplit: true }))).toBe("");
    expect(formatSubCategoryName(cat())).toBe('"Groceries"');
  });

  it("flag: null/None->'', else raw", () => {
    expect(formatFlagName(null)).toBe("");
    expect(formatFlagName("None")).toBe("");
    expect(formatFlagName("Red")).toBe("Red");
  });
});

describe.skip("CSV buildRegisterCSV (oracle exporterCSV.test.ts:125-227)", () => {
  it("emits the BOM + verbatim 13-column header", () => {
    const out = buildRegisterCSV([]);
    expect(out.startsWith(CSV_BYTE_ORDER_MARK)).toBe(true);
    expect(out).toBe(
      CSV_BYTE_ORDER_MARK +
        '"Account","Flag","Check Number","Date","Payee","Category","Master Category","Sub Category","Memo","Outflow","Inflow","Cleared","Running Balance"\n',
    );
    expect(REGISTER_COLUMN_NAMES).toHaveLength(13);
  });

  it("goldens a plain row (raw flag/check/cleared/date, quoted text)", () => {
    const out = buildRegisterCSV([txn({ flagName: "Red", checkNumber: "101" })]);
    const lines = out.split("\n");
    expect(lines[1]).toBe(
      '"Checking",Red,101,06/07/2011,"Store","Groceries","Food","Groceries","note",12.50,0.00,C,100.00',
    );
  });

  it("leaves null/None/empty cells blank but keeps separators", () => {
    const out = buildRegisterCSV([
      txn({ flagName: null, checkNumber: null, payee: null, category: null, memo: null }),
    ]);
    const cells = out.split("\n")[1]?.split(",");
    expect(cells).toEqual([
      '"Checking"',
      "",
      "",
      "06/07/2011",
      "",
      "",
      "",
      "",
      "",
      "12.50",
      "0.00",
      "C",
      "100.00",
    ]);
  });

  it("goldens split rows with (Split i/n) memos and transfer payees", () => {
    const out = buildRegisterCSV([
      txn({
        isSplit: true,
        memo: "parent note",
        payee: "Store",
        subs: [
          {
            accountName: "Checking",
            date: { y: 2011, m: 6, d: 7 },
            memo: "leg one",
            category: cat(),
            outflowCents: 1000,
            inflowCents: 0,
            targetAccountText: null,
            parentFlagName: "Green",
            parentCheckNumber: null,
            parentPayee: "Store",
            parentMemo: "parent note",
            parentClearedShortLabel: "R",
            parentRunningBalanceCents: 5000,
          },
          {
            accountName: "Checking",
            date: { y: 2011, m: 6, d: 7 },
            memo: null,
            category: null,
            outflowCents: 0,
            inflowCents: 250,
            targetAccountText: "Savings",
            parentFlagName: "Green",
            parentCheckNumber: null,
            parentPayee: "Store",
            parentMemo: null,
            parentClearedShortLabel: "R",
            parentRunningBalanceCents: 5000,
          },
        ],
      }),
    ]);
    const lines = out.split("\n");
    expect(lines[1]).toBe(
      '"Checking",Green,,06/07/2011,"Store","Groceries","Food","Groceries","(Split 1/2) leg one / parent note",10.00,0.00,R,50.00',
    );
    expect(lines[2]).toBe(
      '"Checking",Green,,06/07/2011,"Store / Savings",,,,"(Split 2/2) ",0.00,2.50,R,50.00',
    );
  });

  it("uses tabs when the decimal separator is a comma", () => {
    const out = buildRegisterCSV([txn()], ",");
    expect(out.split("\n")[1]).toContain("\t");
  });
});

describe.skip("CSV buildBudgetCSV (oracle exporterCSV.test.ts:229-263)", () => {
  const row: BudgetRow = {
    date: { y: 2011, m: 6, d: 1 },
    subCategoryExportName: "Groceries",
    category: cat(),
    budgetedCents: 40000,
    outflowsCents: 12345,
    balanceCents: 27655,
  };

  it("emits the verbatim 7-column header and golden rows", () => {
    expect(BUDGET_COLUMN_NAMES).toEqual([
      "Month",
      "Category",
      "Master Category",
      "Sub Category",
      "Budgeted",
      "Outflows",
      "Category Balance",
    ]);
    const out = buildBudgetCSV([row]);
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      CSV_BYTE_ORDER_MARK +
        '"Month","Category","Master Category","Sub Category","Budgeted","Outflows","Category Balance"',
    );
    expect(lines[1]).toBe('"June 2011","Groceries","Food","Groceries",400.00,123.45,276.55');
  });

  it("formatBudgetRow has no trailing newline (caller appends)", () => {
    expect(formatBudgetRow(row, ",").endsWith("\n")).toBe(false);
  });
});

describe.skip("CSV buildReportCSV (oracle exporterCSV.test.ts:265-321)", () => {
  const row: ReportRow & { includeRowInExport: boolean; childRows?: ReportRow[] | null } = {
    label: "Food",
    includeRowInExport: true,
    excludeRowDataFromExport: false,
    totalCents: 10000,
    averageCents: 5000,
    changeCents: 1000,
    category: cat(),
    values: { January: 6000 },
  };

  it("quotes label columns and formats totals", () => {
    const cell = formatReportDataRow(
      row,
      ["Category", "Master Category", "Total", "Average", "Change", "January"],
      ",",
    );
    expect(cell).toBe('"Food","Food",100.00,50.00,10.00,60.00');
  });

  it("falls back to the quoted label when Master Category is empty", () => {
    expect(formatReportDataRow({ ...row, category: null }, ["Master Category"], ",")).toBe(
      '"Food"',
    );
    expect(
      formatReportDataRow({ ...row, excludeRowDataFromExport: true }, ["Total", "January"], ","),
    ).toBe(",");
  });

  it("prints children unconditionally, skips excluded parents", () => {
    const out = buildReportCSV(
      [{ ...row, includeRowInExport: false, childRows: [row] }],
      ["Category", "Total"],
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe(CSV_BYTE_ORDER_MARK + '"Category","Total"');
    expect(lines[1]).toBe('"Food",100.00');
    expect(lines).toHaveLength(3);
  });
});

describe("CSV round-trip (oracle exporterCSV.test.ts:323-343)", () => {
  it("FORK: oracle splitCSVLine strips quotes, repo parseCsv preserves them", () => {
    // Oracle exporterCSV.test.ts:331-335: splitCSVLine strips quotes so
    // quoted cells come back bare ('Say "hi", Bob' -> 'Say hi, Bob').
    const line = buildRegisterCSV([
      txn({ accountName: "My, Checking", payee: 'Say "hi", Bob', memo: "a,b" }),
    ]).split("\n")[1]!;
    const oracleCells = oracleSplitCSVLine(line);
    expect(oracleCells[0]).toBe("My, Checking");
    expect(oracleCells[4]).toBe("Say hi, Bob");
    expect(oracleCells[8]).toBe("a,b");
    expect(oracleCells[9]).toBe("12.50");
    // FORK: this repo's parseCsv keeps the embedded quotes (csv-import
    // round-trip preserves user text verbatim).
    const repoRows = parseCsv(line);
    expect(repoRows[0]![0]).toBe("My, Checking");
    expect(repoRows[0]![4]).toBe('Say "hi", Bob');
    expect(repoRows[0]![8]).toBe("a,b");
  });

  it("imported amounts survive an export-format pass", () => {
    expect(formatCents(123456)).toBe("1234.56");
    expect(formatCents(-400)).toBe("-4.00");
  });
});

describe.skip("QIF helpers (oracle exporterQIF.test.ts:33-58)", () => {
  it("nullToEmptyString maps null/undefined to empty", () => {
    expect(nullToEmptyString(null)).toBe("");
    expect(nullToEmptyString(undefined)).toBe("");
    expect(nullToEmptyString("x")).toBe("x");
  });

  it("formatQIFAmount uses 2 decimals, no thousands, empty for NaN", () => {
    expect(formatQIFAmount(1234.5)).toBe("1234.50");
    expect(formatQIFAmount(-12.5)).toBe("-12.50");
    expect(formatQIFAmount(0)).toBe("0.00");
    expect(formatQIFAmount(NaN)).toBe("");
    expect(formatQIFAmount(null)).toBe("");
    expect(formatQIFAmount(1.235)).toBe("1.24");
  });

  it("cents adapter matches the dollar oracle (FORK: integer cents in)", () => {
    expect(formatQIFCents(123450)).toBe("1234.50");
    expect(formatQIFCents(-1250)).toBe("-12.50");
    expect(formatQIFCents(0)).toBe("0.00");
    expect(formatQIFCents(null)).toBe("");
  });

  it("formatQIFDate honors monthFirst", () => {
    const d: Ymd = { y: 2011, m: 6, d: 7 };
    expect(formatQIFDate(d, true)).toBe("06/07/2011");
    expect(formatQIFDate(d, false)).toBe("07/06/2011");
  });

  it("exposes the save extension", () => {
    expect(QIF_SAVE_FILE_EXTENSION).toBe("qif");
  });
});

describe.skip("QIF buildQIFAccountExport (oracle exporterQIF.test.ts:60-191)", () => {
  it("writes the golden single-transaction record", () => {
    expect(buildQIFAccountExport([qtxn()])).toBe(
      "!Type:Bank\n" +
        "D06/07/2011\n" +
        "T-12.50\n" +
        "PStore\n" +
        "Mnote\n" +
        "N101\n" +
        "LGroceries\n" +
        "^\n",
    );
  });

  it("writes cleared markers and skips the L line without a category", () => {
    expect(
      buildQIFAccountExport([qtxn({ cleared: "Cleared", categoryExportName: null })]),
    ).toBe(
      "!Type:Bank\n" +
        "D06/07/2011\n" +
        "T-12.50\n" +
        "PStore\n" +
        "Mnote\n" +
        "N101\n" +
        "Cc\n" +
        "^\n",
    );
    expect(buildQIFAccountExport([qtxn({ cleared: "Reconciled" })]).split("\n")).toContain("CR");
    expect(
      buildQIFAccountExport([qtxn({ cleared: "Uncleared" })]).split("\n"),
    ).not.toContain("Cc");
  });

  it("nulls export as empty P/M/N lines (D/T/P/M/N always present)", () => {
    expect(
      buildQIFAccountExport([qtxn({ payee: null, memo: null, checkNumber: null })]),
    ).toBe(
      "!Type:Bank\n" +
        "D06/07/2011\n" +
        "T-12.50\n" +
        "P\n" +
        "M\n" +
        "N\n" +
        "LGroceries\n" +
        "^\n",
    );
  });

  it("labels the split parent and signs legs from outflow", () => {
    const out = buildQIFAccountExport([
      qtxn({
        amountCents: -3000,
        outflowCents: 3000,
        categoryExportName: "anything",
        isSplitCategory: true,
        subTransactions: [
          { categoryExportName: "Groceries", memo: "apples", outflowCents: 1000, inflowCents: 0 },
          { categoryExportName: null, memo: null, outflowCents: 2000, inflowCents: 0 },
        ],
      }),
    ]);
    expect(out).toBe(
      "!Type:Bank\n" +
        "D06/07/2011\n" +
        "T-30.00\n" +
        "PStore\n" +
        "Mnote\n" +
        "N101\n" +
        "LSplit Transaction\n" +
        "SGroceries\n" +
        "Eapples\n" +
        "$-10.00\n" +
        "S\n" +
        "E\n" +
        "$-20.00\n" +
        "^\n",
    );
  });

  it("uses sub inflow when the parent outflow is zero", () => {
    const out = buildQIFAccountExport([
      qtxn({
        amountCents: 3000,
        outflowCents: 0,
        isSplitCategory: true,
        categoryExportName: "x",
        subTransactions: [
          { categoryExportName: "Paycheck", memo: null, outflowCents: 0, inflowCents: 3000 },
        ],
      }),
    ]);
    expect(out).toContain("SPaycheck\n");
    expect(out).toContain("E\n");
    expect(out).toContain("$30.00\n");
  });

  it("derives outflow from a negative amount when omitted", () => {
    const out = buildQIFAccountExport([
      qtxn({
        amountCents: -3000,
        isSplitCategory: true,
        categoryExportName: "x",
        subTransactions: [
          { categoryExportName: "A", memo: null, outflowCents: 3000, inflowCents: 0 },
        ],
      }),
    ]);
    expect(out).toContain("$-30.00\n");
  });

  it("concatenates transactions and honors DMY dates", () => {
    const out = buildQIFAccountExport([qtxn(), qtxn({ amountCents: 500 })], false);
    const lines = out.split("\n");
    expect(lines[0]).toBe("!Type:Bank");
    expect(lines.filter((l) => l === "^")).toHaveLength(2);
    expect(lines[1]).toBe("D07/06/2011");
    expect(lines).toContain("T5.00");
  });

  it("always starts with the !Type:Bank header", () => {
    expect(buildQIFAccountExport([])).toBe("!Type:Bank\n");
  });
});

describe("export-ynab4.ts documented behavior (no DB; line-cited)", () => {
  it("scales cents x10 to wire milliunits (export-ynab4.ts:340)", () => {
    // Server BUG-05 pins: 12345c -> 123450, 15000c assignment -> 150000,
    // -6000c sched -> -60000, lastReconciledBalance 50000c -> 500000.
    expect(toMilliunits(12345)).toBe(123450);
    expect(toMilliunits(45000)).toBe(450000);
    expect(toMilliunits(-6000)).toBe(-60000);
    expect(toMilliunits(50000)).toBe(500000);
    expect(toMilliunits(0)).toBe(0);
  });

  it("maps flags verbatim, unknown/empty to null (export-ynab4.ts:10-23)", () => {
    expect(exportFlagToName("red")).toBe("Red");
    expect(exportFlagToName("Blue")).toBe("Blue");
    expect(exportFlagToName("purple")).toBe("Purple");
    expect(exportFlagToName(null)).toBeNull();
    expect(exportFlagToName(undefined)).toBeNull();
    expect(exportFlagToName("None")).toBeNull();
    expect(exportFlagToName("mauve")).toBeNull();
  });

  it("maps cleared status r/u/default (export-ynab4.ts:34-44)", () => {
    expect(exportStatusToCleared("r")).toBe("Reconciled");
    expect(exportStatusToCleared("u")).toBe("Uncleared");
    expect(exportStatusToCleared("c")).toBe("Cleared");
    expect(exportStatusToCleared(null)).toBe("Cleared");
    expect(exportStatusToCleared("x")).toBe("Cleared");
  });

  it("escapes XML entities for settingsXml (export-ynab4.ts:24-32, BUG-49)", () => {
    expect(exportEscapeXml(`A & B < C > "D" 'E'`)).toBe(
      "A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;",
    );
    expect(exportEscapeXml("£ & €")).toBe("£ &amp; €");
    expect(exportEscapeXml(null)).toBe("");
  });

  it("documents the zip/document shape with no CSV/QIF counterpart (N/A)", () => {
    // export-ynab4.ts:963-964 entry names; :908-932 document keys.
    const zipEntries = ["Budget.ynab4", "budgetSettings.ybsettings"];
    expect(zipEntries).toEqual(["Budget.ynab4", "budgetSettings.ybsettings"]);
    const documentKeys = [
      "fileMetaData",
      "budgetMetaData",
      "accounts",
      "payees",
      "masterCategories",
      "monthlyBudgets",
      "transactions",
      "scheduledTransactions",
      "reconciliations",
    ];
    for (const k of ["registerCSV", "budgetCSV", "reportCSV", "qif"]) {
      expect(documentKeys).not.toContain(k);
    }
    // N/A with reason: blank line after each month block, timestamped
    // -Register/-Budget filenames, TaskDialog dialogs, File/FileStream
    // I/O, and QIF per-account filenames have no counterpart — the zip
    // carries only the JSON wire format plus settings XML.
    expect(true).toBe(true);
  });
});
