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

type SubTxn = { categoryId: number; amount: number; memo?: string };

function parseSubTransactions(raw: unknown): SubTxn[] {
  if (!Array.isArray(raw)) {
    throw new RecurringError("subTransactions must be an array");
  }
  return raw.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new RecurringError(`subTransactions[${i}] is not an object`);
    }
    const o = c as Record<string, unknown>;
    const categoryId = Number(o.categoryId);
    const amount = Number(o.amount);
    if (!categoryId || Number.isNaN(amount)) {
      throw new RecurringError(`subTransactions[${i}] missing categoryId or amount`);
    }
    return {
      categoryId,
      amount,
      memo: typeof o.memo === "string" ? o.memo : undefined,
    };
  });
}

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
    if (!id) return Response.json({ error: "invalid id" }, { status: 400 });
    try {
      const res = await postRecurringTransaction(db, id);
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

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  if (body?.action === "post") {
    const id = Number(body.id);
    if (!id) return Response.json({ error: "invalid id" }, { status: 400 });
    try {
      const res = await postRecurringTransaction(db, id, body.date ? String(body.date) : undefined);
      return Response.json(res);
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (body?.action === "autopost") {
    try {
      const posted = await autoPostDueRecurringTransactions(db, body.asOfDate ? String(body.asOfDate) : undefined);
      return Response.json({ postedCount: posted.length, posted });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const accountId = Number(body.accountId);
  const amount = Number(body.amount);
  if (!accountId || Number.isNaN(amount)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }

  let subTransactions: SubTxn[] | undefined;
  if (Array.isArray(body.subTransactions)) {
    try {
      subTransactions = parseSubTransactions(body.subTransactions);
    } catch (e) {
      return errorResponse(e);
    }
  }

  try {
    const row = await createRecurring(getDefaultDb(), {
      accountId,
      categoryId: body.categoryId ? Number(body.categoryId) : null,
      payee: String(body.payee ?? ""),
      amount,
      frequency: String(body.frequency ?? "monthly"),
      nextDate: String(body.nextDate),
      active: body.active ?? true,
      transferAccountId: body.transferAccountId ? Number(body.transferAccountId) : null,
      subTransactions,
    });
    return Response.json(row);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const id = Number(body.id);
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });

  let subTransactions: SubTxn[] | undefined;
  if (Array.isArray(body.subTransactions)) {
    try {
      subTransactions = parseSubTransactions(body.subTransactions);
    } catch (e) {
      return errorResponse(e);
    }
  }

  try {
    const row = await updateRecurring(getDefaultDb(), id, {
      accountId: body.accountId != null ? Number(body.accountId) : undefined,
      categoryId:
        "categoryId" in body
          ? body.categoryId
            ? Number(body.categoryId)
            : null
          : undefined,
      payee: body.payee,
      amount: body.amount != null ? Number(body.amount) : undefined,
      frequency: body.frequency,
      nextDate: body.nextDate,
      active: body.active,
      transferAccountId:
        "transferAccountId" in body
          ? body.transferAccountId
            ? Number(body.transferAccountId)
            : null
          : undefined,
      subTransactions,
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
    await deleteRecurring(getDefaultDb(), id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
