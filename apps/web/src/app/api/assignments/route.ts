import { getDefaultDb, upsertAssignment } from "@ynab/server";
import { AssignmentUpsertSchema, formatZodError } from "../schemas.js";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const parseResult = AssignmentUpsertSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const row = await upsertAssignment(getDefaultDb(), parseResult.data);
  return Response.json(row);
}
