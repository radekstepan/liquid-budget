"use client";

import { useEffect, type ReactNode } from "react";
import { Button as YButton, Modal as YModal, cx } from "@ynab/theme";

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
    <YModal
      title={title}
      onClose={onClose}
      width={wide ? 620 : 460}
      footer={footer}
    >
      {children}
    </YModal>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="y-label mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

export const inputCls = "y-input w-full";

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
  const map = {
    primary: "primary" as const,
    ghost: "default" as const,
    danger: "danger" as const,
  };
  return (
    <YButton
      type={type}
      onClick={onClick}
      disabled={disabled}
      variant={map[variant]}
      className={cx("px-3.5 py-[5px] text-[12px]")}
    >
      {children}
    </YButton>
  );
}
