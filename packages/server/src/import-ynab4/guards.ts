/**
 * guards.ts
 *
 * Validated read sites for the untyped YNAB4 wire format (P2 type-safety).
 * `JSON.parse` yields `any`, but every boundary below treats the document
 * as `unknown` and reads through these guards: a missing/non-record holder
 * gives `undefined` (or `[]` for collections), exactly matching the old
 * `?.` / `|| []` defensive reads. Element-level typing stays with the
 * phase files, which keep their own explicit-`any` carve-out.
 */

/** An untyped YNAB4 JSON object: keys are known, values are validated at use. */
export type Ynab4Record = Record<string, unknown>;

/**
 * `v` as a plain record, or null when it isn't one. Arrays are rejected
 * (they are collections, not rows) so `arrayField` owns them.
 */
export function asRecord(v: unknown): Ynab4Record | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Ynab4Record;
}

/**
 * Null-safe field read: `undefined` when the holder isn't a record or the
 * key is absent. Mirrors the old `holder?.key` chains.
 */
export function recordField(v: unknown, key: string): unknown {
  const r = asRecord(v);
  return r == null ? undefined : r[key];
}

/**
 * Array field read: the collection when present, `[]` when the holder
 * isn't a record or the field is missing/non-array. Mirrors the old
 * `holder.key || []` reads (with one deliberate hardening: a truthy
 * non-array such as a string no longer iterates as characters).
 */
export function arrayField(v: unknown, key: string): unknown[] {
  const a = recordField(v, key);
  return Array.isArray(a) ? a : [];
}
