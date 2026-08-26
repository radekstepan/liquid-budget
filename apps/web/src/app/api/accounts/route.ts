import {
  AccountError,
  createAccount,
  deleteAccount,
  getDefaultDb,
  listAccounts,
  TransactionError,
  updateAccount,
} from "@ynab/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await listAccounts(getDefaultDb());
  return Response.json(rows);
}

import {
  AccountCreateSchema,
  AccountPatchSchema,
  formatZodError,
} from "../schemas";

export async function POST(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const parseResult = AccountCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  const row = await createAccount(getDefaultDb(), {
    name: body.name,
    kind: body.kind,
    groupLabel: body.groupLabel,
    balance: body.balance,
    onBudget: body.onBudget,
    archived: body.archived,
  });
  return Response.json(row);
}

export async function PATCH(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
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

  const row = await updateAccount(getDefaultDb(), body.id, patch);
  return Response.json(row);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  try {
    await deleteAccount(getDefaultDb(), id);
    return Response.json({ ok: true });
  } catch (e: any) {
    if (e instanceof AccountError || e instanceof TransactionError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
