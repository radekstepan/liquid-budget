import {
  bulkDeleteTransactions,
  bulkUpdateTransactions,
  createSplitWithChildren,
  createTransaction,
  deleteSplitChildren,
  deleteTransaction,
  getDefaultDb,
  mergeTransactions,
  updateSplit,
  updateTransaction,
} from "@ynab/server";

export const dynamic = "force-dynamic";

// TODO(P0) [auth-hardening]: bind-or-guard mutating routes — require loopback token or
// extend RESET_ENABLED pattern to import/restore/export; document auth-proxy need for any
// non-localhost deployment. All routes here call getDefaultDb() with no session check.

import { bodyHasField, peekBody, readRouteAction } from "../action";
import { apiErrorResponse } from "../errors";
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

  // TODO(P1) [thin-route]: push split-vs-single conversion (deleteSplitChildren) into
  // server/queries/transactions/update.ts — split-membership transition is a domain invariant.
  // TODO(P1) [thin-route]: accept contract patch type directly in updateTransaction signature
  // instead of manually copying 10+ fields here; new fields currently need two edits.
  // TODO(P1) [api-consistency]: extend TransactionPatchSchema with isIncome instead of
  // (body as {isIncome}) cast below; unify ?action=/body-discriminator dispatch to one canonical form.
  try {
    const isExplicitSingle = peekBody(json).mode === "single";
    const isConvertingSplit =
      (body.mode === "single" && (body.categoryId !== undefined || body.amount !== undefined || "transferAccountId" in body)) ||
      (body.mode === "transfer" && "transferAccountId" in body && body.transferAccountId !== undefined);

    if (isConvertingSplit) {
      await deleteSplitChildren(db, body.id);
    }

    const patch: Parameters<typeof updateTransaction>[2] = {};
    if (body.accountId !== undefined) patch.accountId = body.accountId;
    if (body.categoryId !== undefined) patch.categoryId = body.categoryId;
    if ("isIncome" in body && (body as { isIncome?: boolean }).isIncome !== undefined) {
      patch.isIncome = (body as { isIncome: boolean }).isIncome;
    }
    if ("transferAccountId" in body && body.transferAccountId !== undefined) {
      patch.transferAccountId = body.transferAccountId;
    } else if (isExplicitSingle) {
      patch.transferAccountId = null;
    }
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
