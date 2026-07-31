import {
  createRecurring,
  deleteRecurring,
  getDefaultDb,
  updateRecurring,
} from "@ynab/server";

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

export async function PATCH(req: Request) {
  const body = await req.json();
  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  const row = await updateRecurring(getDefaultDb(), id, {
    accountId: body.accountId != null ? Number(body.accountId) : undefined,
    categoryId:
      "categoryId" in body ? (body.categoryId ? Number(body.categoryId) : null) : undefined,
    payee: body.payee,
    amount: body.amount != null ? Number(body.amount) : undefined,
    frequency: body.frequency,
    nextDate: body.nextDate,
    active: body.active,
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
