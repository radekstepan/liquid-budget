import React, {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const cx = (...c: (string | false | undefined | null)[]) =>
  c.filter(Boolean).join(" ");

/* -------------------------------------------------- money */
export const money = (n: number, showZero = true) => {
  if (n === 0 && !showZero) return "";
  const s = (Math.abs(n) / 100).toLocaleString("en-US", {
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
    chevronDown: <path d="M3.5 6 8 10.5 12.5 6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
    chevronRight: <path d="M6 3.5 10.5 8 6 12.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
    dots: (
      <>
        <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      </>
    ),
    grip: (
      <>
        <circle cx="6" cy="3.5" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="6" cy="8" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="6" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="10" cy="3.5" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="10" cy="8" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="10" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
    swap: <path d="M3 6h9M9 3l3 3-3 3M13 10H4M7 13l-3-3 3-3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
    clock: (
      <>
        <circle cx="8" cy="8" r="5.6" strokeWidth="1.5" />
        <path d="M8 5v3.2L10.2 9" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </>
    ),
    projections: <path d="M2.5 13.5V3m0 10h11M5 11.2 8 8.3 10.5 10.4 13.5 6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
    reset: (
      <>
        <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        <path d="M3.5 3.2v2.6h2.6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </>
    ),
    drop: (
      <path
        d="M8 1.8c-2.4 3-4.2 5-4.2 7.4a4.2 4.2 0 0 0 8.4 0c0-2.4-1.8-4.4-4.2-7.4z"
        fill="currentColor"
        stroke="none"
      />
    ),
    edit: <path d="M11.2 2.4 13.6 4.8 5.6 12.8 2.4 13.6 3.2 10.4z" strokeWidth="1.4" strokeLinejoin="round" />,
    archive: (
      <>
        <path d="M2.5 3.5h11v3h-11zM3.5 6.5v6.5h9v-6.5M6.5 9h3" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
      </>
    ),
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
    bank: (
      <>
        <path d="M2 6.4h12M8 2.4l6 4H2l6-4z" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M4 6.4v5.2M7 6.4v5.2M10 6.4v5.2M13 6.4v5.2" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M2 11.6h12" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M1.5 13.6h13" strokeWidth="1.5" strokeLinecap="round" />
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

export type SelectOption = string | { value: string | number; label: string };

type DropdownItem = { value: string; label: string; disabled?: boolean };

function childrenToItems(children: React.ReactNode): DropdownItem[] {
  const out: DropdownItem[] = [];
  const walk = (nodes: React.ReactNode) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const el = child as React.ReactElement<{
        value?: string | number;
        disabled?: boolean;
        children?: React.ReactNode;
      }>;
      // Fragments (and arrays of children passed as a single Fragment)
      // don't carry a `value` — recurse into their children.
      if (el.props.value === undefined) {
        if (el.props.children != null) walk(el.props.children as React.ReactNode);
        return;
      }
      const raw = el.props.value;
      const value = String(raw);
      const label =
        typeof el.props.children === "string" || typeof el.props.children === "number"
          ? String(el.props.children)
          : Array.isArray(el.props.children)
            ? el.props.children
                .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""))
                .join("")
            : "";
      out.push({ value, label, disabled: !!el.props.disabled });
    });
  };
  walk(children);
  return out;
}

function optionsToItems(options?: SelectOption[]): DropdownItem[] {
  if (!options) return [];
  return options.map((o) => {
    if (typeof o === "string") return { value: o, label: o };
    return { value: String(o.value), label: o.label };
  });
}

export type SelectProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "onChange" | "defaultValue"
> & {
  value: string | number;
  onChange: (next: string) => void;
  options?: SelectOption[];
  children?: React.ReactNode;
  ariaLabel?: string;
  "aria-label"?: string;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  /**
   * When true, the dropdown opens with a search input at the top that
   * filters options by case-insensitive substring match. Intended for
   * lists that can grow long (e.g. the "Transfer to" account picker).
   */
  searchable?: boolean;
};

export const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  children,
  className,
  ariaLabel,
  "aria-label": ariaLabelAttr,
  disabled,
  size = "md",
  searchable = false,
  ...rest
}) => {
  const labelForAria = ariaLabel ?? ariaLabelAttr;
  const items = useMemo<DropdownItem[]>(
    () => {
      const fromChildren = childrenToItems(children);
      return fromChildren.length > 0 ? fromChildren : optionsToItems(options);
    },
    [children, options]
  );

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number; width: number; placeAbove: boolean }>(
    { left: 0, top: 0, width: 0, placeAbove: false }
  );
  const [mounted, setMounted] = useState(false);
  // Snapshot the items the dropdown was opened with so the portaled buttons
  // always commit against the same array the click handler captured. Without
  // this, `children` re-renders between opening and clicking can produce an
  // index `i` whose `items[i]` is now undefined → "Cannot read properties of
  // undefined (reading 'value')" inside `commit`. The snapshot is replaced
  // each time the dropdown (re)opens.
  const [openItems, setOpenItems] = useState<DropdownItem[]>(items);

  useEffect(() => {
    setMounted(true);
  }, []);

  const selectedIdx = useMemo(() => {
    const v = String(value);
    const i = items.findIndex((it) => it.value === v);
    return i >= 0 ? i : 0;
  }, [items, value]);

  const selectedLabel = items[selectedIdx]?.label ?? "";

  // Filter against the open-time snapshot so the visible list stays stable
  // for the lifetime of the open dropdown, even if the parent re-renders
  // (e.g. an account name is edited elsewhere).
  const filteredItems = useMemo(() => {
    if (!searchable) return openItems;
    const q = query.trim().toLowerCase();
    if (!q) return openItems;
    return openItems.filter((it) => it.label.toLowerCase().includes(q));
  }, [searchable, openItems, query]);

  // Whenever the filter shrinks or shifts the list, keep `activeIdx` valid.
  useEffect(() => {
    if (filteredItems.length === 0) {
      setActiveIdx(0);
      return;
    }
    setActiveIdx((i) => (i >= filteredItems.length ? 0 : i));
  }, [filteredItems]);

  const computePos = () => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const estimatedH = Math.min(280, items.length * 24 + 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < estimatedH && rect.top > spaceBelow;
    setPos({
      left: rect.left,
      top: placeAbove ? rect.top - 1 : rect.bottom - 1,
      width: rect.width,
      placeAbove,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    computePos();
    const onScroll = () => computePos();
    const onResize = () => computePos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) {
      // Capture the items at the moment of opening so subsequent re-renders
      // (e.g. parent state changes) can't mutate what `commit(i)` reads.
      setOpenItems(items);
      setActiveIdx(selectedIdx);
      setQuery("");
    }
  }, [open, items, selectedIdx]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      // When searchable, the user types into the search box first; focus it
      // so they can immediately start filtering. Otherwise focus the first
      // option as before so keyboard navigation is ready.
      if (searchable) {
        searchRef.current?.focus();
      } else {
        itemRefs.current[activeIdx]?.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [open, activeIdx, searchable]);

  const commit = (idx: number) => {
    // `idx` is a position in the *rendered* list. When searchable that's
    // `filteredItems` (a subset of the open-time snapshot); otherwise it's
    // the snapshot itself. Commit against the right source so we can still
    // hand `onChange` the value the user actually clicked.
    const source = searchable ? filteredItems : openItems;
    if (!Number.isInteger(idx) || idx < 0 || idx >= source.length) return;
    const it = source[idx];
    if (!it || it.disabled || typeof it.value === "undefined") return;
    onChange(it.value);
    setOpen(false);
    // Defer focus until after React commits the close, otherwise the trigger
    // can be unmounted (parent re-rendered the whole toolbar) before we focus.
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const onKeyDownTrigger = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onKeyDownList = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // When focus is in the search input, only ArrowDown/Up should leave the
    // input and move into the option list. All other printable keystrokes
    // belong to the search field, not the listbox's letter-jump handler.
    const inSearch = searchable && e.target === searchRef.current;
    if (inSearch && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = filteredItems;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => {
        for (let step = 0; step < list.length; step++) {
          const next = (i + 1 + step) % list.length;
          if (!list[next]?.disabled) return next;
        }
        return i;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => {
        for (let step = 0; step < list.length; step++) {
          const next = (i - 1 - step + list.length) % list.length;
          if (!list[next]?.disabled) return next;
        }
        return i;
      });
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(list.findIndex((it) => !it.disabled));
    } else if (e.key === "End") {
      e.preventDefault();
      for (let i = list.length - 1; i >= 0; i--) {
        if (!list[i]?.disabled) {
          setActiveIdx(i);
          break;
        }
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(activeIdx);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      const start = (activeIdx + 1) % list.length;
      for (let step = 0; step < list.length; step++) {
        const i = (start + step) % list.length;
        const label = list[i]?.label.toLowerCase() ?? "";
        if (!list[i]?.disabled && label.startsWith(ch)) {
          setActiveIdx(i);
          break;
        }
      }
    }
  };

  const sizeClass = size === "lg" ? "y-select--lg" : "";

  return (
    <div
      className={cx("y-select-wrap", className)}
      data-open={open ? "true" : undefined}
      {...rest}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={labelForAria}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDownTrigger}
        className={cx("y-select", "y-select-trigger", sizeClass)}
        style={{
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <span className="y-select-trigger-label">{selectedLabel}</span>
      </button>
      {open && mounted &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            onKeyDown={onKeyDownList}
            className="y-dropdown"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.placeAbove ? undefined : pos.top,
              bottom: pos.placeAbove
                ? window.innerHeight - pos.top
                : undefined,
              width: pos.width,
              zIndex: 60,
            }}
          >
            {searchable && (
              <input
                ref={searchRef}
                type="text"
                className="y-input y-search y-dropdown-search"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                autoComplete="off"
                spellCheck={false}
                aria-label="Filter options"
              />
            )}
            {filteredItems.length === 0 && searchable ? (
              <span className="y-dropdown-empty" role="presentation">
                No matches
              </span>
            ) : (
              filteredItems.map((it, i) => {
                const originalIdx = openItems.indexOf(it);
                const isSel = originalIdx === selectedIdx;
                const isActive = i === activeIdx;
                return (
                  <button
                    key={it.value}
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    data-value={it.value}
                    disabled={it.disabled}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => commit(i)}
                    className={cx(
                      "y-dropdown-item",
                      isSel && "is-sel",
                      isActive && "is-active",
                      it.disabled && "is-disabled"
                    )}
                  >
                    <span className="y-dropdown-item-label">{it.label}</span>
                    {isSel && (
                      <span className="y-dropdown-item-check" aria-hidden>
                        &#x2713;
                      </span>
                    )}
                  </button>
              );
            })
            )}
          </div>,
          document.body
        )}
    </div>
  );
};

