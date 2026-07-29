import {
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  getDefaultDb,
  renameCategoryGroup,
  updateCategory,
} from "@ynab/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  const db = getDefaultDb();

  if (body.type === "group") {
    const row = await createCategoryGroup(db, { name: body.name });
    return Response.json(row);
  }

  const groupId = Number(body.groupId);
  if (!groupId) return Response.json({ error: "invalid" }, { status: 400 });
  const row = await createCategory(db, {
    groupId,
    name: body.name,
    goalTarget: body.goalTarget != null ? Number(body.goalTarget) : null,
  });
  return Response.json(row);
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  const db = getDefaultDb();

  if (body.type === "group") {
    const row = await renameCategoryGroup(db, id, String(body.name));
    return Response.json(row);
  }

  const row = await updateCategory(db, id, {
    name: body.name,
    goalTarget: body.goalTarget === undefined ? undefined : body.goalTarget,
  });
  return Response.json(row);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  const type = searchParams.get("type");
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  const db = getDefaultDb();

  if (type === "group") {
    await deleteCategoryGroup(db, id);
  } else {
    await deleteCategory(db, id);
  }
  return Response.json({ ok: true });
}
