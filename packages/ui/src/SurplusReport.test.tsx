"use client";

import { fireEvent, render } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BudgetData, SurplusMonthPoint } from "@ynab/logic";
import { SurplusReport } from "./SurplusReport.js";
import { ReportsView } from "./ReportsView.js";

function makePoints(surpluses: number[]): SurplusMonthPoint[] {
  return surpluses.map((surplus, i) => ({
    month: `2026-0${i + 1}`,
    income: surplus > 0 ? surplus + 100000 : 100000,
    outflow: surplus > 0 ? 100000 : 100000 - surplus,
    surplus,
  }));
}

describe("SurplusReport", () => {
  it("renders the panel title with surplus/loss legend entries", () => {
    const { getByText } = render(<SurplusReport points={[]} />);
    expect(getByText("Monthly Cash Flow")).not.toBeNull();
    expect(getByText("Surplus")).not.toBeNull();
    expect(getByText("Loss")).not.toBeNull();
  });

  it("shows an empty state when there are no months", () => {
    const { getByText } = render(<SurplusReport points={[]} />);
    expect(getByText("No data for this timeframe.")).not.toBeNull();
  });
});

describe("SurplusReport chart capping", () => {
  const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

  beforeAll(() => {
    // jsdom reports zero sizes; give the chart a real layout box.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      value: 600,
    });
  });

  afterAll(() => {
    if (origWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origWidth);
    if (origHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origHeight);
  });

  it("renders an axis break when one month dwarfs the rest", () => {
    const points = makePoints([10000, 11000, 10500, 9500, 10200, 9800, 500000]);
    const { container } = render(<SurplusReport points={points} />);
    // Same capping mechanism as Spending Trends: Tukey-fence outlier break.
    expect(container.querySelector('[data-testid="axis-break"]')).not.toBeNull();
  });

  it("renders no axis break for evenly distributed months", () => {
    const points = makePoints([10000, 11000, 10500, 9500, 10200, 9800, -5000]);
    const { container } = render(<SurplusReport points={points} />);
    expect(container.querySelector('[data-testid="axis-break"]')).toBeNull();
    // Bars still render above and below the zero line.
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  function barHeights(container: HTMLElement): number[] {
    return Array.from(container.querySelectorAll("rect"))
      .filter((r) => {
        const fill = r.getAttribute("fill") ?? "";
        return fill.includes("surplus-grad") || fill.includes("loss-grad");
      })
      .map((r) => Number(r.getAttribute("height")));
  }

  it("renders full-height bars when an outlier break fires on all-surplus months", () => {
    // Narrow-range scenario (e.g. Jun-Oct 2026): 5 surplus months, one a
    // bonus outlier. The break must compress the axis, not the bars — every
    // bar keeps a fair share of the 550px plot height instead of collapsing
    // to 1px slivers at the top edge.
    const points = makePoints([10000, 11000, 10500, 9500, 500000]);
    const { container } = render(<SurplusReport points={points} />);
    expect(container.querySelector('[data-testid="axis-break"]')).not.toBeNull();
    const heights = barHeights(container);
    expect(heights.length).toBe(5);
    expect(heights.every((h) => h > 50)).toBe(true);
  });

  it("renders full-height bars when an outlier break fires on all-loss months", () => {
    // Symmetric case: 5 loss months with one outsized loss. The zero line
    // belongs at the top so the losses get the full plot height.
    const points = makePoints([-10000, -11000, -10500, -9500, -500000]);
    const { container } = render(<SurplusReport points={points} />);
    expect(container.querySelector('[data-testid="axis-break"]')).not.toBeNull();
    const heights = barHeights(container);
    expect(heights.length).toBe(5);
    expect(heights.every((h) => h > 50)).toBe(true);
  });
});

describe("ReportsView cash flow tab", () => {
  const emptyData: BudgetData = {
    accounts: [],
    groups: [],
    categories: [],
    assignments: [],
    transactions: [],
    recurring: [],
  };

  it("places a Cash Flow tab immediately to the right of Net Worth", () => {
    const { container } = render(<ReportsView data={emptyData} month="2026-06" />);
    const labels = Array.from(container.querySelectorAll(".y-tab")).map(
      (el) => el.textContent
    );
    expect(labels).toEqual([
      "Spending Trends",
      "Spending by Category",
      "Net Worth",
      "Cash Flow",
    ]);
  });

  it("shows the cash flow chart when the Cash Flow tab is selected", () => {
    const { container, getByText } = render(
      <ReportsView data={emptyData} month="2026-06" />
    );
    const cashFlowTab = Array.from(container.querySelectorAll(".y-tab")).find(
      (el) => el.textContent === "Cash Flow"
    );
    expect(cashFlowTab).not.toBeUndefined();
    fireEvent.click(cashFlowTab!);
    expect(getByText("Monthly Cash Flow")).not.toBeNull();
  });
});

