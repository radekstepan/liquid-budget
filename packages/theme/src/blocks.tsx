import React from "react";
import { Icon, cx, money } from "./primitives";

/* ==================================================================
   MONTH NAVIGATOR
   ================================================================== */
export const MonthNav: React.FC<{
  month: string;
  onPrev?: () => void;
  onNext?: () => void;
}> = ({ month, onPrev, onNext }) => (
  <div className="flex items-center gap-2">
    <button
      type="button"
      className="y-btn y-btn--sm"
      aria-label="Previous month"
      onClick={onPrev}
    >
      <Icon name="left" size={11} />
    </button>
    <div className="text-[15px] font-bold text-[#3b4245] min-w-[132px] text-center [text-shadow:0_1px_0_rgba(255,255,255,.8)]">
      {month}
    </div>
    <button
      type="button"
      className="y-btn y-btn--sm"
      aria-label="Next month"
      onClick={onNext}
    >
      <Icon name="right" size={11} />
    </button>
  </div>
);

/* ==================================================================
   BUDGET HEADER  —  the "math strip" + Available to Budget box.
   Caller supplies a list of {label, value, danger?} cells and the
   final ATB value; this stays purely presentational so the app
   can wire its own budget numbers.
   ================================================================== */
export const MathCell: React.FC<{ label: string; value: number; danger?: boolean }> = ({
  label,
  value,
  danger,
}) => (
  <div className="y-mathbox">
    <div className="y-math-label">{label}</div>
    <div className="y-math-val" style={{ color: danger ? "var(--y-red)" : undefined }}>
      {money(value)}
    </div>
  </div>
);

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
}> = ({ parts, ops, atb, atbLabel = "Available to Budget" }) => {
  const tone = atb > 0 ? "green" : atb < 0 ? "red" : "orange";
  const renderedOps = ops ?? parts.slice(0, -1).map(() => "+");
  return (
    <div
      className="flex items-center gap-3 px-3 py-3 flex-wrap"
      style={{
        background: "linear-gradient(#f6f6f4,#e7e7e4)",
        borderBottom: "1px solid #bdbdb8",
      }}
    >
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
  const body = (
    <div className="y-modal" style={{ width }}>
      <div className="y-modal-head flex items-center">
        <span>{title}</span>
        {onClose && (
          <button
            type="button"
            className="ml-auto text-[#7d8386] hover:text-[#33383b]"
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
      onClick={dismissOnScrim ? onClose : undefined}
    >
      <div onClick={(e) => e.stopPropagation()}>{body}</div>
    </div>
  );
};
