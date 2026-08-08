import {
  getDefaultDb,
  reconcileAccount,
  TransactionError,
  unreconcileAccount,
} from "@ynab/server";

export const dynamic = "force-dynamic";

function errorResponse(e: unknown): Response {
  if (e instanceof TransactionError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return Response.json({ error: String(e) }, { status: 500 });
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const action = String(body.action ?? "reconcile");
  const db = getDefaultDb();

  try {
    if (action === "unreconcile") {
      const accountId = Number(body.accountId);
      if (!accountId) {
        return Response.json({ error: "accountId required" }, { status: 400 });
      }
      const result = await unreconcileAccount(db, accountId);
      return Response.json({ action: "unreconcile", ...result });
    }

    // Default: reconcile.
    const accountId = Number(body.accountId);
    const statementBalance = Number(body.statementBalance);
    if (!accountId || Number.isNaN(statementBalance)) {
      return Response.json(
        { error: "accountId and statementBalance are required" },
        { status: 400 }
      );
    }
    const result = await reconcileAccount(db, {
      accountId,
      statementBalance,
      adjustmentCategoryId:
        body.adjustmentCategoryId != null ? Number(body.adjustmentCategoryId) : null,
    });
    return Response.json({ action: "reconcile", ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