describe("SurplusReport trendline", () => {
  const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

  beforeAll(() => {
    // jsdom reports zero sizes; give the chart a real layout box.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      value: 600,
    });
  });

  afterAll(() => {
    if (origWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origWidth);
    if (origHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origHeight);
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("is off by default", () => {
    const { container, getByText } = render(
      <SurplusReport points={makePoints([10000, 11000, 10500])} />
    );
    expect(getByText("Off")).not.toBeNull();
    expect(container.querySelector('[data-testid="trendline"]')).toBeNull();
  });

  it("toggles the trendline on and back off", () => {
    const { container, getByText } = render(
      <SurplusReport points={makePoints([10000, 11000, 10500])} />
    );
    fireEvent.click(getByText("Off"));
    expect(getByText("On")).not.toBeNull();
    expect(container.querySelector('[data-testid="trendline"]')).not.toBeNull();
    fireEvent.click(getByText("On"));
    expect(getByText("Off")).not.toBeNull();
    expect(container.querySelector('[data-testid="trendline"]')).toBeNull();
  });

  it("persists the toggle across mounts", () => {
    const points = makePoints([10000, 11000, 10500]);
    const first = render(<SurplusReport points={points} />);
    fireEvent.click(first.getByText("Off"));
    expect(first.getByText("On")).not.toBeNull();
    first.unmount();
    const second = render(<SurplusReport points={points} />);
    expect(second.getByText("On")).not.toBeNull();
    expect(second.container.querySelector('[data-testid="trendline"]')).not.toBeNull();
  });

  it("disables the toggle when fewer than 2 months are available", () => {
    const single = render(<SurplusReport points={makePoints([10000])} />);
    expect((single.getByText("Off") as HTMLButtonElement).disabled).toBe(true);
    expect(single.container.querySelector('[data-testid="trendline"]')).toBeNull();
    single.unmount();
    const empty = render(<SurplusReport points={[]} />);
    expect((empty.getByText("Off") as HTMLButtonElement).disabled).toBe(true);
  });

  it("composes with the log scale and the outlier axis break", () => {
    const points = makePoints([10000, 11000, 10500, 9500, 10200, 9800, 500000]);
    const { container, getByText } = render(<SurplusReport points={points} />);
    fireEvent.click(getByText("Off"));
    // Axis break still applies with the trendline on.
    expect(container.querySelector('[data-testid="axis-break"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trendline"]')).not.toBeNull();
    // And the trendline survives a switch to the log scale.
    fireEvent.click(getByText("Log"));
    expect(container.querySelector('[data-testid="trendline"]')).not.toBeNull();
  });

  it("renders one dot per month on the trendline when on, none when off", () => {
    const { container, getByText } = render(
      <SurplusReport points={makePoints([10000, 11000, 10500])} />
    );
    expect(container.querySelectorAll('[data-testid="trendline-dot"]').length).toBe(0);
    fireEvent.click(getByText("Off"));
    expect(container.querySelectorAll('[data-testid="trendline-dot"]').length).toBe(3);
  });
});

describe("SurplusReport trendline tooltip", () => {
  const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const origRaf = globalThis.requestAnimationFrame;

  beforeAll(() => {
    // jsdom reports zero sizes; give the chart a real layout box.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      value: 600,
    });
    // Deliver hover state updates synchronously for deterministic tooltips.
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof requestAnimationFrame;
  });

  afterAll(() => {
    if (origWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origWidth);
    if (origHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origHeight);
    globalThis.requestAnimationFrame = origRaf;
  });

  beforeEach(() => {
    localStorage.clear();
  });

  // OLS over [10000, 30000, 20000]: slope 5000, intercept 15000,
  // fitted [15000, 20000, 25000] — each differs from its bar value.
  const surpluses = [10000, 30000, 20000];

  function hoverMonth(container: HTMLElement, clientX: number) {
    const chartArea = container.querySelector("div.relative.min-h-0");
    expect(chartArea).not.toBeNull();
    fireEvent.mouseMove(chartArea!, { clientX, clientY: 100 });
    const tip = document.querySelector(".y-tip");
    expect(tip).not.toBeNull();
    return tip!;
  }

  it("shows the trend value for the hovered month when the trendline is on", () => {
    const { container, getByText } = render(
      <SurplusReport points={makePoints(surpluses)} />
    );
    fireEvent.click(getByText("Off"));
    expect(getByText("On")).not.toBeNull();
    const tip = hoverMonth(container, 100);
    expect(tip.textContent).toContain("Trend");
    expect(tip.textContent).toContain("$150.00");
  });

  it("omits the trend value when the trendline is off", () => {
    const { container } = render(<SurplusReport points={makePoints(surpluses)} />);
    const tip = hoverMonth(container, 100);
    expect(tip.textContent).toContain("Surplus");
    expect(tip.textContent).not.toContain("Trend");
  });

  it("shows the fitted value of the hovered month, not the first month", () => {
    const { container, getByText } = render(
      <SurplusReport points={makePoints(surpluses)} />
    );
    fireEvent.click(getByText("Off"));
    const tip = hoverMonth(container, 400);
    expect(tip.textContent).toContain("Trend");
    expect(tip.textContent).toContain("$200.00");
    expect(tip.textContent).not.toContain("$150.00");
  });

  it("separates income/outflow rows from surplus/trend rows with a divider", () => {
    const { container, getByText } = render(
      <SurplusReport points={makePoints(surpluses)} />
    );
    fireEvent.click(getByText("Off"));
    const tip = hoverMonth(container, 100);
    expect(tip.querySelector('[data-testid="tip-divider"]')).not.toBeNull();
  });

  it("shows dots only on the surplus and trend rows", () => {
    const { container, getByText } = render(
      <SurplusReport points={makePoints(surpluses)} />
    );
    fireEvent.click(getByText("Off"));
    const tip = hoverMonth(container, 100);
    // Income/Outflow render dotless with an aligning spacer; amounts stay.
    expect(tip.textContent).toContain("Income");
    expect(tip.textContent).toContain("Outflow");
    expect(tip.querySelectorAll('[data-testid="tip-dot"]').length).toBe(2);
  });

  it("shows a single surplus dot and the divider when the trendline is off", () => {
    const { container } = render(<SurplusReport points={makePoints(surpluses)} />);
    const tip = hoverMonth(container, 100);
    expect(tip.querySelectorAll('[data-testid="tip-dot"]').length).toBe(1);
    expect(tip.querySelector('[data-testid="tip-divider"]')).not.toBeNull();
  });
});
