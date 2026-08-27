import {
  createRenameRule,
  deleteRenameRule,
  getDefaultDb,
  getRenameRules,
  updateRenameRule,
} from "@ynab/server";
import { z } from "zod";
import { apiErrorResponse } from "../errors";
import {
  formatZodError,
  RenameRuleCreateSchema,
  RenameRulePatchSchema,
} from "../schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(getRenameRules(getDefaultDb()));
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
  const parseResult = RenameRuleCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  try {
    const row = await createRenameRule(getDefaultDb(), {
      sourcePattern: body.sourcePattern,
      targetPayee: body.targetPayee,
    });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parseResult = RenameRulePatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  try {
    const row = await updateRenameRule(getDefaultDb(), body.id, {
      sourcePattern: body.sourcePattern,
      targetPayee: body.targetPayee,
    });
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const parsedId = z.coerce.number().int().positive().safeParse(searchParams.get("id"));
  if (!parsedId.success) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const ok = deleteRenameRule(getDefaultDb(), parsedId.data);
    return Response.json({ ok });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
