import { db } from "@/db";
import { categories, categoryGroups } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();

  // Create a new group
  if (body.type === "group") {
    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${categoryGroups.sort}), -1)` })
      .from(categoryGroups);
    const [row] = await db
      .insert(categoryGroups)
      .values({ name: String(body.name ?? "New Group"), sort: Number(max) + 1 })
      .returning();
    return Response.json(row);
  }

  // Create a new category within a group
  const groupId = Number(body.groupId);
  if (!groupId) return Response.json({ error: "invalid" }, { status: 400 });
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${categories.sort}), -1)` })
    .from(categories)
    .where(eq(categories.groupId, groupId));
  const [row] = await db
    .insert(categories)
    .values({
      groupId,
      name: String(body.name ?? "New Category"),
      sort: Number(max) + 1,
      goalTarget: body.goalTarget != null ? Number(body.goalTarget).toFixed(2) : null,
    })
    .returning();
  return Response.json(row);
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });

  if (body.type === "group") {
    const [row] = await db
      .update(categoryGroups)
      .set({ name: String(body.name) })
      .where(eq(categoryGroups.id, id))
      .returning();
    return Response.json(row);
  }

  const patch: Record<string, unknown> = {};
  if (body.name != null) patch.name = String(body.name);
  if ("goalTarget" in body)
    patch.goalTarget = body.goalTarget == null ? null : Number(body.goalTarget).toFixed(2);
  const [row] = await db.update(categories).set(patch).where(eq(categories.id, id)).returning();
  return Response.json(row);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  const type = searchParams.get("type");
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  if (type === "group") {
    await db.delete(categoryGroups).where(eq(categoryGroups.id, id));
  } else {
    await db.delete(categories).where(eq(categories.id, id));
  }
  return Response.json({ ok: true });
}
