import { createRecurring, deleteRecurring, getDefaultDb } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  const accountId = Number(body.accountId);
  const amount = Number(body.amount);
  if (!accountId || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const row = await createRecurring(getDefaultDb(), {
    accountId,
    categoryId: body.categoryId ? Number(body.categoryId) : null,
    payee: String(body.payee ?? ""),
    amount,
    frequency: String(body.frequency ?? "monthly"),
    nextDate: String(body.nextDate),
    active: body.active ?? true,
  });
  return Response.json(row);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  await deleteRecurring(getDefaultDb(), id);
  return Response.json({ ok: true });
}
