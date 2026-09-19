import { applyRenameRuleToExisting, getDefaultDb } from "@ynab/server";
import { apiErrorResponse } from "../../errors";
import { formatZodError, RenameRuleApplySchema } from "../../schemas";

export const dynamic = "force-dynamic";

/**
 * Apply one rename rule to already-stored transactions. Learning a rule
 * otherwise only affects future CSV imports; this backfills history.
 */
export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parseResult = RenameRuleApplySchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  try {
    const res = await applyRenameRuleToExisting(getDefaultDb(), parseResult.data.id);
    if (!res) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ updated: res.updated, skippedLocked: res.skippedLocked });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
