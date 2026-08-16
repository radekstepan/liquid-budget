import {
  createAccount,
  deleteAccount,
  getDefaultDb,
  listAccounts,
  updateAccount,
} from "@ynab/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await listAccounts(getDefaultDb());
  return Response.json(rows);
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body.name) return Response.json({ error: "invalid" }, { status: 400 });
  const row = await createAccount(getDefaultDb(), {
    name: body.name,
    kind: body.kind,
    groupLabel: body.groupLabel,
    balance: body.balance != null ? Number(body.balance) : undefined,
    onBudget: body.onBudget,
    archived: body.archived != null ? Boolean(body.archived) : undefined,
  });
  return Response.json(row);
}

export async function PATCH(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  const row = await updateAccount(getDefaultDb(), id, {
    name: body.name,
    kind: body.kind,
    groupLabel: body.groupLabel,
    balance: body.balance != null ? Number(body.balance) : undefined,
    onBudget: body.onBudget,
    sort: body.sort != null ? Number(body.sort) : undefined,
    archived: body.archived != null ? Boolean(body.archived) : undefined,
  });
  return Response.json(row);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  await deleteAccount(getDefaultDb(), id);
  return Response.json({ ok: true });
}
