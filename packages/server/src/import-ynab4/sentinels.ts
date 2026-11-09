import type { MangledHiddenName } from "./types.js";

/**
 * YNAB4 income sentinels. The in-memory ids are `__ImmediateIncome__`
 * (CurrentMonth offset) / `__DeferredIncome__` (NextMonth offset)
 * (`MasterCategoryList.as:72-73`); on the wire they serialize under the
 * legacy names `__SupplementalIncome__` / `__PrimaryIncome__`
 * (`CategoryConstants.as:16-18`, resolved by
 * `OldVOToNewVOMarshaller.as:411-420`). Both spellings classify as
 * income on import and the verbatim spelling round-trips through
 * `income_category_raw`.
 */
const IMMEDIATE_INCOME_SENTINELS = new Set([
  "Category/__ImmediateIncome__",
  "Category/__SupplementalIncome__",
]);
const DEFERRED_INCOME_SENTINELS = new Set([
  "Category/__DeferredIncome__",
  "Category/__PrimaryIncome__",
]);
export const LEGACY_INCOME_SENTINELS = new Set([
  "Category/__SupplementalIncome__",
  "Category/__PrimaryIncome__",
]);

export type IncomeSentinelOffset = "immediate" | "deferred";

/** Income offset for a YNAB4 category id, or null when not an income sentinel. */
export function incomeSentinelOffset(categoryId: unknown): IncomeSentinelOffset | null {
  if (typeof categoryId !== "string") return null;
  if (IMMEDIATE_INCOME_SENTINELS.has(categoryId)) return "immediate";
  if (DEFERRED_INCOME_SENTINELS.has(categoryId)) return "deferred";
  return null;
}

/**
 * Parse a YNAB4 hidden-sub mangled name
 * (`MangledHiddenNameComponents.createFromMangledSubCategoryName`,
 * `CategoryNameUtilities.getMangledHiddenNameForComponents`):
 * "OldMaster ` Sub" or "OldMaster ` Sub ` OldMasterEntityId"
 * (separator `CategoryConstants.NAME_SEPERATOR_CHAR_HIDDEN`, components
 * trimmed). Returns null when the name carries no backtick (never
 * mangled) or has an unexpected shape — callers keep the verbatim
 * name and null lineage rather than failing the import.
 */
export function parseMangledHiddenName(name: unknown): MangledHiddenName | null {
  if (typeof name !== "string" || !name.includes("`")) return null;
  const parts = name.split("`").map((p) => p.trim());
  if (parts.length !== 2 && parts.length !== 3) return null;
  const [oldMasterName, subName] = parts as [string, string];
  if (!oldMasterName || !subName) return null;
  const oldMasterEntityId = parts.length === 3 && parts[2] ? parts[2]! : null;
  return { oldMasterName, subName, oldMasterEntityId };
}
