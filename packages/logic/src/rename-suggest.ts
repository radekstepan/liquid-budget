import {
  compileRenameRules,
  isTransferPayee,
  matchesCompiledRule,
  normalizeRenameText,
  type RenameRuleInput,
} from "./rename-rules.js";
import type { RenameRule } from "./types.js";

/**
 * LLM-assisted payee rename suggestions.
 *
 * After a CSV import, bank payee names are often "wonky" (`AMZN Mktp
 * US*RT3ABCD12`). This module picks the transactions worth sending to an
 * LLM (imported rows the user has not curated yet), builds the prompt,
 * and validates the model's cleaned-up names back into rename-rule
 * drafts. Transport (fetch) and credentials live in `@ynab/server` so
 * this module stays pure and unit-testable.
 */

/** Default cap on distinct payees covered per click (processed in batches). */
export const DEFAULT_MAX_SUGGEST_PAYEES = 200;

/**
 * Payees per LLM request. Small batches keep each response short, which
 * cheap models follow far more reliably than one giant mapping.
 */
export const RENAME_SUGGEST_BATCH_SIZE = 10;

/** Max distinct memos sent per payee — enough for context, bounded for cost. */
export const MAX_SUGGEST_MEMOS_PER_PAYEE = 3;

/** Memos longer than this are truncated (with an ellipsis) before sending. */
export const MAX_SUGGEST_MEMO_CHARS = 120;

/** Minimal transaction shape needed for candidate selection. */
export type RenameCandidateRow = {
  id: number;
  payee: string;
  memo?: string | null;
  status?: string | null;
  transferStatus?: string | null;
  parentId?: number | null;
  transferAccountId?: number | null;
  /** Set by CSV import; cleared by any user review. Required for candidacy. */
  needsReview?: boolean | null;
};

/** One distinct raw payee awaiting a rename rule. */
export type RenameCandidate = {
  /** Display form of the raw payee (first-seen casing). */
  payee: string;
  /** How many stored transactions carry this payee. */
  count: number;
  /** Ids of those transactions (first 200; informational only). */
  transactionIds: number[];
  /** Distinct non-empty memos on those transactions (first-seen order, capped). */
  memos: string[];
};

export type SelectRenameCandidatesResult = {
  candidates: RenameCandidate[];
  /** Distinct uncovered payees before the cap. */
  totalUnique: number;
  /** True when `candidates` was cut down to the cap. */
  truncated: boolean;
};

export type SelectRenameCandidatesOptions = {
  /** Cap on distinct payees returned. Defaults to {@link DEFAULT_MAX_SUGGEST_PAYEES}. */
  maxPayees?: number;
};

/**
 * Pick the payees worth sending to the LLM: distinct raw payees on
 * freshly imported, not-yet-reviewed transactions that match no
 * existing rename rule.
 *
 * Only rows still flagged `needsReview` (set by CSV import, cleared by
 * any user edit, payee-manager cascade, or reconcile) are eligible —
 * history the user already curated is never re-sent. Reconciled rows
 * are locked and user-approved, and rename rules never apply to
 * transfers or split children, so all three are excluded too. Rows
 * already sitting at a rule's target name are excluded as well: a
 * rename-rule backfill leaves the imported flag set (renamed rows
 * stay bold until reviewed), and re-sending those canonical names
 * would only come back as "already clean" no-ops.
 *
 * Distinct non-empty memos are collected per payee (capped) as
 * disambiguation context for the prompt.
 */
function addCandidateMemo(candidate: RenameCandidate, memo: string): void {
  if (!memo || candidate.memos.length >= MAX_SUGGEST_MEMOS_PER_PAYEE) return;
  const truncated =
    memo.length > MAX_SUGGEST_MEMO_CHARS
      ? `${memo.slice(0, MAX_SUGGEST_MEMO_CHARS).trimEnd()}…`
      : memo;
  if (candidate.memos.some((m) => normalizeRenameText(m) === normalizeRenameText(truncated))) {
    return;
  }
  candidate.memos.push(truncated);
}

