import { evalAmount, fmtSigned } from "@ynab/logic";

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
      = {fmtSigned(n)}
    </div>
  );
}
