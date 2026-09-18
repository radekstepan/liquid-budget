import { evalAmount, fmtSigned, dollarsToCents, validateAmountInput } from "@ynab/logic";

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
