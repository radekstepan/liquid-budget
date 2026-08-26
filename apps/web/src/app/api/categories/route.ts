import {
  CategoryError,
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  getDefaultDb,
  renameCategoryGroup,
  updateCategory,
  updateCategoryGroup,
  updateCategoryGroupSort,
} from "@ynab/server";

export const dynamic = "force-dynamic";

import {
  CategoryCreateSchema,
  CategoryGroupCreateSchema,
  CategoryGroupPatchSchema,
  CategoryPatchSchema,
  formatZodError,
} from "../schemas";

export async function POST(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const db = getDefaultDb();

  if (typeof json === "object" && json !== null && "type" in json && (json as any).type === "group") {
    const parseResult = CategoryGroupCreateSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    const row = await createCategoryGroup(db, { name: parseResult.data.name });
    return Response.json(row);
  }

  const parseResult = CategoryCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  const row = await createCategory(db, {
    groupId: body.groupId,
    name: body.name,
    goalTarget: body.goalTarget,
    carryover: body.carryover,
    overspendCarriesOver: body.overspendCarriesOver,
  });
  return Response.json(row);
}

export async function PATCH(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const db = getDefaultDb();

  if (typeof json === "object" && json !== null && "type" in json && (json as any).type === "group") {
    const parseResult = CategoryGroupPatchSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    const body = parseResult.data;
    const patch: Parameters<typeof updateCategoryGroup>[2] = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.sort !== undefined) patch.sort = body.sort;

    const row = await updateCategoryGroup(db, body.id, patch);
    return Response.json(row);
  }

  const parseResult = CategoryPatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  const patch: Parameters<typeof updateCategory>[2] = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.goalTarget !== undefined) patch.goalTarget = body.goalTarget;
  if (body.carryover !== undefined) patch.carryover = body.carryover;
  if (body.sort !== undefined) patch.sort = body.sort;
  if (body.overspendCarriesOver !== undefined) patch.overspendCarriesOver = body.overspendCarriesOver;

  const row = await updateCategory(db, body.id, patch);
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
      await deleteCategoryGroup(db, id, { moveToCategoryId });
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
