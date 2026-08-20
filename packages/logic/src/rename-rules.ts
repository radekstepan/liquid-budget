import type { RenameRule } from "./types.js";

/**
 * Automatic payee rename rules.
 *
 * Rules are learned from explicit transaction renames after a CSV import
 * and are applied to *future* CSV imports. A rule matches a raw payee and
 * replaces it with a cleaner display name.
 *
 * Two rule shapes exist:
 *
 *   - Exact:  `BCF1 -> BC Ferries`
 *   - Pattern: `BCF[N] -> BC Ferries` — `[N]` matches one or more digits.
 *
 * Patterns are only ever generalised from examples, never guessed: if the
 * user renames `BCF1` to "BC Ferries" and later `BCF2` to "BC Ferries",
 * the two exact rules are merged into `BCF[N] -> BC Ferries`. Two
 * unrelated sources (e.g. "BCF1" and "WHOLE FOODS #24") never merge
 * because their surrounding text differs.
 *
 * Matching is case- and whitespace-insensitive (mirroring duplicate
 * fingerprint normalisation). Exact rules always win over patterns so a
 * user can pin one payee to a different target while the pattern handles
 * the rest of the family.
 */

/** Shape accepted by the settings UI / API when adding or editing a rule. */
export type RenameRuleInput = {
  sourcePattern: string;
  targetPayee: string;
};

/**
 * A rule list as produced by `learnRenameRule`. Existing rules carry their
 * persisted `id`/`createdAt`; newly created rules have neither set.
 */
export type RenameRuleDraft = RenameRuleInput & {
  id?: number;
  createdAt?: string;
};

export const RENAME_WILDCARD = "[N]";

/** Lowercase + collapse repeated whitespace so matching is forgiving. */
export function normalizeRenameText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a stored/displayed source pattern uses the [N] wildcard. */
export function isPatternRule(sourcePattern: string): boolean {
  return sourcePattern.toLowerCase().includes(RENAME_WILDCARD.toLowerCase());
}

/** Regex for a pattern rule; `[N]` becomes `\d+`. Null when pattern is empty. */
export function renamePatternToRegExp(sourcePattern: string): RegExp | null {
  // Normalise the fixed parts the same way payees are normalised (lowercase,
  // whitespace collapsed) so matching is case/whitespace-insensitive.
  const pattern = normalizeRenameText(sourcePattern);
  if (!pattern) return null;
  const wc = RENAME_WILDCARD.toLowerCase();
  if (!pattern.includes(wc)) return null;
  const escaped = escapeRegExp(pattern).replace(escapeRegExp(wc), "\\d+");
  return new RegExp(`^${escaped}$`, "i");
}

/** Does a raw payee match this rule? Exact rules compare normalized text. */
export function matchesRenameRule(rule: RenameRule, payee: string): boolean {
  const raw = payee.trim();
  if (!raw) return false;
  const pattern = rule.sourcePattern.trim();
  if (isPatternRule(pattern)) {
    const re = renamePatternToRegExp(pattern);
    return re != null && re.test(normalizeRenameText(raw));
  }
  return normalizeRenameText(pattern) === normalizeRenameText(raw);
}

/** Apply rules to a raw payee. Exact rules take precedence over patterns. */
export function applyRenameRules(rules: RenameRule[], payee: string): string {
  if (rules.length === 0) return payee;
  const sorted = [...rules].sort((a, b) => {
    const aExact = !isPatternRule(a.sourcePattern) ? 1 : 0;
    const bExact = !isPatternRule(b.sourcePattern) ? 1 : 0;
    return bExact - aExact;
  });
  for (const rule of sorted) {
    if (matchesRenameRule(rule, payee)) return rule.targetPayee.trim();
  }
  return payee;
}

/**
 * Split the trailing numeric run off a raw payee. Returns the prefix/suffix
 * around it, or null when the payee has no trailing digits.
 */
function splitTrailingNumber(source: string): {
  prefix: string;
  suffix: string;
} | null {
  const trimmed = source.trim();
  const match = /^(.*?)(\d+)$/.exec(trimmed);
  if (!match) return null;
  const prefix = match[1] ?? "";
  const suffix = "";
  if (prefix.length === 0) return null;
  return { prefix, suffix };
}

/**
 * Infer a generalised pattern rule from several raw sources that all map
 * to the same target. Returns null unless every source has the same prefix
 * (e.g. `BCF`) and differs only in its trailing digits — in which case the
 * pattern is `BCF[N]` with no suffix.
 *
 * The `newSource` must itself carry a trailing number and the inferred
 * pattern must match *every* existing source, so a stray "WHOLE FOODS #24"
 * never gets swallowed by `BCF[N]`.
 */
export function inferRenameRule(
  existingSources: string[],
  newSource: string
): { sourcePattern: string } | null {
  const parts = splitTrailingNumber(newSource);
  if (!parts) return null;
  const sources = [...new Set([...existingSources, newSource].map((s) => s.trim()))];
  if (sources.length < 2) return null;

  const first = splitTrailingNumber(sources[0]!);
  if (!first) return null;
  const candidate = { prefix: first.prefix, suffix: first.suffix };
  for (const s of sources.slice(1)) {
    const p = splitTrailingNumber(s);
    if (!p || p.prefix !== candidate.prefix || p.suffix !== candidate.suffix) {
      return null;
    }
  }

  const pattern = `${candidate.prefix}${RENAME_WILDCARD}${candidate.suffix}`;
  const re = renamePatternToRegExp(pattern);
  if (!re) return null;
  for (const s of sources) {
    if (!re.test(normalizeRenameText(s))) return null;
  }
  return { sourcePattern: pattern };
}

/**
 * Learn a rule from a rename example (old raw payee -> new payee).
 *
 * Returns the full, deduplicated rule list for the target plus an optional
 * `generalised` indicator. Pure — the caller persists the result.
 */
export function learnRenameRule(
  rules: RenameRule[],
  oldPayee: string,
  newPayee: string
): { rules: RenameRuleDraft[]; generalised: boolean } {
  const target = newPayee.trim();
  const source = oldPayee.trim();
  if (!source || !target || normalizeRenameText(source) === normalizeRenameText(target)) {
    return { rules, generalised: false };
  }

  const sameTarget = rules.filter(
    (r) => normalizeRenameText(r.targetPayee) === normalizeRenameText(target)
  );

  // If an existing rule already maps this exact source to the target,
  // nothing changes.
  for (const r of sameTarget) {
    if (matchesRenameRule(r, source)) {
      return { rules, generalised: false };
    }
  }

  // Try to generalise: do all existing sources for this target plus the new
  // one collapse into a single trailing-number pattern?
  const existingSources = sameTarget.map((r) => r.sourcePattern);
  const inferred = inferRenameRule(existingSources, source);
  if (inferred) {
  const kept = rules.filter((r) => {
    if (normalizeRenameText(r.targetPayee) !== normalizeRenameText(target)) {
      return true;
    }
    return !matchesRenameRule(
      { ...r, sourcePattern: inferred.sourcePattern },
      r.sourcePattern
    );
  });
  return {
    rules: [...kept, { ...inferred, targetPayee: target }],
    generalised: true,
  };
  }

  // No generalisation: add (or keep) an exact rule.
  return {
    rules: [
      ...rules,
      { sourcePattern: source, targetPayee: target },
    ],
    generalised: false,
  };
}
