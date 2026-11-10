import { getDefaultDb, upsertAssignment } from "@ynab/server";
import { apiErrorResponse } from "../errors";
import { mutationGuardResponse } from "../guard";
import { AssignmentUpsertSchema, formatZodError } from "../schemas";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parseResult = AssignmentUpsertSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  try {
    const row = await upsertAssignment(getDefaultDb(), parseResult.data);
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}
