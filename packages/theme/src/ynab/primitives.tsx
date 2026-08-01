import React, { useState } from "react";

export const cx = (...c: (string | false | undefined | null)[]) =>
  c.filter(Boolean).join(" ");

/* -------------------------------------------------- money */
export const money = (n: number, showZero = true) => {
  if (n === 0 && !showZero) return "";
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "-" : ""}$${s}`;
};

/* -------------------------------------------------- Button */
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "blue" | "danger" | "flat";
  size?: "sm" | "md" | "lg";
  active?: boolean;
  icon?: React.ReactNode;
};
export const Button: React.FC<BtnProps> = ({
  variant = "default",
  size = "md",
  active,
  icon,
  className,
  children,
  ...rest
}) => (
  <button
    {...rest}
    className={cx(
      "y-btn",
      variant !== "default" && `y-btn--${variant}`,
      size === "sm" && "y-btn--sm",
      size === "lg" && "y-btn--lg",
      active && "is-on",
      className
    )}
  >
    {icon}
    {children}
  </button>
);

/* -------------------------------------------------- Icons (16px, AIR-ish) */
export const Icon: React.FC<{ name: string; size?: number; color?: string }> = ({
  name,
  size = 13,
  color = "currentColor",
}) => {
  const p: Record<string, React.ReactNode> = {
    plus: <path d="M8 3v10M3 8h10" strokeWidth="2.2" strokeLinecap="round" />,
    minus: <path d="M3 8h10" strokeWidth="2.2" strokeLinecap="round" />,
    check: (
      <path d="M3 8.5 6.4 12 13 4" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    ),
    x: <path d="M4 4l8 8M12 4l-8 8" strokeWidth="2.2" strokeLinecap="round" />,
    left: <path d="M10 3 5 8l5 5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
    right: <path d="M6 3l5 5-5 5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
    edit: <path d="M11.2 2.4 13.6 4.8 5.6 12.8 2.4 13.6 3.2 10.4z" strokeWidth="1.4" strokeLinejoin="round" />,
    trash: (
      <>
        <path d="M3.5 4.5h9M6 4.5V3h4v1.5M4.7 4.5l.7 9h5.2l.7-9" strokeWidth="1.4" strokeLinejoin="round" />
      </>
    ),
    split: <path d="M2 8h4l3-4h5M9 12h5M6 8l3 4" strokeWidth="1.4" strokeLinejoin="round" fill="none" />,
    flag: <path d="M4 14V2.6l8 2.2-8 2.2" strokeWidth="1.4" strokeLinejoin="round" />,
    lock: (
      <>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1" strokeWidth="1.4" />
        <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" strokeWidth="1.4" fill="none" />
      </>
    ),
    gear: (
      <>
        <circle cx="8" cy="8" r="2.4" strokeWidth="1.4" />
        <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" strokeWidth="1.4" strokeLinecap="round" />
      </>
    ),
    reconcile: (
      <>
        <circle cx="8" cy="8" r="6" strokeWidth="1.4" />
        <path d="M5 8.2 7.2 10.4 11 5.6" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    budget: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="1.5" strokeWidth="1.4" />
        <path d="M2 6.4h12M6 6.4V13" strokeWidth="1.2" />
      </>
    ),
    chart: <path d="M2.5 13.5V7m4 6.5V3.5m4 10V9m4 4.5V5.5" strokeWidth="2" strokeLinecap="round" />,
    wallet: (
      <>
        <rect x="1.8" y="3.6" width="12.4" height="9" rx="1.6" strokeWidth="1.4" />
        <circle cx="11.2" cy="8.1" r="1.1" strokeWidth="1.3" />
      </>
    ),
    import: <path d="M8 2v8m0 0 3-3m-3 3L5 7M2.5 12.5h11" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
    search: (
      <>
        <circle cx="7" cy="7" r="4.4" strokeWidth="1.6" />
        <path d="M10.2 10.2 14 14" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
    star: (
      <path
        d="M8 1.8 9.9 5.7l4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    ),
    calendar: (
      <>
        <rect x="2" y="3.2" width="12" height="11" rx="1.4" strokeWidth="1.4" />
        <path d="M2 6.6h12M5.2 1.8v2.6M10.8 1.8v2.6" strokeWidth="1.4" strokeLinecap="round" />
      </>
    ),
    note: (
      <>
        <path d="M3 2.4h7.4L13 5v8.6H3z" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M5.2 7.4h5.6M5.2 10h4" strokeWidth="1.2" strokeLinecap="round" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      style={{ flex: "none" }}
    >
      {p[name]}
    </svg>
  );
};

/* -------------------------------------------------- Toolbar */
export const Toolbar: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => <div className={cx("y-toolbar", className)}>{children}</div>;
export const ToolbarSep = () => <div className="y-tb-sep" />;

/* -------------------------------------------------- Inputs */
export const TextField: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { search?: boolean }
> = ({ search, className, ...rest }) => (
  <input {...rest} className={cx("y-input", search && "y-search", className)} />
);

export const Select: React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement> & { options: string[] }
> = ({ options, className, ...rest }) => (
  <span className="y-select-wrap">
    <select {...rest} className={cx("y-select", className)}>
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  </span>
);

export const Checkbox: React.FC<{
  checked?: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  radio?: boolean;
}> = ({ checked = false, onChange, label, radio }) => (
  <label className="inline-flex items-center gap-[6px] cursor-pointer select-none">
    <span
      onClick={() => onChange?.(!checked)}
      className={cx("y-check", radio && "y-radio", checked && "is-on")}
    />
    {label && <span className="text-[11.5px] text-[#3f4649]">{label}</span>}
  </label>
);

/* -------------------------------------------------- Pill */
export const Pill: React.FC<{
  tone?: "green" | "red" | "orange" | "grey" | "blue";
  children: React.ReactNode;
  className?: string;
}> = ({ tone = "green", children, className }) => (
  <span className={cx("y-pill", `y-pill--${tone}`, className)}>{children}</span>
);

export const balanceTone = (n: number): "green" | "red" | "grey" =>
  n > 0 ? "green" : n < 0 ? "red" : "grey";

/* -------------------------------------------------- Bars */
export const Bar: React.FC<{ pct: number; tone?: "green" | "orange" | "red" | "blue" }> = ({
  pct,
  tone = "green",
}) => (
  <div className="y-bar">
    <div
      className={cx("y-bar-fill", tone !== "green" && `y-bar-fill--${tone}`)}
      style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
    />
  </div>
);

/* -------------------------------------------------- Notice */
export const Notice: React.FC<{
  tone?: "info" | "warn" | "danger" | "ok";
  title?: string;
  children: React.ReactNode;
}> = ({ tone = "info", title, children }) => (
  <div className={cx("y-notice", `y-notice--${tone}`)}>
    <span className="mt-[1px]">
      {tone === "ok" ? "✓" : tone === "danger" ? "✕" : tone === "warn" ? "!" : "i"}
    </span>
    <div>
      {title && <div className="font-bold mb-[2px]">{title}</div>}
      <div>{children}</div>
    </div>
  </div>
);

/* -------------------------------------------------- Tabs */
export const Tabs: React.FC<{
  tabs: string[];
  value: string;
  onChange: (t: string) => void;
}> = ({ tabs, value, onChange }) => (
  <div className="y-tabs">
    {tabs.map((t) => (
      <button
        key={t}
        className={cx("y-tab", t === value && "is-sel")}
        onClick={() => onChange(t)}
      >
        {t}
      </button>
    ))}
  </div>
);

/* -------------------------------------------------- Tooltip */
export const Tooltip: React.FC<{ tip: React.ReactNode; children: React.ReactNode }> = ({
  tip,
  children,
}) => {
  const [on, setOn] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
    >
      {children}
      {on && (
        <span className="y-tip absolute z-30 left-1/2 -translate-x-1/2 bottom-[calc(100%+7px)] whitespace-nowrap">
          {tip}
        </span>
      )}
    </span>
  );
};

/* -------------------------------------------------- Panel */
export const Panel: React.FC<{
  title?: string;
  children: React.ReactNode;
  className?: string;
  bodyClass?: string;
}> = ({ title, children, className, bodyClass }) => (
  <div className={cx("y-panel", className)}>
    {title && <div className="y-panel-head">{title}</div>}
    <div className={cx("p-3", bodyClass)}>{children}</div>
  </div>
);

/* -------------------------------------------------- Cleared flag */
export const ClearedFlag: React.FC<{ state: "c" | "u" | "r" }> = ({ state }) => (
  <span
    className={cx("y-cleared", `y-cleared--${state}`)}
    title={state === "c" ? "Cleared" : state === "r" ? "Reconciled" : "Uncleared"}
  >
    {state === "u" ? "U" : state === "r" ? "R" : "C"}
  </span>
);
