import type { RenameRule } from "./types.js";

/**
 * Automatic payee rename rules.
 *
 * Rules are learned from explicit transaction renames after a CSV import
 * and are applied to *future* CSV imports. A rule matches a raw payee and
 * replaces it with a cleaner display name.
 *
 * Three rule shapes exist:
 *
 *   - Exact:  `BCF1 -> BC Ferries`
 *   - Numeric pattern: `BCF[N] -> BC Ferries` — `[N]` matches one or more digits.
 *   - Reference pattern: `AMZN Mktp US*[X] -> Amazon` — `[X]` matches one or
 *     more letters/digits (bank reference codes like `RT3ABCD12`).
 *
 * Patterns are only ever generalised from examples, never guessed: if the
 * user renames `BCF1` to "BC Ferries" and later `BCF2` to "BC Ferries",
 * the two exact rules are merged into `BCF[N] -> BC Ferries`. Two
 * unrelated sources (e.g. "BCF1" and "WHOLE FOODS #24") never merge
 * because their surrounding text differs. Generalisation also handles
 * numbers in the middle (`STORE #123 - SEATTLE` → `STORE #[N] - SEATTLE`),
 * number-like prefixes (`123 Main St` → `[N] Main St`), and several
 * varying runs at once (`CHK 12 REF 34` → `CHK [N] REF [N]`).
 *
 * Matching is case-insensitive and forgiving about whitespace and bank
 * separator punctuation (`AMZN*MKTP`, `AMZN MKTP` and `Amzn-Mktp` all
 * compare equal; `#` stays significant so `#24` never equals `24`). Exact
 * rules always win over patterns so a user can pin one payee to a
 * different target while the pattern handles the rest of the family.
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
/** Matches one or more letters/digits (bank reference codes). */
export const RENAME_REF_WILDCARD = "[X]";
/** Hard cap on wildcards per inferred pattern; keeps rules readable. */
const MAX_PATTERN_SLOTS = 4;

/**
 * System-generated transfer payees look like `Transfer : <account>`.
 * Rename rules map raw bank payees to display payees for future CSV
 * imports; transfers are a different domain (no category, destination
 * derived from the linked account), so a transfer-looking string must
 * never become a rule source or target.
 */
const TRANSFER_PAYEE_RE = /^transfer\s*:/i;

/** True when a payee or rule pattern is a system transfer string. */
export function isTransferPayee(value: string): boolean {
  return TRANSFER_PAYEE_RE.test(value.trim());
}

/**
 * Lowercase + collapse repeated whitespace + fold bank separator
 * punctuation (`*`, `.`, `-`, `/`, …) to spaces so matching is forgiving:
 * `AMZN*MKTP`, `AMZN MKTP` and `Amzn-Mktp` compare equal. `[`, `]` and `#`
 * stay significant so `[N]`/`[X]` wildcards survive normalisation and
 * `#24` never equals `24`.
 */
export function normalizeRenameText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#[\]\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a stored/displayed source pattern uses an [N]/[X] wildcard. */
export function isPatternRule(sourcePattern: string): boolean {
  const lowered = sourcePattern.toLowerCase();
  return (
    lowered.includes(RENAME_WILDCARD.toLowerCase()) ||
    lowered.includes(RENAME_REF_WILDCARD.toLowerCase())
  );
}

/**
 * Regex for a pattern rule; `[N]` becomes `\d+`, `[X]` becomes
 * `[a-z0-9]+`. Null when the pattern is empty or has no wildcard.
 */
