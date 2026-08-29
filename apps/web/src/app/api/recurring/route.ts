import {
  autoPostDueRecurringTransactions,
  createRecurring,
  deleteRecurring,
  getDefaultDb,
  postRecurringTransaction,
  updateRecurring,
} from "@ynab/server";
import { z } from "zod";
import { apiErrorResponse } from "../errors";
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

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const db = getDefaultDb();

  if (action === "post") {
    const PostQuerySchema = z.object({
      id: z.coerce.number().int().positive(),
      date: ISODateSchema.optional(),
    });
    const parsed = PostQuerySchema.safeParse({
      id: searchParams.get("id"),
      date: searchParams.get("date") || undefined,
    });
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    try {
      const res = await postRecurringTransaction(db, parsed.data.id, parsed.data.date, true);
      return Response.json(res);
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  if (action === "autopost") {
    const AutoPostQuerySchema = z.object({
      asOfDate: ISODateSchema.optional(),
    });
    const parsed = AutoPostQuerySchema.safeParse({
      asOfDate: searchParams.get("asOfDate") || searchParams.get("date") || undefined,
    });
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    try {
      const posted = await autoPostDueRecurringTransactions(db, parsed.data.asOfDate);
      return Response.json({
        postedCount: posted.length,
        posted,
        failures: (posted as any).failures ?? [],
        capped: (posted as any).capped ?? [],
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof json === "object" && json !== null && (json as any).action === "post") {
    const parsed = RecurringPostActionSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    try {
      const res = await postRecurringTransaction(db, parsed.data.id, parsed.data.date, true);
      return Response.json(res);
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  if (typeof json === "object" && json !== null && (json as any).action === "bulk-post") {
    const parsed = RecurringBulkPostActionSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    // Bulk semantics (BUG-18.5): every bulk operation on this route uses
    // per-item isolation — each post commits or fails in its own
    // transaction (postRecurringTransaction wraps itself), so a single
    // invalid item never rolls back the others. Failures are reported
    // per id in `failures`, mirroring the autopost response shape.
    try {
      const results: unknown[] = [];
      const failures: { id: number; error: string }[] = [];
      for (const id of parsed.data.ids) {
        try {
          const res = await postRecurringTransaction(db, id, parsed.data.date, true);
          results.push(res);
        } catch (itemErr) {
          failures.push({
            id,
            error: itemErr instanceof Error ? itemErr.message : String(itemErr),
          });
        }
      }
      return Response.json({ postedCount: results.length, results, failures });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  if (typeof json === "object" && json !== null && (json as any).action === "autopost") {
    const parsed = RecurringAutoPostActionSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    try {
      const posted = await autoPostDueRecurringTransactions(db, parsed.data.asOfDate);
      return Response.json({
        postedCount: posted.length,
        posted,
        failures: (posted as any).failures ?? [],
        capped: (posted as any).capped ?? [],
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  const parseResult = RecurringCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;

  try {
    const row = await createRecurring(db, {
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
    return apiErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof json === "object" && json !== null && (json as any).action === "bulk-update") {
    const parseResult = RecurringBulkUpdateSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    const { ids, patch } = parseResult.data;
    try {
      const db = getDefaultDb();
      // Per-item isolation (BUG-18.5): each update commits independently,
      // so one invalid id cannot roll back the rest of the batch.
      const cleanPatch: Parameters<typeof updateRecurring>[2] = {};
      if (patch.flagColor !== undefined) cleanPatch.flagColor = patch.flagColor;
      if (patch.active !== undefined) cleanPatch.active = patch.active;
      if (patch.categoryId !== undefined) cleanPatch.categoryId = patch.categoryId;
      if (patch.nextDate !== undefined) cleanPatch.nextDate = patch.nextDate;

      let updatedCount = 0;
      for (const id of ids) {
        const row = await updateRecurring(db, id, cleanPatch);
        if (row) updatedCount++;
      }
      return Response.json({ updatedCount });
    } catch (e) {
      return apiErrorResponse(e);
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
    if (!row) return Response.json({ error: "Recurring transaction not found" }, { status: 404 });
    return Response.json(row);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const db = getDefaultDb();

  if (searchParams.has("id")) {
    const parsed = z.coerce.number().int().positive().safeParse(searchParams.get("id"));
    if (!parsed.success) {
      return Response.json({ error: "invalid id" }, { status: 400 });
    }
    try {
      const deleted = await deleteRecurring(db, parsed.data);
      if (!deleted) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true, deleted });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid id or ids" }, { status: 400 });
  }

  const parseResult = RecurringBulkDeleteSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }

  try {
    // Per-item isolation (BUG-18.5): each delete commits in its own
    // transaction (deleteRecurring wraps itself), matching bulk-post and
    // bulk-update. A mid-batch failure leaves earlier deletions committed.
    let deletedCount = 0;
    for (const singleId of parseResult.data.ids) {
      const deleted = await deleteRecurring(db, singleId);
      if (deleted) deletedCount++;
    }
    return Response.json({ ok: true, deletedCount });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
