import { MONTHS, MONTHS_LONG, dollarsToCents } from "./format.js";

export type CsvImportRow = {
  rowNumber: number;
  date: string | null;
  payee: string;
  memo: string;
  category: string;
  amountCents: number | null;
  error: string | null;
};

export type DateFormatConvention = "dmy" | "mdy";

export type CsvImportOptions = {
  swap?: boolean;
  dateFormat?: "auto" | "dmy" | "mdy";
};

export type CsvImportResult = {
  headerError: string | null;
  rows: CsvImportRow[];
  detectedDateFormat?: DateFormatConvention;
};

const MONTH_MAP = new Map<string, number>();
MONTHS.forEach((m, idx) => {
  MONTH_MAP.set(m.toLowerCase(), idx + 1);
});
MONTHS_LONG.forEach((m, idx) => {
  MONTH_MAP.set(m.toLowerCase(), idx + 1);
});
MONTH_MAP.set("sept", 9);

function parseMonthName(str: string): number | null {
  const clean = str.replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (MONTH_MAP.has(clean)) return MONTH_MAP.get(clean)!;
  if (clean.length >= 3) {
    const short = clean.slice(0, 3);
    if (MONTH_MAP.has(short)) return MONTH_MAP.get(short)!;
  }
  return null;
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let currentLine = 1;
  let quoteStartLine = 1;
  const s = text.replace(/^\uFEFF/, "");
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        currentLine += 1;
      } else if (ch === "\r") {
        if (s[i + 1] === "\n") {
          currentLine += 1;
          cell += ch;
          cell += s[i + 1]!;
          i += 2;
          continue;
        } else {
          currentLine += 1;
        }
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      quoteStartLine = currentLine;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      currentLine += 1;
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
    continue;
  }
  if (inQuotes) {
    throw new Error(`Unclosed quote in CSV on line ${quoteStartLine}`);
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function analyzeHeader(rawHeader: string[]) {
  const header = rawHeader.map((h) => normHeader(h));
  let dateIdx = -1;
  let payeeCandidate = -1;
  let memoCandidate = -1;
  let descCandidate = -1;
  let categoryIdx = -1;
  let outflowIdx = -1;
  let inflowIdx = -1;
  let amountIdx = -1;
  let typeIdx = -1;

  header.forEach((h, i) => {
    if (h === "type") {
      typeIdx = i;
      return;
    }
    if (h.includes("type") || h.includes("method")) return;
    if (dateIdx < 0 && h.includes("date")) dateIdx = i;
    else if (payeeCandidate < 0 && (h.includes("payee") || h.includes("merchant") || h.includes("vendor"))) payeeCandidate = i;
    else if (memoCandidate < 0 && (h.includes("memo") || h.includes("note"))) memoCandidate = i;
    else if (descCandidate < 0 && (h.includes("description") || h.includes("details") || h.includes("narrative"))) descCandidate = i;
    else if (categoryIdx < 0 && h.includes("categor")) categoryIdx = i;
    else if (amountIdx < 0 && (h === "amount" || h === "value")) amountIdx = i;
    else if (outflowIdx < 0 && /outflow|debit|withdrawal|expense|spent/.test(h)) outflowIdx = i;
    else if (inflowIdx < 0 && /inflow|credit|deposit|income|received/.test(h)) inflowIdx = i;
    else if (amountIdx < 0 && (h.includes("amount") || h.includes("value"))) amountIdx = i;
    else if (outflowIdx < 0 && /payment/.test(h)) outflowIdx = i;
  });

  let payeeIdx = -1;
  let memoIdx = -1;
  if (payeeCandidate >= 0) {
    payeeIdx = payeeCandidate;
    if (memoCandidate >= 0) {
      memoIdx = memoCandidate;
    } else if (descCandidate >= 0) {
      memoIdx = descCandidate;
    }
  } else if (descCandidate >= 0) {
    payeeIdx = descCandidate;
    if (memoCandidate >= 0) {
      memoIdx = memoCandidate;
    }
  } else if (memoCandidate >= 0) {
    payeeIdx = memoCandidate;
  }

  const isValid = dateIdx >= 0 && payeeIdx >= 0 && (outflowIdx >= 0 || inflowIdx >= 0 || amountIdx >= 0);

  return {
    dateIdx,
    payeeIdx,
    memoIdx,
    categoryIdx,
    outflowIdx,
    inflowIdx,
    amountIdx,
    typeIdx,
    isValid,
  };
}

function toISO(y: string, mo: string, d: string): string | null {
  const Y = Number(y);
  const M = Number(mo);
  const D = Number(d);
  if (!Number.isInteger(Y) || !Number.isInteger(M) || !Number.isInteger(D)) return null;
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  const dt = new Date(Date.UTC(Y, M - 1, D));
  if (dt.getUTCFullYear() !== Y || dt.getUTCMonth() !== M - 1 || dt.getUTCDate() !== D) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Y}-${pad(M)}-${pad(D)}`;
}

export function detectDateFormat(
  rows: string[][],
  dateIdx: number,
  headerIdx: number = 0,
  isMultiSection: boolean = false
): DateFormatConvention {
  let dmyVotes = 0;
  let mdyVotes = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells || cells.every((c) => c.trim() === "")) continue;
    if (isMultiSection && cells[0]?.trim().toLowerCase() !== "transaction") continue;
    const raw = (cells[dateIdx] ?? "").trim();
    if (!raw) continue;

    const mNum = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(raw);
    if (mNum) {
      const dmyValid = parseDate(raw, "dmy") != null;
      const mdyValid = parseDate(raw, "mdy") != null;
      if (dmyValid && !mdyValid) dmyVotes++;
      else if (mdyValid && !dmyValid) mdyVotes++;
      continue;
    }
    const mTextMDY = /^([a-zA-Z]+)\.?[-/.,\s]+(\d{1,2})(?:st|nd|rd|th)?[-/.,\s]+(\d{2,4})$/.exec(raw);
    if (mTextMDY && parseDate(raw) != null) {
      mdyVotes++;
      continue;
    }
    const mTextDMY = /^(\d{1,2})(?:st|nd|rd|th)?[-/.,\s]+([a-zA-Z]+)\.?[-/.,\s]+(\d{2,4})$/.exec(raw);
    if (mTextDMY && parseDate(raw) != null) {
      dmyVotes++;
      continue;
    }
  }
  return mdyVotes > dmyVotes ? "mdy" : "dmy";
}

export function parseDate(input: string, convention: DateFormatConvention = "dmy"): string | null {
  const t = input.trim();
  if (!t) return null;

  // Numeric ISO: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return toISO(m[1]!, m[2]!, m[3]!);

  // Numeric DMY / MDY: DD/MM/YYYY, MM/DD/YYYY, etc.
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t);
  if (m) {
    const n1 = Number(m[1]);
    const n2 = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const d = convention === "mdy" ? n2 : n1;
    const mo = convention === "mdy" ? n1 : n2;
    return toISO(String(y), String(mo), String(d));
  }

  // Text month: YYYY-Mon-DD (Year-first, e.g. 2026-Aug-15, 2026 August 15)
  m = /^(\d{4})[-/.,\s]+([a-zA-Z]+)\.?[-/.,\s]+(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (m) {
    const mo = parseMonthName(m[2]!);
    if (mo != null) return toISO(m[1]!, String(mo), m[3]!);
  }

  // Text month: Mon DD, YYYY (Month-first, e.g. Aug 15, 2026, Aug-15-2026, Aug 15 26)
  m = /^([a-zA-Z]+)\.?[-/.,\s]+(\d{1,2})(?:st|nd|rd|th)?[-/.,\s]+(\d{2,4})$/.exec(t);
  if (m) {
    const mo = parseMonthName(m[1]!);
    if (mo != null) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      return toISO(String(y), String(mo), m[2]!);
    }
  }

  // Text month: DD-Mon-YYYY (Day-first, e.g. 15-Aug-2026, 15-AUG-2026, 15 Aug 2026, 15-Aug-26)
  m = /^(\d{1,2})(?:st|nd|rd|th)?[-/.,\s]+([a-zA-Z]+)\.?[-/.,\s]+(\d{2,4})$/.exec(t);
  if (m) {
    const mo = parseMonthName(m[2]!);
    if (mo != null) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      return toISO(String(y), String(mo), m[1]!);
    }
  }

  return null;
}

export function parseAmount(input: string): number | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;

  // Currency symbols ($ € £ ¥)
  const currencyMatches = s.match(/[$€£¥]/g);
  if (currencyMatches && currencyMatches.length > 1) {
    return null; // Multiple currency symbols
  }

  let sign = 1;
  let isNegative = false;

  // 1. Optional leading/trailing sign or currency before parentheses
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  if (/^[$€£¥]/.test(s)) {
    s = s.slice(1).trim();
  } else if (/[$€£¥]$/.test(s)) {
    s = s.slice(0, -1).trim();
  }

  if (s.startsWith("-")) {
    if (sign === -1) return null;
    sign = -1;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  // 2. Parentheses (accounting format)
  if (s.startsWith("(") && s.endsWith(")")) {
    isNegative = true;
    s = s.slice(1, -1).trim();
  } else if (s.includes("(") || s.includes(")")) {
    return null; // Unbalanced or misplaced parentheses
  }

  // 3. Inside parentheses: optional sign or currency
  if (s.startsWith("-")) {
    if (sign === -1) return null;
    sign = -1;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  if (/^[$€£¥]/.test(s)) {
    s = s.slice(1).trim();
  } else if (/[$€£¥]$/.test(s)) {
    s = s.slice(0, -1).trim();
  }

  if (s.startsWith("-")) {
    if (sign === -1) return null;
    sign = -1;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  // If any remaining currency symbol or sign is embedded in the number, it's invalid (e.g. 1$2, 1-2, 1+)
  if (/[$€£¥+\-]/.test(s)) return null;
  if (!s) return null;

  let num: number;

  if (/^\d+$/.test(s)) {
    num = Number(s);
  } else if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    num = Number(s.replace(/,/g, ""));
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    num = Number(s.replace(/\./g, ""));
  } else if (/^\d{1,3}( \d{3})+$/.test(s)) {
    num = Number(s.replace(/ /g, ""));
  } else if (/^(\d*\.\d+|\d+\.)$/.test(s) && s !== ".") {
    num = Number(s);
  } else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) {
    num = Number(s.replace(/,/g, ""));
  } else if (/^\d{1,3}( \d{3})+\.\d+$/.test(s)) {
    num = Number(s.replace(/ /g, ""));
  } else if (/^(\d*,\d+|\d+,)$/.test(s) && s !== ",") {
    num = Number(s.replace(",", "."));
  } else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) {
    num = Number(s.replace(/\./g, "").replace(",", "."));
  } else if (/^\d{1,3}( \d{3})+,\d+$/.test(s)) {
    num = Number(s.replace(/ /g, "").replace(",", "."));
  } else {
    return null;
  }

  if (!Number.isFinite(num)) return null;

  const totalSign = (isNegative ? -1 : 1) * sign;
  const finalVal = totalSign * num;

  if (Math.abs(finalVal * 100) > Number.MAX_SAFE_INTEGER) return null;

  return finalVal === 0 ? 0 : finalVal;
}

function updatePayeeError(existingError: string | null, newPayee: string): string | null {
  const parts = existingError
    ? existingError.split("; ").filter((p) => p !== "Missing payee" && p.trim() !== "")
    : [];
  if (!newPayee.trim()) {
    parts.push("Missing payee");
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

export function swapPayeeMemo(rows: CsvImportRow[], swap?: boolean): CsvImportRow[] {
  if (!swap) return rows;
  return rows.map((r) => {
    const newPayee = r.memo;
    const newMemo = r.payee;
    return {
      ...r,
      payee: newPayee,
      memo: newMemo,
      error: updatePayeeError(r.error, newPayee),
    };
  });
}

export function parseCsvImport(text: string, opts?: CsvImportOptions): CsvImportResult {
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (err: any) {
    return { headerError: err?.message || "Invalid CSV", rows: [] };
  }

  let headerIdx = -1;
  let headerAnalysis: ReturnType<typeof analyzeHeader> | null = null;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.some((c) => c.trim() !== "")) {
      const analysis = analyzeHeader(rows[i]!);
      if (analysis.isValid) {
        headerIdx = i;
        headerAnalysis = analysis;
        break;
      }
    }
  }

  if (headerIdx < 0) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.some((c) => c.trim() !== "")) {
        headerIdx = i;
        headerAnalysis = analyzeHeader(rows[i]!);
        break;
      }
    }
  }

  if (rows.length === 0 || headerIdx < 0 || !headerAnalysis) {
    return { headerError: "The file is empty", rows: [] };
  }

  const { dateIdx, payeeIdx, memoIdx, categoryIdx, outflowIdx, inflowIdx, amountIdx, typeIdx } = headerAnalysis;
  const isMultiSection = typeIdx === 0;

  let headerError: string | null = null;
  if (dateIdx < 0) headerError = "Could not find a Date column";
  else if (payeeIdx < 0) headerError = "Could not find a Payee column";
  else if (outflowIdx < 0 && inflowIdx < 0 && amountIdx < 0)
    headerError = "Could not find an Outflow, Inflow, or Amount column";

  const convention: DateFormatConvention =
    opts?.dateFormat && opts.dateFormat !== "auto"
      ? opts.dateFormat
      : dateIdx >= 0
        ? detectDateFormat(rows, dateIdx, headerIdx, isMultiSection)
        : "dmy";

  const parsedRows: CsvImportRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i]!;
    if (cells.every((c) => c.trim() === "")) continue;
    if (isMultiSection && cells[0]?.trim().toLowerCase() !== "transaction") continue;
    const raw = (idx: number) => (idx >= 0 ? (cells[idx] ?? "").trim() : "");
    const payee = raw(payeeIdx);
    const memo = raw(memoIdx);
    const category = raw(categoryIdx);
    const date = parseDate(raw(dateIdx), convention);
    let error: string | null = null;
    if (!date) error = "Invalid date";
    let amt: number | null = null;
    let sawZero = false;
    if (outflowIdx >= 0) {
      const parsedOutflow = parseAmount(raw(outflowIdx));
      if (parsedOutflow != null) {
        if (parsedOutflow !== 0) {
          amt = -Math.abs(parsedOutflow);
        } else {
          sawZero = true;
        }
      }
    }
    if (amt == null && inflowIdx >= 0) {
      const parsedInflow = parseAmount(raw(inflowIdx));
      if (parsedInflow != null) {
        if (parsedInflow !== 0) {
          amt = Math.abs(parsedInflow);
        } else {
          sawZero = true;
        }
      }
    }
    if (amt == null && amountIdx >= 0) {
      const parsedAmount = parseAmount(raw(amountIdx));
      if (parsedAmount != null) {
        if (parsedAmount !== 0) {
          amt = parsedAmount;
        } else {
          sawZero = true;
        }
      }
    }
    if (amt == null && sawZero) {
      amt = 0;
    }
    if (amt == null) error = error ? `${error}; Invalid amount` : "Invalid amount";
    else if (amt === 0) error = error ? `${error}; Amount is zero` : "Amount is zero";
    if (!payee.trim()) error = error ? `${error}; Missing payee` : "Missing payee";
    parsedRows.push({
      rowNumber: i + 1,
      date,
      payee,
      memo,
      category,
      amountCents: amt == null ? null : dollarsToCents(amt),
      error,
    });
  }
  return {
    headerError,
    rows: opts?.swap ? swapPayeeMemo(parsedRows, true) : parsedRows,
    detectedDateFormat: convention,
  };
}