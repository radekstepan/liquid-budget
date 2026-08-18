import {
  getDefaultDb,
  reconcileAccount,
  TransactionError,
  unreconcileAccount,
} from "@ynab/server";

import {
  formatZodError,
  ReconcileAccountSchema,
  UnreconcileAccountSchema,
} from "../schemas";

export const dynamic = "force-dynamic";

function errorResponse(e: unknown): Response {
  if (e instanceof TransactionError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return Response.json({ error: String(e) }, { status: 500 });
}

export async function POST(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const db = getDefaultDb();

  if (typeof json === "object" && json !== null && (json as any).action === "unreconcile") {
    const parseResult = UnreconcileAccountSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const result = await unreconcileAccount(db, parseResult.data.accountId);
      return Response.json({ action: "unreconcile", ...result });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const parseResult = ReconcileAccountSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;

  try {
    const result = await reconcileAccount(db, {
      accountId: body.accountId,
      statementBalance: body.statementBalance,
      statementDate: body.statementDate,
      adjustmentCategoryId: body.adjustmentCategoryId ?? null,
    });
    return Response.json({ action: "reconcile", ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
