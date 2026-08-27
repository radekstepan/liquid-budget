import {
  autoPostDueRecurringTransactions,
  createRecurring,
  deleteRecurring,
  getDefaultDb,
  postRecurringTransaction,
  RecurringError,
  updateRecurring,
  withTransaction,
} from "@ynab/server";

export const dynamic = "force-dynamic";

type SubTxn = {
  categoryId?: number | null;
  transferAccountId?: number | null;
  amount: number;
  memo?: string;
};

function parseSubTransactions(raw: unknown): SubTxn[] {
  if (!Array.isArray(raw)) {
    throw new RecurringError("subTransactions must be an array");
  }
  return raw.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new RecurringError(`subTransactions[${i}] is not an object`);
    }
    const o = c as Record<string, unknown>;
    const categoryId = o.categoryId ? Number(o.categoryId) : null;
    const transferAccountId = o.transferAccountId ? Number(o.transferAccountId) : null;
    const amount = Number(o.amount);
    if ((!categoryId && !transferAccountId && amount <= 0) || Number.isNaN(amount)) {
      throw new RecurringError(`subTransactions[${i}] missing categoryId/transferAccountId or amount`);
    }
    return {
      categoryId,
      transferAccountId,
      amount,
      memo: typeof o.memo === "string" ? o.memo : undefined,
    };
  });
}

import {
  formatZodError,
  ISODateSchema,
  RecurringAutoPostActionSchema,
  RecurringBulkDeleteSchema,
  RecurringBulkPostActionSchema,
  RecurringBulkUpdateSchema,
  RecurringCreateSchema,
  RecurringPatchSchema,
  RecurringPostActionSchema,
} from "../schemas";

function errorResponse(e: unknown): Response {
  if (e instanceof RecurringError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return Response.json({ error: String(e) }, { status: 500 });
}

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const db = getDefaultDb();

  if (action === "post") {
    const id = Number(searchParams.get("id"));
    const rawDate = searchParams.get("date") || undefined;
    if (!id || Number.isNaN(id) || id <= 0) return Response.json({ error: "invalid id" }, { status: 400 });
    let postDate: string | undefined;
    if (rawDate !== undefined) {
      const dateRes = ISODateSchema.safeParse(rawDate);
      if (!dateRes.success) return Response.json({ error: "invalid date" }, { status: 400 });
      postDate = dateRes.data;
    }
    try {
      const res = await postRecurringTransaction(db, id, postDate);
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (action === "autopost") {
    const rawAsOfDate = searchParams.get("asOfDate") || searchParams.get("date") || undefined;
    let asOfDate: string | undefined;
    if (rawAsOfDate !== undefined) {
      const dateRes = ISODateSchema.safeParse(rawAsOfDate);
      if (!dateRes.success) return Response.json({ error: "invalid date" }, { status: 400 });
      asOfDate = dateRes.data;
    }
    try {
      const posted = await autoPostDueRecurringTransactions(db, asOfDate);
      return Response.json({ postedCount: posted.length, posted });
    } catch (e) {
      return errorResponse(e);
    }
  }

  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  if (typeof json === "object" && json !== null && (json as any).action === "post") {
    const parsed = RecurringPostActionSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    try {
      const res = await postRecurringTransaction(db, parsed.data.id, parsed.data.date);
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (typeof json === "object" && json !== null && (json as any).action === "bulk-post") {
    const parsed = RecurringBulkPostActionSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    try {
      const results = await withTransaction(db, async () => {
        const list = [];
        for (const id of parsed.data.ids) {
          const res = await postRecurringTransaction(db, id, parsed.data.date);
          list.push(res);
        }
        return list;
      });
      return Response.json({ postedCount: results.length, results });
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (typeof json === "object" && json !== null && (json as any).action === "autopost") {
    const parsed = RecurringAutoPostActionSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    try {
      const posted = await autoPostDueRecurringTransactions(db, parsed.data.asOfDate);
      return Response.json({ postedCount: posted.length, posted });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const parseResult = RecurringCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;

  try {
    const row = await createRecurring(getDefaultDb(), {
      accountId: body.accountId,
      categoryId: body.categoryId ?? null,
      payee: body.payee,
      memo: body.memo,
      amount: body.amount,
      frequency: body.frequency,
      nextDate: body.nextDate,
      anchorDay: body.anchorDay,
      flagColor: body.flagColor,
      transferAccountId: body.transferAccountId ?? null,
      subTransactions: body.subTransactions?.map((c) => ({
        categoryId: c.categoryId ?? null,
        transferAccountId: c.transferAccountId ?? null,
        amount: c.amount,
        memo: c.memo,
      })),
    });
    return Response.json(row);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  if (typeof json === "object" && json !== null && (json as any).action === "bulk-update") {
    const parseResult = RecurringBulkUpdateSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    const { ids, patch } = parseResult.data;
    try {
      const db = getDefaultDb();
      const cleanPatch: Parameters<typeof updateRecurring>[2] = {};
      if (patch.flagColor !== undefined) cleanPatch.flagColor = patch.flagColor;
      if (patch.active !== undefined) cleanPatch.active = patch.active;
      if (patch.categoryId !== undefined) cleanPatch.categoryId = patch.categoryId;
      if (patch.nextDate !== undefined) cleanPatch.nextDate = patch.nextDate;

      for (const id of ids) {
        await updateRecurring(db, id, cleanPatch);
      }
      return Response.json({ updatedCount: ids.length });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const parseResult = RecurringPatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;

  try {
    const patch: Parameters<typeof updateRecurring>[2] = {};
    if (body.accountId !== undefined) patch.accountId = body.accountId;
    if (body.categoryId !== undefined) patch.categoryId = body.categoryId;
    if (body.payee !== undefined) patch.payee = body.payee;
    if (body.memo !== undefined) patch.memo = body.memo ?? undefined;
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.frequency !== undefined) patch.frequency = body.frequency;
    if (body.nextDate !== undefined) patch.nextDate = body.nextDate;
    if (body.anchorDay !== undefined) patch.anchorDay = body.anchorDay;
    if (body.active !== undefined) patch.active = body.active;
    if (body.flagColor !== undefined) patch.flagColor = body.flagColor;
    if (body.transferAccountId !== undefined) patch.transferAccountId = body.transferAccountId;
    if (body.subTransactions !== undefined) {
      patch.subTransactions = body.subTransactions.map((c) => ({
        categoryId: c.categoryId ?? null,
        transferAccountId: c.transferAccountId ?? null,
        amount: c.amount,
        memo: c.memo,
      }));
    }

    const row = await updateRecurring(getDefaultDb(), body.id, patch);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(row);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  const db = getDefaultDb();

  if (id) {
    try {
      await deleteRecurring(db, id);
      return Response.json({ ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  }

  try {
    const json = await req.json();
    const parseResult = RecurringBulkDeleteSchema.safeParse(json);
    if (parseResult.success) {
      for (const singleId of parseResult.data.ids) {
        await deleteRecurring(db, singleId);
      }
      return Response.json({ ok: true, deletedCount: parseResult.data.ids.length });
    }
  } catch {}

  return Response.json({ error: "invalid id or ids" }, { status: 400 });
}
