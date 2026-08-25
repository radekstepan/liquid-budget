export type CsvImportRow = {
  rowNumber: number;
  date: string | null;
  payee: string;
  memo: string;
  category: string;
  amountCents: number | null;
  error: string | null;
};

export type CsvImportResult = {
  headerError: string | null;
  rows: CsvImportRow[];
};

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
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
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
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
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
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

function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.some((c) => c.trim() !== "")) return i;
  }
  return -1;
}

function toISO(y: string, mo: string, d: string): string | null {
  const Y = Number(y);
  const M = Number(mo);
  const D = Number(d);
  const dt = new Date(Date.UTC(Y, M - 1, D));
  if (dt.getUTCFullYear() !== Y || dt.getUTCMonth() !== M - 1 || dt.getUTCDate() !== D) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Y}-${pad(M)}-${pad(D)}`;
}

function parseDate(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return toISO(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t);
  if (m) {
    let d = Number(m[1]);
    let mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (mo > 12) {
      const tmp = d;
      d = mo;
      mo = tmp;
    }
    return toISO(String(y), String(mo), String(d));
  }
  return null;
}

function parseAmount(input: string): number | null {
  let t = input.trim().replace(/[$ \u00a0\t]/g, "");
  if (!t) return null;
  let sign = 1;
  if (t.startsWith("-")) {
    sign = -1;
    t = t.slice(1);
  } else if (t.startsWith("+")) {
    t = t.slice(1);
  } else if (t.startsWith("(") && t.endsWith(")")) {
    sign = -1;
    t = t.slice(1, -1);
  }
  if (!t) return null;
  const hasComma = t.includes(",");
  const hasDot = t.includes(".");
  let num: number;
  if (hasComma && hasDot) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) {
      num = Number.parseFloat(t.replace(/\./g, "").replace(",", "."));
    } else {
      num = Number.parseFloat(t.replace(/,/g, ""));
    }
  } else if (hasComma && !hasDot) {
    num = /^\d{1,3}(,\d{3})+$/.test(t)
      ? Number.parseFloat(t.replace(/,/g, ""))
      : Number.parseFloat(t.replace(",", "."));
  } else {
    num = Number.parseFloat(t);
  }
  if (!Number.isFinite(num)) return null;
  return sign * num;
}

export function swapPayeeMemo(rows: CsvImportRow[], swap?: boolean): CsvImportRow[] {
  if (!swap) return rows;
  return rows.map((r) => ({ ...r, payee: r.memo, memo: r.payee }));
}

export function parseCsvImport(text: string, opts?: { swap?: boolean }): CsvImportResult {
  const rows = parseCsv(text);
  const headerIdx = findHeaderRow(rows);
  if (rows.length === 0 || headerIdx < 0) {
    return { headerError: "The file is empty", rows: [] };
  }
  const header = rows[headerIdx]!.map((h) => normHeader(h));
  let dateIdx = -1;
  let payeeIdx = -1;
  let memoIdx = -1;
  let categoryIdx = -1;
  let outflowIdx = -1;
  let inflowIdx = -1;
  let amountIdx = -1;
  header.forEach((h, i) => {
    if (dateIdx < 0 && h.includes("date")) dateIdx = i;
    else if (payeeIdx < 0 && h.includes("payee")) payeeIdx = i;
    else if (memoIdx < 0 && (h.includes("memo") || h.includes("note") || h.includes("description"))) memoIdx = i;
    else if (categoryIdx < 0 && h.includes("categor")) categoryIdx = i;
    else if (outflowIdx < 0 && /outflow|debit|withdrawal|payment|expense|spent/.test(h)) outflowIdx = i;
    else if (inflowIdx < 0 && /inflow|credit|deposit|income|received/.test(h)) inflowIdx = i;
    else if (amountIdx < 0 && (h.includes("amount") || h.includes("value"))) amountIdx = i;
  });
  if (payeeIdx < 0 && memoIdx >= 0) {
    payeeIdx = memoIdx;
    memoIdx = -1;
  }
  let headerError: string | null = null;
  if (dateIdx < 0) headerError = "Could not find a Date column";
  else if (payeeIdx < 0) headerError = "Could not find a Payee column";
  else if (outflowIdx < 0 && inflowIdx < 0 && amountIdx < 0)
    headerError = "Could not find an Outflow, Inflow, or Amount column";

  const parsedRows: CsvImportRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i]!;
    if (cells.every((c) => c.trim() === "")) continue;
    const raw = (idx: number) => (idx >= 0 ? (cells[idx] ?? "").trim() : "");
    const payee = raw(payeeIdx);
    const memo = raw(memoIdx);
    const category = raw(categoryIdx);
    const date = parseDate(raw(dateIdx));
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
    if (!payee && !memo) error = error ? `${error}; Missing payee` : "Missing payee";
    parsedRows.push({
      rowNumber: i + 1,
      date,
      payee,
      memo,
      category,
      amountCents: amt == null ? null : Math.round(amt * 100),
      error,
    });
  }
  return { headerError, rows: opts?.swap ? swapPayeeMemo(parsedRows, true) : parsedRows };
}