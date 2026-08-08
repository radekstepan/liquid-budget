import { getDefaultDb, upsertAssignment } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const categoryId = Number(body.categoryId);
  const month = String(body.month);
  const amount = Number(body.amount);

  if (!categoryId || !month || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const row = await upsertAssignment(getDefaultDb(), { categoryId, month, amount });
  return Response.json(row);
}
