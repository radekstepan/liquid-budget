"use client";

import type { DraftSubRowInput, SplitTemplate } from "@ynab/logic";
import { applySplitTemplate, isValidISODate } from "@ynab/logic";

export function DateFieldError({ value }: { value: string }) {
  if (isValidISODate(value)) return null;
  return (
    <div
      role="alert"
      className="mt-1 text-[11px]"
      style={{ color: "var(--y-red)" }}
    >
      Enter a valid date.
    </div>
  );
}

export const inputClass = "w-full py-[3px]";

export type DraftSubRow = DraftSubRowInput;

/**
 * Map a template's legs onto editable sub-rows for a parent total
 * (cents). Returns null when the template is invalid for the total.
 */
export function templateToSubRows(template: SplitTemplate, totalCents: number): DraftSubRow[] | null {
  try {
    return applySplitTemplate(totalCents, template.legs).map((l) => ({
      categoryId: l.categoryId,
      transferAccountId: l.transferAccountId,
      amount: (l.amount / 100).toFixed(2),
      memo: l.memo ?? "",
      ...(l.payee ? { payee: l.payee } : {}),
    }));
  } catch {
    return null;
  }
}

/**
 * The default sub-row memo when converting to a split: the parent's
 * memo when it has one, otherwise the parent's payee so the row still
 * shows where it came from. Every row stays editable.
 */
function defaultSubMemo(parentMemo: string, parentPayee: string): string {
  if (parentMemo.trim()) return parentMemo;
  if (parentPayee.trim()) return parentPayee;
  return "";
}

/**
 * A fresh split sub-row defaulted from the parent transaction: the
 * memo falls back to the parent payee when the parent has no memo,
 * and the payee is carried over. Every row stays editable.
 */
export function blankSubRow(parentMemo: string, parentPayee: string): DraftSubRow {
  const row: DraftSubRow = {
    categoryId: null,
    transferAccountId: null,
    amount: "",
    memo: defaultSubMemo(parentMemo, parentPayee),
  };
  if (parentPayee.trim()) row.payee = parentPayee;
  return row;
}

/**
 * Copy the parent's memo/payee into sub-rows that don't have their own
 * yet (fresh blanks or template legs without them). Rows that already
 * have a value — typed or from a template leg — are left untouched.
 */
export function fillSubRowDefaults(
  rows: DraftSubRow[],
  parentMemo: string,
  parentPayee: string
): DraftSubRow[] {
  const memo = defaultSubMemo(parentMemo, parentPayee);
  const payee = parentPayee.trim() ? parentPayee : "";
  if (!memo && !payee) return rows;
  return rows.map((r) => {
    const next: DraftSubRow = { ...r };
    if (!next.memo && memo) next.memo = memo;
    if (!next.payee && payee) next.payee = payee;
    return next;
  });
}
