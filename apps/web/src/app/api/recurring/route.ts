import {
  autoPostDueRecurringTransactions,
  createRecurring,
  deleteRecurring,
  getDefaultDb,
  postRecurringTransaction,
  updateRecurring,
} from "@ynab/server";
import { z } from "zod";
import { bodyHasField, resolveAction } from "../action";
import { apiErrorResponse } from "../errors";
import { mutationGuardResponse } from "../guard";
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
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  const { searchParams } = new URL(req.url);
  const db = getDefaultDb();

  // Canonical dispatch is body {action}; `?action=` is a deprecated alias.
  // Query spellings carry params in the URL, body spellings in JSON — both
  // resolve to one canonical name below.
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    json = undefined;
  }
  const action = resolveAction(req, json, ["post", "bulk-post", "autopost"]);

  if (action === "post") {
    if (json !== undefined && typeof json === "object" && json !== null && "id" in json) {
      const parsed = RecurringPostActionSchema.safeParse(json);
      if (!parsed.success) {
        return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
      }
      try {
        // Manual "Enter Now" always allows early posting (same as the
        // deprecated query spelling below) — the client posts today even
        // when the schedule's nextDate is in the future.
        const res = await postRecurringTransaction(db, parsed.data.id, parsed.data.date, true);
        return Response.json(res);
      } catch (e) {
        return apiErrorResponse(e);
      }
    }
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
    if (json !== undefined && typeof json === "object" && json !== null && ("asOfDate" in json || "action" in json)) {
      const parsed = RecurringAutoPostActionSchema.safeParse(
        "action" in json ? json : { action: "autopost", ...(json as Record<string, unknown>) }
      );
      if (!parsed.success) {
        return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
      }
      try {
        const result = await autoPostDueRecurringTransactions(db, parsed.data.asOfDate);
        return Response.json({
          postedCount: result.posted.length,
          posted: result.posted,
          failures: result.failures,
          capped: result.capped,
        });
      } catch (e) {
        return apiErrorResponse(e);
      }
    }
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
      const result = await autoPostDueRecurringTransactions(db, parsed.data.asOfDate);
      return Response.json({
        postedCount: result.posted.length,
        posted: result.posted,
        failures: result.failures,
        capped: result.capped,
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  if (json === undefined) {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (action === "bulk-post") {
    // Normalise the deprecated query alias (`?action=bulk-post` with a bare
    // body) to the canonical discriminator before validation.
    const rawBulk = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
    const parsed = RecurringBulkPostActionSchema.safeParse({ ...rawBulk, action: "bulk-post" });
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

  // `autopost` via body was handled above (with query fallback); reaching
  // here means no action discriminator, so fall through to create.
  const parseResult = RecurringCreateSchema.safeParse(json);
  if (!parseResult.success) {
    return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
  }
  const body = parseResult.data;

  try {
    const row = await createRecurring(db, {
      accountId: body.accountId,
      categoryId: body.mode === "split" ? null : (body.categoryId ?? null),
      payee: body.payee,
      memo: body.memo,
      amount: body.amount,
      frequency: body.frequency,
      nextDate: body.nextDate,
      anchorDay: body.anchorDay,
      active: body.active,
      flagColor: body.flagColor,
      transferAccountId: body.mode === "transfer" ? body.transferAccountId : null,
      subTransactions: body.mode === "split" ? body.subTransactions.map((c) => ({
        categoryId: c.categoryId ?? null,
        transferAccountId: c.transferAccountId ?? null,
        amount: c.amount,
        memo: c.memo,
      })) : undefined,
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
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const bulkAction = resolveAction(req, json, ["bulk-update"]);

  // Legacy bulk bodies without a discriminator still route to bulk when they
  // carry `ids` (mirrors the transactions PATCH fallback).
  if (bulkAction === "bulk-update" || (bulkAction === null && bodyHasField(json, "ids"))) {
    const rawBulk = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
    const parseResult = RecurringBulkUpdateSchema.safeParse({ ...rawBulk, action: "bulk-update" });
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
    if ("categoryId" in body && body.categoryId !== undefined) patch.categoryId = body.categoryId;
    if (body.payee !== undefined) patch.payee = body.payee;
    if (body.memo !== undefined) patch.memo = body.memo ?? undefined;
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.frequency !== undefined) patch.frequency = body.frequency;
    if (body.nextDate !== undefined) patch.nextDate = body.nextDate;
    if (body.anchorDay !== undefined) patch.anchorDay = body.anchorDay;
    if (body.active !== undefined) patch.active = body.active;
    if (body.flagColor !== undefined) patch.flagColor = body.flagColor;
    if ("transferAccountId" in body && body.transferAccountId !== undefined) patch.transferAccountId = body.transferAccountId;
    if ("subTransactions" in body && body.subTransactions !== undefined) {
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
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
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
