import { num } from "@ynab/logic";
import { getDbMutex, type Db } from "./client.js";
import { getBudgetData } from "./queries/budget.js";

export type BudgetExport = {
  body: string | Uint8Array;
  contentType: string;
  filename: string;
};

function todayStamp(today?: string): string {
  return today ?? new Date().toISOString().slice(0, 10);
}

/** YNAB4 colour name for our flag enum (round-trip with .y4backup import). */
const FLAG_NAME: Record<string, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
};

function csvEscape(val: string | number | null | undefined): string {
  if (val == null) return "";
  let s = String(val);
  // OWASP CSV injection defense: neutralise formula prefixes. Quoting alone
  // does not stop Excel/Sheets evaluating `=cmd`-style cells, so prefix with `'`.
  // Numeric cells (amounts/balances/ids) are exempt — a leading `-` there is a
  // negative number, not a formula, and must round-trip exactly.
  const isNumeric = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s.trim());
  if (!isNumeric && /^[=+@\t\r-]/.test(s)) s = `'${s}`;
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvLine(fields: (string | number | null | undefined)[]): string {
  return fields.map(csvEscape).join(",") + "\n";
}

function formatCents(cents: number | string | null | undefined): string {
  if (cents == null) return "0.00";
  return (num(cents) / 100).toFixed(2);
}

/** Full budget dump as pretty-printed JSON (same payload as GET /api/budget). */
export async function exportBudgetJson(db: Db, today?: string): Promise<BudgetExport> {
  const stamp = todayStamp(today);
  const data = await getBudgetData(db);
  return {
    body: JSON.stringify(data, null, 2),
    contentType: "application/json; charset=utf-8",
    filename: `liquid-budget-${stamp}.json`,
  };
}

/**
 * Consistent binary copy of the live database. Serialized under the
 * connection mutex (checkpoint + serialize) so a concurrent
 * CSV-import/reconcile write cannot tear the image.
 */
export async function exportBudgetSqlite(db: Db, today?: string): Promise<BudgetExport> {
  const stamp = todayStamp(today);
  const release = await getDbMutex(db).acquire();
  try {
    try {
      db.$client.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort; serialize still reads a consistent image without it.
    }
    const buffer = db.$client.serialize();
    return {
      body: new Uint8Array(buffer),
      contentType: "application/x-sqlite3",
      filename: `budget-${stamp}.db`,
    };
  } finally {
    release();
  }
}

/** Multi-section CSV dump (accounts, groups, categories, assignments, transactions, recurring). */
export async function exportBudgetCsv(db: Db, today?: string): Promise<BudgetExport> {
  const stamp = todayStamp(today);
  const data = await getBudgetData(db);
  const lines: string[] = [];

  // Accounts
  lines.push(csvLine(["Type", "ID", "Name", "Kind", "Group", "Balance", "On Budget", "Archived", "Notes"]));
  for (const a of data.accounts) {
    lines.push(csvLine(["Account", a.id, a.name, a.kind, a.groupLabel, formatCents(a.balance), a.onBudget ? "Y" : "N", a.archived ? "Y" : "N", a.notes ?? ""]));
  }

  lines.push("");

  // Category Groups
  lines.push(csvLine(["Type", "ID", "Name", "Sort", "CC Payments", "Hidden"]));
  for (const g of data.groups) {
    lines.push(csvLine(["Group", g.id, g.name, g.sort, g.isCreditCardPayments ? "Y" : "N", g.isHidden ? "Y" : "N"]));
  }

  lines.push("");

  // Categories
  lines.push(csvLine(["Type", "ID", "GroupID", "Name", "Sort", "Carryover", "Goal", "LinkedAccountID"]));
  for (const c of data.categories) {
    lines.push(csvLine(["Category", c.id, c.groupId, c.name, c.sort, formatCents(c.carryover), c.goalTarget != null ? formatCents(c.goalTarget) : "", c.linkedAccountId ?? ""]));
  }

  lines.push("");

  // Assignments
  lines.push(csvLine(["Type", "ID", "CategoryID", "Month", "Amount"]));
  for (const a of data.assignments) {
    lines.push(csvLine(["Assignment", a.id, a.categoryId, a.month, formatCents(a.amount)]));
  }

  lines.push("");

  // Transactions
  lines.push(csvLine(["Type", "ID", "AccountID", "CategoryID", "Date", "Payee", "Memo", "Amount", "Status", "Flag", "TransferAccountID", "ParentID", "IsIncome"]));
  for (const t of data.transactions) {
    lines.push(csvLine([
      "Transaction", t.id, t.accountId, t.categoryId ?? "", t.date,
      t.payee, t.memo, formatCents(t.amount), t.status,
      t.flagColor ? (FLAG_NAME[t.flagColor] ?? "") : "",
      t.transferAccountId ?? "", t.parentId ?? "", t.isIncome ? "Y" : "N",
    ]));
  }

  lines.push("");

  // Recurring
  lines.push(csvLine(["Type", "ID", "AccountID", "CategoryID", "Payee", "Amount", "Frequency", "NextDate", "Active", "TransferAccountID"]));
  for (const r of data.recurring) {
    lines.push(csvLine([
      "Recurring", r.id, r.accountId, r.categoryId ?? "", r.payee,
      formatCents(r.amount), r.frequency, r.nextDate, r.active ? "Y" : "N",
      r.transferAccountId ?? "",
    ]));
  }

  return {
    body: lines.join(""),
    contentType: "text/csv; charset=utf-8",
    filename: `liquid-budget-${stamp}.csv`,
  };
}
