import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getDefaultDb, importCsvTransactions, TransactionError } from "@ynab/server";
import { parseCsvImport } from "@ynab/logic";
import { z } from "zod";
import { apiErrorResponse } from "../../errors";
import { formatZodError } from "../../schemas";
import { mutationGuardResponse } from "../../guard";
import { createScopedLogger, toLogDetails } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createScopedLogger("import/csv");

const BodySchema = z.object({
  accountId: z.number().int().positive(),
  swap: z.boolean().optional().default(false),
  dateFormat: z.enum(["auto", "dmy", "mdy"]).optional().default("auto"),
  // ~5MB: caps memory and the single-transaction lock-hold time of the import.
  csv: z.string().min(1).max(5_000_000),
});

export const MAX_CSV_CONTENT_LENGTH = 6 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CSV_CONTENT_LENGTH) {
    return NextResponse.json({ error: "CSV upload exceeds the size limit" }, { status: 413 });
  }
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
    log.error("Error:", toLogDetails(e));
    return apiErrorResponse(e);
  }
}