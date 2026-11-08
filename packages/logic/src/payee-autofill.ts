import type { Transaction } from "./types.js";

/**
 * Payee amount/memo recall (YNAB4 autofill).
 *
 * YNAB4 keeps one {@link AutoFillData} per payee (`data/AutoFillData.as`):
 * every saved transaction overwrites it via `getSettingsFromTransaction`
 * (`AutoFillData.as:110-118` — category only when non-null, memo and
 * amount unconditionally; last write wins). Typing a known payee on a
 * blank register row then proposes amount + memo (+ category) from that
 * store (`RegisterGrid.as:815/843/871` saving through
 * `PayeeManager.updateAutoFillSettings`, `RowRenderer.as:1974-1983`
 * gating on a blank row via `applyRulesToNew` in
 * `PayeeManager.as:612-632` / `AutoFillData.applyToNew` `:133-164`).
 *
 * The payee row carries the entity-level defaults (`autoCategoryId` plus
 * the imported `autoMemo`/`autoAmount`): history always wins once rows
 * exist (last-write-wins), and the stored defaults seed the proposal
 * for a payee with no history yet. `suggestAutofillForPayee`
 * generalises the server's `lastCategoryForPayee` (most-recent
 * categorized row wins) to amount + memo with the same
 * last-write-wins ordering.
 *
 * Matching is an exact trimmed-name comparison — the same `eq` the server
 * uses — NOT `normalizeRenameText`. Punctuation-folding normalization is
 * deliberately rename-rule-domain only (fork #7); payee memory must not
 * conflate `AMZN*MKTP` with `AMZN MKTP`.
 */

/** Minimal history shape `suggestAutofillForPayee` consults. */
export type PayeeAutofillHistoryRow = Pick<
  Transaction,
  "id" | "payee" | "amount" | "memo" | "categoryId" | "date"
>;

/** Blank-row proposal for a known payee. */
export type PayeeAutofillSuggestion = {
  /**
   * Payee-entity default when the caller passes one, else the most
   * recent non-null history category (mirrors `lastCategoryForPayee`).
   * Null when neither exists — the row stays uncategorized.
   */
  categoryId: number | null;
  /**
   * Cents string from the most recent history row with this payee, or
   * the payee-entity `defaultAmount` when the payee has no history.
   * Null when neither exists (category-only proposal).
   */
  amount: string | null;
  /**
   * Memo from the most recent history row, or the payee-entity
   * `defaultMemo` when the payee has no history, else `""`.
   */
  memo: string;
};

export type SuggestAutofillOptions = {
  /**
   * Row to ignore — the row being renamed/edited must not propose from
   * itself (mirrors `lastCategoryForPayee`'s `excludeId`).
   */
  excludeId?: number;
  /**
   * The payee entity's `autoCategoryId`. Wins over history, mirroring
   * `lastCategoryForPayee`'s prefer-the-entity-default rule.
   */
  defaultCategoryId?: number | null;
  /**
   * The payee entity's `autoMemo` (YNAB4 `autoFillMemo`). Seeds the
   * memo proposal when the payee has no transaction history; history
   * always wins once rows exist (YNAB4 last-write-wins).
   */
  defaultMemo?: string | null;
  /**
   * The payee entity's `autoAmount` in integer cents (YNAB4
   * `autoFillAmount`). Seeds the amount proposal when the payee has no
   * transaction history; history always wins once rows exist.
   */
  defaultAmount?: string | number | null;
};

/**
 * Propose amount + memo (+ category) for a blank row with `payeeName`,
 * from the most recent matching history row (date-descending, id
 * tiebreak — the same ordering `lastCategoryForPayee` uses).
 *
 * Amount/memo always come from the single most recent match (YNAB4
 * last-write-wins: `getSettingsFromTransaction` overwrites both
 * unconditionally); the category is the entity default when given, else
 * the most recent non-null history category (YNAB4 only overwrites the
 * stored category when the saved transaction has one). With no history
 * the stored entity defaults (`defaultMemo`/`defaultAmount`/
 * `defaultCategoryId`) seed the proposal instead, so a payee whose only
 * autofill signal is its YNAB4 entity default still proposes something.
 *
 * Returns null when the payee name is blank, or when there is no history
 * and no entity default.
 */
export function suggestAutofillForPayee(
  history: readonly PayeeAutofillHistoryRow[],
  payeeName: string,
  opts?: SuggestAutofillOptions
): PayeeAutofillSuggestion | null {
  const trimmed = payeeName.trim();
  if (!trimmed) return null;
  const excludeId = opts?.excludeId;
  const matches: PayeeAutofillHistoryRow[] = [];
  for (const row of history) {
    if (row.payee !== trimmed) continue;
    if (excludeId != null && row.id === excludeId) continue;
    matches.push(row);
  }
  matches.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.id - a.id;
  });
  const latest = matches[0];
  const fallbackCategory = opts?.defaultCategoryId ?? null;
  if (!latest) {
    const fallbackMemo = opts?.defaultMemo ?? null;
    const fallbackAmount = opts?.defaultAmount ?? null;
    if (fallbackCategory == null && fallbackMemo == null && fallbackAmount == null) return null;
    return {
      categoryId: fallbackCategory,
      amount: typeof fallbackAmount === "number" ? String(Math.round(fallbackAmount)) : fallbackAmount,
      memo: fallbackMemo ?? "",
    };
  }
  let categoryId = fallbackCategory;
  if (categoryId == null) {
    for (const row of matches) {
      if (row.categoryId != null) {
        categoryId = row.categoryId;
        break;
      }
    }
  }
  const amount = typeof latest.amount === "number" ? String(Math.round(latest.amount)) : latest.amount;
  return { categoryId, amount, memo: latest.memo ?? "" };
}
