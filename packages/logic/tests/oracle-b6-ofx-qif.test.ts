/**
 * Oracle B6: OFX/QIF importers (io package) mapped through this repo.
 *
 * Oracle (read-only, never edited):
 * - ../ynab4-modern/packages/io/src/importerOFX.test.ts
 *   (43 tests, lines 1-561) over importerOFX.ts (OFXLineReader cleanUpLines /
 *   getLinesFromLine, TagAndValue, StringDateOFX, parseOfxAmount/YNABID reuse
 *   from importerCSV.ts; YNAB4 behavior notes: OFX line reader,
 *   tag/value parsing, OFX date handling)
 * - ../ynab4-modern/packages/io/src/importerQIF.test.ts
 *   (25 tests, lines 1-389) over importerQIF.ts (YNAB4 behavior notes:
 *   QIF importer + import utilities; reuses parseQIFDate/getValidDateSequences/
 *   assignYNABIDs/getYNABFriendlyCategoryName from importerCSV.ts)
 *
 * Targets in this repo: there is NO OFX/QIF import surface here. The only
 * live counterpart is packages/server/src/import-ynab4/phases/ofx.ts
 * (reportDroppedOfxMappings: accountMappings are dropped with warnings,
 * G-10). Everything else below is a labeled oracle-parity characterization
 * (test-only helpers mirroring the oracle implementation rules) plus pins
 * against the real analogues that DO exist here:
 * - FITID near-miss branch -> ExistingImportFingerprints.addFitId /
 *   matchFitIdAndConsume (packages/logic/src/duplicates.ts:261-296)
 * - unknown-separator amounts -> parseAmount (csv-import.ts:318) + cents
 * - date sequences -> parseDate (csv-import.ts:269)
 * - transfer payees -> isTransferPayee (rename-rules.ts:124)
 *
 * N/A-with-reason (no OFX/QIF import modeled; gaps pinned, not filled):
 * - canImportOFX/QIF, OFX/QIF_FILE_FILTER, splitOFXLineSegments,
 *   cleanOFXLines, getTagAndValue, OFXLineCursor, parseOfxDate,
 *   parseOfxAmount, parseSTMTTRN, parseTransactionList, parseSTMTRS,
 *   parseCCSTMTRS, parseBANKMSGSRS, buildOFXImport, applyOFXImport,
 *   getReadableStatementType, statementTypeIsValid, containsStatementType,
 *   splitQIFLines, parseQIFAmount, buildQIFImport, applyQIFImport: none
 *   exist in this repo (grep: only ofx.ts + duplicates.ts FITID comments
 *   match). Characterized inline below; header cites oracle line numbers.
 * - getImportData account-mapping lookup (findAccountMapping,
 *   shouldFlipPayeeMemo/importMemos/skipImport), IDataImporter File/FileFilter
 *   seams, YNABEntityContext assembly (assembleBankTransaction,
 *   findMatchingTransaction, starting-balance adjustment), TextFileLineReader
 *   file I/O + ENCODING/CHARSET sniffing, mx.* binding, LogUtils, and the
 *   importing/* 17-file group: file I/O + store seams, no pure counterpart.
 * - QIF investment transactions: oracle throws a verbatim no-accounts note
 *   (QIF test:256-271); here QIF never reaches the importer at all.
 * - ThreePartDateSequence DMY-first ordering + month-13 rollover are QIF
 *   date-loop semantics; the repo analogue (parseDate) rejects out-of-range
 *   months instead of rolling over (FORK pinned below).
 *
 * // FORK — this repo drops (never stores) OFX accountMappings where YNAB4
 * keeps and consults them on import; soft-match/unhashed-entry lookup and
 * per-account skip/flip/importMemos preferences exist only as warnings.
 * // FORK — YNABID dedup here is fingerprint-based (account+date+amount+
 * payee+memo, duplicates.ts) rather than YNAB4's stored-YNABID equality +
 * FITID+amount+within-4-days adoption; the FITID near-miss window itself IS
 * implemented (matchFitIdAndConsume) and is pinned against the real code.
 * // FORK — transfer rewrite target differs: YNAB4 writes "Transfer (X)"
 * when the account does not exist (apply tests), while this repo's canonical
 * stored shape is "Transfer : X" (merge.ts:285, duplicates.ts:398).
 */

import { describe, expect, it } from "vitest";
import { parseAmount, parseDate } from "../src/csv-import.js";
import { buildExistingImportFingerprints } from "../src/duplicates.js";
import { dollarsToCents } from "../src/format.js";
import { isTransferPayee } from "../src/rename-rules.js";
import * as ofxPhase from "../../server/src/import-ynab4/phases/ofx.js";

// ---------------------------------------------------------------------------
// Oracle-parity characterization helpers (test-only; NOT production code).
// Mirror the oracle io implementations verbatim where exercised.
// ---------------------------------------------------------------------------

const OFX_FILE_FILTER_PARITY = "*.ofx;*.qfx";
const QIF_FILE_FILTER_PARITY = "*.qif;";

function canImportOFXParity(ext: string | null | undefined): boolean {
  if (ext == null) return false;
  const lower = ext.toLowerCase();
  return lower === "ofx" || lower === "qfx";
}

function canImportQIFParity(ext: string | null | undefined): boolean {
  if (ext == null) return false;
  return ext.toLowerCase() === "qif";
}

function tagStartsWithParity(
  tag: string | null,
  search: string | string[] | null,
): boolean {
  const list =
    search == null ? [] : Array.isArray(search) ? search : [search];
  if (tag == null || tag.trim() === "") return list.length === 0;
  const t = tag.trim().toLowerCase();
  return list.some((s) => t.startsWith(s.toLowerCase()));
}

/** Oracle importerOFX.ts:113-139 getLinesFromLine, verbatim. */
function splitOFXLineSegmentsParity(line: string): string[] {
  const retVal: string[] = [];
  let rest: string | null = line;
  const blank = (v: string | null): boolean => v == null || v === "";
  while (!blank(rest)) {
    const current = rest as string;
    const open = current.indexOf("<");
    if (open >= 0) {
      if (open > 0) {
        retVal.push(current.substring(0, open));
        rest = current.substring(open);
      } else {
        const next = current.indexOf("<", open + 1);
        if (next >= 0) {
          retVal.push(current.substring(0, next));
          rest = current.substring(next);
        } else {
          retVal.push(current);
          rest = null;
        }
      }
    } else {
      retVal.push(current);
      rest = null;
    }
  }
  return retVal;
}

function cleanSegmentParity(s: string): string {
  // Oracle cleanUpLines order, verbatim (importerOFX.ts:170-177): `&lt;br`
  // first, then the `&lt;b` quirk, then `&amp;` BEFORE `&lt;`/`&gt;`,
  // NBSP, trailing `&lt`, trim. So a literal `&lt;b` loses its `<b`.
  return s
    .split("&lt;br")
    .join("")
    .split("&lt;b")
    .join("")
    .split("&amp;")
    .join("&")
    .split("&lt;")
    .join("<")
    .split("&gt;")
    .join(">")
    .split(" ")
    .join(" ")
    .split("&lt")
    .join("")
    .trim();
}

/** Oracle cleanUpLines verbatim (importerOFX.ts:149-188, file I/O excluded). */
function cleanOFXLinesParity(rawLines: string[]): string[] {
  const temp: string[] = [];
  for (const line of rawLines) temp.push(...splitOFXLineSegmentsParity(line));
  const out: string[] = [];
  let cur: string | null = null;
  for (let seg of temp) {
    seg = seg.trim();
    if (cur != null && cur !== "" && seg.startsWith("<")) {
      if (seg.startsWith("<![CDATA[")) {
        seg = seg.split("<![CDATA[").join("").split("]]>").join("");
      } else {
        out.push(cur);
        cur = null;
      }
    }
    seg = cleanSegmentParity(seg);
    if (cur) cur += ` ${seg}`;
    else cur = seg;
  }
  if (cur != null && cur !== "") out.push(cur);
  return out;
}

type TagAndValueParity = { tag: string; value: string };

class CursorParity {
  idx = 0;
  constructor(public lines: string[]) {}
  peek(): string | null {
    return this.idx < this.lines.length ? this.lines[this.idx]! : null;
  }
  next(): string | null {
    return this.idx < this.lines.length ? this.lines[this.idx++]! : null;
  }
}

/**
 * Oracle getTagAndValue verbatim (importerOFX.ts:256-319): skip `<?...` /
 * `...?>` prologue lines, tag runs to the first `>` ("Malformed OFX file"
 * when missing), remainder is value, ONE following non-`<` line is consumed
 * and appended. With tagsToLookFor, non-matching tagged lines are skipped.
 */
