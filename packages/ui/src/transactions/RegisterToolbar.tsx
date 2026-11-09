"use client";

import { filterId, filterLabel, type Query } from "@ynab/logic";
import { Icon, Toolbar, ToolbarSep, Tooltip } from "@ynab/theme";
import type { RegisterData } from "./useRegisterData.js";
import type { RegisterState } from "./useRegisterState.js";

export function RegisterToolbar({
  state,
  data,
  onEditFilter,
}: {
  state: RegisterState;
  data: RegisterData;
  onEditFilter?: (query: Query) => void;
}) {
  const {
    appliedQuery,
    clearAppliedQuery,
    removeAppliedFilterChip,
    removeAppliedTextChip,
  } = state;
  const { filterAccount } = data;
  return (
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="swap" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>
            {filterAccount ? filterAccount.name : "All Transactions"}
          </span>
          {filterAccount?.archived && (
            <Tooltip tip="This account is closed. Reopen it to add new transactions.">
              <span
                className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded border"
                style={{
                  backgroundColor: "var(--y-gray-100, #f1f5f9)",
                  borderColor: "var(--y-gray-300, #cbd5e1)",
                  color: "var(--y-ink-soft, #64748b)",
                }}
              >
                Closed
              </span>
            </Tooltip>
          )}
          {filterAccount?.notes ? (
            <Tooltip tip={filterAccount.notes}>
              <span
                className="text-[11px] truncate max-w-[320px]"
                style={{ color: "var(--y-ink-soft, #64748b)" }}
              >
                {filterAccount.notes}
              </span>
            </Tooltip>
          ) : null}
        </div>
        <ToolbarSep />
        {appliedQuery != null &&
        (appliedQuery.filters.length > 0 || appliedQuery.text.trim().length > 0) ? (
          <div
            data-testid="register-filter-bar"
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
          >
            {appliedQuery.filters.map((f, i) => {
              const { key, value } = filterLabel(f);
              return (
                <span key={`${filterId(f)}:${i}`} className="y-chip shrink-0">
                  <Tooltip tip={`Edit ${key} filter`} className="flex h-full">
                    <button
                      type="button"
                      onClick={() => appliedQuery && onEditFilter?.(appliedQuery)}
                      className="y-chip-edit"
                      aria-label={`Edit ${key} filter`}
                    >
                      <span className="y-chip-key">{key}</span>
                      <span className="y-chip-val">{value}</span>
                    </button>
                  </Tooltip>
                  <Tooltip tip={`Remove ${key} filter`} className="flex h-full">
                    <button
                      type="button"
                      onClick={() => removeAppliedFilterChip(i)}
                      className="y-chip-x"
                      aria-label={`Remove ${key} filter`}
                    >
                      <Icon name="x" size={10} />
                    </button>
                  </Tooltip>
                </span>
              );
            })}
            {appliedQuery.text.trim().length > 0 && (
              <span className="y-chip shrink-0">
                <Tooltip tip="Edit search text filter" className="flex h-full">
                  <button
                    type="button"
                    onClick={() => appliedQuery && onEditFilter?.(appliedQuery)}
                    className="y-chip-edit"
                    aria-label="Edit search text filter"
                  >
                    <span className="y-chip-key">Search</span>
                    <span className="y-chip-val">“{appliedQuery.text.trim()}”</span>
                  </button>
                </Tooltip>
                <Tooltip tip="Remove search text filter" className="flex h-full">
                  <button
                    type="button"
                    onClick={removeAppliedTextChip}
                    className="y-chip-x"
                    aria-label="Remove search text filter"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </Tooltip>
              </span>
            )}
            <button
              type="button"
              className="y-btn y-btn--sm shrink-0"
              onClick={clearAppliedQuery}
            >
              Clear
            </button>
          </div>
        ) : (
          <Tooltip tip="Filter transactions (⌘K)">
            <button
              type="button"
              className="y-btn y-btn--sm"
              aria-label="Filter transactions"
              onClick={() => onEditFilter?.({ filters: [], text: "" })}
            >
              <span className="inline-flex items-center gap-1.5">
                <Icon name="search" size={12} />
                Filter
              </span>
            </button>
          </Tooltip>
        )}
      </Toolbar>
  );
}
