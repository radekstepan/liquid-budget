"use client";

import type {
  BudgetData,
  Query,
  TransactionFlagColor,
} from "@ynab/logic";
import { Icon, ClearedFlag, FlagCell, Tooltip, money, cx } from "@ynab/theme";
import { RegisterEmptyState } from "./RegisterEmptyState.js";
import { SortableTh } from "./SortableTh.js";
import type { RegisterData } from "./useRegisterData.js";
import type { RegisterState } from "./useRegisterState.js";

export function RegisterTable({
  state,
  data,
  budgetData,
  accountFilter,
  externalFilter,
  onGoToTransfer,
  onAdd,
  onEdit,
  onCycleStatus,
  onFlag,
  onClearFilter,
}: {
  state: RegisterState;
  data: RegisterData;
  budgetData: BudgetData;
  accountFilter: number | null;
  externalFilter?: {
    payee?: string;
    categoryId?: number | null;
    text?: string;
    query?: Query;
    nonce: number;
  } | null;
  onGoToTransfer?: (accountId: number, transactionId: number) => void;
  onAdd: () => void;
  onEdit: (id: number) => void;
  onCycleStatus: (id: number) => void;
  onFlag: (id: number, color: TransactionFlagColor | null) => void;
  onClearFilter?: () => void;
}) {
  const {
    appliedQuery,
    clearAppliedQuery,
    selectedId,
    setSelectedId,
    selectedIds,
    setDuplicateInspectorId,
    sort,
    toggleSort,
    expandedSplitIds,
    toggleExpandSplit,
    containerRef,
    handleScroll,
  } = state;
  const {
    accountById,
    categoryById,
    splitParentIds,
    childrenByParent,
    queryIdSet,
    filtered,
    hasFlagColumn,
    colCount,
    startIndex,
    topHeight,
    bottomHeight,
    visibleRows,
    allVisibleSelected,
    toggleSelectAll,
    toggleRowSelect,
  } = data;
  const transactions = budgetData.transactions;
  return (
      <div
        ref={containerRef}
        tabIndex={0}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto y-scroll bg-white"
        style={{ minHeight: 120, background: "#ffffff" }}
      >
        <table className="y-table w-full text-left bg-white">
          <thead className="y-thead--sticky">
            <tr>
              <th
                style={{ width: 34, minWidth: 34, textAlign: "center", padding: "4px 6px" }}
                className="text-center"
              >
                <input
                  type="checkbox"
                  aria-label="Select all transactions"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle inline-block"
                  style={{ verticalAlign: "middle", margin: "0 auto", display: "inline-block" }}
                />
              </th>
              {hasFlagColumn && (
                <SortableTh
                  label="F"
                  title="Sort by Flag"
                  sortKey="flag"
                  sort={sort}
                  onSort={toggleSort}
                  className="text-center"
                  style={{ width: 32 }}
                />
              )}
              <SortableTh label="Date" sortKey="date" sort={sort} onSort={toggleSort} style={{ width: 85 }} />
              {!accountFilter && (
                <SortableTh
                  label="Account"
                  sortKey="account"
                  sort={sort}
                  onSort={toggleSort}
                  style={{ width: 120 }}
                />
              )}
              <SortableTh label="Payee" sortKey="payee" sort={sort} onSort={toggleSort} />
              <SortableTh
                label="Category"
                sortKey="category"
                sort={sort}
                onSort={toggleSort}
                style={{ width: 180 }}
              />
              <SortableTh
                label="Memo"
                sortKey="memo"
                sort={sort}
                onSort={toggleSort}
                style={{ width: 160 }}
              />
              <SortableTh
                label="Outflow"
                sortKey="outflow"
                sort={sort}
                onSort={toggleSort}
                className="num"
                style={{ width: 95 }}
              />
              <SortableTh
                label="Inflow"
                sortKey="inflow"
                sort={sort}
                onSort={toggleSort}
                className="num"
                style={{ width: 95 }}
              />
              <SortableTh
                label="C"
                sortKey="cleared"
                sort={sort}
                onSort={toggleSort}
                className="text-center"
                style={{ width: 32 }}
              />
              <SortableTh
                label="Balance"
                sortKey="balance"
                sort={sort}
                onSort={toggleSort}
                className="num"
                style={{ width: 108 }}
              />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center" style={{ padding: "28px 12px" }}>
                  <RegisterEmptyState
                    hasTransactions={transactions.length > 0}
                    hasSearch={appliedQuery != null}
                    hasExternalFilter={externalFilter != null}
                    accountName={accountFilter != null ? accountById.get(accountFilter)?.name : undefined}
                    onAdd={onAdd}
                    onClearSearch={clearAppliedQuery}
                    onClearFilter={() => onClearFilter?.()}
                  />
                </td>
              </tr>
            ) : (
              <>
                {topHeight > 0 && (
                  <tr style={{ height: topHeight }}>
                    <td colSpan={colCount} style={{ height: topHeight, padding: 0, border: 0 }} />
                  </tr>
                )}
                {visibleRows.map((t, idx) => {
                  const globalIndex = startIndex + idx;
                  const isIncoming = accountFilter != null && t.transferAccountId === accountFilter;
                  const isChildRow = t.parentId != null && !isIncoming;
                  // Sub-rows are display-only: no checkbox, no highlight, even
                  // if a stale id lingers in selection state.
                  const isSelected = !isChildRow && (t.id === selectedId || selectedIds.has(t.id));
                  const isChecked = !isChildRow && selectedIds.has(t.id);
                  const effAmt = isIncoming ? -t.amount : t.amount;
                  const effStatus = isIncoming ? (t.transferStatus ?? t.status) : t.status;
                  const isReconciled = effStatus === "r";
                  // Unreviewed imports/posts show "N" (New) in the C column
                  // until approved, alongside the bold row. Reconciled rows
                  // are never unreviewed, but keep R authoritative anyway.
                  const showNew = !isChildRow && t.needsReview === true && !isReconciled;
                  const outflow = effAmt < 0 ? -effAmt : 0;
                  const inflow = effAmt > 0 ? effAmt : 0;
                  const isSplit = splitParentIds.has(t.id);
                  const isTransfer = t.transferAccountId != null && !isSplit;
                  const otherAccountId = isTransfer
                    ? accountFilter != null && t.transferAccountId === accountFilter
                      ? t.accountId
                      : t.transferAccountId
                    : null;
                  const otherAccount = otherAccountId != null ? accountById.get(otherAccountId) : null;
                  const otherAccountName = otherAccount?.name ?? "Account";
                  const catName =
                    t.categoryId != null ? categoryById.get(t.categoryId)?.name ?? "" : "";
                  // Income rows (isIncome, no category) show "Income";
                  // uncategorized rows stay blank.
                  const isIncomeRow =
                    !isSplit && !isTransfer && t.categoryId == null && !!t.isIncome;
                  const displayPayee = isIncoming
                    ? `Transfer : ${accountById.get(t.accountId)?.name ?? "Unknown"}`
                    : isChildRow && t.transferAccountId != null
                      ? `Transfer : ${accountById.get(t.transferAccountId)?.name ?? "Unknown"}`
                      : t.payee;

                  const children = childrenByParent.get(t.id);
                  const hasMatchingChild =
                    queryIdSet != null &&
                    (children?.some((c) => queryIdSet.has(c.id)) ?? false);
                  const isParentSelected = selectedId === t.id || selectedIds.has(t.id);
                  const isExpanded =
                    expandedSplitIds.has(t.id) ||
                    isParentSelected ||
                    hasMatchingChild;

                  return (
                    <tr
                      key={t.id}
                      data-txn-id={t.id}
                      className={cx(
                        "group y-row",
                        isChildRow && "y-subrow bg-slate-50/50 text-[11px]",
                        // Freshly imported rows render bold until reviewed,
                        // matching YNAB4's unapproved-import look.
                        !isChildRow && t.needsReview && "font-bold",
                        isSelected && "y-row--selected is-sel",
                        globalIndex % 2 === 1 && !isSelected && "alt"
                      )}
                      onClick={() => {
                        setSelectedId(null);
                        onEdit(t.parentId ?? t.id);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td
                        style={{ width: 34, minWidth: 34, textAlign: "center", padding: "4px 6px" }}
                        className="text-center"
                        onClick={(e) => {
                          if (!isChildRow) toggleRowSelect(t.id, e);
                          else e.stopPropagation();
                        }}
                      >
                        {!isChildRow && (
                          <input
                            type="checkbox"
                            aria-label={`Select transaction ${t.payee || t.id}`}
                            checked={isChecked}
                            onChange={() => {}}
                            onClick={(e) => toggleRowSelect(t.id, e)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle inline-block"
                            style={{ verticalAlign: "middle", margin: "0 auto", display: "inline-block" }}
                          />
                        )}
                      </td>
                      {hasFlagColumn && (
                        <td className="text-center" onClick={(e) => e.stopPropagation()}>
                          <FlagCell
                            color={t.flagColor ?? null}
                            onChange={(color) => onFlag(t.id, color)}
                            disabled={isReconciled}
                            onDuplicateClick={
                              t.flagColor === "duplicate" ? () => setDuplicateInspectorId(t.id) : undefined
                            }
                          />
                        </td>
                      )}
                      <td className={cx("y-num", isChildRow && "text-[11px]")} style={isChildRow ? { color: "var(--y-ink-soft)" } : undefined}>
                        {t.date}
                      </td>
                      {!accountFilter && (
                        <td className={cx("truncate", isChildRow && "text-[11px]")} style={{ color: "var(--y-ink-soft)" }}>
                          {accountById.get(t.accountId)?.name ?? ""}
                        </td>
                      )}
                      <td className={cx("truncate", isChildRow && "text-[11px]")} style={{ color: isChildRow ? "var(--y-ink-soft)" : "var(--y-ink)" }}>
                        {isChildRow ? (
                          <span className="inline-flex items-center">
                            <span className="text-gray-400 mr-1.5 pl-2 select-none font-normal">↳</span>
                            <span>{displayPayee}</span>
                          </span>
                        ) : (
                          <>
                            {isSplit && (
                              <Tooltip
                                tip={isExpanded ? "Collapse split sub-transactions" : "Expand split sub-transactions"}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                     e.stopPropagation();
                                     toggleExpandSplit(t.id);
                                  }}
                                  className="inline-flex items-center justify-center w-3.5 h-3.5 mr-1 text-[9px] text-gray-500 hover:text-gray-900 rounded hover:bg-gray-200 transition-colors cursor-pointer align-middle"
                                  aria-label={isExpanded ? "Collapse split sub-transactions" : "Expand split sub-transactions"}
                                >
                                  {isExpanded ? "▼" : "▶"}
                                </button>
                              </Tooltip>
                            )}
                            <span>{displayPayee}</span>
                          </>
                        )}
                      </td>
                      <td
                        className={cx("truncate", isChildRow && "text-[11px]")}
                        style={{
                          color:
                            isSplit || isTransfer
                              ? "var(--y-blue)"
                              : isIncomeRow
                                ? "var(--y-green-dk)"
                                : "var(--y-ink-soft)",
                        }}
                      >
                        {isSplit ? (
                          "Split (Multiple Categories)"
                        ) : isTransfer && otherAccountId != null ? (
                          <Tooltip tip={`Go to transfer in ${otherAccountName}`}>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onGoToTransfer?.(otherAccountId, t.id);
                              }}
                              className="inline-flex items-center gap-1 px-1 py-0.5 rounded hover:bg-blue-50/80 transition-colors cursor-pointer align-middle"
                              style={{ color: "var(--y-blue)" }}
                              aria-label={`Go to transfer in ${otherAccountName}`}
                            >
                              <Icon name="swap" size={11} color="currentColor" />
                              {catName ? <span className="truncate">{catName}</span> : null}
                            </button>
                          </Tooltip>
                        ) : isIncomeRow ? (
                          "Income"
                        ) : (
                          catName
                        )}
                      </td>
                      <td className={cx("truncate italic", isChildRow && "text-[11px]")} style={{ color: "var(--y-ink-faint)" }}>
                        {t.memo}
                      </td>
                      <td className="num y-num">{outflow ? money(outflow) : ""}</td>
                      <td
                        className="num y-num"
                        style={{
                          color: inflow ? "var(--y-green-dk)" : undefined,
                          fontWeight: inflow ? 700 : 400,
                        }}
                      >
                        {inflow ? money(inflow) : ""}
                      </td>
                      <td className="text-center" onClick={(e) => e.stopPropagation()}>
                        <ClearedFlag
                          state={showNew ? "n" : effStatus}
                          onCycle={() => onCycleStatus(t.id)}
                          disabled={isReconciled}
                        />
                      </td>
                      <td
                        className="num y-num"
                        style={
                          t.runningBalance == null
                            ? { color: "var(--y-ink-faint)" }
                            : {
                                color:
                                  t.runningBalance < 0 ? "var(--y-red)" : "var(--y-ink)",
                                fontWeight: t.runningBalance < 0 ? 700 : 400,
                              }
                        }
                      >
                        {t.runningBalance == null ? "—" : money(t.runningBalance)}
                      </td>
                    </tr>
                  );
                })}
                {bottomHeight > 0 && (
                  <tr style={{ height: bottomHeight }}>
                    <td colSpan={colCount} style={{ height: bottomHeight, padding: 0, border: 0 }} />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
  );
}
