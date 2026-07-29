"use client";

import { useEffect, type ReactNode } from "react";
import { IconX } from "./icons.js";

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="animate-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(10,15,20,0.45)" }}
      onMouseDown={onClose}
    >
      <div
        className="animate-fade w-full overflow-hidden rounded-2xl"
        style={{
          maxWidth: wide ? 620 : 460,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg transition-colors"
            style={{ color: "var(--muted)" }}
          >
            <IconX width={16} height={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div
            className="flex justify-end gap-2 px-5 py-4"
            style={{ borderTop: "1px solid var(--border)", background: "var(--panel-2)" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span
        className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: "var(--muted)" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg px-3 py-2 text-[14px] outline-none transition-shadow focus:ring-2";
export const inputStyle = {
  background: "var(--panel-2)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
} as const;

export function Btn({
  children,
  onClick,
  variant = "ghost",
  type = "button",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const styles: Record<string, React.CSSProperties> = {
    primary: { background: "var(--accent)", color: "var(--accent-fg)", border: "1px solid var(--accent)" },
    ghost: { background: "var(--panel)", color: "var(--text-2)", border: "1px solid var(--border-strong)" },
    danger: { background: "var(--danger)", color: "var(--danger-fg)", border: "1px solid var(--danger)" },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-all hover:brightness-[1.04] active:scale-[0.98] disabled:opacity-50"
      style={styles[variant]}
    >
      {children}
    </button>
  );
}
