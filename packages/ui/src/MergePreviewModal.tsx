"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { Account, Category, MergeableTransaction, Transaction } from "@ynab/logic";
import {
  isImportedTransaction,
  num,
  pickMergePrimary,
  resolveMergedTransaction,
} from "@ynab/logic";
import { Notice, money } from "@ynab/theme";
import { Modal, Btn } from "./ui.js";

function toMergeable(t: Transaction): MergeableTransaction {
  return { ...t, transferAccountId: t.transferAccountId ?? null, amount: num(t.amount) };
}

/** Which constituent a merged field value came from ("both" when they agree). */
function fieldSource(
  primaryVal: unknown,
  secondaryVal: unknown,
  mergedVal: unknown
): "primary" | "secondary" | "both" {
  const primaryEq = primaryVal === mergedVal;
  const secondaryEq = secondaryVal === mergedVal;
  if (primaryEq && secondaryEq) return "both";
  if (secondaryEq) return "secondary";
  return "primary";
}

/**
 * Read-only preview of the transaction a merge will create, laid out like
 * the split editor: the resulting transaction on top (like the split
 * parent) and its two constituents below (like sub-transactions), each
 * result field tagged with the side it came from.
 */
export function MergePreviewModal({
  accounts,
  categories,
  transactions,
  ids,
  onClose,
  onConfirm,
}: {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  /** Exactly two transaction ids to merge. */
  ids: number[];
  onClose: () => void;
  onConfirm: (ids: number[]) => Promise<void> | void;
}) {
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a] as const)), [accounts]);
  const categoryById = useMemo(
    () => new Map(categories.map((c) => [c.id, c] as const)),
    [categories]
  );

  const preview = useMemo(() => {
    if (ids.length !== 2) return null;
    const first = transactions.find((t) => t.id === ids[0]);
    const second = transactions.find((t) => t.id === ids[1]);
    if (!first || !second) return null;
    const [primary, secondary] = pickMergePrimary(toMergeable(first), toMergeable(second));
    const src = accountById.get(primary.accountId);
    const dest =
      primary.transferAccountId != null ? accountById.get(primary.transferAccountId) : null;
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: { onBudget: src?.onBudget ?? true, kind: src?.kind ?? "liquid" },
      destAccount: dest ? { onBudget: dest.onBudget } : null,
    });
    return { primary, secondary, merged };
  }, [accounts, accountById, ids, transactions]);

  if (!preview) return null;
  const { primary, secondary, merged } = preview;

  const doMerge = async () => {
    if (merging) return;
    setMerging(true);
    setError(null);
    try {
      await onConfirm(ids);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setMerging(false);
    }
  };

  const sourceTag = (row: MergeableTransaction) => (isImportedTransaction(row) ? "Imported" : "Manual");
  const categoryName = (id: number | null) =>
    id == null ? null : (categoryById.get(id)?.name ?? "Unknown category");

  const mergedCategory = merged.transferAccountId != null ? "Transfer" : (categoryName(merged.categoryId) ?? "—");
  const fields: { label: string; value: ReactNode; source: "primary" | "secondary" | "both" }[] = [
    { label: "Date", value: merged.date, source: fieldSource(primary.date, secondary.date, merged.date) },
    {
      label: "Account",
      value: accountById.get(merged.accountId)?.name ?? "Unknown account",
      source: fieldSource(primary.accountId, secondary.accountId, merged.accountId),
    },
    {
      label: "Payee",
      value: merged.payee || <span className="y-hint">—</span>,
      source: fieldSource(primary.payee, secondary.payee, merged.payee),
    },
    {
      label: "Category",
      value: mergedCategory,
      source:
        merged.transferAccountId != null
          ? "primary"
          : fieldSource(primary.categoryId, secondary.categoryId, merged.categoryId),
    },
    {
      label: "Memo",
      value: merged.memo || <span className="y-hint">—</span>,
      source: fieldSource(primary.memo, secondary.memo, merged.memo),
    },
    {
      label: "Amount",
      value: money(merged.amount),
      source: fieldSource(primary.amount, secondary.amount, merged.amount),
    },
    {
      label: "Cleared",
      value: merged.status === "c" ? "Cleared" : "Uncleared",
      source: fieldSource(primary.status, secondary.status, merged.status),
    },
  ];
  if (merged.transferAccountId != null) {
    fields.push({
      label: "Transfer to",
      value: accountById.get(merged.transferAccountId)?.name ?? "Unknown account",
      source: "primary",
    });
  }

  const rows = [
    { row: primary, role: "Kept" },
    { row: secondary, role: "Removed" },
  ];

  return (
    <Modal
      wide
      title="Merge transactions"
      onClose={() => !merging && onClose()}
      footer={
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Btn onClick={onClose} disabled={merging}>
              Cancel
            </Btn>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Btn variant="primary" onClick={doMerge} disabled={merging}>
              {merging ? "Merging" : "Merge transactions"}
            </Btn>
          </div>
        </>
      }
    >
      {error && (
        <Notice tone="danger" title="Merge failed">
          {error}
        </Notice>
      )}
      <p className="y-hint text-[12px] leading-relaxed mb-3">
        These 2 transactions will be combined into one. Imported data wins; manual details fill
        the gaps.
      </p>

      <div data-testid="merge-result">
        <div className="y-label mb-1.5 block">Resulting transaction</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 mb-4">
          {fields.map((f) => (
            <div key={f.label}>
              <span className="y-label mb-0.5 block">{f.label}</span>
              <span className="text-[12.5px]" style={{ color: "var(--y-ink)" }}>
                {f.value}
              </span>
              {f.source !== "both" && (
                <span className="y-hint text-[11px] ml-1.5">
                  {sourceTag(f.source === "primary" ? primary : secondary)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div data-testid="merge-constituents">
        <div className="y-label mb-1.5 block">Merged from</div>
        <div className="border rounded overflow-auto" style={{ borderColor: "var(--y-line)" }}>
          <table className="y-table w-full text-left">
            <thead>
              <tr>
                <th aria-label="Merge role" style={{ width: 130 }} />
                <th>Date</th>
                <th>Payee</th>
                <th>Category</th>
                <th>Memo</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, role }) => (
                <tr key={row.id} className="y-row y-subrow">
                  <td className="whitespace-nowrap">
                    <span className="font-semibold text-[12px]" style={{ color: "var(--y-ink)" }}>
                      {role}
                    </span>{" "}
                    <span className="y-hint text-[11px]">· {sourceTag(row)}</span>
                  </td>
                  <td className="y-num whitespace-nowrap">{row.date}</td>
                  <td>{row.payee || <span className="y-hint">—</span>}</td>
                  <td>
                    {row.transferAccountId != null
                      ? "Transfer"
                      : (categoryName(row.categoryId) ?? <span className="y-hint">—</span>)}
                  </td>
                  <td>{row.memo || <span className="y-hint">—</span>}</td>
                  <td className="num y-num">{money(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
