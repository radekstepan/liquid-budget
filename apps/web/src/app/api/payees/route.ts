import {
  deletePayee,
  findOrCreatePayee,
  getDefaultDb,
  getPayees,
  mergePayees,
  updatePayee,
} from "@ynab/server";
import { z } from "zod";
import { apiErrorResponse } from "../errors";
import {
  formatZodError,
  PayeeCreateSchema,
  PayeeMergeSchema,
  PayeePatchSchema,
} from "../schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(getPayees(getDefaultDb()));
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
  const parseResult = PayeePatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  try {
    const row = await updatePayee(getDefaultDb(), body.id, {
      name: body.name,
      autoCategoryId: body.autoCategoryId,
    });
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { searchParams } = new URL(req.url);
  try {
    if (searchParams.get("action") === "merge") {
      const parseResult = PayeeMergeSchema.safeParse(json);
      if (!parseResult.success) {
        return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
      }
      const body = parseResult.data;
      const row = await mergePayees(getDefaultDb(), body.targetId, body.sourceIds);
      if (!row) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(row);
    }
    const parseResult = PayeeCreateSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    const body = parseResult.data;
    const row = findOrCreatePayee(getDefaultDb(), body.name, body.autoCategoryId ?? null);
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
  try {
    const ok = deletePayee(getDefaultDb(), parsedId.data);
    return Response.json({ ok });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
