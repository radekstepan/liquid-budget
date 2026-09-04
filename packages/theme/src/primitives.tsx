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
  const rounded = Math.round(n);
  if (rounded === 0) return showZero ? "$0.00" : "";
  const s = (Math.abs(rounded) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${rounded < 0 ? "-" : ""}$${s}`;
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
  // Settings cog — Heroicons "cog-6-tooth" outline, scaled from its native
  // 24px grid into this set's 16px grid. strokeWidth 2.4 at 24-grid reads as
  // ~1.45 after the 0.6 scale, matching the weight of the sibling icons.
  const cogArt = (
    <g
      transform="translate(8 8) scale(0.6) translate(-12 -12)"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
      <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </g>
  );
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
    transactions: <path d="M3 6h9M9 3l3 3-3 3M13 10H4M7 13l-3-3 3-3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
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
    eyeOff: (
      <>
        <path
          d="M2.4 8C4.3 5.2 6.2 4.6 8 4.6c1.8 0 3.7.6 5.6 3.4C11.7 10.8 9.8 11.4 8 11.4c-1.8 0-3.7-.6-5.6-3.4Z"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="1.6" strokeWidth="1.4" />
        <path d="M3.2 3.2l9.6 9.6" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
    lock: (
      <>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1" strokeWidth="1.4" />
        <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" strokeWidth="1.4" fill="none" />
      </>
    ),
    gear: cogArt,
    cog: cogArt,
    az: (
      <>
        <path
          d="M4.8 12.4 7.4 4.6l2.6 7.8M6.1 9.4h2.6"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10.9 4.6h3.7M10.9 4.6 14.6 12.4M10.9 12.4h3.7"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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
    export: <path d="M8 14V6m0 0L5 9m3-3 3 3M2.5 3.5h11" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
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

type DropdownItem = { value: string; label: string; disabled?: boolean; group?: string };

function childrenToItems(children: React.ReactNode): DropdownItem[] {
  const out: DropdownItem[] = [];
  // `<optgroup label="…">` boundaries are captured so the dropdown can
  // render a group heading above each block of options (e.g. category
  // group names in the category picker). Fragments pass the current
  // group through untouched.
  const walk = (nodes: React.ReactNode, group?: string) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const el = child as React.ReactElement<{
        value?: string | number;
        label?: string;
        disabled?: boolean;
        children?: React.ReactNode;
      }>;
      // Fragments (and arrays of children passed as a single Fragment)
      // don't carry a `value` — recurse into their children.
      if (el.props.value === undefined) {
        if (el.props.children != null) {
          const nextGroup = typeof el.props.label === "string" ? el.props.label : group;
          walk(el.props.children as React.ReactNode, nextGroup);
        }
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
      out.push({ value, label, disabled: !!el.props.disabled, group });
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
  // When the dropdown is closed by a commit/Escape we restore focus to the
  // inline search input programmatically; that focus event must not reopen
  // the dropdown, so it is suppressed for that one tick.
  const suppressOpenRef = useRef(false);
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

  const refocusTrigger = () => {
    suppressOpenRef.current = true;
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
      suppressOpenRef.current = false;
    });
  };

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
    const el = searchable ? searchRef.current : triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
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
      // In searchable mode the inline search input is the trigger.
      if (searchRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        refocusTrigger();
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
    // In searchable mode the search input is only rendered while the
    // dropdown is open, so move focus into it as soon as it mounts.
    // Non-searchable listboxes rove focus to the active option instead.
    if (searchable) {
      const id = requestAnimationFrame(() => {
        suppressOpenRef.current = true;
        searchRef.current?.focus();
        suppressOpenRef.current = false;
      });
      return () => cancelAnimationFrame(id);
    }
    const id = requestAnimationFrame(() => {
      itemRefs.current[activeIdx]?.focus();
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
    refocusTrigger();
  };

  const onKeyDownTrigger = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onFocusSearch = () => {
    if (suppressOpenRef.current) return;
    if (disabled) return;
    setOpen(true);
    setQuery("");
  };

  // Keyboard handling for the inline search input (the searchable trigger).
  // Typing filters the options; navigation/commit keys behave like the
  // listbox's handler for the non-searchable variant.
  const onKeyDownSearchable = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    const list = filteredItems;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => {
        if (list.length === 0) return 0;
        for (let step = 0; step < list.length; step++) {
          const next = (i + 1 + step) % list.length;
          if (!list[next]?.disabled) return next;
        }
        return i;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => {
        if (list.length === 0) return 0;
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
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(activeIdx);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const onKeyDownList = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Searchable selects keep focus in the inline search input (handled by
    // onKeyDownSearchable above), so this handler only serves the
    // non-searchable listbox whose option buttons hold focus.
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
      className={cx("y-select-wrap", searchable && "y-select-wrap--searchable", className)}
      data-open={open ? "true" : undefined}
      {...rest}
    >
      {searchable && open ? (
        <input
          ref={searchRef}
          type="text"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={labelForAria}
          disabled={disabled}
          value={query}
          placeholder={selectedLabel || undefined}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={onFocusSearch}
          onKeyDown={onKeyDownSearchable}
          autoComplete="off"
          spellCheck={false}
          className={cx("y-input", "y-select-search", sizeClass)}
        />
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={labelForAria}
          disabled={disabled}
          onClick={() => !disabled && setOpen(searchable ? true : (o) => !o)}
          onKeyDown={onKeyDownTrigger}
          className={cx("y-select", "y-select-trigger", sizeClass)}
          style={{
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? "default" : "pointer",
          }}
        >
          <span className="y-select-trigger-label">{selectedLabel}</span>
        </button>
      )}
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
            {filteredItems.length === 0 && searchable ? (
              <span className="y-dropdown-empty" role="presentation">
                No matches
              </span>
            ) : (
              filteredItems.map((it, i) => {
                const originalIdx = openItems.indexOf(it);
                // A disabled option can never be selected, so it must not be
                // shown with the selected check/state even when its value
                // happens to match the current value (e.g. a disabled
                // "Select account…" placeholder with value="").
                const isSel = originalIdx === selectedIdx && !it.disabled;
                const isActive = i === activeIdx;
                // Render an <optgroup> heading above the first option of
                // each group (persisting while the list is filtered so the
                // user can tell which subcategories a search matched).
                const showHeader =
                  it.group != null && it.group !== filteredItems[i - 1]?.group;
                return (
                  <React.Fragment key={it.value}>
                    {showHeader && (
                      <div className="y-dropdown-group" role="presentation">
                        {it.group}
                      </div>
                    )}
                    <button
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
                    </button>
                  </React.Fragment>
                );
              })
            )}
          </div>,
          document.body
        )}
    </div>
  );
};

/* -------------------------------------------------- SearchList (combobox) */
export type SearchListOption = {
  /** Committed value; defaults to `label` when omitted. */
  value?: string;
  label: string;
  /** Optional section heading shown above the option in the dropdown. */
  group?: string;
};

export type SearchListProps = {
  /** The raw text of the field (controlled). */
  value: string;
  onChange: (next: string) => void;
  options?: SearchListOption[];
  placeholder?: string;
  /**
   * When true and the typed text has no exact match among `options`,
   * the dropdown offers a "Create "<query>"" row so the user can commit
   * a brand-new value (used for payees). When false the dropdown is
   * pick-only (used for categories).
   */
  allowCreate?: boolean;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  "aria-label"?: string;
};

/**
 * A searchable combobox: a text input that opens a dropdown of existing
 * options filtered by substring as the user types. Backed by the same
 * portaled dropdown + keyboard navigation as `Select`. Used for payees,
 * where free-typing a brand-new name is allowed (`allowCreate`), and for
 * any field that needs "type to filter" over a long list.
 */
export const SearchList: React.FC<SearchListProps> = ({
  value,
  onChange,
  options = [],
  placeholder,
  allowCreate = false,
  className,
  disabled = false,
  autoFocus,
  ariaLabel,
  "aria-label": ariaLabelAttr,
}) => {
  const labelForAria = ariaLabel ?? ariaLabelAttr;
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; placeAbove: boolean }>(
    { left: 0, top: 0, width: 0, placeAbove: false }
  );
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const q = value.trim();
  const qLower = q.toLowerCase();

  const filtered = useMemo(() => {
    if (!qLower) return options;
    return options.filter((o) => o.label.toLowerCase().includes(qLower));
  }, [options, qLower]);

  const hasExactMatch =
    qLower.length > 0 && filtered.some((o) => o.label.toLowerCase() === qLower);
  const showCreate = allowCreate && qLower.length > 0 && !hasExactMatch;
  // Row space of the dropdown: index 0 is the create row (when shown),
  // indexes [1, filtered.length] are the filtered options.
  const rowCount = filtered.length + (showCreate ? 1 : 0);
  const optionAt = (i: number): SearchListOption | undefined =>
    showCreate ? filtered[i - 1] : filtered[i];

  // Keep the active row valid whenever the filter shrinks the list.
  useEffect(() => {
    if (rowCount === 0) {
      setActiveIdx(0);
      return;
    }
    setActiveIdx((i) => (i >= rowCount ? rowCount - 1 : i));
  }, [rowCount, filtered]);

  const computePos = () => {
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const estimatedH = Math.min(280, rowCount * 24 + 8);
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
  }, [open, rowCount]);

  useEffect(() => {
    if (open) setActiveIdx(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (inputRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commitRow = (i: number) => {
    if (i < 0 || i >= rowCount) return;
    if (showCreate && i === 0) {
      onChange(q);
      setOpen(false);
      return;
    }
    const it = optionAt(i);
    if (!it) return;
    onChange(it.value ?? it.label);
    setOpen(false);
  };

  const onKeyDownInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (rowCount === 0 ? 0 : (i + 1) % rowCount));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (rowCount === 0 ? 0 : (i - 1 + rowCount) % rowCount));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(Math.max(0, rowCount - 1));
    } else if (e.key === "Enter") {
      if (rowCount > 0) {
        e.preventDefault();
        commitRow(activeIdx);
      } else {
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      // Dropdown closes without committing; focus moves naturally.
      setOpen(false);
    }
  };

  return (
    <div
      className={cx("y-searchlist", className)}
      data-open={open ? "true" : undefined}
      data-above={pos.placeAbove ? "true" : undefined}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onClick={() => {
          if (!disabled && !open) setOpen(true);
        }}
        onKeyDown={onKeyDownInput}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        aria-label={labelForAria}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cx("y-input", "w-full", "y-searchlist-input", "y-searchlist-trigger")}
      />
      {open &&
        mounted &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            className={cx("y-dropdown", pos.placeAbove ? "y-dropdown--above" : "y-dropdown--below")}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.placeAbove ? undefined : pos.top,
              bottom: pos.placeAbove ? window.innerHeight - pos.top : undefined,
              width: pos.width,
              zIndex: 60,
            }}
          >
            {rowCount === 0 ? (
              <span className="y-dropdown-empty" role="presentation">
                No matches
              </span>
            ) : (
              <>
                {showCreate && (
                  <button
                    ref={(el) => {
                      itemRefs.current[0] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onMouseEnter={() => setActiveIdx(0)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                    }}
                    onClick={() => commitRow(0)}
                    className={cx(
                      "y-dropdown-item",
                      "y-dropdown-create",
                      activeIdx === 0 && "is-active"
                    )}
                  >
                    <span className="y-dropdown-item-label">Create “{q}”</span>
                  </button>
                )}
                {filtered.map((it, i) => {
                  const rowIdx = showCreate ? i + 1 : i;
                  const isActive = activeIdx === rowIdx;
                  const showHeader =
                    it.group != null && it.group !== filtered[i - 1]?.group;
                  return (
                    <React.Fragment key={`${it.value ?? it.label}-${i}`}>
                      {showHeader && (
                        <div className="y-dropdown-group" role="presentation">
                          {it.group}
                        </div>
                      )}
                      <button
                        ref={(el) => {
                          itemRefs.current[rowIdx] = el;
                        }}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onMouseEnter={() => setActiveIdx(rowIdx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                        }}
                        onClick={() => commitRow(rowIdx)}
                        className={cx("y-dropdown-item", isActive && "is-active")}
                      >
                        <span className="y-dropdown-item-label">{it.label}</span>
                      </button>
                    </React.Fragment>
                  );
                })}
              </>
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
  disabled?: boolean;
}> = ({ checked = false, onChange, label, radio, disabled = false }) => (
  <label
    className={cx(
      "inline-flex items-center gap-[6px] select-none leading-none align-middle",
      disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
    )}
  >
    <input
      type={radio ? "radio" : "checkbox"}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.checked)}
      className="sr-only"
    />
    <span
      aria-hidden
      className={cx("y-check", radio && "y-radio", checked && "is-on")}
    />
    {label && <span className="text-[11.5px] leading-none" style={{ color: "var(--y-ink)" }}>{label}</span>}
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

export const Bar: React.FC<{
  pct: number;
  tone?: "green" | "orange" | "red" | "blue";
  truncated?: boolean;
}> = ({ pct, tone = "green", truncated = false }) => {
  const isTruncated = truncated || pct >= 100;
  const displayPct = isTruncated ? Math.min(96, Math.max(0, pct)) : Math.max(0, Math.min(100, pct));
  return (
    <div className="y-bar">
      <div
        className={cx(
          "y-bar-fill",
          tone !== "green" && `y-bar-fill--${tone}`,
          isTruncated && "y-bar-truncated"
        )}
        style={{ width: `${displayPct}%` }}
      />
    </div>
  );
};

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

/* -------------------------------------------------- Transaction flag color */
export type FlagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

/**
 * Internal flag the duplicate analyzer writes onto matching rows. Never
 * offered in the picker; the user can only switch away from it.
 */
export type TransactionDuplicateFlag = "duplicate";

/** Canonical YNAB4 flag palette (display order). */
export const FLAG_COLORS: FlagColor[] = ["red", "orange", "yellow", "green", "blue", "purple"];

/** Hex swatches for the flag palette. */
export const FLAG_HEX: Record<FlagColor, string> = {
  red: "#d65a3a",
  orange: "#e0903a",
  yellow: "#d6b73a",
  green: "#5aa84a",
  blue: "#3a7bd6",
  purple: "#7c5fb6",
};

/** Label used in tooltips / aria labels. */
export const FLAG_LABEL: Record<FlagColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
};

/**
 * Inline row of flag swatches (used inside the transaction modal). Renders
 * the six color circles plus a "clear" (×) button when `onClear` is set.
 */
export const FlagPicker: React.FC<{
  value: FlagColor | null;
  onChange: (color: FlagColor | null) => void;
  disabled?: boolean;
  className?: string;
}> = ({ value, onChange, disabled, className }) => {
  return (
    <div
      className={cx("y-flag-picker", className)}
      role="radiogroup"
      aria-label="Transaction flag color"
      style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? "none" : undefined }}
    >
      {FLAG_COLORS.map((c) => {
        const active = value === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={FLAG_LABEL[c]}
            title={FLAG_LABEL[c]}
            onClick={() => onChange(c)}
            className={cx("y-flag-swatch", active && "is-active")}
            style={{ background: FLAG_HEX[c] }}
          />
        );
      })}
      {value != null && (
        <button
          type="button"
          aria-label="Clear flag"
          title="Clear flag"
          onClick={() => onChange(null)}
          className="y-flag-clear"
        >
          ×
        </button>
      )}
    </div>
  );
};

/**
 * A single clickable flag cell shown in the register's Flag column. Manual
 * flags render as the classic YNAB4 color circle and open the swatch picker.
 * The internal "duplicate" marker renders as a square "D" status badge (same
 * language as the C/U cleared flags) and is read-only — the user cannot
 * change or clear it; they must remove the duplicate and rerun the duplicate
 * check. Disabled when the row is reconciled (locked).
 */
export const FlagCell: React.FC<{
  color: FlagColor | TransactionDuplicateFlag | null;
  onChange: (color: FlagColor | null) => void;
  disabled?: boolean;
}> = ({ color, onChange, disabled }) => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; placeAbove: boolean }>({
    left: 0,
    top: 0,
    placeAbove: false,
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const btn = triggerRef.current;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      const estH = 120;
      const spaceBelow = window.innerHeight - rect.bottom;
      setPos({
        left: rect.left,
        top: rect.bottom + 4,
        placeAbove: spaceBelow < estH && rect.top > spaceBelow,
      });
    }
    setOpen(true);
  };

  const commit = (c: FlagColor | null) => {
    setOpen(false);
    onChange(c);
  };

  const interactive = !disabled;
  const isDuplicate = color === "duplicate";

  // The duplicate marker is analyzer-owned and read-only: no popover, no
  // way to switch away from it.
  if (isDuplicate) {
    return (
      <span
        className="y-flag-cell"
        aria-label="Flag: Duplicate"
        title="Duplicate transaction — remove one of the matching transactions and rerun the duplicate check"
      >
        <span className="y-cleared y-cleared--duplicate">D</span>
      </span>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={color != null ? `Flag: ${FLAG_LABEL[color]}` : "No flag"}
        title={color != null ? `Flag: ${FLAG_LABEL[color]}` : "Add a flag"}
        onClick={toggle}
        className={cx("y-flag-cell", interactive && "cursor-pointer")}
        style={{ opacity: disabled ? 0.45 : 1 }}
      >
        {color != null ? (
          <span className="y-flag" style={{ background: FLAG_HEX[color] }} />
        ) : (
          <span className="y-flag y-flag--empty" />
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Choose flag color"
            className="y-flag-popover"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.placeAbove ? undefined : pos.top,
              bottom: pos.placeAbove ? window.innerHeight - pos.top + 8 : undefined,
              zIndex: 60,
            }}
          >
            <FlagPicker value={color} onChange={commit} />
          </div>,
          document.body
        )}
    </>
  );
};

/* -------------------------------------------------- Toast */
export type ToastTone = "info" | "ok" | "warn" | "danger";

export type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
};

let _nextToastId = 0;

export function createToast(message: string, tone: ToastTone = "info"): ToastItem {
  return { id: ++_nextToastId, message, tone };
}

const TOAST_BG: Record<ToastTone, string> = {
  info: "linear-gradient(#4f5c64, #333e45)",
  ok: "linear-gradient(var(--y-green-lt), var(--y-green-dk))",
  warn: "linear-gradient(#f0b559, var(--y-orange-dk))",
  danger: "linear-gradient(var(--y-red-lt), var(--y-red-dk))",
};

export const Toast: React.FC<{ items: ToastItem[]; onDismiss: (id: number) => void }> = ({
  items,
  onDismiss,
}) => {
  if (items.length === 0) return null;
  return createPortal(
    <div className="y-toast-stack" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className="y-toast"
          style={{ background: TOAST_BG[t.tone] }}
          onClick={() => onDismiss(t.id)}
        >
          <span className="y-toast-msg">{t.message}</span>
        </div>
      ))}
    </div>,
    document.body
  );
};
