import { db } from "@/db";
import { accounts } from "@/db/schema";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  if (!body.name) return Response.json({ error: "invalid" }, { status: 400 });
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${accounts.sort}), -1)` })
    .from(accounts);
  const [row] = await db
    .insert(accounts)
    .values({
      name: String(body.name),
      kind: String(body.kind ?? "liquid"),
      groupLabel: String(body.groupLabel ?? "Liquid"),
      balance: (Number(body.balance) || 0).toFixed(2),
      onBudget: body.onBudget ?? true,
      sort: Number(max) + 1,
    })
    .returning();
  return Response.json(row);
}
