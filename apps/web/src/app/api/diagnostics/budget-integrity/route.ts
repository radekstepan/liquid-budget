import { getDefaultDb, verifyBudgetIntegrity } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDefaultDb();
    const report = await verifyBudgetIntegrity(db);
    return Response.json({
      ok: report.difference === 0,
      ...report,
    });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message ?? "Failed to verify budget integrity" },
      { status: 500 }
    );
  }
}