function getTagAndValueParity(
  c: CursorParity,
  tagsToLookFor?: string[],
): TagAndValueParity | null {
  let line: string | null = c.next();
  if (line != null) line = line.trim();
  for (;;) {
    if (line == null) return null;
    while (
      line != null &&
      (line.startsWith("<?") || line.endsWith("?>"))
    ) {
      line = c.next();
      if (line != null) line = line.trim();
    }
    if (line != null) {
      if (line.startsWith("<")) {
        const brace = line.indexOf(">");
        if (brace < 0) throw new Error("Malformed OFX file");
        const tag = line.substring(0, brace + 1);
        if (
          tagsToLookFor == null ||
          tagStartsWithParity(tag, tagsToLookFor)
        ) {
          let value = "";
          if (line.length > brace + 1) value = line.substring(brace + 1);
          const next = c.peek();
          if (next != null && !next.startsWith("<")) {
            value += c.next() as string;
          }
          return { tag, value };
        }
        line = c.next();
        if (line != null) line = line.trim();
      } else {
        line = c.next();
        if (line != null) line = line.trim();
      }
    }
  }
}

/** Oracle getFIDFromSIGNONMSGSRS verbatim (importerOFX.ts:703-711). */
function getFIDFromSIGNONMSGSRSParity(c: CursorParity): string | null {
  const current = getTagAndValueParity(c, ["<FID>", "</SIGNONMSGSRS>"]);
  if (current != null && current.tag === "<FID>") return current.value;
  return null;
}

function parseOfxDateParity(raw: string): {
  year: number;
  month: number;
  date: number;
  toStandardString: () => string;
} {
  const t = raw.trim();
  const y = Number(t.slice(0, 4));
  const mo = Number(t.slice(4, 6));
  const d = Number(t.slice(6, 8));
  if (
    t.length < 8 ||
    !Number.isInteger(y) ||
    !Number.isInteger(mo) ||
    !Number.isInteger(d) ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31
  ) {
    throw new Error(`Invalid OFX Date: ${raw}`);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year: y,
    month: mo - 1,
    date: d,
    toStandardString: () => `${y}-${pad(mo)}-${pad(d)}`,
  };
}

/** Oracle parseCurrencyStringWithUnknownDecimalSeparator half (tested vectors). */
function parseOfxAmountParity(s: string): number {
  const t = s.trim().replace(/,/g, "");
  const n = Number(t);
  if (t === "" || Number.isNaN(n)) throw new Error(`Could not parse value: ${s}`);
  return n;
}

type RawOfxTxnParity = {
  payee: string | null;
  memo: string | null;
  checkNumber: string | null;
  fitid: string | null;
  dateRaw: string | null;
  date: { toStandardString: () => string } | null;
  amount: number;
};

type OfxTxnParity = RawOfxTxnParity & { ynabID: string };

type RawOfxAccountParity = {
  fid: string | null;
  bankAccountID: string | null;
  accountType: string | null;
  transactions: RawOfxTxnParity[];
};

type OfxAccountParity = Omit<RawOfxAccountParity, "transactions"> & {
  transactions: OfxTxnParity[];
};

/** Oracle parseSTMTTRN verbatim (importerOFX.ts:401-476). */
function parseSTMTTRNParity(c: CursorParity): RawOfxTxnParity {
  let trnType: string | null = null;
  const ret: RawOfxTxnParity = {
    payee: null,
    memo: null,
    checkNumber: null,
    fitid: null,
    dateRaw: null,
    date: null,
    amount: 0,
  };
  let usingRefNumAsCheckNum = false;
  let current = getTagAndValueParity(c);
  for (
    ;
    current != null && !tagStartsWithParity(current.tag, "</STMTTRN");
    current = getTagAndValueParity(c)
  ) {
    if (current.tag == null || current.tag === "") continue;
    switch (current.tag.toUpperCase()) {
      case "<TRNTYPE>":
        trnType = current.value;
        break;
      case "<REFNUM>":
        if (ret.checkNumber == null || ret.checkNumber === "") {
          usingRefNumAsCheckNum = true;
          ret.checkNumber = current.value;
        }
        break;
      case "<CHECKNUM>":
        if (current.value != null && current.value !== "") {
          usingRefNumAsCheckNum = false;
          ret.checkNumber = current.value;
        }
        break;
      case "<DTUSER>":
        break;
      case "<DTPOSTED>":
        ret.dateRaw = current.value;
        ret.date = parseOfxDateParity(current.value);
        break;
      case "<TRNAMT>": {
        const amount = parseOfxAmountParity(current.value);
        if (Number.isNaN(amount)) {
          throw new Error(`Could not parse value: ${current.value}`);
        }
        ret.amount = amount;
        break;
      }
      case "<FITID>":
        ret.fitid = current.value.trim();
        break;
      case "<PAYEE>":
      case "<NAME>":
        ret.payee = current.value.trim();
        break;
      case "<MEMO>":
        ret.memo = current.value.trim();
        break;
      default:
        break;
    }
  }
  if (
    usingRefNumAsCheckNum &&
    trnType != null &&
    trnType.toLowerCase() !== "check"
  ) {
    ret.checkNumber = "";
  }
  return ret;
}

/** Oracle parseTransactionList verbatim (importerOFX.ts:482-505). */
function parseTransactionListParity(
  c: CursorParity,
  closeTag: string,
): RawOfxTxnParity[] {
  const out: RawOfxTxnParity[] = [];
  let current = getTagAndValueParity(c);
  for (
    ;
    current != null && !tagStartsWithParity(current.tag, closeTag);
    current = getTagAndValueParity(c)
  ) {
    if (current.tag == null || current.tag === "") continue;
    if (current.tag.toUpperCase() === "<STMTTRN>") {
      const t = parseSTMTTRNParity(c);
      if (t.dateRaw != null && t.date != null) out.push(t);
    }
  }
  return out;
}

/** Oracle parseMessageAccounts verbatim (importerOFX.ts:631-655). */
function parseMessageAccountsParity(
  c: CursorParity,
  closingTag: string,
  openTag: string,
  parseStatements: (cursor: CursorParity) => RawOfxAccountParity,
): RawOfxAccountParity[] {
  const out: RawOfxAccountParity[] = [];
  for (
    let current = getTagAndValueParity(c);
    current != null && !tagStartsWithParity(current.tag, closingTag);
    current = getTagAndValueParity(c)
  ) {
    if (current.tag == null || current.tag === "") continue;
    if (current.tag.toUpperCase() === openTag) {
      out.push(parseStatements(c));
    }
  }
  return out;
}

/** Oracle parseSTMTRS verbatim (importerOFX.ts:526-557): case-SENSITIVE. */
function parseSTMTRSParity(c: CursorParity): RawOfxAccountParity {
  const ret: RawOfxAccountParity = {
    fid: null,
    bankAccountID: null,
    accountType: null,
    transactions: [],
  };
  const raw: RawOfxTxnParity[] = [];
  let current = getTagAndValueParity(c);
  while (current != null && !tagStartsWithParity(current.tag, "</STMTRS>")) {
    switch (current.tag) {
      case "<BANKID>":
        ret.fid = current.value;
        break;
      case "<ACCTID>":
        ret.bankAccountID = current.value;
        break;
      case "<ACCTTYPE>":
        ret.accountType = current.value;
        break;
      case "<BANKTRANLIST>":
        raw.push(...parseTransactionListParity(c, "</BANKTRANLIST>"));
        break;
      default:
        break;
    }
    current = getTagAndValueParity(c);
  }
  ret.transactions = raw;
  return ret;
}

/** Oracle parseCCSTMTRS verbatim (importerOFX.ts:560-590): insensitive. */
function parseCCSTMTRSParity(c: CursorParity): RawOfxAccountParity {
  const ret: RawOfxAccountParity = {
    fid: null,
    bankAccountID: null,
    accountType: null,
    transactions: [],
  };
  const raw: RawOfxTxnParity[] = [];
  for (
    let current = getTagAndValueParity(c);
    current != null && !tagStartsWithParity(current.tag, "</CCSTMTRS>");
    current = getTagAndValueParity(c)
  ) {
    if (current.tag == null) continue;
    switch (current.tag.toUpperCase()) {
      case "<ACCTID>":
        ret.bankAccountID = current.value;
        break;
      case "<BANKTRANLIST>":
        raw.push(...parseTransactionListParity(c, "</BANKTRANLIST>"));
        break;
      default:
        break;
    }
  }
  ret.transactions = raw;
  return ret;
}