export const Checkbox: React.FC<{
  checked?: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  radio?: boolean;
}> = ({ checked = false, onChange, label, radio }) => (
  <label className="inline-flex items-center gap-[6px] cursor-pointer select-none">
    <input
      type={radio ? "radio" : "checkbox"}
      checked={checked}
      onChange={(e) => onChange?.(e.target.checked)}
      className="sr-only"
    />
    <span
      aria-hidden
      className={cx("y-check", radio && "y-radio", checked && "is-on")}
    />
    {label && <span className="text-[11.5px]" style={{ color: "var(--y-ink)" }}>{label}</span>}
  </label>
);

/* -------------------------------------------------- Pill */
export const Pill: React.FC<{
  tone?: "green" | "red" | "orange" | "grey" | "blue";
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  title?: string;
  "aria-label"?: string;
}> = ({ tone = "green", children, className, style, onClick, title, ...rest }) => {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      {...rest}
      className={cx("y-pill", `y-pill--${tone}`, className)}
      style={style}
    >
      {children}
    </Tag>
  );
};

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
  className?: string;
  style?: React.CSSProperties;
}> = ({ tone = "info", title, children, className, style }) => (
  <div className={cx("y-notice", `y-notice--${tone}`, className)} style={style}>
    <Icon
      name={tone === "ok" ? "check" : tone === "danger" ? "x" : tone === "warn" ? "minus" : "note"}
      size={13}
      color="currentColor"
    />
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
export const ClearedFlag: React.FC<{
  state: "c" | "u" | "r";
  onCycle?: () => void;
  disabled?: boolean;
}> = ({ state, onCycle, disabled }) => {
  const interactive = !!onCycle && !disabled;
  const inner = (
    <span
      className={cx(
        "y-cleared",
        `y-cleared--${state}`,
        interactive && "cursor-pointer"
      )}
      title={state === "c" ? "Cleared" : state === "r" ? "Reconciled" : "Uncleared"}
      onClick={onCycle}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCycle?.();
              }
            }
          : undefined
      }
    >
      {state === "u" ? "U" : state === "r" ? "R" : "C"}
    </span>
  );
  return inner;
};
