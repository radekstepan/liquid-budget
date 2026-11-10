import {
  getDefaultDb,
  verifyBalanceIntegrity,
  recomputeAccountBalances,
} from "@ynab/server";
import { optionalErrorMessage } from "../../errors";
import { mutationGuardResponse } from "../../guard";

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
  } catch (err) {
    return Response.json(
      { ok: false, error: optionalErrorMessage(err) ?? "Failed to verify balance integrity" },
      { status: 500 }
    );
  }
}

export async function POST(req?: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  try {
    const db = getDefaultDb();
    const result = await recomputeAccountBalances(db);
    const issues = await verifyBalanceIntegrity(db);
    return Response.json({
      ok: issues.length === 0,
      repairedCount: result.updatedCount,
      remainingIssues: issues,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: optionalErrorMessage(err) ?? "Failed to repair balance integrity" },
      { status: 500 }
    );
  }
}
