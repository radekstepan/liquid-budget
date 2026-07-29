import { db } from "@/db";
import { assignments } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Upsert an assignment for a category+month
export async function PUT(req: Request) {
  const body = await req.json();
  const categoryId = Number(body.categoryId);
  const month = String(body.month);
  const amount = Number(body.amount);

  if (!categoryId || !month || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const amountStr = amount.toFixed(2);

  const existing = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.categoryId, categoryId), eq(assignments.month, month)));

  if (existing.length > 0) {
    const [row] = await db
      .update(assignments)
      .set({ amount: amountStr })
      .where(eq(assignments.id, existing[0].id))
      .returning();
    return Response.json(row);
  }

  const [row] = await db
    .insert(assignments)
    .values({ categoryId, month, amount: amountStr })
    .returning();
  return Response.json(row);
}
