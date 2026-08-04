import {
  createSplitWithChildren,
  createTransaction,
  deleteTransaction,
  getDefaultDb,
  TransactionError,
  updateSplit,
  updateTransaction,
  type SubTransactionInput,
} from "@ynab/server";

export const dynamic = "force-dynamic";

type SubTxn = { categoryId: number; amount: number; memo?: string };

function parseSubTransactions(raw: unknown): SubTxn[] {
  if (!Array.isArray(raw)) {
    throw new TransactionError("subTransactions must be an array");
  }
  return raw.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new TransactionError(`subTransactions[${i}] is not an object`);
    }
    const o = c as Record<string, unknown>;
    const categoryId = Number(o.categoryId);
    const amount = Number(o.amount);
    if (!categoryId || Number.isNaN(amount)) {
      throw new TransactionError(`subTransactions[${i}] missing categoryId or amount`);
    }
    return {
      categoryId,
      amount,
      memo: typeof o.memo === "string" ? o.memo : undefined,
    };
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof TransactionError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return Response.json({ error: String(e) }, { status: 500 });
}

export async function POST(req: Request) {
  const body = await req.json();
  const accountId = Number(body.accountId);
  const amount = Number(body.amount);
  if (!accountId || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  const db = getDefaultDb();

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
          cleared: body.cleared ?? true,
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
      cleared: body.cleared ?? true,
      transferAccountId: body.transferAccountId ? Number(body.transferAccountId) : null,
      parentId: body.parentId ? Number(body.parentId) : null,
      skipBalance: !!body.skipBalance,
    });
    return Response.json(row);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });

  const db = getDefaultDb();

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
          cleared: body.cleared,
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
      cleared: body.cleared,
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
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  try {
    await deleteTransaction(getDefaultDb(), id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
