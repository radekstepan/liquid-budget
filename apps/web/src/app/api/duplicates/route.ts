import { NextResponse } from "next/server";
import { analyzeUnflaggedDuplicates, getDefaultDb } from "@ynab/server";
import { apiErrorResponse } from "../errors";
import { mutationGuardResponse } from "../guard";
import { createScopedLogger, toLogDetails } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createScopedLogger("duplicates");

/**
 * Analyze the whole database for duplicate transactions. Any unflagged
 * duplicates are flagged yellow so they stand out in the register;
 * duplicates that already carry a flag or are reconciled are reported
 * but left untouched. The full report is returned to the client.
 */
export async function POST(req?: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  try {
    const db = getDefaultDb();
    const result = await analyzeUnflaggedDuplicates(db);
    return NextResponse.json(result);
  } catch (e) {
    log.error("Error:", toLogDetails(e));
    return apiErrorResponse(e);
  }
}
