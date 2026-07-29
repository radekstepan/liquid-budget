import { db } from "@/db";
import { transactions, accounts } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function applyBalance(accountId: number, delta: number) {
  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${delta.toFixed(2)}` })
    .where(eq(accounts.id, accountId));
}

export async function POST(req: Request) {
  const body = await req.json();
  const accountId = Number(body.accountId);
  const amount = Number(body.amount);
  if (!accountId || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const [row] = await db
    .insert(transactions)
    .values({
      accountId,
      categoryId: body.categoryId ? Number(body.categoryId) : null,
      date: String(body.date),
      payee: String(body.payee ?? ""),
      memo: String(body.memo ?? ""),
      amount: amount.toFixed(2),
      cleared: body.cleared ?? true,
    })
    .returning();

  await applyBalance(accountId, amount);

  return Response.json(row);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });

  const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!existing) return Response.json({ error: "not found" }, { status: 404 });

  await db.delete(transactions).where(eq(transactions.id, id));
  await applyBalance(existing.accountId, -Number(existing.amount));

  return Response.json({ ok: true });
}
