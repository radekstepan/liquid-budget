import { NextRequest, NextResponse } from "next/server";
import { getDefaultDb, importCsvTransactions, TransactionError } from "@ynab/server";
import { parseCsvImport } from "@ynab/logic";
import { z } from "zod";
import { formatZodError } from "../../schemas";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  accountId: z.number().int().positive(),
  swap: z.boolean().optional().default(false),
  dateFormat: z.enum(["auto", "dmy", "mdy"]).optional().default("auto"),
  csv: z.string().min(1),
});

export async function POST(req: NextRequest) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  const { accountId, swap, dateFormat, csv } = parsed.data;
  const result = parseCsvImport(csv, { swap, dateFormat });
  if (result.headerError) {
    return NextResponse.json({ error: result.headerError }, { status: 400 });
  }
  const db = getDefaultDb();
  try {
    const out = await importCsvTransactions(db, { accountId, rows: result.rows });
    return NextResponse.json({ ok: true, imported: out.count, skipped: out.skipped });
  } catch (e) {
    if (e instanceof TransactionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[import/csv] Error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}