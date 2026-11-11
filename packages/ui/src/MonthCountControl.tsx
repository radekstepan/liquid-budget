"use client";

import { cx } from "@ynab/theme";

/** Segmented 1/3/6/12 control for visible budget months (ui-split slice 2). */
export function MonthCountControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const options = [1, 3, 6, 12];
  return (
    <div
      className="flex items-center overflow-hidden"
      role="group"
      aria-label="Months shown"
      style={{
        border: "1px solid var(--y-chrome-line)",
        borderRadius: 3,
        background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
      }}
    >
      {options.map((n, i) => {
        const active = n === value;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={active}
            aria-label={`${n} month${n === 1 ? "" : "s"}`}
            className={cx(
              "px-2 py-[3px] text-[11px] leading-none",
              i > 0 && "y-table-colgroup-divider"
            )}
            style={{
              border: 0,
              borderLeft: i > 0 ? "1px solid var(--y-chrome-line)" : "none",
              background: active ? "var(--y-master)" : "transparent",
              color: active ? "var(--y-ink)" : "var(--y-ink-soft)",
              fontWeight: active ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}
