import {
  bulkDeleteTransactions,
  bulkUpdateTransactions,
  createSplitWithChildren,
  createTransaction,
  deleteTransaction,
  getDefaultDb,
  TransactionError,
  updateSplit,
  updateTransaction,
  type ClearedStatus,
  type SubTransactionInput,
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
    throw new TransactionError("subTransactions must be an array");
  }
  return raw.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new TransactionError(`subTransactions[${i}] is not an object`);
    }
    const o = c as Record<string, unknown>;
    const categoryId = o.categoryId ? Number(o.categoryId) : null;
    const transferAccountId = o.transferAccountId ? Number(o.transferAccountId) : null;
    const amount = Number(o.amount);
    if ((!categoryId && !transferAccountId) || Number.isNaN(amount)) {
      throw new TransactionError(`subTransactions[${i}] missing categoryId/transferAccountId or amount`);
    }
    return {
      categoryId,
      transferAccountId,
      amount,
      memo: typeof o.memo === "string" ? o.memo : undefined,
    };
  });
}

function parseStatus(raw: unknown, fallback: ClearedStatus = "c"): ClearedStatus {
  if (raw === "u" || raw === "c" || raw === "r") return raw;
  if (raw === false) return "u";
  if (raw === true) return fallback;
  return fallback;
}

import {
  formatZodError,
  TransactionBulkDeleteSchema,
  TransactionBulkUpdateSchema,
  TransactionCreateSchema,
  TransactionPatchSchema,
} from "../schemas.js";

function errorResponse(e: unknown): Response {
  if (e instanceof TransactionError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return Response.json({ error: String(e) }, { status: 500 });
}

export async function POST(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const db = getDefaultDb();

  if (action === "bulk-delete" || (typeof json === "object" && json !== null && "action" in json && (json as any).action === "delete")) {
    const parseResult = TransactionBulkDeleteSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const deleted = await bulkDeleteTransactions(db, parseResult.data.ids);
      return Response.json({ ok: true, count: deleted.length, deleted });
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (action === "bulk-update" || (typeof json === "object" && json !== null && "patch" in json)) {
    const parseResult = TransactionBulkUpdateSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const updated = await bulkUpdateTransactions(db, parseResult.data.ids, parseResult.data.patch);
      return Response.json({ ok: true, count: updated.length, updated });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const parseResult = TransactionCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;

  if (body.subTransactions && body.subTransactions.length > 0) {
    try {
      const result = await createSplitWithChildren(
        db,
        {
          accountId: body.accountId,
          date: body.date,
          payee: body.payee,
          memo: body.memo,
          amount: body.amount,
          status: body.status,
        },
        body.subTransactions.map((c) => ({
          categoryId: c.categoryId ?? null,
          transferAccountId: c.transferAccountId ?? null,
          amount: c.amount,
          memo: c.memo,
        }))
      );
      return Response.json(result);
    } catch (e) {
      return errorResponse(e);
    }
  }

  try {
    const row = await createTransaction(db, {
      accountId: body.accountId,
      categoryId: body.categoryId ?? null,
      date: body.date,
      payee: body.payee,
      memo: body.memo,
      amount: body.amount,
      status: body.status,
      transferAccountId: body.transferAccountId ?? null,
      parentId: body.parentId ?? null,
      skipBalance: body.skipBalance,
      incomeMonth: body.incomeMonth,
    });
    return Response.json(row);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const db = getDefaultDb();

  if (typeof json === "object" && json !== null && "ids" in json) {
    const parseResult = TransactionBulkUpdateSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const updated = await bulkUpdateTransactions(db, parseResult.data.ids, parseResult.data.patch);
      return Response.json({ ok: true, count: updated.length, updated });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const parseResult = TransactionPatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;

  if (body.subTransactions && body.subTransactions.length > 0) {
    try {
      const result = await updateSplit(
        db,
        body.id,
        {
          date: body.date,
          payee: body.payee,
          memo: body.memo ?? undefined,
          status: body.status,
        },
        body.subTransactions.map((c) => ({
          categoryId: c.categoryId ?? null,
          transferAccountId: c.transferAccountId ?? null,
          amount: c.amount,
          memo: c.memo,
        }))
      );
      return Response.json(result);
    } catch (e) {
      return errorResponse(e);
    }
  }

  try {
    const row = await updateTransaction(db, body.id, {
      accountId: body.accountId,
      categoryId: body.categoryId !== undefined ? body.categoryId : undefined,
      date: body.date,
      payee: body.payee,
      memo: body.memo !== undefined ? (body.memo ?? undefined) : undefined,
      amount: body.amount,
      status: body.status,
      incomeMonth: body.incomeMonth,
    });
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(row);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const idsParam = searchParams.get("ids");
  if (idsParam) {
    const ids = idsParam.split(",").map(Number).filter(Boolean);
    try {
      const deleted = await bulkDeleteTransactions(getDefaultDb(), ids);
      return Response.json({ ok: true, count: deleted.length, deleted });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const id = Number(searchParams.get("id"));
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  try {
    await deleteTransaction(getDefaultDb(), id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
