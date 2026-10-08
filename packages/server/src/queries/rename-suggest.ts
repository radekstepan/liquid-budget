import { and, isNull } from "drizzle-orm";
import type {
  RenameCandidate,
  RenameRule as RenameRuleView,
  RenameSuggestion,
  RenameSuggestionSkipped,
} from "@ynab/logic";
import {
  buildRenameSuggestMessages,
  normalizeRenameText,
  parseRenameSuggestions,
  selectRenameCandidates,
} from "@ynab/logic";
import type { Db } from "../client.js";
import { completeChatJson, getLlmConfig, isLlmRenameEnabled, LlmError, type LlmFetch } from "../llm.js";
import { transactions } from "../schema.js";
import {
  applyRenameRuleToExisting,
  getRenameRules,
  learnRenameRuleFromPayees,
} from "./rename-rules.js";

export type RenameSuggestStatus = {
  enabled: boolean;
  candidates: RenameCandidate[];
  totalUnique: number;
  truncated: boolean;
};

/**
 * Distinct raw payees awaiting a rename rule, without calling the LLM.
 * Powers the AI button's visibility/count on the rename-rules page.
 */
export function getRenameSuggestStatus(
  db: Db,
  env: NodeJS.ProcessEnv = process.env
): RenameSuggestStatus {
  const rows = db
    .select({
      id: transactions.id,
      payee: transactions.payee,
      memo: transactions.memo,
      status: transactions.status,
      transferStatus: transactions.transferStatus,
      parentId: transactions.parentId,
      transferAccountId: transactions.transferAccountId,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .where(and(isNull(transactions.parentId), isNull(transactions.transferAccountId)))
    .all();
  const { candidates, totalUnique, truncated } = selectRenameCandidates(
    rows,
    getRenameRules(db),
    { maxPayees: getLlmConfig(env).maxPayees }
  );
  return { enabled: isLlmRenameEnabled(env), candidates, totalUnique, truncated };
}

export type RenameSuggestResult = {
  suggestions: RenameSuggestion[];
  skipped: RenameSuggestionSkipped[];
  model: string;
  /** Distinct payees actually sent to the LLM. */
  candidates: number;
};

/**
 * Send one page of uncovered payees to the LLM and validate the cleaned
 * names back into rename-rule drafts. Pure suggestion — nothing is
 * persisted; the caller reviews the drafts and persists them via
 * {@link acceptRenameSuggestions}. Throws {@link LlmError} when the
 * response is unusable, so callers never mistake a failed request for
 * an empty result.
 *
 * Candidates are deterministically ordered, so paging with
 * `offset`/`limit` walks the queue without gaps. Omitting both keeps
 * the legacy single-shot behavior (all candidates up to the cap).
 */
export async function suggestRenameRules(
  db: Db,
  opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: LlmFetch; offset?: number; limit?: number }
): Promise<RenameSuggestResult> {
  const env = opts?.env ?? process.env;
  const maxPayees = getLlmConfig(env).maxPayees;
  const status = getRenameSuggestStatus(db, env);
  if (!status.enabled) {
    throw new LlmError(
      "AI rename suggestions are not configured. Set LLM_API_KEY and LLM_MODEL (see apps/web/.env.example).",
      501
    );
  }
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const limit = Math.max(1, Math.floor(opts?.limit ?? maxPayees));
  const slice = status.candidates.slice(offset, offset + limit);
  if (slice.length === 0) {
    return {
      suggestions: [],
      skipped: [],
      model: getLlmConfig(env).model,
      candidates: 0,
    };
  }
  const { content, model } = await completeChatJson(buildRenameSuggestMessages(slice), {
    env,
    fetchImpl: opts?.fetchImpl,
  });
  const parsed = parseRenameSuggestions(content, slice);
  if (parsed.error) {
    throw new LlmError(parsed.error, 502);
  }
  return {
    suggestions: parsed.suggestions,
    skipped: parsed.skipped,
    model,
    candidates: slice.length,
  };
}

export type AcceptRenameSuggestionsResult = {
  /** Full stored rule list after learning. */
  rules: RenameRuleView[];
  /** Backfill of already-stored transactions (zeroes unless applied). */
  applied: { updated: number; skippedLocked: number };
  /** True when at least one suggestion generalised into a pattern rule. */
  generalised: boolean;
};

/**
 * Persist reviewed suggestions as rename rules. Each suggestion goes
 * through the standard rule learner, so families like `BCF1`/`BCF2`
 * still collapse into `BCF[N] -> BC Ferries` instead of piling up exact
 * rules. With `applyToExisting`, the newly learned rules are also
 * backfilled onto already-stored transactions.
 */
export async function acceptRenameSuggestions(
  db: Db,
  suggestions: { sourcePattern: string; targetPayee: string }[],
  opts?: { applyToExisting?: boolean }
): Promise<AcceptRenameSuggestionsResult> {
  const cleaned = suggestions
    .map((s) => ({ sourcePattern: s.sourcePattern.trim(), targetPayee: s.targetPayee.trim() }))
    .filter((s) => s.sourcePattern.length > 0 && s.targetPayee.length > 0);
  let generalised = false;
  let rules: RenameRuleView[] = getRenameRules(db);
  for (const s of cleaned) {
    const learned = await learnRenameRuleFromPayees(db, s.sourcePattern, s.targetPayee);
    generalised = generalised || learned.generalised;
    rules = learned.rules;
  }
  const applied = { updated: 0, skippedLocked: 0 };
  if (opts?.applyToExisting) {
    const targets = new Set(cleaned.map((s) => normalizeRenameText(s.targetPayee)));
    for (const rule of rules) {
      if (!targets.has(normalizeRenameText(rule.targetPayee))) continue;
      const res = await applyRenameRuleToExisting(db, rule.id);
      if (res) {
        applied.updated += res.updated;
        applied.skippedLocked += res.skippedLocked;
      }
    }
  }
  return { rules, applied, generalised };
}
