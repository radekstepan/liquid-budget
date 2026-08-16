import {
  getDefaultDb,
  verifyBalanceIntegrity,
  recomputeAccountBalances,
} from "@ynab/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDefaultDb();
    const issues = await verifyBalanceIntegrity(db);
    return Response.json({
      ok: issues.length === 0,
      issueCount: issues.length,
      issues,
    });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message ?? "Failed to verify balance integrity" },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    const db = getDefaultDb();
    const result = await recomputeAccountBalances(db);
    const issues = await verifyBalanceIntegrity(db);
    return Response.json({
      ok: issues.length === 0,
      repairedCount: result.updatedCount,
      remainingIssues: issues,
    });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message ?? "Failed to repair balance integrity" },
      { status: 500 }
    );
  }
}
