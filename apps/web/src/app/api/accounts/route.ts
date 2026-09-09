import {
  createAccount,
  deleteAccount,
  getDefaultDb,
  listAccounts,
  updateAccount,
} from "@ynab/server";
import { z } from "zod";
import { apiErrorResponse } from "../errors";
import {
  AccountCreateSchema,
  AccountPatchSchema,
  formatZodError,
} from "../schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await listAccounts(getDefaultDb());
  return Response.json(rows);
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parseResult = AccountCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  try {
    const row = await createAccount(getDefaultDb(), {
      name: body.name,
      kind: body.kind,
      groupLabel: body.groupLabel,
      balance: body.balance,
      onBudget: body.onBudget,
      archived: body.archived,
      notes: body.notes,
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
  const parseResult = AccountPatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  const patch: Parameters<typeof updateAccount>[2] = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.kind !== undefined) patch.kind = body.kind;
  if (body.groupLabel !== undefined) patch.groupLabel = body.groupLabel;
  if (body.onBudget !== undefined) patch.onBudget = body.onBudget;
  if (body.sort !== undefined) patch.sort = body.sort;
  if (body.archived !== undefined) patch.archived = body.archived;
  if (body.notes !== undefined) patch.notes = body.notes;

  try {
    const row = await updateAccount(getDefaultDb(), body.id, patch);
    if (!row) {
      return Response.json({ error: "Account not found" }, { status: 404 });
    }
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
    await deleteAccount(getDefaultDb(), parsedId.data);
    return Response.json({ ok: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
