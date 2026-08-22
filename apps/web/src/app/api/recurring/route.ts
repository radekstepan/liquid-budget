import {
  autoPostDueRecurringTransactions,
  createRecurring,
  deleteRecurring,
  getDefaultDb,
  postRecurringTransaction,
  RecurringError,
  updateRecurring,
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
    if ((!categoryId && !transferAccountId) || Number.isNaN(amount)) {
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
  RecurringCreateSchema,
  RecurringPatchSchema,
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
    const postDate = searchParams.get("date") || undefined;
    if (!id) return Response.json({ error: "invalid id" }, { status: 400 });
    try {
      const res = await postRecurringTransaction(db, id, postDate);
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (action === "autopost") {
    try {
      const posted = await autoPostDueRecurringTransactions(db);
      return Response.json({ postedCount: posted.length, posted });
    } catch (e) {
      return errorResponse(e);
    }
  }

  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  if (typeof json === "object" && json !== null && (json as any).action === "post") {
    const id = Number((json as any).id);
    if (!id) return Response.json({ error: "invalid id" }, { status: 400 });
    try {
      const res = await postRecurringTransaction(db, id, (json as any).date ? String((json as any).date) : undefined);
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (typeof json === "object" && json !== null && (json as any).action === "bulk-post") {
    const ids = (json as any).ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return Response.json({ error: "ids must be a non-empty array" }, { status: 400 });
    }
    const postDate = (json as any).date ? String((json as any).date) : undefined;
    try {
      const results = [];
      for (const id of ids) {
        const res = await postRecurringTransaction(db, Number(id), postDate);
        results.push(res);
      }
      return Response.json({ postedCount: results.length, results });
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (typeof json === "object" && json !== null && (json as any).action === "autopost") {
    try {
      const posted = await autoPostDueRecurringTransactions(db, (json as any).asOfDate ? String((json as any).asOfDate) : undefined);
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
    const ids = (json as any).ids;
    const patch = (json as any).patch;
    if (!Array.isArray(ids) || ids.length === 0 || !patch || typeof patch !== "object") {
      return Response.json({ error: "invalid bulk-update payload" }, { status: 400 });
    }
    try {
      const db = getDefaultDb();
      for (const id of ids) {
        await updateRecurring(db, Number(id), {
          flagColor: patch.flagColor,
          active: patch.active,
          categoryId: patch.categoryId,
        });
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
    const row = await updateRecurring(getDefaultDb(), body.id, {
      accountId: body.accountId,
      categoryId: body.categoryId !== undefined ? body.categoryId : undefined,
      payee: body.payee,
      memo: body.memo !== undefined ? (body.memo ?? undefined) : undefined,
      amount: body.amount,
      frequency: body.frequency,
      nextDate: body.nextDate,
      active: body.active,
      flagColor: body.flagColor !== undefined ? body.flagColor : undefined,
      transferAccountId: body.transferAccountId !== undefined ? body.transferAccountId : undefined,
      subTransactions: body.subTransactions?.map((c) => ({
        categoryId: c.categoryId ?? null,
        transferAccountId: c.transferAccountId ?? null,
        amount: c.amount,
        memo: c.memo,
      })),
    });
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
    if (typeof json === "object" && json !== null && Array.isArray((json as any).ids)) {
      for (const singleId of (json as any).ids) {
        await deleteRecurring(db, Number(singleId));
      }
      return Response.json({ ok: true, deletedCount: (json as any).ids.length });
    }
  } catch {}

  return Response.json({ error: "invalid id or ids" }, { status: 400 });
}
