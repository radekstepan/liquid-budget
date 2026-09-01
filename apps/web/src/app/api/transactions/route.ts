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
  type SubTransactionInput,
} from "@ynab/server";

export const dynamic = "force-dynamic";

import { apiErrorResponse } from "../errors";
import {
  formatZodError,
  TransactionBulkDeleteSchema,
  TransactionBulkUpdateSchema,
  TransactionCreateSchema,
  TransactionPatchSchema,
} from "../schemas";

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
      return apiErrorResponse(e);
    }
  }

  if (action === "bulk-update" || (typeof json === "object" && json !== null && (json as any).action === "bulk-update")) {
    const parseResult = TransactionBulkUpdateSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const updated = await bulkUpdateTransactions(db, parseResult.data.ids, parseResult.data.patch);
      return Response.json({ ok: true, count: updated.length, updated });
    } catch (e) {
      return apiErrorResponse(e);
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
          flagColor: body.flagColor ?? null,
        },
        body.subTransactions.map((c) => ({
          id: c.id,
          categoryId: c.categoryId ?? null,
          transferAccountId: c.transferAccountId ?? null,
          transferStatus: c.transferStatus,
          amount: c.amount,
          memo: c.memo,
          payee: c.payee,
        }))
      );
      return Response.json(result);
    } catch (e) {
      return apiErrorResponse(e);
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
      transferStatus: body.transferStatus,
      flagColor: body.flagColor ?? null,
      transferAccountId: body.transferAccountId ?? null,
      incomeMonth: body.incomeMonth,
    });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
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
      return apiErrorResponse(e);
    }
  }

  const parseResult = TransactionPatchSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;

  if (body.subTransactions && body.subTransactions.length > 0) {
    try {
      const parentFields: Parameters<typeof updateSplit>[2] = {};
      if (body.amount !== undefined) parentFields.amount = body.amount;
      if (body.date !== undefined) parentFields.date = body.date;
      if (body.payee !== undefined) parentFields.payee = body.payee;
      if (body.memo !== undefined) parentFields.memo = body.memo ?? undefined;
      if (body.status !== undefined) parentFields.status = body.status;
      if (body.flagColor !== undefined) parentFields.flagColor = body.flagColor;

      const result = await updateSplit(
        db,
        body.id,
        parentFields,
        body.subTransactions.map((c) => ({
          id: c.id,
          categoryId: c.categoryId ?? null,
          transferAccountId: c.transferAccountId ?? null,
          transferStatus: c.transferStatus,
          amount: c.amount,
          memo: c.memo,
          payee: c.payee,
        }))
      );
      return Response.json(result);
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  try {
    const patch: Parameters<typeof updateTransaction>[2] = {};
    if (body.accountId !== undefined) patch.accountId = body.accountId;
    if (body.categoryId !== undefined) patch.categoryId = body.categoryId;
    if (body.date !== undefined) patch.date = body.date;
    if (body.payee !== undefined) patch.payee = body.payee;
    if (body.memo !== undefined) patch.memo = body.memo ?? undefined;
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.status !== undefined) patch.status = body.status;
    if (body.transferStatus !== undefined) patch.transferStatus = body.transferStatus;
    if (body.flagColor !== undefined) patch.flagColor = body.flagColor;
    if (body.incomeMonth !== undefined) patch.incomeMonth = body.incomeMonth;

    const row = await updateTransaction(db, body.id, patch);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
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
      return apiErrorResponse(e);
    }
  }

  const id = Number(searchParams.get("id"));
  if (!id) return Response.json({ error: "invalid" }, { status: 400 });
  try {
    const deleted = await deleteTransaction(getDefaultDb(), id);
    if (!deleted) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
