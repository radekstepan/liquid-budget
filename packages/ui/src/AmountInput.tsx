"use client";

import { useEffect, useRef, useState } from "react";
import { evalAmount, fmtSigned, dollarsToCents, validateAmountInput } from "@ynab/logic";
import { Button, Icon, TextField, Tooltip } from "@ynab/theme";

export function amountValidationMessage(value: string): string | null {
  const v = validateAmountInput(value);
  if (v.status === "invalid") return "Enter a valid amount (numbers and + − × ÷ work too).";
  if (v.status === "zero") return "Amount can't be zero.";
  return null;
}

export function AmountFieldError({ value }: { value: string }) {
  const message = amountValidationMessage(value);
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mt-1 text-[11px]"
      style={{ color: "var(--y-red)" }}
    >
      {message}
    </div>
  );
}

export function AmountPreview({ value }: { value: string }) {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  const containsOp = /[+\-*/]/.test(trimmed.replace(/^[+-]/, ""));
  if (!containsOp) return null;
  const n = evalAmount(trimmed);
  if (n == null || !Number.isFinite(n)) return null;
  return (
    <div
      className="mt-1 text-[11px]"
      style={{ color: "var(--y-ink-faint)" }}
    >
      = {fmtSigned(dollarsToCents(n))}
    </div>
  );
}

/**
 * YNAB4-style amount field with an on-the-fly calculator. The icon opens a
 * small popover with an expression input (not a button-pad calculator);
 * applying writes the evaluated result back into the field.
 *
 * Expressions are evaluated with `evalAmount` from `@ynab/logic` — a
 * purpose-built tokenizer/shunting-yard parser. It never uses `eval()` or
 * `new Function()`, so arbitrary code cannot run.
 */
export function AmountFieldWithCalculator({
  value,
  onChange,
  placeholder = "0.00",
  inputMode = "decimal",
  autoFocus,
  ariaLabel,
  className,
  calculatorLabel = "Open calculator",
}: {
  value: string | number;
  onChange: (next: string) => void;
  placeholder?: string;
  inputMode?: "decimal" | "numeric" | "text";
  autoFocus?: boolean;
  ariaLabel?: string;
  className?: string;
  calculatorLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [expr, setExpr] = useState("");
  const wrapRef = useRef<HTMLSpanElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Most recent valid result this session, kept visible (greyed out) while
  // the expression is mid-typing and temporarily invalid.
  const lastValidRef = useRef<number | null>(null);

  const openCalculator = () => {
    // Seed with the current field value so the user can build on it.
    setExpr(typeof value === "number" ? String(value) : value);
    lastValidRef.current = null;
    setOpen(true);
  };

  // Close when the user clicks outside of the field + popover.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open ]);

  const result = evalAmount(expr);
  const canApply = result != null && Number.isFinite(result);
  if (canApply && result != null) {
    lastValidRef.current = result;
  }
  const staleResult = lastValidRef.current;

  // While the expression is mid-typing (invalid but non-empty), keep
  // showing the last valid number greyed out instead of an error hint.
  const trimmedExpr = expr.trim();
  let hint: string;
  let hintDimmed = false;
  if (canApply && result != null) {
    hint = `= ${fmtSigned(dollarsToCents(result))}`;
  } else if (!trimmedExpr) {
    hint = "Result shows here";
  } else if (staleResult != null) {
    hint = `= ${fmtSigned(dollarsToCents(staleResult))}`;
    hintDimmed = true;
  } else {
    hint = "Enter a valid expression";
  }

  const apply = () => {
    if (!canApply || result == null) return;
    onChange(result.toFixed(2));
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <span ref={wrapRef} className="relative block">
      <TextField
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        className={className}
        style={{ paddingRight: 26 }}
      />
      {/* Positioned by this span: Tooltip renders its own `relative`
          wrapper, so the button cannot anchor itself to the field. */}
      <span className="absolute" style={{ right: 3, top: "50%", transform: "translateY(-50%)" }}>
        <Tooltip tip="Calculate">
          <button
            ref={toggleRef}
            type="button"
            aria-label={calculatorLabel}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => (open ? setOpen(false) : openCalculator())}
            className="y-icon-btn y-icon-btn--subtle"
            style={{ height: 20, minWidth: 20 }}
          >
            <Icon name="calculator" size={13} />
          </button>
        </Tooltip>
      </span>
      {open && (
        <span
          role="dialog"
          aria-label="Calculator"
          className="absolute right-0 top-full z-20 mt-1 block"
          style={{
            width: 232,
            padding: 8,
            background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
            border: "1px solid var(--y-chrome-line)",
            borderRadius: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
          }}
        >
          <span className="mb-1 block text-[11px]" style={{ color: "var(--y-ink-soft)" }}>
            Enter an expression
          </span>
          <TextField
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              } else if (e.key === "Escape") {
                // Stop here so the modal behind the popover stays open.
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                toggleRef.current?.focus();
              }
            }}
            placeholder="e.g. 10 + 5 * 2"
            autoFocus
            aria-label="Math expression"
            className="w-full py-[3px]"
          />
          <span
            aria-live="polite"
            className="y-num mt-1 block text-[11.5px]"
            style={{
              color: canApply ? "var(--y-green-dk)" : "var(--y-ink-faint)",
              fontWeight: 700,
              opacity: hintDimmed ? 0.65 : 1,
            }}
          >
            {hint}
          </span>
          <span className="mt-1.5 flex gap-2">
            <Button size="sm" variant="primary" onClick={apply} disabled={!canApply}>
              Apply
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                toggleRef.current?.focus();
              }}
            >
              Cancel
            </Button>
          </span>
        </span>
      )}
    </span>
  );
}
