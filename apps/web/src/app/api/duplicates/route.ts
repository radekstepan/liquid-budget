import { NextResponse } from "next/server";
import { analyzeUnflaggedDuplicates, getDefaultDb } from "@ynab/server";

export const dynamic = "force-dynamic";

/**
 * Analyze the whole database for duplicate transactions. Any unflagged
 * duplicates are flagged yellow so they stand out in the register;
 * duplicates that already carry a flag or are reconciled are reported
 * but left untouched. The full report is returned to the client.
 */
export async function POST() {
  try {
    const db = getDefaultDb();
    const result = await analyzeUnflaggedDuplicates(db);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[duplicates] Error:", e);
    return NextResponse.json({ error: e.message || "Failed to analyze duplicates" }, { status: 500 });
  }
}