export function selectRenameCandidates(
  rows: RenameCandidateRow[],
  rules: RenameRule[],
  opts?: SelectRenameCandidatesOptions
): SelectRenameCandidatesResult {
  const maxPayees = Math.max(1, Math.floor(opts?.maxPayees ?? DEFAULT_MAX_SUGGEST_PAYEES));
  const grouped = new Map<string, RenameCandidate>();
  const targets = new Set(rules.map((r) => normalizeRenameText(r.targetPayee)));
  // Rules are compiled once (pattern regexes built once) and each payee is
  // normalized once — the naive per-row loop recompiles every pattern for
  // every transaction.
  const compiled = compileRenameRules(rules);
  for (const row of rows) {
    if (!row.needsReview) continue;
    if (row.parentId != null) continue;
    if (row.transferAccountId != null) continue;
    if (row.status === "r" || row.transferStatus === "r") continue;
    const payee = row.payee.trim();
    if (!payee) continue;
    if (isTransferPayee(payee)) continue;
    const key = normalizeRenameText(payee);
    if (compiled.some((c) => matchesCompiledRule(c, key))) continue;
    if (targets.has(key)) continue;
    const memo = row.memo?.trim() ? row.memo.trim() : "";
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.transactionIds.length < 200) existing.transactionIds.push(row.id);
      addCandidateMemo(existing, memo);
    } else {
      const candidate: RenameCandidate = { payee, count: 1, transactionIds: [row.id], memos: [] };
      addCandidateMemo(candidate, memo);
      grouped.set(key, candidate);
    }
  }
  const all = [...grouped.values()].sort(
    (a, b) => b.count - a.count || a.payee.localeCompare(b.payee)
  );
  return {
    candidates: all.slice(0, maxPayees),
    totalUnique: all.length,
    truncated: all.length > maxPayees,
  };
}

/** One chat message for an OpenAI-compatible `/chat/completions` call. */
export type LlmChatMessage = {
  role: "system" | "user";
  content: string;
};

/**
 * Prompt for cleaning bank payee names. Every candidate must come back
 * mapped (even unchanged ones) so the response is a total function over
 * the request — no-ops are filtered locally by
 * {@link parseRenameSuggestions}, not by the model.
 */
