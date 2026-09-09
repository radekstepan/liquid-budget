import React from "react";
import { Icon, Select, cx, money } from "./primitives";

/* ==================================================================
   MONTH NAVIGATOR
   ================================================================== */
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseKey(key: string): { year: number; month0: number } {
  const [y, m] = key.split("-").map(Number);
  return { year: y ?? 0, month0: (m ?? 1) - 1 };
}

function keyOf(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}`;
}

export const MonthNav: React.FC<{
  month: string;
  onPrev?: () => void;
  onNext?: () => void;
  onSetMonth?: (key: string) => void;
  minYear?: number;
  maxYear?: number;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
}> = ({ month, onPrev, onNext, onSetMonth, minYear, maxYear, prevDisabled, nextDisabled }) => {
  const { year, month0 } = parseKey(month);
  const yMin = minYear ?? year - 10;
  const yMax = maxYear ?? year + 5;
  const years: number[] = [];
  for (let y = yMin; y <= yMax; y++) years.push(y);
  const yearsSet = new Set(years);
  const safeYear = yearsSet.has(year) ? year : Math.min(yMax, Math.max(yMin, year));

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="y-btn y-btn--sm y-monthnav-btn"
        aria-label="Previous month"
        onClick={onPrev}
        disabled={prevDisabled}
      >
        <Icon name="left" size={11} />
      </button>
      {onSetMonth ? (
        <div
          className="flex items-center gap-1 min-w-[132px] justify-center"
          data-testid="month-nav-picker"
        >
          <Select
            value={String(month0)}
            onChange={(v) => onSetMonth(keyOf(safeYear, Number(v)))}
            aria-label="Month"
          >
            {MONTHS_LONG.map((m, i) => (
              <option key={m} value={String(i)}>
                {m}
              </option>
            ))}
          </Select>
          <Select
            value={String(safeYear)}
            onChange={(v) => onSetMonth(keyOf(Number(v), month0))}
            aria-label="Year"
          >
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div
          className="text-[15px] font-bold min-w-[132px] text-center [text-shadow:0_1px_0_rgba(255,255,255,.8)]"
          style={{ color: "var(--y-ink)" }}
        >
          {`${MONTHS_LONG[month0] ?? ""} ${year}`}
        </div>
      )}
      <button
        type="button"
        className="y-btn y-btn--sm y-monthnav-btn"
        aria-label="Next month"
        onClick={onNext}
        disabled={nextDisabled}
      >
        <Icon name="right" size={11} />
      </button>
    </div>
  );
};

/* ==================================================================
   BUDGET HEADER  —  the "math strip" + Available to Budget box.
   Caller supplies a list of {label, value, danger?} cells and the
   final ATB value; this stays purely presentational so the app
   can wire its own budget numbers.
   ================================================================== */
export const MathCell: React.FC<{
  label: string;
  value: number | string;
  danger?: boolean;
  tone?: "default" | "green" | "red";
  className?: string;
  style?: React.CSSProperties;
}> = ({ label, value, danger, tone = "default", className, style }) => {
  const color =
    tone === "green"
      ? "var(--y-green-dk)"
      : tone === "red"
        ? "var(--y-red)"
        : danger
          ? "var(--y-red)"
          : undefined;
  const rendered = typeof value === "number" ? money(value) : value;
  return (
    <div className={cx("y-mathbox", className)} style={style}>
      <div className="y-math-label">{label}</div>
      <div className="y-math-val" style={{ color }}>
        {rendered}
      </div>
    </div>
  );
};

export type BudgetHeaderPart = {
  label: string;
  value: number;
  danger?: boolean;
};

export const BudgetHeader: React.FC<{
  parts: BudgetHeaderPart[];
  ops?: string[];
  atb: number;
  atbLabel?: string;
  deferredIncomeNotice?: string;
}> = ({ parts, ops, atb, atbLabel = "Available to Budget", deferredIncomeNotice }) => {
  const tone = atb > 0 ? "green" : atb < 0 ? "red" : "orange";
  const renderedOps = ops ?? parts.slice(0, -1).map(() => "+");
  return (
    <div className="y-budget-header flex items-center gap-3 px-3 py-3 flex-wrap">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="y-math-op">{renderedOps[i - 1] ?? "+"}</span>}
          <MathCell label={p.label} value={p.value} danger={p.danger} />
        </React.Fragment>
      ))}
      <span className="y-math-op">=</span>
      <div className={cx("y-atb", `y-atb--${tone}`)}>
        <div className="text-[20px] font-bold leading-[1.1] y-num">{money(atb)}</div>
        <div className="text-[9px] font-bold tracking-[.09em] uppercase opacity-90">
          {atbLabel}
        </div>
      </div>
      {deferredIncomeNotice && (
        <div className="w-full text-[11px] text-[var(--y-ink-soft)] italic" data-testid="budget-header-deferred-notice">
          {deferredIncomeNotice}
        </div>
      )}
    </div>
  );
};

/* ==================================================================
   MODAL
   ================================================================== */
export const Modal: React.FC<{
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  onClose?: () => void;
  inline?: boolean;
  dismissOnScrim?: boolean;
}> = ({ title, children, footer, width = 420, onClose, inline, dismissOnScrim = true }) => {
  // Track where the press started: a drag-select that begins inside the
  // dialog and releases over the scrim fires a click on the scrim, which
  // must NOT dismiss (otherwise selecting text in an input closes the modal).
  const scrimArmedRef = React.useRef(false);
  const body = (
    <div className="y-modal" style={{ width }}>
      <div className="y-modal-head flex items-center">
        <span>{title}</span>
        {onClose && (
          <button
            type="button"
            className="y-modal-close ml-auto"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={11} />
          </button>
        )}
      </div>
      <div className="p-4">{children}</div>
      {footer && <div className="y-modal-foot">{footer}</div>}
    </div>
  );
  if (inline) return body;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center y-scrim"
      onMouseDown={(e) => {
        scrimArmedRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (!dismissOnScrim || !onClose) return;
        // Only dismiss for a genuine scrim press: the click must land on the
        // scrim itself and the press must have started there. This keeps
        // text-selection drags that end over the scrim from closing the modal.
        if (e.target === e.currentTarget && scrimArmedRef.current) onClose();
        scrimArmedRef.current = false;
      }}
    >
      <div onClick={(e) => e.stopPropagation()}>{body}</div>
    </div>
  );
};
