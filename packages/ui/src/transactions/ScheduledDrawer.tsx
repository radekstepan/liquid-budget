"use client";

import type { TransactionFlagColor } from "@ynab/logic";
import { frequencyLabel, num, recurringFlavour } from "@ynab/logic";
import { Icon, FlagCell, Button, Tooltip, money, cx } from "@ynab/theme";
import { MIN_SCHEDULED_HEIGHT } from "./scheduledHeights.js";
import type { RegisterData } from "./useRegisterData.js";
import type { RegisterState } from "./useRegisterState.js";

export function ScheduledDrawer({
  state,
  data,
  accountFilter,
  onAddRecurring,
  onAddRecurringTransfer,
  onEditRecurring,
  onFlagRecurring,
  onBulkDeleteRecurring,
}: {
  state: RegisterState;
  data: RegisterData;
  accountFilter: number | null;
  onAddRecurring?: () => void;
  onAddRecurringTransfer?: () => void;
  onEditRecurring?: (id: number) => void;
  onFlagRecurring?: (id: number, color: TransactionFlagColor | null) => void;
  onBulkDeleteRecurring?: (ids: number[]) => Promise<void> | void;
}) {
  const {
    selectedRecurringIds,
    setSelectedRecurringIds,
    toggleScheduledDrawer,
    drawerRef,
    scheduledHeight,
    startScheduledResizing,
    resetScheduledHeight,
  } = state;
  const {
    accountById,
    categoryById,
    filterAccount,
    scheduledRows,
    today,
    dueScheduledCount,
    hasScheduledFlag,
    scheduledColCount,
    toggleRecurringRowSelect,
  } = data;
  return (
        <div
          ref={drawerRef}
          className="y-scheduled-drawer"
          style={
            scheduledHeight != null
              ? {
                  height: scheduledHeight,
                  minHeight: MIN_SCHEDULED_HEIGHT,
                  maxHeight: "75%",
                }
              : undefined
          }
        >
          {/* Horizontal Drag Resize Handle on the Top Edge */}
          <div
            onMouseDown={startScheduledResizing}
            onDoubleClick={resetScheduledHeight}
            className="y-scheduled-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize scheduled transactions"
          />
          {/* Drawer Header Bar / Bulk Actions Bar */}
          <div className="y-scheduled-header">
            {selectedRecurringIds.size > 0 ? (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="y-caps font-bold" style={{ color: "var(--y-ink)" }}>
                  {selectedRecurringIds.size} scheduled selected
                </span>
                <div className="y-tb-sep mx-1" style={{ height: 14 }} />
                {onBulkDeleteRecurring && (
                  <Button
                    variant="danger"
                    size="sm"
                    className="!py-0.5 !px-2 text-[11px]"
                    onClick={async () => {
                      const ids = Array.from(selectedRecurringIds);
                      setSelectedRecurringIds(new Set());
                      await onBulkDeleteRecurring(ids);
                    }}
                  >
                    Delete ({selectedRecurringIds.size})
                  </Button>
                )}
                <Button
                  variant="default"
                  size="sm"
                  className="ml-auto !py-0.5 !px-2 text-[11px]"
                  onClick={() => setSelectedRecurringIds(new Set())}
                >
                  Deselect All
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-bold text-[var(--y-ink)]">
                  Scheduled Transactions
                </span>
                <span className="text-[11px] text-gray-500 font-medium">
                  ({scheduledRows.length} scheduled{dueScheduledCount > 0 ? ` · ${dueScheduledCount} due` : ""})
                </span>
              </div>
            )}

            <Tooltip tip="Close drawer">
              <Button
                variant="default"
                size="sm"
                onClick={toggleScheduledDrawer}
                className="text-[11px] !py-0.5 !px-1.5 text-gray-500 ml-2"
                aria-label="Close drawer"
              >
                <span>✕</span>
              </Button>
            </Tooltip>
          </div>

          {/* Drawer Scheduled Table */}
          <div className="flex-1 overflow-y-auto overflow-x-auto y-scroll bg-white" style={{ background: "#ffffff" }}>
            <table className="y-table y-scheduled-table w-full text-left bg-white" style={{ background: "#ffffff" }}>
              <thead className="y-thead--sticky">
                <tr>
                  <th style={{ width: 34, minWidth: 34, textAlign: "center", padding: "4px 6px" }}>
                    <input
                      type="checkbox"
                      aria-label="Select all scheduled transactions"
                      checked={scheduledRows.length > 0 && selectedRecurringIds.size === scheduledRows.length}
                      onChange={() => {
                        if (selectedRecurringIds.size === scheduledRows.length) {
                          setSelectedRecurringIds(new Set());
                        } else {
                          setSelectedRecurringIds(new Set(scheduledRows.map((r) => r.id)));
                        }
                      }}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle"
                    />
                  </th>
                  {hasScheduledFlag && <th style={{ width: 32 }} className="text-center">Flag</th>}
                  <th style={{ width: 85 }}>Date</th>
                  <th style={{ width: 110 }}>Frequency</th>
                  {!accountFilter && <th style={{ width: 120 }}>Account</th>}
                  <th>Payee</th>
                  <th style={{ width: 170 }}>Category</th>
                  <th style={{ width: 150 }}>Memo</th>
                  <th className="num" style={{ width: 90 }}>
                    Outflow
                  </th>
                  <th className="num" style={{ width: 90 }}>
                    Inflow
                  </th>
                </tr>
              </thead>
              <tbody>
                {scheduledRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={scheduledColCount}
                      className="text-center text-[12px]"
                      style={{ color: "var(--y-ink-faint)", background: "#ffffff", padding: "24px 12px" }}
                    >
                      <div className="mx-auto flex max-w-[420px] flex-col items-center gap-1.5">
                        <div className="font-semibold" style={{ color: "var(--y-ink-soft)" }}>
                          Nothing scheduled for {filterAccount ? filterAccount.name : "these accounts"}
                        </div>
                        <p className="y-hint leading-relaxed">
                          Put bills and paychecks on autopilot — they post themselves on the right date.
                        </p>
                        {onAddRecurring && (
                          <Button size="sm" onClick={onAddRecurring} className="mt-1">
                            Schedule one
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  scheduledRows.map((r, idx) => {
                    const isScheduledSelected = selectedRecurringIds.has(r.id);
                    const flavour = recurringFlavour(r, r.subTransactions ?? []);
                    const sourceName = accountById.get(r.accountId)?.name ?? "";
                    const destName =
                      flavour === "transfer" && r.transferAccountId != null
                        ? accountById.get(r.transferAccountId)?.name ?? ""
                        : "";
                    const children = r.subTransactions ?? [];
                    const displayAmt =
                      flavour === "split"
                        ? children.reduce((s, c) => s + num(c.amount), 0)
                        : num(r.amount);

                    const isIncomingTransfer = accountFilter != null && r.transferAccountId === accountFilter;
                    const effAmt = isIncomingTransfer ? -displayAmt : displayAmt;
                    const outflow = effAmt < 0 ? -effAmt : 0;
                    const inflow = effAmt > 0 ? effAmt : 0;

                    const isOverdue = r.active && r.nextDate < today;
                    const isDueToday = r.active && r.nextDate === today;
                    const isFuture = r.active && r.nextDate > today;

                    const displayPayee =
                      flavour === "transfer"
                        ? isIncomingTransfer
                          ? `Transfer : ${sourceName}`
                          : `Transfer : ${destName}`
                        : r.payee;

                    const catName = r.categoryId ? categoryById.get(r.categoryId)?.name ?? "" : "";
                    const displayCat =
                      flavour === "split"
                        ? `Split (${children.length} Categories)`
                        : flavour === "transfer"
                          ? "Transfer"
                          : catName;

                    const isDue = r.active && r.nextDate <= today;
                    return (
                      <tr
                        key={r.id}
                        className={cx(
                          "y-row hover:bg-blue-50/60 cursor-pointer",
                          // Due scheduled rows render bold like unreviewed
                          // imports: both mean "new" and share one count.
                          isDue && "font-bold",
                          isScheduledSelected && "y-row--selected is-sel",
                          idx % 2 === 1 && !isScheduledSelected && "alt"
                        )}
                        onClick={() => {
                          if (onEditRecurring) onEditRecurring(r.id);
                        }}
                      >
                        <td
                          style={{ width: 34, minWidth: 34, textAlign: "center", padding: "4px 6px" }}
                          className="text-center"
                          onClick={(e) => toggleRecurringRowSelect(r.id, e)}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select scheduled transaction ${r.payee || r.id}`}
                            checked={isScheduledSelected}
                            onChange={() => {}}
                            onClick={(e) => toggleRecurringRowSelect(r.id, e)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle"
                          />
                        </td>
                        {hasScheduledFlag && (
                          <td className="text-center" onClick={(e) => e.stopPropagation()}>
                            <FlagCell
                              color={r.flagColor ?? null}
                              onChange={(color) => onFlagRecurring?.(r.id, color)}
                            />
                          </td>
                        )}
                        <td className="y-num font-medium">
                          <span
                            style={{
                              color: isOverdue ? "var(--y-red)" : isDueToday ? "var(--y-orange-dk)" : undefined,
                            }}
                          >
                            {r.nextDate}
                          </span>
                        </td>
                        <td className="truncate text-[11px]" style={{ color: "var(--y-ink-soft)" }}>
                          {frequencyLabel(r.frequency)}
                        </td>
                        {!accountFilter && (
                          <td className="truncate text-[11px]" style={{ color: "var(--y-ink-soft)" }}>
                            {sourceName}
                          </td>
                        )}
                        <td className="truncate font-medium" style={{ color: "var(--y-ink)" }}>
                          {displayPayee}
                        </td>
                        <td
                          className="truncate text-[11px]"
                          style={{
                            color:
                              displayCat.startsWith("Split") || flavour === "transfer"
                                ? "var(--y-blue)"
                                : "var(--y-ink-soft)",
                          }}
                        >
                          {displayCat}
                        </td>
                        <td className="truncate italic text-[11px]" style={{ color: "var(--y-ink-faint)" }}>
                          {r.memo || (children.length > 0 ? children.map((c) => c.memo).filter(Boolean).join("; ") : "")}
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
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Drawer Footer: Schedule Actions */}
          <div className="y-scheduled-footer">
            {onAddRecurring && (
              <Button onClick={onAddRecurring} variant="primary" size="sm">
                <Icon name="plus" size={11} color="#fff" />
                <span className="ml-1 font-bold">Schedule a new transaction</span>
              </Button>
            )}

            {onAddRecurringTransfer && (
              <Button onClick={onAddRecurringTransfer} variant="default" size="sm">
                <Icon name="swap" size={11} color="var(--y-ink)" />
                <span className="ml-1 font-medium">Schedule a transfer</span>
              </Button>
            )}
          </div>
        </div>
  );
}
