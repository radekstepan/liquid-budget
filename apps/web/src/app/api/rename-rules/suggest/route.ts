import {
  acceptRenameSuggestions,
  getDefaultDb,
  getRenameSuggestStatus,
  suggestRenameRules,
} from "@ynab/server";
import { resolveAction } from "../../action";
import { apiErrorResponse } from "../../errors";
import { mutationGuardResponse } from "../../guard";
import { logger } from "@/lib/logger";
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
 * POST { action:"accept", suggestions, applyToExisting? }: persist reviewed
 * drafts as rules via the standard rule learner, optionally backfilling
 * existing transactions. `?action=accept` is a deprecated alias.
 */
export async function POST(req: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  const db = getDefaultDb();

  const rawText = await req.text();
  let rawJson: unknown;
  if (rawText.trim()) {
    try {
      rawJson = JSON.parse(rawText);
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
  }

  // Canonical dispatch is body {action}; `?action=` is a deprecated alias.
  // An empty body means the legacy single-shot suggest (no discriminator).
  const action = resolveAction(req, rawJson, ["accept"]);

  if (action === "accept") {
    const parseResult = RenameSuggestAcceptSchema.safeParse(rawJson);
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

  if (new URL(req.url).searchParams.get("action") !== null) {
    return Response.json(
      { error: `unknown action: ${new URL(req.url).searchParams.get("action")}` },
      { status: 400 }
    );
  }
  // A body discriminator with an unknown action is also a 400 (previously
  // it would have fallen through to suggest and 400'd on the batch schema
  // with a confusing message).
  if (
    typeof rawJson === "object" &&
    rawJson !== null &&
    "action" in rawJson &&
    (rawJson as Record<string, unknown>).action !== undefined
  ) {
    return Response.json(
      { error: `unknown action: ${String((rawJson as Record<string, unknown>).action)}` },
      { status: 400 }
    );
  }

  let batch: RenameSuggestBatchInput = {};
  if (rawJson !== undefined) {
    const batchResult = RenameSuggestBatchSchema.safeParse(rawJson);
    if (!batchResult.success) {
      return Response.json({ error: formatZodError(batchResult.error) }, { status: 400 });
    }
    batch = batchResult.data;
  }

  try {
    // PII-free audit trail: model served + candidate count per request
    // (never key, payee, or memo text — see LlmAuditEntry).
    const res = await suggestRenameRules(db, {
      ...batch,
      onAudit: (entry) => {
        logger.info(
          JSON.stringify({
            source: "rename-suggest",
            host: entry.host,
            model: entry.servedModel ?? entry.requestedModel,
            candidates: entry.candidates,
            ok: entry.ok,
            ...(entry.error ? { error: entry.error } : {}),
          })
        );
      },
    });
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
