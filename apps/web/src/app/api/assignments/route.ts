import { getDefaultDb, upsertAssignment } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const body = await req.json();
  const categoryId = Number(body.categoryId);
  const month = String(body.month);
  const amount = Number(body.amount);

  if (!categoryId || !month || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const row = await upsertAssignment(getDefaultDb(), { categoryId, month, amount });
  return Response.json(row);
}
