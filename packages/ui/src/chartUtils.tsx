"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fmt } from "@ynab/logic";

export const PALETTE = [
  "#2f7fb0",
  "#1f5c85",
  "#5aa5d0",
  "#e8a33d",
  "#5c8f2c",
  "#97341f",
  "#b3bbc0",
  "#a482d4",
  "#4f9f8f",
  "#c07d1c",
  "#5f7fb8",
  "#b0608f",
];

export function colorAt(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? "#888";
}

export function fmtShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2).replace(/\.?0+$/, "")}K`;
  return fmt(n);
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}

export function ChartTip({
  x,
  y,
  content,
}: {
  x: number | null;
  y: number | null;
  content: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (x == null || y == null || !ref.current) return;
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pad = 10;
    let left = x - w / 2;
    left = Math.max(pad, Math.min(window.innerWidth - w - pad, left));
    let top = y - h - 12;
    if (top < 8) top = y + 16;
    setPos({ left, top });
  }, [x, y]);

  if (x == null || y == null || content == null) return null;

  return (
    <div
      ref={ref}
      className="y-tip pointer-events-none fixed z-40"
      style={{ left: pos.left, top: pos.top, textAlign: "left" }}
    >
      {content}
    </div>
  );
}

export function TipLabel({
  color,
  label,
  value,
  pct,
}: {
  color: string;
  label: string;
  value: string;
  pct?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap">
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: color, boxShadow: "0 0 0 2px rgba(255,255,255,0.18)" }}
      />
      <span style={{ color: "rgba(242,245,247,0.78)" }}>{label}</span>
      <span className="y-num font-semibold" style={{ color: "#f2f5f7" }}>
        {value}
        {pct && (
          <span className="ml-1 font-normal" style={{ color: "rgba(242,245,247,0.55)" }}>
            ({pct})
          </span>
        )}
      </span>
    </div>
  );
}