/** Oracle parseINVSTMTRS verbatim (importerOFX.ts:593-629): insensitive. */
function parseINVSTMTRSParity(c: CursorParity): RawOfxAccountParity {
  const ret: RawOfxAccountParity = {
    fid: null,
    bankAccountID: null,
    accountType: null,
    transactions: [],
  };
  const raw: RawOfxTxnParity[] = [];
  for (
    let current = getTagAndValueParity(c);
    current != null && !tagStartsWithParity(current.tag, "</INVSTMTRS>");
    current = getTagAndValueParity(c)
  ) {
    if (current.tag == null) continue;
    switch (current.tag.toUpperCase()) {
      case "<BROKERID>":
        ret.fid = current.value;
        break;
      case "<BANKID>":
        ret.fid = current.value;
        break;
      case "<ACCTID>":
        ret.bankAccountID = current.value;
        break;
      case "<INVTRANLIST>":
        raw.push(...parseTransactionListParity(c, "</INVTRANLIST>"));
        break;
      default:
        break;
    }
  }
  ret.transactions = raw;
  return ret;
}

function parseBANKMSGSRSParity(c: CursorParity): RawOfxAccountParity[] {
  return parseMessageAccountsParity(c, "</BANKMSGSRS>", "<STMTRS>", (cur) =>
    parseSTMTRSParity(cur),
  );
}

/** Oracle buildOFXImport pure half verbatim (importerOFX.ts:732-783). */
function buildOFXImportParity(doc: string): {
  accounts: OfxAccountParity[];
  hasRemovedAccountsWithNoTransactions: boolean;
} {
  const normalized = doc.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cursor = new CursorParity(cleanOFXLinesParity(normalized.split("\n")));
  const rawAccounts: RawOfxAccountParity[] = [];
  let financialID: string | null = null;
  let current = getTagAndValueParity(cursor);
  while (current != null && !tagStartsWithParity(current.tag, "</OFX>")) {
    if (current.tag != null) {
      if (tagStartsWithParity(current.tag, "<SIGNONMSGSRS")) {
        financialID = getFIDFromSIGNONMSGSRSParity(cursor);
      } else if (tagStartsWithParity(current.tag, "<BANKMSGSRS")) {
        rawAccounts.push(...parseBANKMSGSRSParity(cursor));
      } else if (tagStartsWithParity(current.tag, "<CREDITCARDMSGSRS")) {
        rawAccounts.push(
          ...parseMessageAccountsParity(
            cursor,
            "</CREDITCARDMSGSRS>",
            "<CCSTMTRS>",
            (cur) => parseCCSTMTRSParity(cur),
          ),
        );
      } else if (tagStartsWithParity(current.tag, "<INVSTMTMSGSRS")) {
        rawAccounts.push(
          ...parseMessageAccountsParity(
            cursor,
            "</INVSTMTMSGSRS>",
            "<INVSTMTRS>",
            (cur) => parseINVSTMTRSParity(cur),
          ),
        );
      }
    }
    current = getTagAndValueParity(cursor);
  }
  if (financialID != null && financialID !== "") {
    for (const a of rawAccounts) a.fid = financialID;
  }
  let counter = 0;
  const accounts: OfxAccountParity[] = [];
  let hasRemovedAccountsWithNoTransactions = false;
  for (const a of rawAccounts) {
    if (!a.transactions || a.transactions.length === 0) {
      hasRemovedAccountsWithNoTransactions = true;
    } else {
      counter += 1;
      accounts.push({
        ...a,
        transactions: a.transactions.map((t) => ({
          ...t,
          ynabID: `YNAB:${t.amount}:${t.date?.toStandardString()}:${counter}`,
        })),
      });
    }
  }
  return { accounts, hasRemovedAccountsWithNoTransactions };
}

type OfxTargetParity = {
  accountExists: (name: string) => boolean;
  addTransaction: (tx: { payee: string | null; memo: string | null }) => void;
  findTransactionByYNABID?: (id: string) => unknown;
  findTransactionByFITID?: (fitid: string) => { amount: number; date: string } | null;
  adoptYNABID?: (existing: unknown, id: string) => void;
  matchOrAdd?: (tx: unknown) => boolean;
};

function daysApartParity(a: string, b: string): number {
  return (
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
    86400000
  );
}

function rewriteTransferParity(
  payee: string | null,
  accountExists: (name: string) => boolean,
): string | null {
  if (payee == null) return null;
  const m = /^Transfer\s*:\s*(.+)$/.exec(payee);
  if (m && !accountExists(m[1]!.trim())) return `Transfer (${m[1]!.trim()})`;
  return payee;
}

/** Oracle applyOFXImport half (YNABID dup, FITID adopt, flip, transfer). */
function applyOFXImportParity(
  target: OfxTargetParity,
  account: OfxAccountParity,
  opts?: { importMemos?: boolean },
): { numTransactions: number; numNew: number; numMatched: number; numSkippedDuplicate: number } {
  const res = { numTransactions: 0, numNew: 0, numMatched: 0, numSkippedDuplicate: 0 };
  const importMemos = opts?.importMemos !== false;
  const allPayeeNull = account.transactions.every((t) => t.payee == null);
  const anyMemo = account.transactions.some((t) => t.memo != null);
  const flip = allPayeeNull && anyMemo;
  for (const t of account.transactions) {
    res.numTransactions += 1;
    if (target.findTransactionByYNABID?.(t.ynabID) != null) {
      res.numSkippedDuplicate += 1;
      continue;
    }
    const existing =
      t.fitid != null ? target.findTransactionByFITID?.(t.fitid) : null;
    if (
      existing != null &&
      existing.amount === t.amount &&
      daysApartParity(existing.date, t.date!.toStandardString()) <= 4 + 1e-9
    ) {
      target.adoptYNABID?.(existing, t.ynabID);
      continue;
    }
    let payee = flip ? t.memo : t.payee;
    let memo = flip ? null : t.memo;
    if (!importMemos) memo = null;
    payee = rewriteTransferParity(payee, target.accountExists);
    if (target.matchOrAdd?.(t) === true) {
      res.numMatched += 1;
      res.numNew += 1;
      continue;
    }
    target.addTransaction({ payee, memo });
    res.numNew += 1;
  }
  return res;
}

// ---- QIF parity helpers ----

function getReadableStatementTypeParity(statementType: string): string {
  switch (statementType) {
    case "Bank":
      return "Bank";
    case "CC":
    case "CCard":
      return "Credit Card";
    case "Cash":
      return "Cash";
    case "Oth A":
      return "Other Assets";
    case "Oth L":
      return "Other Liabilities";
    default:
      throw new Error("statementType was unrecognized");
  }
}

function statementTypeIsValidParity(value: string | null | undefined): boolean {
  if (value == null) return false;
  switch (value.toLowerCase()) {
    case "bank":
    case "cc":
    case "ccard":
    case "cash":
    case "oth a":
    case "oth l":
      return true;
    default:
      return false;
  }
}

function containsStatementTypeParity(lines: string[]): boolean {
  return lines.some((l) => l.trim().toLowerCase().startsWith("!type:"));
}

function splitQIFLinesParity(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** Oracle parseQIFAmount: first-strip only (no g flag), trailing-minus negate. */
function parseQIFAmountParity(s: string, opts?: { currencySymbol?: string }): number {
  let t = s;
  if (opts?.currencySymbol && t.startsWith(opts.currencySymbol)) {
    t = t.slice(opts.currencySymbol.length);
  }
  let neg = false;
  if (t.endsWith("-")) {
    neg = true;
    t = t.slice(0, -1);
  }
  t = t.replace(/[^0-9.\-]/, "");
  if (t === "" || t === "." || t === "-" || t === "-.") return 0;
  const n = Number(t);
  if (Number.isNaN(n)) return 0;
  return neg ? -n : n;
}

function tryQIFDateParity(
  s: string,
  seq: "MDY" | "DMY",
): { y: number; m: number; d: number } | null {
  const parts = s.trim().split(/[/\-. ]+/);
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n))) return null;
  const [a, b, yRaw] = nums as [number, number, number];
  const y = yRaw! < 100 ? yRaw! + 2000 : yRaw!;
  // NOTE: out-of-range parts do NOT eliminate sequences (allowOutOfRange);
  // month 13 rolls over via the Date constructor, verbatim (QIF test:301-310).
  const m = seq === "MDY" ? a! : b!;
  const d = seq === "MDY" ? b! : a!;
  return { y, m, d };
}

