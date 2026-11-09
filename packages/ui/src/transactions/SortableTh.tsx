"use client";

import { Tooltip } from "@ynab/theme";
import type { SortKey, SortState } from "./registerTypes.js";

export function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  className,
  style,
  title,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      className={className}
      style={style}
    >
      <Tooltip tip={title ?? `Sort by ${label}`} side="bottom">
        <button
          type="button"
          className="y-sort-btn"
          onClick={() => onSort(sortKey)}
        >
          {label}
          {/* The indicator slot is always reserved (even when inactive) so a
              column's intrinsic width never changes when the sort key moves —
              otherwise the register columns would reflow on every click. */}
          <span
            aria-hidden="true"
            className="y-sort-ind"
            style={{ display: "inline-block", width: 10, fontSize: 8, textAlign: "center" }}
          >
            {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
          </span>
        </button>
      </Tooltip>
    </th>
  );
}
