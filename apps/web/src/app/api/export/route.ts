import { NextRequest } from "next/server";
import { getDefaultDb, exportYnab4Zip, getBudgetData } from "@ynab/server";
import { num } from "@ynab/logic";

export const dynamic = "force-dynamic";

/** Our flag enum → YNAB4 colour name (round-trip with .y4backup import). */
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
  const s = String(val);
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

export async function GET(req: NextRequest) {
  try {
    const format = req.nextUrl?.searchParams?.get("format")?.toLowerCase();
    const db = getDefaultDb();
    const today = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      const data = await getBudgetData(db);
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="liquid-budget-${today}.json"`,
        },
      });
    }

    if (format === "sqlite" || format === "db") {
      try {
        db.$client.pragma("wal_checkpoint(TRUNCATE)");
      } catch (e) {
        console.warn("[export] wal_checkpoint failed:", e);
      }
      const buffer = db.$client.serialize();
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type": "application/x-sqlite3",
          "Content-Disposition": `attachment; filename="budget-${today}.db"`,
        },
      });
    }

    if (format === "csv") {
      const data = await getBudgetData(db);
      const lines: string[] = [];

      // Accounts
      lines.push(csvLine(["Type", "ID", "Name", "Kind", "Group", "Balance", "On Budget", "Archived", "Notes"]));
      for (const a of data.accounts) {
        lines.push(csvLine(["Account", a.id, a.name, a.kind, a.groupLabel, formatCents(a.balance), a.onBudget ? "Y" : "N", a.archived ? "Y" : "N", (a as { notes?: string | null }).notes ?? ""]));
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
          t.transferAccountId ?? "", t.parentId ?? "", t.isIncome ? "Y" : "N"
        ]));
      }

      lines.push("");

      // Recurring
      lines.push(csvLine(["Type", "ID", "AccountID", "CategoryID", "Payee", "Amount", "Frequency", "NextDate", "Active", "TransferAccountID"]));
      for (const r of data.recurring) {
        lines.push(csvLine([
          "Recurring", r.id, r.accountId, r.categoryId ?? "", r.payee,
          formatCents(r.amount), r.frequency, r.nextDate, r.active ? "Y" : "N",
          r.transferAccountId ?? ""
        ]));
      }

      const csv = lines.join("");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="liquid-budget-${today}.csv"`,
        },
      });
    }

    const buffer = await exportYnab4Zip(db);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="budget-${today}.y4backup"`,
      },
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Failed to export data" },
      { status: 500 }
    );
  }
}