export function buildRenameSuggestMessages(candidates: RenameCandidate[]): LlmChatMessage[] {
  const lines = candidates.map((c, i) => {
    const memoClause =
      c.memos.length > 0
        ? ` — memo${c.memos.length === 1 ? "" : "s"}: ${c.memos.map((m) => JSON.stringify(m)).join("; ")}`
        : "";
    return `${i + 1}. "${c.payee}"${c.count > 1 ? ` (${c.count} transactions)` : ""}${memoClause}`;
  });
  return [
    {
      role: "system",
      content: [
        "You clean up bank statement payee names for a personal budgeting app.",
        "Each raw payee becomes a short, human-readable merchant name.",
        "",
        "Rules:",
        "- Strip card/transaction reference codes, dates, phone numbers, and store numbers (e.g. \"AMZN Mktp US*RT3ABCD12\" -> \"Amazon\", \"WHOLE FOODS #24\" -> \"Whole Foods\").",
        "- Use natural capitalization (\"BC Ferries\", not \"BCF1\" or \"BC FERRIES\").",
        "- Keep genuinely distinct merchants distinct; never merge two different businesses into one name.",
        "- A memo shown after a payee is extra context to help identify the merchant; use it for disambiguation but never copy memo text into the target unless it is the merchant's name.",
        "- Never output a payee starting with \"Transfer :\" — that prefix is reserved by the app.",
        "- Respond with JSON ONLY, no prose or markdown: an object with a \"renames\" array.",
        "- Include EVERY numbered input exactly once, echoing its raw payee text verbatim in \"source\" (payee only, never the memo), even when it is already clean (then \"target\" equals \"source\").",
        "",
        'Example: {"renames": [{"source": "AMZN Mktp US*RT3ABCD12", "target": "Amazon"}]}',
      ].join("\n"),
    },
    {
      role: "user",
      content: `Clean up these ${candidates.length} payee name${candidates.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    },
  ];
}

/** A validated rename suggestion: raw payee -> cleaned name. */
export type RenameSuggestion = RenameRuleInput & {
  /** How many stored transactions carry the raw payee. */
  count: number;
  /**
   * The distinct memos the AI saw alongside this payee (review evidence).
   * Present only when the candidate had memos; absent means "none".
   */
  memos?: string[];
};

export type RenameSuggestionSkipped = {
  source: string;
  reason: string;
};

export type ParseRenameSuggestionsResult = {
  suggestions: RenameSuggestion[];
  skipped: RenameSuggestionSkipped[];
  /** Set when the whole response is unusable — nothing was evaluated. */
  error?: string;
};

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort recovery for models that wrap the payload in prose
 * ("Here are the renames: {...}") despite the JSON-only instruction.
 * Returns the first balanced `{...}`/`[...]` span that parses,
 * scanning start positions in order. String-aware, so braces inside
 * quoted text and escaped quotes don't confuse the depth count.
 */
function extractEmbeddedJson(text: string): unknown | undefined {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJson(text.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break; // Balanced but not JSON — try the next start position.
        }
      }
    }
  }
  return undefined;
}

function previewRawResponse(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const shown = collapsed.length > 150 ? `${collapsed.slice(0, 150).trimEnd()}…` : collapsed;
  return `"${shown}"`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(entry: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Validate raw LLM output into rename suggestions.
 *
 * Accepts a bare JSON array or an object wrapping the array under
 * `renames`/`suggestions`/`rules` (the prompt asks for the former;
 * models sometimes choose the latter), tolerating markdown fences and
 * prose around the payload. Entries must echo one of the sent
 * `candidates` — anything else is a hallucination and is skipped —
 * and no-ops, empty targets, over-long names, and transfer-looking
 * strings are skipped with reasons instead of becoming rules.
 *
 * When the whole response is unusable, `error` is set and nothing was
 * evaluated — callers should treat that as a failed request, not as an
 * empty result.
 */
export function parseRenameSuggestions(
  rawText: string,
  candidates: RenameCandidate[]
): ParseRenameSuggestionsResult {
  const suggestions: RenameSuggestion[] = [];
  const skipped: RenameSuggestionSkipped[] = [];
  const counts = new Map(candidates.map((c) => [normalizeRenameText(c.payee), c]));
  const seen = new Set<string>();

  let parsed = tryParseJson(stripCodeFences(rawText));
  if (parsed === undefined) parsed = extractEmbeddedJson(rawText);
  if (parsed === undefined) {
    return {
      suggestions,
      skipped,
      error: `The AI response was not valid JSON (received: ${previewRawResponse(rawText)}).`,
    };
  }
  const root = asRecord(parsed);
  const list = Array.isArray(parsed)
    ? parsed
    : root != null
      ? [root.renames, root.suggestions, root.rules].find(Array.isArray)
      : undefined;
  if (!list) {
    return {
      suggestions,
      skipped,
      error: "The AI response did not contain a renames list.",
    };
  }

  for (const item of list) {
    const entry = asRecord(item);
    if (!entry) continue;
    const source = pickString(entry, ["source", "sourcePattern", "payee", "from", "original"]);
    const target = pickString(entry, ["target", "targetPayee", "renamed", "to", "clean", "name"]);
    if (!source) {
      skipped.push({ source: "", reason: "Missing source payee." });
      continue;
    }
    const candidate = counts.get(normalizeRenameText(source));
    if (!candidate) {
      skipped.push({ source, reason: "Not one of the payees sent for cleanup." });
      continue;
    }
    const key = normalizeRenameText(candidate.payee);
    if (seen.has(key)) continue;
    if (!target) {
      skipped.push({ source: candidate.payee, reason: "The AI returned an empty name." });
      continue;
    }
    if (target.length > 255) {
      skipped.push({ source: candidate.payee, reason: "The suggested name is too long." });
      continue;
    }
    if (isTransferPayee(target) || isTransferPayee(source)) {
      skipped.push({ source: candidate.payee, reason: "Rename rules do not apply to transfers." });
      continue;
    }
    if (normalizeRenameText(target) === normalizeRenameText(candidate.payee)) {
      skipped.push({ source: candidate.payee, reason: "Already clean — no rename needed." });
      continue;
    }
    seen.add(key);
    const suggestion: RenameSuggestion = {
      sourcePattern: candidate.payee,
      targetPayee: target,
      count: candidate.count,
    };
    // Carry the memos the AI saw into review so a target that only makes
    // sense with its memo (e.g. "PAYPAL *4821" -> "Spotify") can be judged.
    if (candidate.memos.length > 0) suggestion.memos = [...candidate.memos];
    suggestions.push(suggestion);
  }
  return { suggestions, skipped };
}
