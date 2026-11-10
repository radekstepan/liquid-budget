import {
  bulkDeleteTransactions,
  bulkUpdateTransactions,
  createSplitWithChildren,
  createTransaction,
  deleteTransaction,
  getDefaultDb,
  mergeTransactions,
  updateSingleOrTransferTransaction,
  updateSplit,
} from "@ynab/server";

export const dynamic = "force-dynamic";

import { bodyHasField, peekBody, readRouteAction } from "../action";
import { apiErrorResponse } from "../errors";
import { mutationGuardResponse } from "../guard";
import {
  formatZodError,
  IdListQuerySchema,
  PositiveIntQuerySchema,
  TransactionBulkDeleteSchema,
  TransactionBulkUpdateSchema,
  TransactionCreateSchema,
  TransactionMergeSchema,
  TransactionPatchSchema,
} from "../schemas";

export async function POST(req: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const actions = readRouteAction(req, json);
  const db = getDefaultDb();

  // Both spellings are accepted: the legacy query verb (`?action=bulk-delete`)
  // and the body discriminator (`{ action: "delete" }`).
  if (actions.queryMatches("bulk-delete") || actions.bodyMatches("delete")) {
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

  if (actions.matches("merge")) {
    const parseResult = TransactionMergeSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const { merged, deletedId } = await mergeTransactions(
        db,
        parseResult.data.ids,
        parseResult.data.patch ?? {}
      );
      return Response.json({ ok: true, merged, deletedId });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  if (actions.matches("bulk-update")) {
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

  if (body.mode === "split") {
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
      transferStatus: body.mode === "transfer" ? body.transferStatus : undefined,
      flagColor: body.flagColor ?? null,
      transferAccountId: body.mode === "transfer" ? body.transferAccountId : null,
      incomeMonth: body.incomeMonth,
      ...(body.mode === "single" && body.isIncome !== undefined ? { isIncome: body.isIncome } : {}),
    });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  let json: unknown;
  try { json = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const db = getDefaultDb();

  if (bodyHasField(json, "ids")) {
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

  if (body.mode === "split") {
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

  // TODO(P1) [api-consistency]: unify ?action=/body-discriminator dispatch to one canonical form.
  try {
    // Split-membership transition + patch shaping live in the server query;
    // only the explicit-mode signal stays here (the contract infers "single"
    // when mode is absent, which must not clear the transfer leg on its own).
    const explicitSingle = peekBody(json).mode === "single";
    const row = await updateSingleOrTransferTransaction(db, body.id, body, { explicitSingle });
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  const { searchParams } = new URL(req.url);
  const idsParam = searchParams.get("ids");
  if (idsParam !== null) {
    const parsedIds = IdListQuerySchema.safeParse(idsParam);
    if (!parsedIds.success) {
      return Response.json({ error: formatZodError(parsedIds.error) }, { status: 400 });
    }
    try {
      const deleted = await bulkDeleteTransactions(getDefaultDb(), parsedIds.data);
      return Response.json({ ok: true, count: deleted.length, deleted });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  const parsedId = PositiveIntQuerySchema.safeParse(searchParams.get("id") ?? "");
  if (!parsedId.success) return Response.json({ error: "invalid" }, { status: 400 });
  const id = parsedId.data;
  try {
    const deleted = await deleteTransaction(getDefaultDb(), id);
    if (!deleted) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