export function renamePatternToRegExp(sourcePattern: string): RegExp | null {
  // Normalise the fixed parts the same way payees are normalised (lowercase,
  // whitespace collapsed, separator punctuation folded) so matching is
  // case- and punctuation-insensitive.
  const pattern = normalizeRenameText(sourcePattern);
  if (!pattern) return null;
  if (!isPatternRule(pattern)) return null;
  const body = pattern
    .split(/(\[[nx]\])/g)
    .map((part) =>
      part === RENAME_WILDCARD.toLowerCase()
        ? "\\d+"
        : part === RENAME_REF_WILDCARD.toLowerCase()
          ? "[a-z0-9]+"
          : escapeRegExp(part)
    )
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/**
 * A rename rule compiled for bulk matching: the target is normalized once
 * and each pattern regex is built once instead of once per payee.
 */
export type CompiledRenameRule = {
  rule: RenameRule;
  normalizedTarget: string;
  /** Set for exact rules: normalized source text for O(1) comparison. */
  normalizedSource?: string;
  /** Set for pattern rules with a valid regex; absent means "never matches". */
  regex?: RegExp;
};

export function compileRenameRules(rules: RenameRule[]): CompiledRenameRule[] {
  return rules.map((rule) => {
    const pattern = rule.sourcePattern.trim();
    const normalizedTarget = normalizeRenameText(rule.targetPayee);
    if (isPatternRule(pattern)) {
      const regex = renamePatternToRegExp(pattern);
      return regex ? { rule, normalizedTarget, regex } : { rule, normalizedTarget };
    }
    return { rule, normalizedTarget, normalizedSource: normalizeRenameText(pattern) };
  });
}

/**
 * Match an already-normalized payee against a compiled rule. Mirrors
 * {@link matchesRenameRule}, including its empty-payee behaviour.
 */
export function matchesCompiledRule(
  compiled: CompiledRenameRule,
  normalizedPayee: string
): boolean {
  if (!normalizedPayee) return false;
  if (compiled.regex) return compiled.regex.test(normalizedPayee);
  if (compiled.normalizedSource !== undefined) {
    return compiled.normalizedSource === normalizedPayee;
  }
  return false;
}

/**
 * Per-rule counts of stored payees the rule would rewrite: matching rows
 * not already at the target (mirrors the server's apply semantics).
 *
 * Stored payees are normalized once and grouped by distinct text, so this
 * is O(distinct payees × rules) with each pattern regex compiled once —
 * the naive per-row loop is O(rows × rules) with a regex build per cell.
 */
export function countRenameRuleMatches(
  rules: RenameRule[],
  payees: string[]
): Map<number, number> {
  const counts = new Map<number, number>();
  const byNormalized = new Map<string, number>();
  for (const payee of payees) {
    if (!payee.trim()) continue;
    const key = normalizeRenameText(payee);
    byNormalized.set(key, (byNormalized.get(key) ?? 0) + 1);
  }
  for (const compiled of compileRenameRules(rules)) {
    let n = 0;
    for (const [normalized, count] of byNormalized) {
      if (normalized === compiled.normalizedTarget) continue;
      if (matchesCompiledRule(compiled, normalized)) n += count;
    }
    counts.set(compiled.rule.id, n);
  }
  return counts;
}

/**
 * Substring for filtering the transaction register down to rows a rule
 * likely matches. Exact rules filter on the source text itself; pattern
 * rules filter on the longest literal fragment (`BCF[N]` → `BCF`).
 * Returns null when a pattern has no literal text to filter on.
 */
export function renameRulePayeeFilter(sourcePattern: string): string | null {
  const trimmed = sourcePattern.trim();
  if (!trimmed) return null;
  if (!isPatternRule(trimmed)) return trimmed;
  const fragments = trimmed
    .split(/\[[nx]\]/gi)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return null;
  let longest = fragments[0]!;
  for (const f of fragments) {
    if (f.length > longest.length) longest = f;
  }
  return longest;
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

/** Apply rules to a raw payee. Exact rules take precedence over patterns; newer rules take precedence over older rules. */
export function applyRenameRules(rules: RenameRule[], payee: string): string {
  if (rules.length === 0) return payee;
  const sorted = [...rules].sort((a, b) => {
    const aExact = !isPatternRule(a.sourcePattern) ? 1 : 0;
    const bExact = !isPatternRule(b.sourcePattern) ? 1 : 0;
    if (bExact !== aExact) return bExact - aExact;
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return b.createdAt.localeCompare(a.createdAt);
    }
    if (a.id != null && b.id != null && a.id !== b.id) {
      return b.id - a.id;
    }
    return 0;
  });
  for (const rule of sorted) {
    if (matchesRenameRule(rule, payee)) return rule.targetPayee.trim();
  }
  return payee;
}

const PURE_DIGITS_RE = /^\d+$/;
const ALNUM_REF_RE = /^[A-Za-z0-9]+$/;
const HAS_DIGIT_RE = /\d/;

/**
 * Wildcard for one aligned varying run across a cluster: all-digits runs
 * become `[N]`; letter/digit runs that carry a digit (bank reference codes
 * like `RT3ABCD12`) become `[X]`. Pure-letter variation is never
 * generalised — it looks like distinct names, not one family's numbering.
 */
function slotFor(values: string[]): string | null {
  if (values.length === 0 || values.some((v) => v.length === 0)) return null;
  if (values.every((v) => PURE_DIGITS_RE.test(v))) return RENAME_WILDCARD;
  if (values.every((v) => ALNUM_REF_RE.test(v) && HAS_DIGIT_RE.test(v))) {
    return RENAME_REF_WILDCARD;
  }
  return null;
}

/** Length of the longest common prefix, compared case-insensitively. */
function commonPrefixLength(values: string[]): number {
  if (values.length === 0) return 0;
  let len = values[0]!.length;
  for (let i = 1; i < values.length; i++) {
    const s = values[i]!;
    const cap = Math.min(len, s.length);
    let j = 0;
    while (
      j < cap &&
      values[0]![j]!.toLowerCase() === s[j]!.toLowerCase()
    ) {
      j++;
    }
    len = j;
  }
  return len;
}

/** Length of the longest common suffix, compared case-insensitively. */
function commonSuffixLength(values: string[]): number {
  if (values.length === 0) return 0;
  let len = Math.min(...values.map((v) => v.length));
  for (let i = 1; i < values.length; i++) {
    const a = values[0]!;
    const s = values[i]!;
    let j = 0;
    while (
      j < len &&
      a[a.length - 1 - j]!.toLowerCase() === s[s.length - 1 - j]!.toLowerCase()
    ) {
      j++;
    }
    len = j;
  }
  return len;
}

/**
 * Longest substring (≥2 chars, case-insensitive) shared by every value,
 * sliced from the first value. Used to split a varying middle that still
 * has fixed text inside it (`12 REF 34` / `56 REF 78` share ` REF `).
 */
function longestCommonInfix(values: string[]): string | null {
  if (values.length < 2) return null;
  const first = values[0]!;
  const lowered = first.toLowerCase();
  const rest = values.slice(1).map((v) => v.toLowerCase());
  let best = "";
  for (let i = 0; i < lowered.length; i++) {
    for (let j = i + 2; j <= lowered.length; j++) {
      const sub = lowered.slice(i, j);
      if (sub.length <= best.length) continue;
      if (rest.every((r) => r.includes(sub))) best = sub;
    }
  }
  if (!best) return null;
  const at = lowered.indexOf(best);
  return first.slice(at, at + best.length);
}

function splitAtFirst(value: string, infix: string): [string, string] | null {
  const idx = value.toLowerCase().indexOf(infix.toLowerCase());
  if (idx < 0) return null;
  return [value.slice(0, idx), value.slice(idx + infix.length)];
}

/**
 * Pattern for the aligned varying runs of a cluster. A single run becomes
 * one wildcard; a middle with fixed text inside (`12 REF 34`) recurses on
 * both sides of the shared infix. Returns null when the runs do not look
 * like one family's numbering.
 */
function generalizeSegments(segments: string[]): string | null {
  const slot = slotFor(segments);
  if (slot) return slot;
  const infix = longestCommonInfix(segments);
  if (!infix) return null;
  const split = segments.map((s) => splitAtFirst(s, infix));
  if (split.some((p) => p == null)) return null;
  const lefts = split.map((p) => p![0]);
  const rights = split.map((p) => p![1]);
  if (lefts.some((s) => s.length === 0) || rights.some((s) => s.length === 0)) {
    return null;
  }
  const left = generalizeSegments(lefts);
  if (!left) return null;
  const right = generalizeSegments(rights);
  if (!right) return null;
  return `${left}${infix}${right}`;
}

/**
 * Build a pattern for a cluster of distinct raw sources, or null when they
 * do not generalise. The common prefix/suffix anchor the pattern; the
 * varying middle becomes `[N]`/`[X]` wildcards (possibly several).
 */
function buildGeneralizedPattern(cluster: string[]): string | null {
  if (cluster.length < 2) return null;
  const preLen = commonPrefixLength(cluster);
  let prefix = cluster[0]!.slice(0, preLen);
  const remainders = cluster.map((c) => c.slice(preLen));
  const sufLen = commonSuffixLength(remainders);
  let suffix = remainders[0]!.slice(remainders[0]!.length - sufLen);
  let middles = remainders.map((r) => r.slice(0, r.length - sufLen));
  if (middles.some((m) => m.length === 0)) return null;
  // Numbers are atomic: when the varying run is all digits, neighbouring
  // digits belong to the same number (`#24`/`#25` vary as `24`, not `4`),
  // so pull the adjacent digit runs off the anchors into the middle.
  if (middles.every((m) => PURE_DIGITS_RE.test(m))) {
    const preDigits = /(\d+)$/.exec(prefix)?.[1] ?? "";
    if (preDigits) {
      prefix = prefix.slice(0, prefix.length - preDigits.length);
      middles = middles.map((m) => `${preDigits}${m}`);
    }
    const sufDigits = /^(\d+)/.exec(suffix)?.[1] ?? "";
    if (sufDigits) {
      suffix = suffix.slice(sufDigits.length);
      middles = middles.map((m) => `${m}${sufDigits}`);
    }
  }
  // A pattern that is all wildcard (`[N]` alone) would rename everything.
  if (!prefix.trim() && !suffix.trim()) return null;
  const middle = generalizeSegments(middles);
  if (!middle) return null;
  const pattern = `${prefix}${middle}${suffix}`;
  const slots = pattern.match(/\[[nx]\]/gi) ?? [];
  if (slots.length === 0 || slots.length > MAX_PATTERN_SLOTS) return null;
  const re = renamePatternToRegExp(pattern);
  if (!re) return null;
  for (const c of cluster) {
    if (!re.test(normalizeRenameText(c))) return null;
  }
  return pattern;
}

/**
 * Infer a generalised pattern rule from several raw sources that all map
 * to the same target. Grows a cluster around `newSource`: each existing
 * exact source joins only while the wider cluster still generalises, so
 * unrelated merchants sharing the target (e.g. `Lyft 456` next to
 * `Uber 123`/`Uber 789`) never block or corrupt the family's pattern.
 *
 * Returns null if no cluster of 2 or more distinct sources is formed.
 */
export function inferRenameRule(
  existingSources: string[],
  newSource: string
): { sourcePattern: string } | null {
  if (isTransferPayee(newSource)) return null;
  const fresh = newSource.trim();
  if (!fresh || isPatternRule(fresh)) return null;

  // Existing sources come first so the inferred pattern inherits their
  // casing (`bcf1` + `BCF2` → `bcf[N]`); the fresh source anchors the
  // cluster and is always last.
  const cluster: string[] = [];
  const seen = new Set([normalizeRenameText(fresh)]);
  for (const s of existingSources) {
    const trimmed = s.trim();
    if (!trimmed || isTransferPayee(trimmed) || isPatternRule(trimmed)) continue;
    const norm = normalizeRenameText(trimmed);
    if (seen.has(norm)) continue;
    const trial = [...cluster, trimmed, fresh];
    if (!buildGeneralizedPattern(trial)) continue;
    seen.add(norm);
    cluster.push(trimmed);
  }
  cluster.push(fresh);

  if (cluster.length < 2) return null;
  const sourcePattern = buildGeneralizedPattern(cluster);
  if (!sourcePattern) return null;
  return { sourcePattern };
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
  // Transfers live outside the rename-rule domain: their payees are
  // system-generated (`Transfer : <account>`) and carry no category.
  // Never learn a rule from or to one in either direction.
  if (isTransferPayee(source) || isTransferPayee(target)) {
    return { rules, generalised: false };
  }

  // Strip conflicting exact rules matching this normalized source payee
  // so the latest explicit rename replaces any older exact mapping.
  const cleanRules = rules.filter(
    (r) => isPatternRule(r.sourcePattern) || normalizeRenameText(r.sourcePattern) !== normalizeRenameText(source)
  );

  const sameTarget = cleanRules.filter(
    (r) => normalizeRenameText(r.targetPayee) === normalizeRenameText(target)
  );

  // If an existing rule for this target already covers this source,
  // we do not need to add a duplicate rule.
  for (const r of sameTarget) {
    if (matchesRenameRule(r, source)) {
      return { rules: cleanRules, generalised: false };
    }
  }

  // Try to generalise: do all existing sources for this target plus the new
  // one collapse into a single trailing-number pattern?
  const existingSources = sameTarget.map((r) => r.sourcePattern);
  const inferred = inferRenameRule(existingSources, source);
  if (inferred) {
    const kept = cleanRules.filter((r) => {
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

  // No generalisation: add an exact rule.
  return {
    rules: [
      ...cleanRules,
      { sourcePattern: source, targetPayee: target },
    ],
    generalised: false,
  };
}
