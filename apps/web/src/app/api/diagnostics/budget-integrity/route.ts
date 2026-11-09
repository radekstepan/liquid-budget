import { getDefaultDb, verifyBudgetIntegrity } from "@ynab/server";
import { optionalErrorMessage } from "../../errors";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  try {
    const db = getDefaultDb();
    let targetMonth: string | undefined;
    if (request?.url) {
      const url = new URL(request.url);
      targetMonth = url.searchParams.get("month") ?? undefined;
    }
    const report = await verifyBudgetIntegrity(db, targetMonth);
    return Response.json({
      ok: report.difference === 0,
      ...report,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: optionalErrorMessage(err) ?? "Failed to verify budget integrity" },
      { status: 500 }
    );
  }
}