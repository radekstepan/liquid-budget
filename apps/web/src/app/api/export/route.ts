import { NextRequest } from "next/server";
import { getDefaultDb, getBudgetData } from "@ynab/server";
import { num } from "@ynab/logic";

export const dynamic = "force-dynamic";

function csvEscape(val: string | number): string {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvLine(fields: (string | number)[]): string {
  return fields.map(csvEscape).join(",") + "\n";
}

export async function GET(req: NextRequest) {
  try {
    const format = req.nextUrl?.searchParams?.get("format")?.toLowerCase() ?? "csv";
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
      const buffer = db.$client.serialize();
      return new Response(buffer, {
        headers: {
          "Content-Type": "application/x-sqlite3",
          "Content-Disposition": `attachment; filename="budget-${today}.db"`,
        },
      });
    }

    const data = await getBudgetData(db);

    const lines: string[] = [];

    // Accounts
    lines.push(csvLine(["Type", "ID", "Name", "Kind", "Group", "Balance", "On Budget", "Archived"]));
    for (const a of data.accounts) {
      lines.push(csvLine(["Account", a.id, a.name, a.kind, a.groupLabel, num(a.balance), a.onBudget ? "Y" : "N", a.archived ? "Y" : "N"]));
    }

    lines.push("");

    // Category Groups
    lines.push(csvLine(["Type", "ID", "Name", "Sort", "CC Payments"]));
    for (const g of data.groups) {
      lines.push(csvLine(["Group", g.id, g.name, g.sort, g.isCreditCardPayments ? "Y" : "N"]));
    }

    lines.push("");

    // Categories
    lines.push(csvLine(["Type", "ID", "GroupID", "Name", "Sort", "Carryover", "Goal", "LinkedAccountID"]));
    for (const c of data.categories) {
      lines.push(csvLine(["Category", c.id, c.groupId, c.name, c.sort, num(c.carryover), c.goalTarget ?? "", c.linkedAccountId ?? ""]));
    }

    lines.push("");

    // Assignments
    lines.push(csvLine(["Type", "ID", "CategoryID", "Month", "Amount"]));
    for (const a of data.assignments) {
      lines.push(csvLine(["Assignment", a.id, a.categoryId, a.month, num(a.amount)]));
    }

    lines.push("");

    // Transactions
    lines.push(csvLine(["Type", "ID", "AccountID", "CategoryID", "Date", "Payee", "Memo", "Amount", "Status", "TransferAccountID", "ParentID", "IsIncome"]));
    for (const t of data.transactions) {
      lines.push(csvLine([
        "Transaction", t.id, t.accountId, t.categoryId ?? "", t.date,
        t.payee, t.memo, num(t.amount), t.status,
        t.transferAccountId ?? "", t.parentId ?? "", t.isIncome ? "Y" : "N"
      ]));
    }

    lines.push("");

    // Recurring
    lines.push(csvLine(["Type", "ID", "AccountID", "CategoryID", "Payee", "Amount", "Frequency", "NextDate", "Active", "TransferAccountID"]));
    for (const r of data.recurring) {
      lines.push(csvLine([
        "Recurring", r.id, r.accountId, r.categoryId ?? "", r.payee,
        num(r.amount), r.frequency, r.nextDate, r.active ? "Y" : "N",
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
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Failed to export data" },
      { status: 500 }
    );
  }
}