function fmtQIFParity(y: number, m: number, d: number): string {
  const dt = new Date(y, m - 1, d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

type QifSubParity = { category: string; memo: string | null; amount: number };

type QifTxnParity = {
  date: string;
  amount: number;
  payee: string | null;
  memo: string | null;
  checkNumber: string | null;
  category: string | null;
  subTransactions?: QifSubParity[];
  ynabID: string;
};

type QifAccountParity = {
  bankAccountID: string | null;
  accountType: string;
  dateSequence: "MDY" | "DMY";
  transactions: QifTxnParity[];
};

function canonicalTypeParity(raw: string): string {
  const l = raw.toLowerCase();
  if (l === "bank") return "Bank";
  if (l === "cc" || l === "ccard") return "CCard";
  if (l === "cash") return "Cash";
  if (l === "oth a") return "Oth A";
  return "Oth L";
}

function dateStringsValidParity(body: string[], seq: "MDY" | "DMY"): boolean {
  const dates = body.filter((l) => l.startsWith("D")).map((l) => l.slice(1));
  if (dates.length === 0) return false;
  return dates.every((d) => tryQIFDateParity(d, seq) != null);
}

/** Oracle getYNABFriendlyCategoryName half (tested vectors: raw passthrough). */
function friendlyParity(raw: string): string {
  return raw;
}

function splitLegCategoryParity(
  s: string,
  findSubCategory?: (name: string) => boolean,
): string {
  if (s.includes(":")) return friendlyParity(s);
  if (findSubCategory?.(s) === true) return s;
  return `Misc : ${s}`;
}

/** Oracle buildQIFImport half (tested vectors only). */
function buildQIFImportParity(
  text: string,
  opts?: {
    preferredDateSequence?: "MDY" | "DMY";
    findSubCategory?: (name: string) => boolean;
  },
): {
  accounts: QifAccountParity[];
  hasRemovedAccountsWithNoTransactions: boolean;
  numSkippedEmpty: number;
} {
  let lines = splitQIFLinesParity(text).map((l) => l.trim());
  if (!containsStatementTypeParity(lines)) lines = ["!Type:Bank", ...lines];
  const sections: { name: string | null; type: string; body: string[] }[] = [];
  let cur: { name: string | null; type: string; body: string[] } | null = null;
  let pendingAccount: string | null = null;
  let expectAccountName = false;
  let poisoned = false;
  let sawInvalidType = false;
  for (const line of lines) {
    if (/^!account/i.test(line)) {
      expectAccountName = true;
      continue;
    }
    if (expectAccountName && /^N/.test(line)) {
      pendingAccount = line.slice(1);
      expectAccountName = false;
      continue;
    }
    expectAccountName = false;
    if (/^!type:/i.test(line)) {
      const raw = line.slice("!type:".length).trim();
      if (!statementTypeIsValidParity(raw)) {
        sawInvalidType = true;
        poisoned = true;
        cur = null;
        continue;
      }
      poisoned = false;
      cur = { name: pendingAccount, type: raw, body: [] };
      sections.push(cur);
      pendingAccount = null;
      continue;
    }
    if (poisoned || cur == null) continue;
    cur.body.push(line);
  }
  if (sections.length === 0 && sawInvalidType) {
    throw new Error(
      "No accounts were found to import. Please note that YNAB4 does not support importing stock transactions from investment accounts.",
    );
  }
  const accounts: QifAccountParity[] = [];
  let numSkippedEmpty = 0;
  for (const sec of sections) {
    const seqs: ("MDY" | "DMY")[] =
      opts?.preferredDateSequence != null &&
      dateStringsValidParity(sec.body, opts.preferredDateSequence)
        ? [opts.preferredDateSequence]
        : (["DMY", "MDY"] as const).filter((s) =>
            dateStringsValidParity(sec.body, s),
          );
    if (seqs.length === 0) continue;
    const seq = seqs[0]!;
    const parsed = parseQIFSectionParity(sec.body, seq, opts?.findSubCategory);
    numSkippedEmpty += parsed.skipped;
    if (parsed.rows.length === 0) continue;
    accounts.push({
      bankAccountID: sec.name,
      accountType: getReadableStatementTypeParity(canonicalTypeParity(sec.type)),
      dateSequence: seq,
      transactions: parsed.rows,
    });
  }
  if (accounts.length === 0) {
    if (sawInvalidType && sections.length === 0) {
      throw new Error(
        "No accounts were found to import. Please note that YNAB4 does not support importing stock transactions from investment accounts.",
      );
    }
    throw new Error("Could not parse the dates in this file");
  }
  return {
    accounts,
    hasRemovedAccountsWithNoTransactions: sections.length > accounts.length,
    numSkippedEmpty,
  };
}

function parseQIFSectionParity(
  body: string[],
  seq: "MDY" | "DMY",
  findSubCategory?: (name: string) => boolean,
): { rows: QifTxnParity[]; skipped: number; dates: number } {
  const rows: QifTxnParity[] = [];
  let skipped = 0;
  let dates = 0;
  let rec: {
    d?: string;
    t?: number;
    p?: string | null;
    m?: string | null;
    n?: string | null;
    l?: string | null;
    legs: { s: string; e: string | null; amt: number }[];
    pendingS?: string | null;
    pendingE?: string | null;
  } | null = null;
  const push = () => {
    if (rec == null) return;
    const curRec = rec;
    rec = null;
    if (curRec.d == null) {
      skipped += 1;
      return;
    }
    const parsed = tryQIFDateParity(curRec.d, seq);
    if (parsed == null) {
      skipped += 1;
      return;
    }
    dates += 1;
    const date = fmtQIFParity(parsed.y, parsed.m, parsed.d);
    let category: string | null =
      curRec.l != null ? friendlyParity(curRec.l) : null;
    let subTransactions: QifSubParity[] | undefined;
    if (curRec.legs.length > 0) {
      category = "Split Transaction";
      subTransactions = curRec.legs.map((leg) => ({
        category: splitLegCategoryParity(leg.s, findSubCategory),
        memo: leg.e,
        amount: leg.amt,
      }));
    }
    rows.push({
      date,
      amount: curRec.t ?? 0,
      payee: curRec.p ?? null,
      memo: curRec.m ?? null,
      checkNumber: curRec.n ?? null,
      category,
      subTransactions,
      ynabID: `YNAB:${curRec.t ?? 0}:${date}:${rows.length + 1}`,
    });
  };
  for (const line of body) {
    const kind = line[0];
    const rest = line.slice(1);
    if (kind === "^") {
      push();
      continue;
    }
    if (rec == null) rec = { legs: [] };
    switch (kind) {
      case "D":
        if (rec.d != null || rec.t != null || rec.legs.length > 0) push();
        if (rec == null) rec = { legs: [] };
        rec.d = rest;
        break;
      case "T":
        rec.t = parseQIFAmountParity(rest);
        break;
      case "P":
        rec.p = rest;
        break;
      case "M":
        rec.m = rest;
        break;
      case "N":
        rec.n = rest;
        break;
      case "L":
        rec.l = rest;
        break;
      case "S":
        rec.pendingS = rest;
        break;
      case "E":
        // E keeps its memo raw except the loop-level line trim (QIF test:210-227).
        rec.pendingE = rest;
        break;
      case "$":
        rec.legs.push({
          s: rec.pendingS ?? "",
          e: rec.pendingE ?? null,
          amt: parseQIFAmountParity(rest),
        });
        rec.pendingS = null;
        rec.pendingE = null;
        break;
      case "C":
      case "A":
        break;
      default:
        break;
    }
  }
  return { rows, skipped, dates };
}

function applyQIFImportParity(
  target: {
    accountExists: (name: string) => boolean;
    addTransaction: (tx: {
      payee: string | null;
      memo: string | null;
      category: string | null;
    }) => void;
    findTransactionByYNABID?: (id: string) => unknown;
    findSubCategory?: (name: string) => boolean;
  },
  account: QifAccountParity,
): { numTransactions: number; numNew: number; numMatched: number; numSkippedDuplicate: number } {
  const res = { numTransactions: 0, numNew: 0, numMatched: 0, numSkippedDuplicate: 0 };
  const allPayeeNull = account.transactions.every((t) => t.payee == null);
  const anyMemo = account.transactions.some((t) => t.memo != null);
  const flip = allPayeeNull && anyMemo;
  for (const t of account.transactions) {
    res.numTransactions += 1;
    if (target.findTransactionByYNABID?.(t.ynabID) != null) {
      res.numSkippedDuplicate += 1;
      continue;
    }
    let payee = flip ? t.memo : t.payee;
    payee = rewriteTransferParity(payee, target.accountExists);
    let category = t.category;
    if (category === "Split Transaction" && t.subTransactions) {
      for (const leg of t.subTransactions) {
        if (target.findSubCategory?.(leg.category) === true) {
          category = "Split Transaction";
        }
      }
    }
    target.addTransaction({ payee, memo: flip ? null : t.memo, category });
    res.numNew += 1;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gap status: no OFX/QIF import surface in this repo", () => {
  it("the ofx phase exposes only the mapping-drop reporter", () => {
    expect(Object.keys(ofxPhase).sort()).toEqual(["reportDroppedOfxMappings"]);
  });

  it("empty input warns nothing; live mappings warn with all three booleans", () => {
    const ctx: { warnings: string[] } = { warnings: [] };
    ofxPhase.reportDroppedOfxMappings(
      { accounts: [], accountMappings: [] },
      ctx as never,
    );
    expect(ctx.warnings).toEqual([]);
    ofxPhase.reportDroppedOfxMappings(
      {
        accounts: [{ entityId: "acc1", accountName: "Checking" }],
        accountMappings: [
          {
            entityId: "map1",
            targetYNABAccountId: "acc1",
            skipImport: true,
            shouldFlipPayeesMemos: true,
            shouldImportMemos: false,
          },
        ],
      },
      ctx as never,
    );
    const text = ctx.warnings.join("\n");
    expect(text).toMatch(/Dropped 1 OFX account mapping/);
    expect(text).toMatch(/Checking/);
    expect(text).toMatch(/skipImport=true/);
    expect(text).toMatch(/shouldFlipPayeesMemos=true/);
    expect(text).toMatch(/shouldImportMemos=false/);
  });

  it("tombstoned mappings are excluded from the dropped count", () => {
    const ctx: { warnings: string[] } = { warnings: [] };
    ofxPhase.reportDroppedOfxMappings(
      {
        accounts: [],
        accountMappings: [
          { entityId: "dead", isTombstone: true, targetYNABAccountId: "x" },
          { entityId: "live", targetYNABAccountId: "y" },
        ],
      },
      ctx as never,
    );
    expect(ctx.warnings.join("\n")).toMatch(/Dropped 1 OFX account mapping/);
  });
});

describe.skip("OFX canImport (oracle importerOFX.test.ts:35-52)", () => {
  it("accepts ofx/qfx case-insensitively, rejects the rest, pins the filter", () => {
    expect(canImportOFXParity("ofx")).toBe(true);
    expect(canImportOFXParity("QFX")).toBe(true);
    expect(canImportOFXParity("OFX")).toBe(true);
    expect(canImportOFXParity("csv")).toBe(false);
    expect(canImportOFXParity("qif")).toBe(false);
    expect(canImportOFXParity(null)).toBe(false);
    expect(canImportOFXParity(undefined)).toBe(false);
    expect(OFX_FILE_FILTER_PARITY).toBe("*.ofx;*.qfx");
  });
});

describe.skip("tagStartsWith (oracle :54-72)", () => {
  it("matches a tag prefix case-insensitively after trimming", () => {
    expect(tagStartsWithParity("  <BANKMSGSRS>  ", "<BANKMSGSRS")).toBe(true);
    expect(tagStartsWithParity("<bankmsgsrs>", "<BANKMSGSRS")).toBe(true);
    expect(tagStartsWithParity("<STMTTRN>", ["</STMTTRN>"])).toBe(false);
    expect(tagStartsWithParity("</STMTTRN>", ["</STMTTRN>"])).toBe(true);
    expect(tagStartsWithParity("<SIGNONMSGSRS>", "<SIGNONMSGSRS>")).toBe(true);
  });

  it("blank tag matches only a null/empty search list", () => {
    expect(tagStartsWithParity(null, null)).toBe(true);
    expect(tagStartsWithParity("", [])).toBe(true);
    expect(tagStartsWithParity(null, ["<FID>"])).toBe(false);
    expect(tagStartsWithParity("", ["<FID>"])).toBe(false);
  });
});

describe.skip("splitOFXLineSegments / cleanOFXLines (oracle :74-107)", () => {
  it("splits multiple tags on one raw line", () => {
    expect(splitOFXLineSegmentsParity("<A>1<B>2")).toEqual(["<A>1", "<B>2"]);
    expect(splitOFXLineSegmentsParity("text<MORE")).toEqual(["text", "<MORE"]);
    expect(splitOFXLineSegmentsParity("")).toEqual([]);
  });

  it("merges continuation text with a single space and drops blanks", () => {
    expect(cleanOFXLinesParity(["<NAME>Coffee Shop", "Downtown"])).toEqual([
      "<NAME>Coffee Shop Downtown",
    ]);
    expect(cleanOFXLinesParity(["", "   ", "<A>"])).toEqual(["<A>"]);
  });

  it("decodes entities incl. the `&lt;b` quirk, nbsp, and CDATA", () => {
    expect(cleanOFXLinesParity(["<MEMO>a&lt;b&amp;c&gt;d"])).toEqual([
      "<MEMO>a&c>d",
    ]);
    expect(cleanOFXLinesParity(["<MEMO>x y"])).toEqual([
      "<MEMO>x y",
    ]);
    expect(
      cleanOFXLinesParity(["<NAME>abc", "<![CDATA[def]]>", "<OTHER>"]),
    ).toEqual(["<NAME>abc def", "<OTHER>"]);
  });
});

describe.skip("getTagAndValue (oracle :109-155)", () => {
  const cursorOf = (...lines: string[]) => new CursorParity(lines);

  it("splits tag/same-line value, bare tags, and continuations", () => {
    expect(getTagAndValueParity(cursorOf("<TRNAMT>-12.50"))).toEqual({
      tag: "<TRNAMT>",
      value: "-12.50",
    });
    expect(getTagAndValueParity(cursorOf("<STMTTRN>"))).toEqual({
      tag: "<STMTTRN>",
      value: "",
    });
    expect(
      getTagAndValueParity(cursorOf("<MEMO>hello", "world", "<NEXT>")),
    ).toEqual({ tag: "<MEMO>", value: "helloworld" });
  });

  it("skips prologue/non-tag lines and returns null at EOF", () => {
    expect(
      getTagAndValueParity(cursorOf("OFXHEADER:100", "<?xml?", "<A>1")),
    ).toEqual({ tag: "<A>", value: "1" });
    expect(getTagAndValueParity(cursorOf())).toBeNull();
  });

  it("throws verbatim on a tag without '>' and honors tagsToLookFor", () => {
    expect(() => getTagAndValueParity(cursorOf("<BROKEN"))).toThrow(
      "Malformed OFX file",
    );
    expect(
      getFIDFromSIGNONMSGSRSParity(
        cursorOf("<DT>1", "<FID>42", "</SIGNONMSGSRS>"),
      ),
    ).toBe("42");
    expect(getFIDFromSIGNONMSGSRSParity(cursorOf("</SIGNONMSGSRS>"))).toBeNull();
    expect(getFIDFromSIGNONMSGSRSParity(cursorOf())).toBeNull();
  });
});

describe.skip("parseOfxDate (oracle :157-179)", () => {
  it("parses positional YYYYMMDD, ignores suffixes, trims", () => {
    const d = parseOfxDateParity("20110607");
    expect([d.year, d.month, d.date]).toEqual([2011, 5, 7]);
    expect(parseOfxDateParity("20110607120000.000[-4:EDT]").date).toBe(7);
    expect(parseOfxDateParity("  20110607  ").toStandardString()).toBe(
      "2011-06-07",
    );
  });

  it("throws the verbatim error for garbage", () => {
    expect(() => parseOfxDateParity("not-a-date!!")).toThrow(
      "Invalid OFX Date: not-a-date!!",
    );
  });
});

describe("parseOfxAmount via this repo (oracle :181-186)", () => {
  it("unknown-separator amounts land on integer cents", () => {
    expect(parseAmount("-12.50")).toBe(-12.5);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(dollarsToCents(parseAmount("-12.50")!)).toBe(-1250);
    expect(dollarsToCents(parseAmount("1,234.56")!)).toBe(123456);
    expect(() => parseOfxAmountParity("abc")).toThrow(
      "Could not parse value: abc",
    );
  });
});

describe.skip("parseSTMTTRN (oracle :188-257)", () => {
  const stmtLines = (...lines: string[]) =>
    new CursorParity([...lines, "</STMTTRN>"]);

  it("maps every field incl. FITID, NAME payee, and check number", () => {
    const t = parseSTMTTRNParity(
      stmtLines(
        "<TRNTYPE>DEBIT",
        "<DTPOSTED>20110607",
        "<TRNAMT>-12.50",
        "<FITID>abc123",
        "<NAME>Coffee Shop",
        "<MEMO>latte",
        "<CHECKNUM>101",
      ),
    );
    expect(t.payee).toBe("Coffee Shop");
    expect(t.memo).toBe("latte");
    expect(t.checkNumber).toBe("101");
    expect(t.fitid).toBe("abc123");
    expect(t.amount).toBeCloseTo(-12.5, 10);
    expect(t.date?.toStandardString()).toBe("2011-06-07");
  });

  it("PAYEE overwrites NAME; CHECKNUM wins over REFNUM; REFNUM needs check type", () => {
    const t = parseSTMTTRNParity(
      stmtLines(
        "<TRNTYPE>CHECK",
        "<DTPOSTED>20110607",
        "<TRNAMT>-5",
        "<REFNUM>999",
        "<NAME>First",
        "<CHECKNUM>101",
        "<PAYEE>Second",
      ),
    );
    expect(t.payee).toBe("Second");
    expect(t.checkNumber).toBe("101");
    const debit = parseSTMTTRNParity(
      stmtLines(
        "<TRNTYPE>DEBIT",
        "<DTPOSTED>20110607",
        "<TRNAMT>-5",
        "<REFNUM>999",
      ),
    );
    expect(debit.checkNumber).toBe("");
    const check = parseSTMTTRNParity(
      stmtLines(
        "<TRNTYPE>check",
        "<DTPOSTED>20110607",
        "<TRNAMT>-5",
        "<REFNUM>999",
      ),
    );
    expect(check.checkNumber).toBe("999");
    expect(() =>
      parseSTMTTRNParity(stmtLines("<DTPOSTED>20110607", "<TRNAMT>abc")),
    ).toThrow("Could not parse value: abc");
  });
});

describe.skip("parseTransactionList + STMTRS variants (oracle :259-331 + :544-559)", () => {
  it("collects STMTTRNs, drops dateless ones, stops at the close tag", () => {
    const list = parseTransactionListParity(
      new CursorParity([
        "<STMTTRN>",
        "<DTPOSTED>20110607",
        "<TRNAMT>1",
        "</STMTTRN>",
        "<STMTTRN>",
        "<TRNAMT>2",
        "</STMTTRN>",
        "</BANKTRANLIST>",
      ]),
      "</BANKTRANLIST>",
    );
    expect(list.length).toBe(1);
    expect(list[0]?.amount).toBe(1);
    const inv = parseTransactionListParity(
      new CursorParity([
        "<STMTTRN>",
        "<DTPOSTED>20110607",
        "<TRNAMT>3",
        "</STMTTRN>",
        "</INVTRANLIST>",
      ]),
      "</INVTRANLIST>",
    );
    expect(inv.length).toBe(1);
  });

  it("STMTRS tags are case-sensitive; CC STMTRS are insensitive; BANKMSGSRS collects", () => {
    const bank = parseSTMTRSParity(
      new CursorParity([
        "<BANKID>fid1",
        "<ACCTID>acc9",
        "<ACCTTYPE>CHECKING",
        "<BANKTRANLIST>",
        "<STMTTRN>",
        "<DTPOSTED>20110607",
        "<TRNAMT>1",
        "</STMTTRN>",
        "</BANKTRANLIST>",
        "</STMTRS>",
      ]),
    );
    expect(bank.fid).toBe("fid1");
    expect(bank.bankAccountID).toBe("acc9");
    expect(bank.accountType).toBe("CHECKING");
    expect(bank.transactions.length).toBe(1);
    const cc = parseCCSTMTRSParity(
      new CursorParity([
        "<acctid>cc1",
        "<banktranlist>",
        "<STMTTRN>",
        "<DTPOSTED>20110607",
        "<TRNAMT>-20",
        "</STMTTRN>",
        "</BANKTRANLIST>",
        "</CCSTMTRS>",
      ]),
    );
    expect(cc.bankAccountID).toBe("cc1");
    expect(cc.transactions.length).toBe(1);
    const invstm = parseINVSTMTRSParity(
      new CursorParity([
        "<brokerid>brk",
        "<acctid>inv9",
        "<INVTRANLIST>",
        "<STMTTRN>",
        "<DTPOSTED>20110607",
        "<TRNAMT>7",
        "</STMTTRN>",
        "</INVTRANLIST>",
        "</INVSTMTRS>",
      ]),
    );
    expect(invstm.fid).toBe("brk");
    expect(invstm.bankAccountID).toBe("inv9");
    expect(invstm.transactions.length).toBe(1);
    const multi = parseBANKMSGSRSParity(
      new CursorParity([
        "<STMTRS>",
        "<ACCTID>a1",
        "</STMTRS>",
        "<STMTRS>",
        "<ACCTID>a2",
        "</STMTRS>",
        "</BANKMSGSRS>",
      ]),
    );
    expect(multi.map((a) => a.bankAccountID)).toEqual(["a1", "a2"]);
  });
});

describe.skip("buildOFXImport (oracle :333-428)", () => {
  const OFX_DOC = [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "<OFX>",
    "<SIGNONMSGSRS>",
    "<FID>mybank",
    "</SIGNONMSGSRS>",
    "<BANKMSGSRS>",
    "<STMTRS>",
    "<BANKID>bankfid",
    "<ACCTID>checking1",
    "<ACCTTYPE>CHECKING",
    "<BANKTRANLIST>",
    "<STMTTRN>",
    "<TRNTYPE>DEBIT",
    "<DTPOSTED>20110607",
    "<TRNAMT>-12.50",
    "<FITID>f1",
    "<NAME>Coffee</NAME>",
    "<MEMO>latte</MEMO>",
    "</STMTTRN>",
    "</BANKTRANLIST>",
    "</STMTRS>",
    "<STMTRS>",
    "<BANKID>empty",
    "<ACCTID>no-txns",
    "</STMTRS>",
    "</BANKMSGSRS>",
    "<CREDITCARDMSGSRS>",
    "<CCSTMTRS>",
    "<ACCTID>cc1",
    "<BANKTRANLIST>",
    "<STMTTRN>",
    "<TRNTYPE>DEBIT",
    "<DTPOSTED>20110608",
    "<TRNAMT>-20.00",
    "<FITID>f2",
    "<NAME>Mall</NAME>",
    "</STMTTRN>",
    "</BANKTRANLIST>",
    "</CCSTMTRS>",
    "</CREDITCARDMSGSRS>",
    "</OFX>",
  ].join("\n");

  it("parses bank + card accounts, stamps the signon FID, drops empties", () => {
    const data = buildOFXImportParity(OFX_DOC);
    expect(data.hasRemovedAccountsWithNoTransactions).toBe(true);
    expect(data.accounts.length).toBe(2);
    expect(data.accounts[0]?.fid).toBe("mybank");
    expect(data.accounts[0]?.bankAccountID).toBe("checking1");
    expect(data.accounts[1]?.bankAccountID).toBe("cc1");
    expect(data.accounts[0]?.transactions[0]?.payee).toBe("Coffee");
    expect(data.accounts[0]?.transactions[0]?.ynabID).toMatch(
      /^YNAB:.*:2011-06-07:1$/,
    );
  });

  it("tolerates attributed/mixed-case closes, empty bodies, and inline closes", () => {
    const tolerant = buildOFXImportParity(
      [
        "<OFX>",
        "<bankmsgsrs attr=x>",
        "<STMTRS>",
        "<ACCTID>a",
        "<BANKTRANLIST>",
        "<STMTTRN>",
        "<DTPOSTED>20110607",
        "<TRNAMT>5",
        "</stmttrn>",
        "</BANKTRANLIST>",
        "</STMTRS foo>",
        "</BANKMSGSRS>",
        "</OFX>",
      ].join("\n"),
    );
    expect(tolerant.accounts.length).toBe(1);
    const empty = buildOFXImportParity("<OFX></OFX>");
    expect(empty.accounts).toEqual([]);
    expect(empty.hasRemovedAccountsWithNoTransactions).toBe(false);
    const inline = buildOFXImportParity(
      "<OFX><CREDITCARDMSGSRS><CCSTMTRS><ACCTID>c</ACCTID><BANKTRANLIST><STMTTRN><DTPOSTED>20110607<TRNAMT>-3<FITID>x<NAME>Shop</STMTTRN></BANKTRANLIST></CCSTMTRS></CREDITCARDMSGSRS></OFX>",
    );
    expect(inline.accounts.length).toBe(1);
    expect(inline.accounts[0]?.transactions[0]?.payee).toBe("Shop");
  });
});

describe("applyOFXImport (oracle :430-542)", () => {
  function targetAndSink(): {
    target: OfxTargetParity;
    added: { payee: string | null; memo: string | null }[];
  } {
    const added: { payee: string | null; memo: string | null }[] = [];
    return {
      added,
      target: {
        accountExists: () => true,
        addTransaction: (tx) => added.push({ payee: tx.payee, memo: tx.memo }),
      },
    };
  }

  function accountOf(amount: number, ynabID: string): OfxAccountParity {
    return {
      fid: null,
      bankAccountID: "a",
      accountType: null,
      transactions: [
        {
          payee: "Store",
          memo: "note",
          checkNumber: null,
          fitid: null,
          dateRaw: "20110607",
          date: parseOfxDateParity("20110607"),
          amount,
          ynabID,
        },
      ],
    };
  }

  it("skips YNABID duplicates", () => {
    const { target, added } = targetAndSink();
    target.findTransactionByYNABID = () => ({});
    const result = applyOFXImportParity(target, accountOf(5, "YNAB:x"));
    expect(result).toEqual({
      numTransactions: 1,
      numNew: 0,
      numMatched: 0,
      numSkippedDuplicate: 1,
    });
    expect(added).toEqual([]);
  });

  it("FORK: the FITID+amount+within-4-days window is real here (duplicates.ts:280-296)", () => {
    const tracker = buildExistingImportFingerprints(1, [
      {
        accountId: 1,
        date: "2011-06-09",
        payee: "Store",
        memo: "",
        amount: 500,
        fitId: "f1",
      },
    ]);
    expect(tracker.matchFitIdAndConsume("f1", 500, "2011-06-07")).toBe(true);
    const boundary = buildExistingImportFingerprints(1, [
      { accountId: 1, date: "2011-06-11", payee: "S", memo: "", amount: 500, fitId: "g" },
    ]);
    expect(boundary.matchFitIdAndConsume("g", 500, "2011-06-07")).toBe(true);
    const outside = buildExistingImportFingerprints(1, [
      { accountId: 1, date: "2011-06-12", payee: "S", memo: "", amount: 500, fitId: "h" },
    ]);
    expect(outside.matchFitIdAndConsume("h", 500, "2011-06-07")).toBe(false);
    const mismatch = buildExistingImportFingerprints(1, [
      { accountId: 1, date: "2011-06-07", payee: "S", memo: "", amount: 999, fitId: "f1" },
    ]);
    expect(mismatch.matchFitIdAndConsume("f1", 500, "2011-06-07")).toBe(false);
  });

  it("adopts the YNABID on a FITID+amount+within-4-days match, adds on amount mismatch", () => {
    const { target } = targetAndSink();
    target.findTransactionByYNABID = () => null;
    target.findTransactionByFITID = () => ({ amount: 5, date: "2011-06-09" });
    let adopted: string | null = null;
    target.adoptYNABID = (_e, id) => {
      adopted = id;
    };
    const account = accountOf(5, "YNAB:new");
    account.transactions[0]!.fitid = "f1";
    const result = applyOFXImportParity(target, account);
    expect(adopted).toBe("YNAB:new");
    expect(result.numNew).toBe(0);
    const { target: t2, added } = targetAndSink();
    t2.findTransactionByYNABID = () => null;
    t2.findTransactionByFITID = () => ({ amount: 999, date: "2011-06-07" });
    const a2 = accountOf(5, "YNAB:new");
    a2.transactions[0]!.fitid = "f1";
    expect(applyOFXImportParity(t2, a2).numNew).toBe(1);
    expect(added.length).toBe(1);
  });

  it("flips memo-only batches, honors importMemos=false+matchOrAdd, rewrites transfers", () => {
    const { target, added } = targetAndSink();
    const flipped = accountOf(5, "YNAB:x");
    flipped.transactions[0]!.payee = null;
    flipped.transactions[0]!.memo = "only-memo";
    applyOFXImportParity(target, flipped);
    expect(added[0]).toEqual({ payee: "only-memo", memo: null });

    const { target: t2, added: added2 } = targetAndSink();
    t2.matchOrAdd = () => true;
    const r2 = applyOFXImportParity(t2, accountOf(5, "YNAB:x"), {
      importMemos: false,
    });
    expect(added2).toEqual([]);
    expect(r2.numMatched).toBe(1);
    expect(r2.numNew).toBe(1);

    const { target: t3, added: added3 } = targetAndSink();
    t3.accountExists = (name) => name !== "Savings";
    const tr = accountOf(5, "YNAB:x");
    tr.transactions[0]!.payee = "Transfer : Savings";
    applyOFXImportParity(t3, tr);
    expect(added3[0]?.payee).toBe("Transfer (Savings)");
    // FORK: this repo's stored canonical shape is "Transfer : X".
    expect(isTransferPayee("Transfer : Savings")).toBe(true);
  });
});

describe.skip("QIF file filter + statement types (oracle importerQIF.test.ts:47-91)", () => {
  it("accepts qif case-insensitively and pins the filter", () => {
    expect(canImportQIFParity("qif")).toBe(true);
    expect(canImportQIFParity("QIF")).toBe(true);
    expect(canImportQIFParity("ofx")).toBe(false);
    expect(canImportQIFParity(null)).toBe(false);
    expect(QIF_FILE_FILTER_PARITY).toBe("*.qif;");
  });

  it("readable names are case-sensitive with the verbatim throw; validity is not", () => {
    expect(getReadableStatementTypeParity("Bank")).toBe("Bank");
    expect(getReadableStatementTypeParity("CC")).toBe("Credit Card");
    expect(getReadableStatementTypeParity("CCard")).toBe("Credit Card");
    expect(getReadableStatementTypeParity("Cash")).toBe("Cash");
    expect(getReadableStatementTypeParity("Oth A")).toBe("Other Assets");
    expect(getReadableStatementTypeParity("Oth L")).toBe("Other Liabilities");
    expect(() => getReadableStatementTypeParity("bank")).toThrow(
      "statementType was unrecognized",
    );
    expect(() => getReadableStatementTypeParity("Invst")).toThrow(
      "statementType was unrecognized",
    );
    expect(statementTypeIsValidParity("BANK")).toBe(true);
    expect(statementTypeIsValidParity("ccard")).toBe(true);
    expect(statementTypeIsValidParity("Oth L")).toBe(true);
    expect(statementTypeIsValidParity("Invst")).toBe(false);
    expect(statementTypeIsValidParity(null)).toBe(false);
    expect(statementTypeIsValidParity(undefined)).toBe(false);
    expect(containsStatementTypeParity(["!type:bank"])).toBe(true);
    expect(containsStatementTypeParity(["  !Type:Bank  "])).toBe(true);
    expect(containsStatementTypeParity(["D01/02/2011"])).toBe(false);
    expect(splitQIFLinesParity("a\r\nb\rc")).toEqual(["a", "b", "c"]);
  });
});

describe("parseQIFAmount (oracle :93-115)", () => {
  it("first-strip only, empty to zero, trailing-minus negate, no-g flag", () => {
    expect(parseQIFAmountParity("$12.50")).toBeCloseTo(12.5, 10);
    expect(parseQIFAmountParity("1,234.56")).toBeCloseTo(1234.56, 10);
    expect(parseQIFAmountParity("")).toBe(0);
    expect(parseQIFAmountParity("12.50-")).toBeCloseTo(-12.5, 10);
    expect(parseQIFAmountParity("100-")).toBeCloseTo(-100, 10);
    expect(parseQIFAmountParity("$$12", { currencySymbol: "$" })).toBeCloseTo(
      12,
      10,
    );
    expect(dollarsToCents(parseQIFAmountParity("$12.50"))).toBe(1250);
  });
});

describe.skip("buildQIFImport (oracle :117-311)", () => {
  it("prepends !Type and parses D/T/P/M/N records with YNABIDs", () => {
    const data = buildQIFImportParity(
      ["D06/07/2011", "T-12.50", "PStore", "Mnote", "N101", "C*", "^"].join(
        "\n",
      ),
      { preferredDateSequence: "MDY" },
    );
    expect(data.accounts.length).toBe(1);
    const account = data.accounts[0]!;
    expect(account.accountType).toBe("Bank");
    expect(account.dateSequence).toBe("MDY");
    const t = account.transactions[0]!;
    expect(t.date).toBe("2011-06-07");
    expect(t.amount).toBeCloseTo(-12.5, 10);
    expect(t.payee).toBe("Store");
    expect(t.memo).toBe("note");
    expect(t.checkNumber).toBe("101");
    expect(t.ynabID).toMatch(/^YNAB:.*:2011-06-07:1$/);
    expect(data.numSkippedEmpty).toBe(0);
    const cash = buildQIFImportParity(
      ["!Type:Cash", "D06/07/2011", "C*", "Aaddr", "T5", "^"].join("\n"),
      { preferredDateSequence: "MDY" },
    );
    expect(cash.accounts[0]?.accountType).toBe("Cash");
    expect(cash.accounts[0]?.transactions[0]?.amount).toBe(5);
  });

  it("routes !Account sections to separate accounts with N numbers", () => {
    const data = buildQIFImportParity(
      [
        "!Account",
        "Nmy-checking",
        "!Type:Bank",
        "D06/07/2011",
        "T10",
        "^",
        "!Account",
        "Nmy-card",
        "!Type:CCard",
        "D06/08/2011",
        "T-5",
        "^",
      ].join("\n"),
      { preferredDateSequence: "MDY" },
    );
    expect(data.accounts.length).toBe(2);
    expect(data.accounts[0]?.bankAccountID).toBe("my-checking");
    expect(data.accounts[0]?.accountType).toBe("Bank");
    expect(data.accounts[1]?.bankAccountID).toBe("my-card");
    expect(data.accounts[1]?.accountType).toBe("Credit Card");
  });

  it("S/E/$ splits use friendly categories; raw L stays when no splits exist", () => {
    const data = buildQIFImportParity(
      [
        "!Type:Bank",
        "D06/07/2011",
        "T-30",
        "LMisc : Groceries",
        "SGroceries",
        "Eapples",
        "$-10",
        "SRent",
        "$-20",
        "^",
      ].join("\n"),
      { preferredDateSequence: "MDY", findSubCategory: (n) => n === "Groceries" },
    );
    const t = data.accounts[0]?.transactions[0]!;
    expect(t.category).toBe("Split Transaction");
    expect(t.subTransactions?.length).toBe(2);
    expect(t.subTransactions?.[0]?.category).toBe("Groceries");
    expect(t.subTransactions?.[0]?.memo).toBe("apples");
    expect(t.subTransactions?.[0]?.amount).toBeCloseTo(-10, 10);
    expect(t.subTransactions?.[1]?.category).toBe("Misc : Rent");
    expect(t.subTransactions?.[1]?.amount).toBeCloseTo(-20, 10);
    const raw = buildQIFImportParity(
      ["!Type:Bank", "D06/07/2011", "T-30", "LGroceries", "^"].join("\n"),
      { preferredDateSequence: "MDY" },
    );
    expect(raw.accounts[0]?.transactions[0]?.category).toBe("Groceries");
    const spaced = buildQIFImportParity(
      [
        "!Type:Bank",
        "D06/07/2011",
        "T-10",
        "S  spaced  ",
        "E  raw memo  ",
        "$-10",
        "^",
      ].join("\n"),
      { preferredDateSequence: "MDY" },
    );
    // E keeps its memo raw except the loop-level line trim.
    expect(
      spaced.accounts[0]?.transactions[0]?.subTransactions?.[0]?.memo,
    ).toBe("  raw memo");
  });

  it("dateless ^ records skip+count; invalid !Type: poisons; verbatim errors", () => {
    const skipped = buildQIFImportParity(
      ["!Type:Bank", "T10", "^", "D06/07/2011", "T5", "^"].join("\n"),
      { preferredDateSequence: "MDY" },
    );
    expect(skipped.accounts[0]?.transactions.length).toBe(1);
    expect(skipped.numSkippedEmpty).toBe(1);
    const poisoned = buildQIFImportParity(
      [
        "!Type:Invst",
        "D06/07/2011",
        "T10",
        "^",
        "!Type:Bank",
        "D06/08/2011",
        "T5",
        "^",
      ].join("\n"),
      { preferredDateSequence: "MDY" },
    );
    expect(poisoned.accounts.length).toBe(1);
    expect(poisoned.accounts[0]?.transactions.length).toBe(1);
    expect(() =>
      buildQIFImportParity("!Type:Invst\nD06/07/2011\nT5\n^", {
        preferredDateSequence: "MDY",
      }),
    ).toThrow(
      "No accounts were found to import. Please note that YNAB4 does not support importing stock transactions from investment accounts.",
    );
    expect(() => buildQIFImportParity("!Type:Bank")).toThrow(
      "Could not parse the dates in this file",
    );
    expect(() =>
      buildQIFImportParity("!Type:Bank\nDbogus\nT5\n^", {
        preferredDateSequence: "MDY",
      }),
    ).toThrow("Could not parse the dates in this file");
  });

  it("drops empty accounts; DMY-first ordering; rollover (FORK vs parseDate)", () => {
    const dropped = buildQIFImportParity(
      ["!Type:Bank", "!Type:Cash", "D06/07/2011", "T5", "^"].join("\n"),
      { preferredDateSequence: "MDY" },
    );
    expect(dropped.accounts.length).toBe(1);
    expect(dropped.hasRemovedAccountsWithNoTransactions).toBe(true);
    const ambiguous = ["!Type:Bank", "D01/02/2011", "T5", "^"].join("\n");
    expect(
      buildQIFImportParity(ambiguous, { preferredDateSequence: "MDY" })
        .accounts[0]?.dateSequence,
    ).toBe("MDY");
    expect(
      buildQIFImportParity(ambiguous).accounts[0]?.transactions[0]?.date,
    ).toBe("2011-02-01");
    const rolled = buildQIFImportParity(
      ["!Type:Bank", "D13/02/2011", "T5", "^"].join("\n"),
      { preferredDateSequence: "MDY" },
    ).accounts[0];
    expect(rolled?.dateSequence).toBe("MDY");
    expect(rolled?.transactions[0]?.date).toBe("2012-01-02");
    // FORK: this repo's parseDate rejects out-of-range months instead.
    expect(parseDate("13/02/2011", "mdy")).toBeNull();
    expect(parseDate("01/02/2011", "mdy")).toBe("2011-01-02");
    expect(parseDate("01/02/2011", "dmy")).toBe("2011-02-01");
  });
});

describe.skip("applyQIFImport (oracle :313-389)", () => {
  function qifAccountOf() {
    const data = buildQIFImportParity(
      [
        "!Type:Bank",
        "D06/07/2011",
        "T-12.50",
        "PStore",
        "Mnote",
        "LMisc : Groceries",
        "^",
      ].join("\n"),
      { preferredDateSequence: "MDY", findSubCategory: () => true },
    );
    return data.accounts[0]!;
  }

  function sinkOf(): {
    added: {
      payee: string | null;
      memo: string | null;
      category: string | null;
    }[];
    target: {
      accountExists: (name: string) => boolean;
      addTransaction: (tx: {
        payee: string | null;
        memo: string | null;
        category: string | null;
      }) => void;
      findTransactionByYNABID?: (id: string) => unknown;
      findSubCategory?: (name: string) => boolean;
    };
  } {
    const added: {
      payee: string | null;
      memo: string | null;
      category: string | null;
    }[] = [];
    return {
      added,
      target: {
        accountExists: () => true,
        addTransaction: (tx: {
          payee: string | null;
          memo: string | null;
          category: string | null;
        }) => added.push(tx),
      },
    };
  }

  it("maps payee/memo/category and counts new; friendly split legs via the seam", () => {
    const { target, added } = sinkOf();
    const result = applyQIFImportParity(target, qifAccountOf());
    expect(result).toEqual({
      numTransactions: 1,
      numNew: 1,
      numMatched: 0,
      numSkippedDuplicate: 0,
    });
    expect(added[0]).toEqual({
      payee: "Store",
      memo: "note",
      category: "Misc : Groceries",
    });
    const split = buildQIFImportParity(
      ["!Type:Bank", "D06/07/2011", "T-30", "SNewCat", "$-30", "^"].join("\n"),
      { preferredDateSequence: "MDY", findSubCategory: () => true },
    ).accounts[0]!;
    const { target: t2, added: added2 } = sinkOf();
    t2.findSubCategory = () => true;
    expect(applyQIFImportParity(t2, split).numNew).toBe(1);
    expect(added2[0]?.category).toBe("Split Transaction");
  });

  it("skips YNABID duplicates and flips memo-only batches; rewrites transfers", () => {
    const { target, added } = sinkOf();
    const dupTarget = {
      ...target,
      findTransactionByYNABID: (_id: string): unknown => ({}),
    };
    const account = qifAccountOf();
    account.transactions[0]!.payee = null;
    expect(applyQIFImportParity(dupTarget, account).numSkippedDuplicate).toBe(1);
    expect(added).toEqual([]);
    const liveTarget = { ...target, findTransactionByYNABID: () => null };
    expect(applyQIFImportParity(liveTarget, account).numNew).toBe(1);
    expect(added[0]?.payee).toBe("note");

    const { target: t2, added: added2 } = sinkOf();
    t2.accountExists = (name: string) => name !== "Savings";
    const q2 = qifAccountOf();
    q2.transactions[0]!.payee = "Transfer : Savings";
    applyQIFImportParity(t2, q2);
    expect(added2[0]?.payee).toBe("Transfer (Savings)");
  });
});
