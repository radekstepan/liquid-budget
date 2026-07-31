import {
  createTransaction,
  deleteTransaction,
  getDefaultDb,
  updateTransaction,
} from "@ynab/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  const accountId = Number(body.accountId);
  const amount = Number(body.amount);
  if (!accountId || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const row = await createTransaction(getDefaultDb(), {
    accountId,
    categoryId: body.categoryId ? Number(body.categoryId) : null,
    date: String(body.date),
    payee: String(body.payee ?? ""),
    memo: String(body.memo ?? ""),
    amount,
    cleared: body.cleared ?? true,
  });
  return Response.json(row);
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  const row = await updateTransaction(getDefaultDb(), id, {
    accountId: body.accountId != null ? Number(body.accountId) : undefined,
    categoryId:
      "categoryId" in body ? (body.categoryId ? Number(body.categoryId) : null) : undefined,
    date: body.date,
    payee: body.payee,
    memo: body.memo,
    amount: body.amount != null ? Number(body.amount) : undefined,
    cleared: body.cleared,
  });
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(row);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  await deleteTransaction(getDefaultDb(), id);
  return Response.json({ ok: true });
}
