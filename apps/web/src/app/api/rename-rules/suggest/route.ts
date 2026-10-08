import {
  acceptRenameSuggestions,
  getDefaultDb,
  getRenameSuggestStatus,
  suggestRenameRules,
} from "@ynab/server";
import { apiErrorResponse } from "../../errors";
import {
  formatZodError,
  RenameSuggestAcceptSchema,
  RenameSuggestBatchSchema,
  type RenameSuggestBatchInput,
} from "../../schemas";

export const dynamic = "force-dynamic";

/**
 * Suggestion status (no LLM call): whether AI suggestions are configured
 * plus the distinct raw payees awaiting a rename rule. The settings UI
 * hides the AI button when `enabled` is false.
 */
export async function GET() {
  try {
    const status = getRenameSuggestStatus(getDefaultDb());
    return Response.json({
      enabled: status.enabled,
      candidates: status.candidates.map((c) => ({ payee: c.payee, count: c.count })),
      totalUnique: status.totalUnique,
      truncated: status.truncated,
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

/**
 * POST with no action: send one page of uncovered payees to the LLM
 * (`{offset, limit}` JSON body, both optional) and return validated
 * rename drafts (nothing is persisted). An empty body keeps the legacy
 * single-shot behavior up to the configured cap.
 *
 * POST ?action=accept: persist reviewed drafts as rules via the
 * standard rule learner, optionally backfilling existing transactions.
 */
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const db = getDefaultDb();

  if (action === "accept") {
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const parseResult = RenameSuggestAcceptSchema.safeParse(json);
    if (!parseResult.success) {
      return Response.json({ error: formatZodError(parseResult.error) }, { status: 400 });
    }
    try {
      const res = await acceptRenameSuggestions(db, parseResult.data.suggestions, {
        applyToExisting: parseResult.data.applyToExisting,
      });
      return Response.json({ rules: res.rules, applied: res.applied, generalised: res.generalised });
    } catch (e) {
      return apiErrorResponse(e);
    }
  }

  if (action !== null) {
    return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  let batch: RenameSuggestBatchInput = {};
  const raw = await req.text();
  if (raw.trim()) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const batchResult = RenameSuggestBatchSchema.safeParse(json);
    if (!batchResult.success) {
      return Response.json({ error: formatZodError(batchResult.error) }, { status: 400 });
    }
    batch = batchResult.data;
  }

  try {
    const res = await suggestRenameRules(db, batch);
    return Response.json({
      suggestions: res.suggestions,
      skipped: res.skipped,
      model: res.model,
      processed: res.candidates,
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
