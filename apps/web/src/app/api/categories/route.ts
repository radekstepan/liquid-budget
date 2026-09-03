import {
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  getDefaultDb,
  updateCategory,
  updateCategoryGroup,
} from "@ynab/server";
import { z } from "zod";
import { apiErrorResponse } from "../errors";
import {
  CategoryCreateSchema,
  CategoryGroupCreateSchema,
  CategoryGroupPatchSchema,
  CategoryPatchSchema,
  formatZodError,
} from "../schemas";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const db = getDefaultDb();

  if (typeof json === "object" && json !== null && "type" in json && (json as any).type === "group") {
    const parseResult = CategoryGroupCreateSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const row = await createCategoryGroup(db, {
        name: parseResult.data.name,
        isHidden: parseResult.data.isHidden,
      });
      return Response.json(row);
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  const parseResult = CategoryCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  try {
    const row = await createCategory(db, {
      groupId: body.groupId,
      name: body.name,
      goalTarget: body.goalTarget,
      carryover: body.carryover,
      overspendCarriesOver: body.overspendCarriesOver,
    });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
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
    if (body.isHidden !== undefined) patch.isHidden = body.isHidden;

    try {
      const row = await updateCategoryGroup(db, body.id, patch);
      if (!row) {
        return Response.json({ error: "Category group not found" }, { status: 404 });
      }
      return Response.json(row);
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  const parseResult = CategoryPatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  const patch: Parameters<typeof updateCategory>[2] = {};
  if (body.groupId !== undefined) patch.groupId = body.groupId;
  if (body.name !== undefined) patch.name = body.name;
  if (body.goalTarget !== undefined) patch.goalTarget = body.goalTarget;
  if (body.carryover !== undefined) patch.carryover = body.carryover;
  if (body.sort !== undefined) patch.sort = body.sort;
  if (body.overspendCarriesOver !== undefined) patch.overspendCarriesOver = body.overspendCarriesOver;

  try {
    const row = await updateCategory(db, body.id, patch);
    if (!row) {
      return Response.json({ error: "Category not found" }, { status: 404 });
    }
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const parsedId = z.coerce.number().int().positive().safeParse(searchParams.get("id"));
  if (!parsedId.success) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }
  const id = parsedId.data;
  const type = searchParams.get("type");

  let moveToCategoryId: number | undefined;
  if (searchParams.has("moveToCategoryId")) {
    const parsedMoveTo = z.coerce.number().int().positive().safeParse(searchParams.get("moveToCategoryId"));
    if (!parsedMoveTo.success) {
      return Response.json({ error: "invalid moveToCategoryId" }, { status: 400 });
    }
    moveToCategoryId = parsedMoveTo.data;
  }

  const db = getDefaultDb();

  try {
    if (type === "group") {
      await deleteCategoryGroup(db, id, { moveToCategoryId });
    } else {
      await deleteCategory(db, id, { moveToCategoryId });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
