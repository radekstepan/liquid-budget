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

function errorResponse(e: unknown): Response {
  if (e instanceof TransactionError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return Response.json({ error: String(e) }, { status: 500 });
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const db = getDefaultDb();

  if (action === "bulk-delete" || (Array.isArray(body?.ids) && body?.action === "delete")) {
    const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    try {
      const deleted = await bulkDeleteTransactions(db, ids);
      return Response.json({ ok: true, count: deleted.length, deleted });
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (action === "bulk-update" || (Array.isArray(body?.ids) && body?.patch)) {
    const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    try {
      const updated = await bulkUpdateTransactions(db, ids, body.patch);
      return Response.json({ ok: true, count: updated.length, updated });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const accountId = Number(body.accountId);
  const amount = Number(body.amount);
  if (!accountId || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  if (Array.isArray(body.subTransactions)) {
    try {
      const children = parseSubTransactions(body.subTransactions);
      const result = await createSplitWithChildren(
        db,
        {
          accountId,
          date: String(body.date),
          payee: String(body.payee ?? ""),
          memo: String(body.memo ?? ""),
          amount,
          status: parseStatus(body.status ?? body.cleared, "c"),
        },
        children
      );
      return Response.json(result);
    } catch (e) {
      return errorResponse(e);
    }
  }

  try {
    const row = await createTransaction(db, {
      accountId,
      categoryId: body.categoryId ? Number(body.categoryId) : null,
      date: String(body.date),
      payee: String(body.payee ?? ""),
      memo: String(body.memo ?? ""),
      amount,
      status: parseStatus(body.status ?? body.cleared, "c"),
      transferAccountId: body.transferAccountId ? Number(body.transferAccountId) : null,
      parentId: body.parentId ? Number(body.parentId) : null,
      skipBalance: !!body.skipBalance,
      incomeMonth: body.incomeMonth !== undefined ? (body.incomeMonth ? String(body.incomeMonth) : null) : undefined,
    });
    return Response.json(row);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const db = getDefaultDb();

  if (Array.isArray(body.ids)) {
    try {
      const ids = body.ids.map(Number);
      const updated = await bulkUpdateTransactions(db, ids, body.patch ?? {});
      return Response.json({ ok: true, count: updated.length, updated });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });

  if (Array.isArray(body.subTransactions)) {
    try {
      const children = parseSubTransactions(body.subTransactions);
      const result = await updateSplit(
        db,
        id,
        {
          date: body.date,
          payee: body.payee,
          memo: body.memo,
          status:
            "status" in body || "cleared" in body
              ? parseStatus(body.status ?? body.cleared, "c")
              : undefined,
        },
        children
      );
      return Response.json(result);
    } catch (e) {
      return errorResponse(e);
    }
  }

  try {
    const row = await updateTransaction(db, id, {
      accountId: body.accountId != null ? Number(body.accountId) : undefined,
      categoryId:
        "categoryId" in body ? (body.categoryId ? Number(body.categoryId) : null) : undefined,
      date: body.date,
      payee: body.payee,
      memo: body.memo,
      amount: body.amount != null ? Number(body.amount) : undefined,
      status:
        "status" in body || "cleared" in body
          ? parseStatus(body.status ?? body.cleared, "c")
          : undefined,
      incomeMonth:
        "incomeMonth" in body ? (body.incomeMonth ? String(body.incomeMonth) : null) : undefined,
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
