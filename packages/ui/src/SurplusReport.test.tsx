"use client";

import { fireEvent, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    expect(getByText("Monthly Surplus")).not.toBeNull();
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
});

describe("ReportsView surplus tab", () => {
  const emptyData: BudgetData = {
    accounts: [],
    groups: [],
    categories: [],
    assignments: [],
    transactions: [],
    recurring: [],
  };

  it("places a Surplus tab immediately to the right of Net Worth", () => {
    const { container } = render(<ReportsView data={emptyData} month="2026-06" />);
    const labels = Array.from(container.querySelectorAll(".y-tab")).map(
      (el) => el.textContent
    );
    expect(labels).toEqual([
      "Spending Trends",
      "Spending by Category",
      "Net Worth",
      "Surplus",
    ]);
  });

  it("shows the surplus chart when the Surplus tab is selected", () => {
    const { container, getByText } = render(
      <ReportsView data={emptyData} month="2026-06" />
    );
    const surplusTab = Array.from(container.querySelectorAll(".y-tab")).find(
      (el) => el.textContent === "Surplus"
    );
    expect(surplusTab).not.toBeUndefined();
    fireEvent.click(surplusTab!);
    expect(getByText("Monthly Surplus")).not.toBeNull();
  });
});
