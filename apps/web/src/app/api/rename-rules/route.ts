import {
  createRenameRule,
  deleteRenameRule,
  getDefaultDb,
  getRenameRules,
  updateRenameRule,
} from "@ynab/server";
import {
  formatZodError,
  RenameRuleCreateSchema,
  RenameRulePatchSchema,
} from "../schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getRenameRules(getDefaultDb()));
}

export async function POST(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const parseResult = RenameRuleCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  try {
    const row = await createRenameRule(getDefaultDb(), {
      sourcePattern: body.sourcePattern,
      targetPayee: body.targetPayee,
    });
    return Response.json(row);
  } catch (e: any) {
    if (String(e?.message ?? e).includes("UNIQUE constraint failed")) {
      return Response.json(
        { error: "A rule with that source pattern and target already exists" },
        { status: 409 }
      );
    }
    throw e;
  }
}

export async function PATCH(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const parseResult = RenameRulePatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;
  try {
    const row = await updateRenameRule(getDefaultDb(), body.id, {
      sourcePattern: body.sourcePattern,
      targetPayee: body.targetPayee,
    });
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(row);
  } catch (e: any) {
    if (String(e?.message ?? e).includes("UNIQUE constraint failed")) {
      return Response.json(
        { error: "A rule with that source pattern and target already exists" },
        { status: 409 }
      );
    }
    throw e;
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  const ok = deleteRenameRule(getDefaultDb(), id);
  return Response.json({ ok });
}
