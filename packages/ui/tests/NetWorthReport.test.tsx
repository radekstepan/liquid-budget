import { describe, expect, it, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { NetWorthReport } from "../src/NetWorthReport.js";
import type { NetWorthPoint } from "@ynab/logic";

class MockResizeObserver {
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(el: HTMLElement) {
    if (el.clientWidth === 0) {
      Object.defineProperty(el, "clientWidth", { value: 900, configurable: true });
    }
    if (el.clientHeight === 0) {
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    }
    this.cb();
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver;
});

function point(month: string, assets: number, debts: number): NetWorthPoint {
  return { month, assets, debts, net: assets + debts };
}

describe("NetWorthReport", () => {
  it("renders baseline chart with title and scale toggle", () => {
    const points = [point("2026-01", 50000, -50000), point("2026-02", 60000, -40000)];
    render(<NetWorthReport points={points} />);

    expect(screen.getByText("Net Worth")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Linear" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log" })).toBeInTheDocument();
    expect(document.querySelector("svg")).not.toBeNull();
  });

  it("caps outsized asset and debt bars with solid caps matching bar colors", () => {
    const points = [
      point("2026-01", 50000, -50000),
      point("2026-02", 5000000, -4000000),
    ];
    render(<NetWorthReport points={points} />);

    const svg = document.querySelector("svg")!;
    // Only the Feb bar is truncated on each side (Jan values are far below the max).
    expect(svg.querySelectorAll('[data-testid="trunc-hatch"]').length).toBe(2);
    const caps = svg.querySelectorAll('[data-testid="trunc-cap"]');
    expect(caps.length).toBe(2);

    const fills = Array.from(caps).map((el) => el.getAttribute("fill"));
    expect(fills).toContain("#2f7fb0"); // assets cap
    expect(fills).toContain("#c0483a"); // debts cap

    // Asset cap sits above its hatch; debt cap sits below its hatch.
    const assetHatch = document.querySelector('[data-testid="trunc-hatch"][fill*="hatch"]');
    const debtHatch = document.querySelectorAll('[data-testid="trunc-hatch"]')[1]!;
    expect(assetHatch).not.toBeNull();
    const assetCap = Array.from(caps).find((c) => c.getAttribute("fill") === "#2f7fb0")!;
    const debtCap = Array.from(caps).find((c) => c.getAttribute("fill") === "#c0483a")!;
    expect(Number(assetCap.getAttribute("y"))).toBe(Number(assetHatch!.getAttribute("y")) - 5);
    expect(Number(debtCap.getAttribute("y"))).toBe(Number(debtHatch.getAttribute("y")) + 5);
  });

  it("renders an axis break when a month's assets are a statistical outlier (>= 5 points)", () => {
    const points = [
      point("2026-01", 100000, -10000),
      point("2026-02", 150000, -12000),
      point("2026-03", 120000, -11000),
      point("2026-04", 130000, -13000),
      point("2026-05", 5000000, -15000),
    ];
    render(<NetWorthReport points={points} />);

    const svg = document.querySelector("svg")!;
    // One break mark for the asset side; debts are not outliers so no break there.
    expect(svg.querySelectorAll('[data-testid="axis-break"]').length).toBe(1);
    // No truncation caps when the axis break is active.
    expect(svg.querySelectorAll('[data-testid="trunc-cap"]').length).toBe(0);
    // The compressed top tick label is rendered ($50K).
    expect(screen.getByText("$50K")).toBeInTheDocument();
  });
});