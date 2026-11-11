"use client";

import { useState, useRef, useEffect } from "react";
import type { GroupRow, CatRow } from "@ynab/logic";
import { fmt, evalAmount, dollarsToCents, validateAmountInput } from "@ynab/logic";
import { balanceColor, COL_A, COL_O, COL_V } from "./budgetViewHelpers.js";
import { cx, Tooltip } from "@ynab/theme";

/** Assigned/Outflow/Balance `<td>` triple for one group row or category row
 * in a single month column (ui-split slice 4). Group rows are read-only;
 * category rows embed the inline assigned-amount editor when `onAssign`
 * is provided. */
export function MonthCells({
  group,
  row,
  isOtherMonth,
  isFirstMonth,
  isRowForGroup,
  onAssign,
  quickFill,
  categoryId,
  isThisMonth,
}: {
  group?: GroupRow;
  row?: CatRow;
  isOtherMonth: boolean;
  isFirstMonth: boolean;
  isRowForGroup?: boolean;
  onAssign?: (val: number) => void;
  quickFill?: CategoryMonthCellProps["quickFill"];
  categoryId?: number;
  isThisMonth?: boolean;
}) {
  const divCls = isFirstMonth ? "" : "y-table-colgroup-divider";
  const readOnlyCls = isOtherMonth ? "y-table-cell--readonly" : "";
  const firstCls = isThisMonth ? "y-grid-col--current-first" : "";
  const lastCls = isThisMonth ? "y-grid-col--current-last" : "";

  if (isRowForGroup && group) {
    return (
      <>
        <td className={cx("num y-num text-right", COL_A, divCls, readOnlyCls, firstCls)}>
          {fmt(group.assigned)}
        </td>
        <td
          className={cx("num y-num text-right", COL_O, readOnlyCls)}
          style={{
            color: !isOtherMonth && group.outflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)",
          }}
        >
          {fmt(group.outflow)}
        </td>
        <td className={cx("num y-num text-right", COL_V, lastCls)} style={{ color: balanceColor(group.available) }}>
          {fmt(group.available)}
          {group.available < 0 && <OverspentMarker />}
        </td>
      </>
    );
  }

  if (!row) return <td colSpan={3} className={divCls} />;

  return (
    <>
      <td className={cx("num", COL_A, divCls, firstCls)}>
        {onAssign ? (
          <CategoryMonthCell
            value={row.assigned}
            onAssign={onAssign}
            quickFill={quickFill}
            categoryId={categoryId}
            available={row.available}
          />
        ) : (
          <span className={cx("y-num", readOnlyCls)}>{fmt(row.assigned)}</span>
        )}
      </td>
      <td
        className={cx("num y-num", COL_O, readOnlyCls)}
        style={{
          color: row.outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)",
        }}
      >
        {fmt(row.outflow)}
      </td>
      <td className={cx("num y-num", COL_V, lastCls)} style={{ color: balanceColor(row.available) }}>
        {fmt(row.available)}
        {row.available < 0 && <OverspentMarker />}
        {row.available < 0 && row.category.overspendCarriesOver && (
          <Tooltip tip="Red Arrow to the Right: Overspending carries over to next month">
            <span
              className="ml-1 text-red-600 font-bold"
              aria-label="Red arrow: carry over"
            >
              ➔
            </span>
          </Tooltip>
        )}
      </td>
    </>
  );
}

export type CategoryMonthCellProps = {
  value: number;
  onAssign: (v: number) => void;
  quickFill?: {
    lastMonthAssignments?: Map<number, number>;
    spentLastMonthByCategory?: Map<number, number>;
    avgSpentByCategory?: Map<number, number>;
    avgBudgetedByCategory?: Map<number, number>;
    underfundedByCategory?: Map<number, number>;
  };
  categoryId?: number;
  available?: number;
};

/** Button → input inline editor for a category's assigned amount, with
 * validation, overspend preview, and expression preview (ui-split slice 4).
 * Zero is assignable (it clears the category) even though zero-amount
 * transactions are rejected elsewhere. */
export function CategoryMonthCell({
  value,
  onAssign,
  quickFill,
  categoryId,
  available,
}: CategoryMonthCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    // Note: zero is assignable here (it clears the category) even though
    // zero-amount transactions are rejected elsewhere.
    const v = validateAmountInput(draft);
    if ((v.status === "valid" || v.status === "zero") && v.cents != null) onAssign(v.cents);
    setEditing(false);
  };

  const lastMonthVal =
    categoryId != null ? quickFill?.lastMonthAssignments?.get(categoryId) : undefined;

  if (editing) {
    const validation = validateAmountInput(draft);
    // Zero is assignable (it clears the category); only unparseable input blocks.
    const blocked = validation.status === "invalid";
    const assignableCents =
      (validation.status === "valid" || validation.status === "zero") ? validation.cents : null;
    // Projected balance if this draft were assigned: assigning replaces the
    // current value, so availability shifts by the delta.
    const projected =
      assignableCents != null && available != null
        ? available - value + assignableCents
        : null;
    const overspend = projected != null && projected < 0 ? projected : null;
    const preview = (() => {
      const n = evalAmount(draft);
      if (n == null || !Number.isFinite(n)) return undefined;
      if (!/[+\-*/]/.test(draft.replace(/^[+-]/, ""))) return undefined;
      return `= ${fmt(dollarsToCents(n))}`;
    })();
    const tip = blocked
      ? "Enter a valid amount"
      : overspend != null
        ? `Would overspend by ${fmt(-overspend)}`
        : preview;
    const warn = blocked || overspend != null;
    return (
      <Tooltip tip={tip}>
        <input
          ref={inputRef}
          size={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Blocked drafts stay open on Enter so the hint can be read;
            // Escape or blurring away still discards without saving.
            if (e.key === "Enter" && !blocked) commit();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
          aria-label={tip ?? "Edit assigned amount"}
          aria-invalid={blocked}
          className="y-inline-amt"
          style={warn ? { color: "var(--y-red)" } : undefined}
        />
      </Tooltip>
    );
  }

  return (
    <Tooltip tip={lastMonthVal != null ? `Last month: ${fmt(lastMonthVal)}` : undefined}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setDraft((value / 100).toFixed(2));
          setEditing(true);
        }}
        className="y-inline-amt cursor-text"
        style={{ color: "var(--y-ink)" }}
      >
        {fmt(value)}
      </button>
    </Tooltip>
  );
}

/** Non-color overspent cue for negative balances (a11y slice 3). A ▼ glyph
 * with an accessible label, rendered next to every negative available
 * figure, so the overspent state never rides on red alone. Amount text
 * is untouched: the marker is a separate element readers query past. */
export function OverspentMarker() {
  return (
    <Tooltip tip="Overspent">
      <span className="ml-1 font-bold" aria-label="Overspent" style={{ color: "var(--y-red)" }}>
        ▼
      </span>
    </Tooltip>
  );
}
