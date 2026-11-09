"use client";

import { Button } from "@ynab/theme";

export function RegisterEmptyState({
  hasTransactions,
  hasSearch,
  hasExternalFilter,
  accountName,
  onAdd,
  onClearSearch,
  onClearFilter,
}: {
  hasTransactions: boolean;
  hasSearch: boolean;
  hasExternalFilter: boolean;
  accountName?: string;
  onAdd: () => void;
  onClearSearch: () => void;
  onClearFilter: () => void;
}) {
  const title = !hasTransactions
    ? "No transactions yet"
    : hasSearch
      ? "No transactions match your search"
      : hasExternalFilter
        ? "No transactions match this filter"
        : accountName
          ? `No transactions in ${accountName} yet`
          : "No transactions here yet";
  const hint = !hasTransactions
    ? "Record your first transaction below — every budget starts with one entry."
    : hasSearch || hasExternalFilter
      ? "Try widening the search, or clear it to see everything again."
      : "Add one to get this account moving.";
  return (
    <div
      className="mx-auto flex max-w-[420px] flex-col items-center gap-2"
      data-testid="register-empty-state"
    >
      <div className="text-[13px] font-semibold" style={{ color: "var(--y-ink)" }}>
        {title}
      </div>
      <p className="y-hint text-[12px] leading-relaxed">{hint}</p>
      <div className="mt-1 flex items-center justify-center gap-2">
        {(hasSearch || hasExternalFilter) && (
          <Button
            size="sm"
            onClick={hasSearch ? onClearSearch : onClearFilter}
          >
            Clear {hasSearch ? "search" : "filter"}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={onAdd}>
          Add transaction
        </Button>
      </div>
    </div>
  );
}
