import { NextResponse } from "next/server";
import { dismissDuplicateGroup, getDefaultDb } from "@ynab/server";
import { DuplicateDismissSchema, formatZodError } from "@ynab/logic";
import { apiErrorResponse } from "../../errors";
import { mutationGuardResponse } from "../../guard";
import { createScopedLogger, toLogDetails } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createScopedLogger("duplicates/dismiss");

/**
 * Confirm a duplicate group as legitimate. The group's fingerprint is
 * recorded so future duplicate analyses skip it, and the internal
 * duplicate marker is cleared from the group's rows immediately.
 */
export async function POST(req: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parseResult = DuplicateDismissSchema.safeParse(json);
  if (!parseResult.success) {
    return NextResponse.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  try {
    const db = getDefaultDb();
    const result = await dismissDuplicateGroup(db, parseResult.data.fingerprint);
    return NextResponse.json(result);
  } catch (e) {
    log.error("Error:", toLogDetails(e));
    return apiErrorResponse(e);
  }
}
