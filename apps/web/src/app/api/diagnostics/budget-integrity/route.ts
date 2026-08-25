import { getDefaultDb, verifyBudgetIntegrity } from "@ynab/server";

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
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message ?? "Failed to verify budget integrity" },
      { status: 500 }
    );
  }
}