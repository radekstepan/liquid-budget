import {
  getDefaultDb,
  getReconcileState,
  reconcileAccount,
  unreconcileAccount,
} from "@ynab/server";
import { resolveAction } from "../action";
import { apiErrorResponse, errorMessage, errorStatus } from "../errors";
import { mutationGuardResponse } from "../guard";
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
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const db = getDefaultDb();

  // Canonical dispatch is body {action}; `?action=` is a deprecated alias.
  const action = resolveAction(req, json, ["reconcile", "unreconcile"], {
    reconcile: "reconcile",
  });

  if (action === "unreconcile") {
    // Accept the legacy `?action=unreconcile` spelling with a bare
    // `{accountId}` body: normalise to the canonical discriminator.
    const raw = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
    const parseResult = UnreconcileAccountSchema.safeParse({ ...raw, action: "unreconcile" });
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
