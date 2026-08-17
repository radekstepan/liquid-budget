import {
  CategoryError,
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  getDefaultDb,
  renameCategoryGroup,
  updateCategory,
  updateCategoryGroupSort,
} from "@ynab/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
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
    carryover: body.carryover != null ? Number(body.carryover) : undefined,
  });
  return Response.json(row);
}

export async function PATCH(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  const db = getDefaultDb();

  if (body.type === "group") {
    if (body.sort != null) {
      const row = await updateCategoryGroupSort(db, id, Number(body.sort));
      return Response.json(row);
    }
    const row = await renameCategoryGroup(db, id, String(body.name));
    return Response.json(row);
  }

  const row = await updateCategory(db, id, {
    name: body.name,
    goalTarget: body.goalTarget === undefined ? undefined : body.goalTarget,
    carryover: body.carryover != null ? Number(body.carryover) : undefined,
    sort: body.sort != null ? Number(body.sort) : undefined,
  });
  return Response.json(row);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  const type = searchParams.get("type");
  const moveToCategoryId = searchParams.get("moveToCategoryId")
    ? Number(searchParams.get("moveToCategoryId"))
    : undefined;
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  const db = getDefaultDb();

  try {
    if (type === "group") {
      await deleteCategoryGroup(db, id);
    } else {
      await deleteCategory(db, id, { moveToCategoryId });
    }
    return Response.json({ ok: true });
  } catch (e: any) {
    if (e instanceof CategoryError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
