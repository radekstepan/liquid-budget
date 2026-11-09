import {
  getDefaultDb,
  getReconcileState,
  reconcileAccount,
  unreconcileAccount,
} from "@ynab/server";
import { readRouteAction } from "../action";
import { apiErrorResponse, errorMessage, errorStatus } from "../errors";
import {
  formatZodError,
  ReconcileAccountSchema,
  ReconcileStateQuerySchema,
  UnreconcileAccountSchema,
} from "../schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = ReconcileStateQuerySchema.safeParse({
    accountId: url.searchParams.get("accountId"),
    statementDate: url.searchParams.get("statementDate") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  const db = getDefaultDb();
  try {
    const state = await getReconcileState(db, parsed.data.accountId, parsed.data.statementDate);
    return Response.json(state);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const db = getDefaultDb();

  const actions = readRouteAction(req, json);

  if (actions.bodyMatches("unreconcile")) {
    const parseResult = UnreconcileAccountSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const result = await unreconcileAccount(db, parseResult.data.accountId);
      return Response.json({ action: "unreconcile", ...result });
    } catch (e) {
      return apiErrorResponse(e);
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
      expectedWorkingBalance: body.expectedWorkingBalance ?? null,
    });
    return Response.json({ action: "reconcile", ...result });
  } catch (e) {
    if (errorStatus(e) === 422) {
      try {
        const state = await getReconcileState(db, body.accountId, body.statementDate);
        return Response.json({ error: errorMessage(e), state }, { status: 422 });
      } catch {
        // Fallback to standard error response
      }
    }
    return apiErrorResponse(e);
  }
}
