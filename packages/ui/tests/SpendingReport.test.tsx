import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import {
  SANKEY_LEFT_LABEL_INSET,
  sankeyThresholdStops,
  type SpendingGroupFlow,
} from "@ynab/logic";
import {
  SpendingReport,
  SANKEY_BUCKET_HATCH_ID,
  SANKEY_INCOME_GRADIENT_ID_PREFIX,
  SANKEY_RIBBON_DIM_OPACITY,
  SANKEY_RIBBON_HOVER_OPACITY,
  SANKEY_RIBBON_OPACITY,
  SOURCE_AMOUNT_PX_PER_CHAR,
  SOURCE_NAME_PX_PER_CHAR,
  type SpendingItem,
} from "../src/SpendingReport.js";
import {
  colorForName,
  REMAINING_COLOR,
  sankeyTargetColor,
  SANKEY_INCOME_COLOR,
} from "../src/chartUtils.js";

class MockResizeObserver {
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(el: HTMLElement) {
    if (el.clientWidth === 0) {
      Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
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
  // Deliver hover state updates synchronously for deterministic tooltips
  // (same pattern as the other rAF-throttled report tests).
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

beforeEach(() => {
  // View, dimension, and threshold persist in localStorage and the auto-fit
  // session flag in sessionStorage: reset both so every test starts from a
  // fresh initial load.
  localStorage.clear();
  sessionStorage.clear();
});

const sampleCategories: SpendingItem[] = [
  { name: "Mortgage Interest", value: 100000 },
  { name: "Groceries", value: 40000 },
  { name: "Electric Bill", value: 15000 },
];

const sampleMerchants: SpendingItem[] = [
  { name: "Bank of Example", value: 100000 },
  { name: "Whole Foods", value: 30000 },
  { name: "Corner Shop", value: 20000 },
];

const sampleCategoryFlow: SpendingGroupFlow = {
  groups: [
    { name: "Bills", value: 115000 },
    { name: "Everyday", value: 40000 },
  ],
  targets: sampleCategories,
  links: [
    { groupIndex: 0, targetIndex: 0, value: 100000 },
    { groupIndex: 0, targetIndex: 2, value: 15000 },
    { groupIndex: 1, targetIndex: 1, value: 40000 },
  ],
};

const sampleMerchantFlow: SpendingGroupFlow = {
  groups: [
    { name: "Bills", value: 100000 },
    { name: "Everyday", value: 50000 },
  ],
  targets: sampleMerchants,
  links: [
    { groupIndex: 0, targetIndex: 0, value: 100000 },
    { groupIndex: 1, targetIndex: 1, value: 30000 },
    { groupIndex: 1, targetIndex: 2, value: 20000 },
  ],
};

const emptyFlow: SpendingGroupFlow = { groups: [], targets: [], links: [] };

// Income $2,000 vs spending $1,550: flow is $2,000 with a $450 Remaining plug.
const sampleIncome: SpendingItem[] = [{ name: "Payroll", value: 200000 }];

function renderReport(
  categoryFlow: SpendingGroupFlow = sampleCategoryFlow,
  merchantFlow: SpendingGroupFlow = sampleMerchantFlow,
  income: SpendingItem[] = sampleIncome,
  groupOrder: readonly string[] = [],
  categoryOrder: readonly string[] = []
) {
  return render(
    <SpendingReport
      categoryFlow={categoryFlow}
      merchantFlow={merchantFlow}
      income={income}
      groupOrder={groupOrder}
      categoryOrder={categoryOrder}
    />
  );
}

// The Under slider walks stepped stops, not raw dollars: resolve the slider
// position for a dollar threshold from the stops covering `maxDollars` (the
// fixture's largest row on any column — the same input the report uses).
function stepFor(maxDollars: number, dollars: number): string {
  return String(sankeyThresholdStops(maxDollars).indexOf(dollars));
}

describe("SpendingReport", () => {
  it("renders the panel title with the In / Out / Left header readout", () => {
    renderReport();
    expect(screen.getByText("Spending by Category")).toBeInTheDocument();
    expect(screen.getByText("In:")).toBeInTheDocument();
    expect(screen.getByText("Out:")).toBeInTheDocument();
    expect(screen.getByText("Left:")).toBeInTheDocument();
    expect(screen.getByText("$2,000.00")).toBeInTheDocument();
    expect(screen.getByText("$1,550.00")).toBeInTheDocument();
    expect(screen.getByText("$450.00")).toBeInTheDocument();
    expect(screen.getByText("3 categories")).toBeInTheDocument();
  });

  it("shows no explainer tooltip on the Left / Over header readout", () => {
    renderReport();
    // The header readout is factual data only — hovering it explains nothing.
    fireEvent.mouseOver(screen.getByText("Left:"));
    expect(
      screen.queryByText(
        "Unspent income — lands in the render-only Remaining row on the right"
      )
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("defaults to the 3-column Sankey with income→group→expense ribbons", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]');
    expect(svg).not.toBeNull();
    // Left: one income source; middle: 2 category groups; right: 3
    // categories plus the Remaining plug. Left ribbons run income → groups
    // (1 x 2) plus the full-width Remaining ribbon; right ribbons run
    // groups → categories (3 exact cells).
    expect(svg!.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(1);
    expect(svg!.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg!.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(4);
    expect(svg!.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(6);
    expect(svg!.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')).toHaveLength(3);
    expect(svg!.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')).toHaveLength(3);
    // No Total bar and no Total-side ribbons.
    expect(svg!.querySelector('[data-testid="sankey-total"]')).toBeNull();
    expect(svg!.querySelectorAll('[data-testid="sankey-in-link"]')).toHaveLength(0);
    expect(container.querySelectorAll(".y-bar-track")).toHaveLength(0);
  });

  it("labels each node with its name, amount, and share of the flow", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const scope = within(svg as unknown as HTMLElement);
    // Flow is $2,000: 100000 -> 50%, 40000 -> 20%, 15000 -> 8%, 45000 -> 23%.
    expect(scope.getByText("Mortgage Interest")).toBeInTheDocument();
    expect(scope.getByText("Groceries")).toBeInTheDocument();
    expect(scope.getByText("$1,000.00 · 50%")).toBeInTheDocument();
    expect(scope.getByText("$150.00 · 8%")).toBeInTheDocument();
    expect(scope.getByText("Payroll")).toBeInTheDocument();
    expect(scope.getByText("$2,000.00 · 100%")).toBeInTheDocument();
    expect(scope.getByText("Remaining")).toBeInTheDocument();
    expect(scope.getByText("$450.00 · 23%")).toBeInTheDocument();
    // Middle column: Bills ($1,150) and Everyday ($400) with flow shares.
    // Groceries and Everyday coincide at $400.00 · 20%, one per column.
    expect(scope.getAllByText("$400.00 · 20%")).toHaveLength(2);
    expect(scope.getByText("Bills")).toBeInTheDocument();
    expect(scope.getByText("$1,150.00 · 57%")).toBeInTheDocument();
    expect(scope.getByText("Everyday")).toBeInTheDocument();
  });

  it("anchors group labels right of the middle bars with a halo over the ribbons", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const bars = svg.querySelectorAll('[data-testid="sankey-group"]');
    const labels = svg.querySelectorAll('[data-testid="sankey-group-label"]');
    expect(bars).toHaveLength(2);
    expect(labels).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      const bar = bars[i]!;
      const label = labels[i]!;
      // Start-anchored 6px right of the bar, inside the ribbon zone.
      expect(Number(label.getAttribute("x"))).toBe(
        Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")) + 6
      );
      // Fully opaque halo so the text stays readable over the ribbons —
      // no ribbon color can bleed through and tint it.
      expect(label.getAttribute("paint-order")).toBe("stroke");
      expect(label.getAttribute("stroke")).toBe("#ffffff");
    }
  });

  it("colors each category by its own name, never by its parent group", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const nodes = Array.from(svg.querySelectorAll('[data-testid="sankey-node"]'));
    // The category determines the color: Mortgage Interest and Electric Bill
    // share the Bills group but keep their own stable hues — the parent
    // group never tints them. Remaining stays green.
    expect(nodes.map((n) => n.getAttribute("fill"))).toEqual([
      colorForName("Mortgage Interest"),
      colorForName("Groceries"),
      colorForName("Electric Bill"),
      REMAINING_COLOR,
    ]);
    // The middle bars carry their own group colors; the children match only
    // by hash coincidence, never by design.
    const groups = Array.from(svg.querySelectorAll('[data-testid="sankey-group"]'));
    expect(groups.map((g) => g.getAttribute("fill"))).toEqual([
      colorForName("Bills"),
      colorForName("Everyday"),
    ]);
    // The helper agrees with the rendered bars (same rule, pinned twice).
    expect(
      sankeyTargetColor({ name: "Mortgage Interest", bucket: false, isPlug: false })
    ).toBe(nodes[0]!.getAttribute("fill"));
  });

  it("toggles between Categories and Merchants dimensions", () => {
    const { container } = renderReport();
    expect(screen.getByText("Spending by Category")).toBeInTheDocument();
    expect(screen.getByText("3 categories")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    expect(screen.getByText("Spending by Merchant")).toBeInTheDocument();
    expect(screen.getByText("3 merchants")).toBeInTheDocument();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    expect(within(svg as unknown as HTMLElement).getByText("Whole Foods")).toBeInTheDocument();
    expect(
      within(svg as unknown as HTMLElement).queryByText("Mortgage Interest")
    ).not.toBeInTheDocument();
    // Merchant total differs: 100000 + 30000 + 20000; income side is unchanged.
    expect(screen.getByText("$1,500.00")).toBeInTheDocument();
    expect(screen.getByText("$500.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Categories", exact: true }));
    expect(screen.getByText("Spending by Category")).toBeInTheDocument();
  });

  it("toggles between Sankey and Bars views", () => {
    const { container } = renderReport();
    expect(container.querySelector('[data-testid="sankey-svg"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    expect(container.querySelector('[data-testid="sankey-svg"]')).toBeNull();
    expect(container.querySelectorAll(".y-bar-track")).toHaveLength(3);
    expect(screen.getByText("Mortgage Interest")).toBeInTheDocument();
    expect(screen.getByText("65%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sankey", exact: true }));
    expect(container.querySelector('[data-testid="sankey-svg"]')).not.toBeNull();
    expect(container.querySelectorAll(".y-bar-track")).toHaveLength(0);
  });

  it("merges rows under the slider threshold into an Other bucket on every column", () => {
    const { container } = renderReport();
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    // $500 threshold: Groceries ($400) and Electric Bill ($150) merge on
    // the right, Everyday ($400) merges in the middle.
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });

    expect(screen.getByText("(3 in Other)")).toBeInTheDocument();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Mortgage + Other + Remaining on the right; Bills + Other in the
    // middle: 1 x 3 left ribbons and 3 right ribbons.
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(6);
    expect(within(svg as unknown as HTMLElement).getAllByText("Other")).toHaveLength(2);
    expect(within(svg as unknown as HTMLElement).getByText("$550.00 · 28%")).toBeInTheDocument();
    expect(within(svg as unknown as HTMLElement).getByText("$400.00 · 20%")).toBeInTheDocument();
    // Out total is unchanged by merging.
    expect(screen.getByText("$1,550.00")).toBeInTheDocument();
  });

  it("merges everything into a single Other row when the threshold exceeds all values", () => {
    // Non-round top value so the slider ceiling ($1000) sits above it; the
    // income stays below it so the ceiling still comes from the expense side.
    const everythingFlow: SpendingGroupFlow = {
      groups: [{ name: "Stuff", value: 100000 }],
      targets: [
        { name: "Almost All", value: 99900 },
        { name: "Dust", value: 100 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 99900 },
        { groupIndex: 0, targetIndex: 1, value: 100 },
      ],
    };
    const { container } = renderReport(
      everythingFlow,
      emptyFlow,
      [{ name: "Payroll", value: 50000 }]
    );
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    // Stops cover the $1,000 group: 15 positions, top stop $1,000.
    expect(slider).toHaveAttribute("max", String(sankeyThresholdStops(1000).length - 1));
    fireEvent.change(slider, { target: { value: stepFor(1000, 1000) } });
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Both outer columns collapse to a single Other row each while the
    // $1000 group sits exactly at the threshold and stays: $500 of income
    // cannot cover $1000 of spending, so there is no Remaining — one ribbon
    // per hop, and the header counts the merged rows (2 expenses + 1 income).
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(1);
    expect(within(svg as unknown as HTMLElement).getAllByText("Other")).toHaveLength(2);
    expect(screen.getByText("(3 in Other)")).toBeInTheDocument();
  });

  it("applies the threshold merge to the Bars view too", () => {
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });
    expect(container.querySelectorAll(".y-bar-track")).toHaveLength(2);
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("(2 merged)")).toBeInTheDocument();
  });

  it("merges small incomes into an Other bucket on the left with the same threshold", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Side Gig", value: 30000 },
      { name: "Cashback", value: 5000 },
    ]);
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    // $500 threshold: Groceries ($400) + Electric Bill ($150) merge on the
    // right, Side Gig ($300) + Cashback ($50) merge on the left, and
    // Everyday ($400) merges in the middle.
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });

    // Header counts merged rows on all three columns.
    expect(screen.getByText("(5 in Other)")).toBeInTheDocument();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Left: Payroll + Other; middle: Bills + Other; right: Mortgage +
    // Other + Remaining. Left ribbons run 2 x 3, right ribbons run one per
    // cell (3) — never one per income.
    expect(svg.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(9);
    expect(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
    ).toHaveLength(6);
    expect(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    ).toHaveLength(3);
    expect(within(svg as unknown as HTMLElement).getAllByText("Other")).toHaveLength(3);
    expect(within(svg as unknown as HTMLElement).getByText("$350.00 · 15%")).toBeInTheDocument();
    // In total is unchanged by merging.
    expect(screen.getByText("$2,350.00")).toBeInTheDocument();
  });

  it("shows merged-income detail when hovering the income Other bucket", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Side Gig", value: 30000 },
      { name: "Cashback", value: 5000 },
    ]);
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });
    // Left column is Payroll, then Other.
    const otherIncome = container.querySelectorAll('[data-testid="sankey-income"]')[1]!;
    fireEvent.mouseMove(otherIncome, { clientX: 100, clientY: 300 });
    expect(screen.getByText("2 smaller incomes under $500.00")).toBeInTheDocument();
    fireEvent.mouseLeave(otherIncome);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("sizes the slider ceiling from the largest row on any side", () => {
    // Largest expense is $1,000 but the $2,000 income drives the ceiling:
    // positions run through the $2,000 stop.
    renderReport();
    const stops = sankeyThresholdStops(2000);
    expect(
      screen.getByRole("slider", { name: /merge smaller groups/i })
    ).toHaveAttribute("max", String(stops.length - 1));
  });

  it("steps the Under slider in small increments first, larger jumps later", () => {
    renderReport();
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    const stops = sankeyThresholdStops(2000);
    // Position 1 merges under $10; the last step jumps $500 to $2,000.
    expect(stops[1]).toBe(10);
    expect(stops[stops.length - 1]! - stops[stops.length - 2]!).toBe(500);
    fireEvent.change(slider, { target: { value: "1" } });
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: String(stops.length - 1) } });
    // The Under readout joins the $2,000 income total at the top stop.
    expect(screen.getAllByText("$2,000.00")).toHaveLength(2);
  });

  it("raises the Under ceiling past the old $2,000 cap on large datasets", () => {
    // A $60,000 income used to pin the slider at $2,000; stops now reach
    // $100,000 so the long tail stays mergeable.
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Windfall", value: 6000000 },
    ]);
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    const stops = sankeyThresholdStops(60000);
    expect(stops[stops.length - 1]).toBe(100000);
    expect(slider).toHaveAttribute("max", String(stops.length - 1));
    fireEvent.change(slider, { target: { value: String(stops.length - 1) } });
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Everything folds: one Other bucket per column.
    expect(svg.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(1);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(1);
    expect(within(svg as unknown as HTMLElement).getAllByText("Other")).toHaveLength(3);
  });

  it("shows a tooltip with amount and shares when hovering a spending node", () => {
    const { container } = renderReport();
    const node = container.querySelectorAll('[data-testid="sankey-node"]')[1]!;
    fireEvent.mouseMove(node, { clientX: 400, clientY: 200 });
    // The floating ChartTip carries the hovered details (node labels also
    // show the name, so scope to the .y-tip overlay).
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Groceries")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$400.00")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("(20%)")).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("26% of $1,550.00 spending")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(node);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows merged-group detail when hovering the Other bucket", () => {
    const { container } = renderReport();
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });
    // Nodes are Mortgage, Other, Remaining — Other sits in the middle.
    const otherNode = container.querySelectorAll('[data-testid="sankey-node"]')[1]!;
    fireEvent.mouseMove(otherNode, { clientX: 600, clientY: 200 });
    expect(screen.getByText("2 smaller categories under $500.00")).toBeInTheDocument();
    // No explainer lines: the tooltip carries only factual data.
    expect(
      screen.queryByText("Render-only — grouped by the Under threshold")
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(otherNode);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows the proportional flow when hovering an income→group ribbon", () => {
    const { container } = renderReport();
    // Left ribbons run middle-major: [Payroll→Bills, Payroll→Everyday, ...].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[1]!;
    expect(link.getAttribute("data-side")).toBe("left");
    fireEvent.mouseMove(link, { clientX: 400, clientY: 200 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Payroll → Everyday")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$400.00")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("(100%)")).toBeInTheDocument();
    fireEvent.mouseLeave(link);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows the exact rollup when hovering a group→category ribbon", () => {
    const { container } = renderReport();
    // Right ribbons run group-major: [Bills→Mortgage, Bills→Electric, ...].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[3]!;
    expect(link.getAttribute("data-side")).toBe("right");
    fireEvent.mouseMove(link, { clientX: 500, clientY: 120 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    // One ribbon per cell: the tooltip reads as the group flowing into the
    // target, carrying the full cell value.
    expect(
      within(tip as unknown as HTMLElement).getByText("Bills → Mortgage Interest")
    ).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$1,000.00")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("(100%)")).toBeInTheDocument();
    // No explainer lines: the tooltip carries only factual data.
    expect(
      within(tip as unknown as HTMLElement).queryByText("Rolls up into its group — no splitting")
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(link);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows only factual flow data when hovering a group→merchant ribbon", () => {
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    // Right ribbons: [Bills→Bank of Example, Everyday→Whole Foods, ...].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[4]!;
    expect(link.getAttribute("data-side")).toBe("right");
    fireEvent.mouseMove(link, { clientX: 500, clientY: 200 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("Everyday → Whole Foods")
    ).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$300.00")).toBeInTheDocument();
    // No explainer lines: the tooltip carries only factual data.
    expect(
      within(tip as unknown as HTMLElement).queryByText("The merchant's exact share in this group")
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(link);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("colors every ribbon flat by the node it flows into, not its income source", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 50000 },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // One ribbon per group→target cell (3) even with two incomes — no
    // per-income subdivision, so no split lines inside a cell. Every band
    // renders in the final category's color.
    const right = svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]');
    expect(right).toHaveLength(3);
    const left = svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]');
    // 2 incomes x 2 groups plus 2 full-width Remaining ribbons on the left.
    expect(left).toHaveLength(6);
    // Each ribbon carries one flat color through its whole length,
    // exactly its destination node's fill — gradients live only on the
    // income bars (one per bar), never on a ribbon.
    for (const link of svg.querySelectorAll('[data-testid="sankey-link"]')) {
      expect(link.getAttribute("fill")).not.toMatch(/^url\(/);
    }
    expect(svg.querySelectorAll("linearGradient")).toHaveLength(2);
    const bills = colorForName("Bills");
    const everyday = colorForName("Everyday");
    // Right ribbons fill with their target's own color, cell-major:
    // Bills→Mortgage, Bills→Electric, Everyday→Groceries. Both Bills legs
    // carry their category's color — the middle group never tints them.
    const targetFills = [
      colorForName("Mortgage Interest"),
      colorForName("Electric Bill"),
      colorForName("Groceries"),
    ];
    right.forEach((link, k) => {
      expect(link.getAttribute("fill")).toBe(targetFills[k]);
      // Cells carry every income's money: no per-income identity survives.
      expect(link.getAttribute("data-income")).toBeNull();
    });
    // Left ribbons fill with their middle's color; the plug ribbons run
    // Remaining green full-width. Links run middle-major, incomes within.
    const leftFills = [bills, bills, everyday, everyday, REMAINING_COLOR, REMAINING_COLOR];
    left.forEach((link, k) => {
      expect(link.getAttribute("fill")).toBe(leftFills[k]);
    });
    // Ribbon fills equal their destination bars' fills exactly: the line
    // from an income to a category reads as one color throughout. The
    // income's own color never appears on a ribbon.
    const incomeFill = svg
      .querySelector('[data-testid="sankey-income"]')!
      .getAttribute("fill");
    const nodeFills = Array.from(svg.querySelectorAll('[data-testid="sankey-node"]')).map(
      (n) => n.getAttribute("fill")
    );
    const groupFills = Array.from(svg.querySelectorAll('[data-testid="sankey-group"]')).map(
      (g) => g.getAttribute("fill")
    );
    expect(nodeFills).toEqual([
      colorForName("Mortgage Interest"),
      colorForName("Groceries"),
      colorForName("Electric Bill"),
      REMAINING_COLOR,
    ]);
    right.forEach((link, k) => {
      const targetIndex = [0, 2, 1][k]!;
      expect(link.getAttribute("fill")).toBe(nodeFills[targetIndex]);
    });
    left.forEach((link, k) => {
      const destFill = k < 4 ? groupFills[Math.floor(k / 2)] : nodeFills[3];
      expect(link.getAttribute("fill")).toBe(destFill);
      if (incomeFill !== destFill) {
        expect(link.getAttribute("fill")).not.toBe(incomeFill);
      }
    });
    // The group tooltip still counts distinct targets, not sub-ribbons.
    const group = svg.querySelectorAll('[data-testid="sankey-group"]')[0]!;
    fireEvent.mouseMove(group, { clientX: 380, clientY: 100 });
    const tip = document.querySelector(".y-tip")!;
    expect(
      within(tip as unknown as HTMLElement).getByText("2 categories · 74% of $1,550.00 spending")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(group);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("highlights every line leading from a hovered income source", () => {
    // Money is fungible, so one income reaches every group and target: the
    // hover lights its left ribbons plus its full downstream contribution —
    // every right-hop cell in full — and dims only the OTHER income's bar
    // and bands.
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 50000 },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const income = svg.querySelectorAll('[data-testid="sankey-income"]')[0]!;
    fireEvent.mouseMove(income, { clientX: 100, clientY: 200 });
    // Every group sits on Payroll's path, so every group bar brightens to
    // the spotlight level with its ribbons; every right bar brightens too
    // (all benefit from Payroll) — same steps as the ribbons.
    for (const bar of svg.querySelectorAll('[data-testid="sankey-group"]')) {
      expect(bar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    }
    for (const bar of svg.querySelectorAll('[data-testid="sankey-node"]')) {
      expect(bar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    }
    // Payroll's own bar brightens; the Bonus bar dims.
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    expect(incomes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    expect(incomes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    // Payroll's left ribbons brighten and render above the dimmed Bonus
    // ribbons (spotlight z-order: dimmed legs first, lit legs last).
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.12",
      "0.12",
      "0.12",
      "0.85",
      "0.85",
      "0.85",
    ]);
    // Every downstream cell brightens in full — not just Payroll's share of
    // each cell.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual(["0.85", "0.85", "0.85"]);
    fireEvent.mouseLeave(income);
  });

  it("highlights a hovered target and every line leading into it", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 50000 },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Groceries (index 1) draws only from Everyday: the whole cell ribbon
    // brightens — one ribbon per cell, never split per income.
    const node = svg.querySelectorAll('[data-testid="sankey-node"]')[1]!;
    fireEvent.mouseMove(node, { clientX: 600, clientY: 200 });
    expect(node.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    // Right ribbons run cell-major (Bills→Mortgage, Bills→Electric,
    // Everyday→Groceries): only the Groceries cell brightens, rendered
    // above the dimmed rest.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual(["0.12", "0.12", "0.85"]);
    // The parent group joins the spotlight in the same bright color as
    // its ribbon while the off-path group dims; dimmed legs render first
    // in the DOM.
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[0]!.getAttribute("fill-opacity")).toBe("0.12");
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.85");
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.12",
      "0.12",
      "0.12",
      "0.12",
      "0.85",
      "0.85",
    ]);
    // Sibling targets dim.
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    expect(nodes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    expect(nodes[2]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    fireEvent.mouseLeave(node);
  });

  it("spotlights the full path — every leg — when hovering a merchant split across groups", () => {
    // Airbnb draws mostly from Everyday ($900) with a small Bills cell
    // ($100): hovering it must trace its FULL path — both cells brighten,
    // in the merchant's own color along their whole length, or the small
    // leg sits dim beside the bar while the tooltip claims the whole
    // amount. A dominant-only spotlight used to leave that leg dark
    // (task-35): the full path is the merchant's whole story, so it all
    // lights. Categories (one group each) trivially behave the same way.
    const merchantFlow: SpendingGroupFlow = {
      groups: [
        { name: "Bills", value: 110000 },
        { name: "Everyday", value: 140000 },
      ],
      targets: [
        { name: "Airbnb", value: 100000 },
        { name: "Bank of Example", value: 100000 },
        { name: "Whole Foods", value: 50000 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 10000 },
        { groupIndex: 0, targetIndex: 1, value: 100000 },
        { groupIndex: 1, targetIndex: 0, value: 90000 },
        { groupIndex: 1, targetIndex: 2, value: 50000 },
      ],
    };
    const { container } = renderReport(sampleCategoryFlow, merchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 50000 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const node = svg.querySelectorAll('[data-testid="sankey-node"]')[0]!;
    fireEvent.mouseMove(node, { clientX: 600, clientY: 100 });
    // The merchant itself brightens; siblings dim.
    expect(node.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    expect(nodes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    expect(nodes[2]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    // Both Airbnb cells brighten — the small Bills leg included — in the
    // merchant's own color, rendered above the two dimmed off-path cells.
    // Right links run cell-major: Bills→Airbnb, Bills→Bank, Everyday→Airbnb,
    // Everyday→Whole Foods; the spotlight z-reorder moves lit legs last.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.12",
      "0.12",
      "0.85",
      "0.85",
    ]);
    const airbnb = colorForName("Airbnb");
    expect(node.getAttribute("fill")).toBe(airbnb);
    expect(right[2]!.getAttribute("fill")).toBe(airbnb);
    expect(right[3]!.getAttribute("fill")).toBe(airbnb);
    // Both parent groups join the spotlight — the non-dominant Bills bar
    // brightens with its ribbon instead of dimming away from it.
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[0]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.85");
    // The income fans of both groups brighten: every left ribbon feeds a
    // lit group here, so all four light.
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.85",
      "0.85",
      "0.85",
      "0.85",
    ]);
    // Every income funds every group proportionally, so both income bars
    // join the spotlight — the same contract as hovering a category in
    // Categories view.
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    expect(incomes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    expect(incomes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    fireEvent.mouseLeave(node);
  });

  it("renders parent groups in the same bright color as their ribbons while hovered", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const group = svg.querySelectorAll('[data-testid="sankey-group"]')[0]!;
    // No border at rest, and hovering adds none either — brightness
    // carries the highlight instead.
    expect(group.getAttribute("stroke")).toBe("none");
    expect(group.getAttribute("stroke-width")).toBeNull();
    // The bar matches its ribbons exactly: same fill, same rest opacity.
    expect(group.getAttribute("fill")).toBe(colorForName("Bills"));
    expect(group.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
    fireEvent.mouseMove(group, { clientX: 380, clientY: 100 });
    expect(group.getAttribute("stroke")).toBe("none");
    expect(group.getAttribute("stroke-width")).toBeNull();
    // The hovered group brightens to the spotlight level with its ribbons
    // while the off-path sibling dims.
    expect(group.getAttribute("fill-opacity")).toBe("0.85");
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.12");
    // The connected ribbons brighten above the dimmed rest
    // (spotlight z-order: the dimmed Everyday ribbon renders first).
    const links = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]'));
    expect(links[3]!.getAttribute("fill-opacity")).toBe("0.12");
    expect(links[4]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(links[5]!.getAttribute("fill-opacity")).toBe("0.85");
    fireEvent.mouseLeave(group);
    // Rest state returns once the hover clears.
    expect(group.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
    expect(groups[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
  });

  it("lands the group spotlight with no transition so the bar matches its ribbons from the first frame", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // The spotlight z-reorder paints instantly (DOM order is not
    // transitionable), so any opacity transition would show final z-order
    // with pre-transition brightness — the hovered bar flashing lighter
    // than its own ribbons. No element on the spotlight path may carry a
    // fill-opacity transition: the whole spotlight lands atomically.
    const spotlighted = Array.from(
      svg.querySelectorAll(
        '[data-testid="sankey-link"], [data-testid="sankey-group"], [data-testid="sankey-node"], [data-testid="sankey-income"]'
      )
    );
    expect(spotlighted.length).toBeGreaterThan(0);
    for (const el of spotlighted) {
      expect(el.getAttribute("style") ?? "").not.toMatch(/fill-opacity/);
    }
    const group = svg.querySelectorAll('[data-testid="sankey-group"]')[0]!;
    fireEvent.mouseMove(group, { clientX: 380, clientY: 100 });
    // Same commit, same brightness: the bar and every ribbon on its path
    // share the hover step, and the left-hop ribbons share the bar's exact
    // fill (right-hop ribbons carry their target's own color by design).
    const barFill = group.getAttribute("fill");
    expect(group.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    const lit = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]')).filter(
      (l) => l.getAttribute("fill-opacity") === String(SANKEY_RIBBON_HOVER_OPACITY)
    );
    expect(lit.length).toBeGreaterThan(0);
    for (const l of lit) {
      expect(l.getAttribute("style") ?? "").not.toMatch(/fill-opacity/);
    }
    const leftLit = lit.filter((l) => l.getAttribute("data-side") === "left");
    expect(leftLit.length).toBeGreaterThan(0);
    for (const l of leftLit) {
      expect(l.getAttribute("fill")).toBe(barFill);
    }
    fireEvent.mouseLeave(group);
  });

  it("switches node hover A → B in one commit: unchanged arms keep attributes and DOM identity", () => {
    // Real browsers deliver rAF asynchronously, so a leave(A)+move(B) pair
    // lands in one frame; the suite's synchronous rAF mock would commit
    // each push separately, so queue frames here and flush by hand.
    const syncRaf = globalThis.requestAnimationFrame;
    let queued: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      queued.push(cb);
      return queued.length;
    };
    try {
      const { container } = renderReport();
      const svg = container.querySelector('[data-testid="sankey-svg"]')!;
      const flush = () => {
        const q = queued;
        queued = [];
        for (const cb of q) cb(0);
      };
      const nodes = () => Array.from(svg.querySelectorAll('[data-testid="sankey-node"]'));
      const leftLinks = () =>
        Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
      const labels = () =>
        Array.from(svg.querySelectorAll('[data-testid="sankey-target-label"]'));
      // The plug ribbon carries the Remaining green; find it by fill, not
      // by index — the spotlight z-reorder moves lit ribbons above dim ones.
      const plugLink = () => leftLinks().find((l) => l.getAttribute("fill") === REMAINING_COLOR)!;

      // Hover Mortgage Interest (node 0, a Bills child).
      fireEvent.mouseMove(nodes()[0]!, { clientX: 700, clientY: 100 });
      act(() => {
        flush();
      });
      expect(nodes()[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
      expect(nodes()[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));

      // Arms dimmed under BOTH spotlights: Electric Bill (node 2, a Bills
      // child — never on Groceries' Everyday path) and the full-width
      // Remaining plug ribbon (plug ribbons never join a node path).
      const electric = nodes()[2]!;
      const electricLabel = labels()[2]!;
      const plug = plugLink();
      expect(electric.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
      expect(plug.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
      const electricFill = electric.getAttribute("fill");
      const electricLabelOpacity = electricLabel.getAttribute("opacity");

      // Direct A → B switch, as the browser delivers it: leave(A) then
      // move(B) before the next frame. The leave must not clear
      // synchronously — that would flash every unchanged arm to rest
      // (dim → rest → dim) for a frame in between.
      fireEvent.mouseLeave(nodes()[0]!);
      fireEvent.mouseMove(nodes()[1]!, { clientX: 700, clientY: 150 });
      // No intermediate rest frame: A's spotlight is still painted.
      expect(nodes()[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
      expect(nodes()[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
      act(() => {
        flush();
      });
      // B's spotlight, landed directly: no rest frame in between.
      expect(nodes()[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
      expect(nodes()[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
      // Unchanged arms: identical paint attributes AND identical DOM nodes
      // — no remount, no reorder of the bars, no repaint trigger.
      const nodesAfter = nodes();
      expect(nodesAfter[2]).toBe(electric);
      expect(nodesAfter[2]!.getAttribute("fill")).toBe(electricFill);
      expect(nodesAfter[2]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
      expect(labels()[2]).toBe(electricLabel);
      expect(labels()[2]!.getAttribute("opacity")).toBe(electricLabelOpacity);
      expect(plugLink()).toBe(plug);
      expect(plugLink().getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));

      // Hover-leave back to rest is one commit too: the unchanged arm's
      // node survives the round trip with rest attributes.
      fireEvent.mouseLeave(nodesAfter[1]!);
      act(() => {
        flush();
      });
      const nodesRest = nodes();
      expect(nodesRest[2]).toBe(electric);
      expect(nodesRest[2]!.getAttribute("fill")).toBe(electricFill);
      expect(nodesRest[2]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
      expect(nodesRest[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
    } finally {
      globalThis.requestAnimationFrame = syncRaf;
    }
  });

  it("shows the proportional flow when hovering the full-width Remaining ribbon", () => {
    const { container } = renderReport();
    // The plug ribbon trails the left ribbons: [Payroll→Bills,
    // Payroll→Everyday, Payroll→Remaining, ...].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[2]!;
    expect(link.getAttribute("data-side")).toBe("left");
    fireEvent.mouseMove(link, { clientX: 400, clientY: 300 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("Payroll → Remaining")
    ).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$450.00")).toBeInTheDocument();
    fireEvent.mouseLeave(link);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows received amount and income share when hovering an income node", () => {
    const { container } = renderReport();
    const node = container.querySelector('[data-testid="sankey-income"]')!;
    fireEvent.mouseMove(node, { clientX: 100, clientY: 200 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Payroll")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$2,000.00")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("(100%)")).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("100% of $2,000.00 income")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(node);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows unspent detail when hovering the Remaining plug", () => {
    const { container } = renderReport();
    const nodes = container.querySelectorAll('[data-testid="sankey-node"]');
    const remaining = nodes[nodes.length - 1]!;
    fireEvent.mouseMove(remaining, { clientX: 600, clientY: 350 });
    expect(screen.getByText("Unspent of $2,000.00 income")).toBeInTheDocument();
    // No explainer lines: the tooltip carries only factual data.
    expect(
      screen.queryByText("Render-only row — unspent income, not a real category")
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(remaining);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("fills each income bar with its own ribbon-color gradient, never flat gray", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 50000 },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // One gradient per bar, painted from its own def — neither bar takes
    // flat gray nor its name color.
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    expect(incomes).toHaveLength(2);
    incomes.forEach((bar, i) => {
      expect(bar.getAttribute("fill")).toBe(`url(#${SANKEY_INCOME_GRADIENT_ID_PREFIX}${i})`);
      expect(bar.getAttribute("fill")).not.toBe(SANKEY_INCOME_COLOR);
    });
    expect(incomes[0]!.getAttribute("fill")).not.toBe(incomes[1]!.getAttribute("fill"));
    // The tooltip dot stays neutral gray: no single color can stand for
    // a gradient bar.
    fireEvent.mouseMove(incomes[0]!, { clientX: 100, clientY: 200 });
    const tip = document.querySelector(".y-tip")!;
    expect(
      within(tip as unknown as HTMLElement).getByTestId("tip-dot")
    ).toHaveStyle({ background: SANKEY_INCOME_COLOR });
    fireEvent.mouseLeave(incomes[0]!);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("marks render-only bars with a hatch and no border", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Side Gig", value: 30000 },
      { name: "Cashback", value: 5000 },
    ]);
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    // $500 threshold: Other buckets land on all three columns (Side Gig +
    // Cashback left, Everyday middle, Groceries + Electric right).
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // No borders on any bars — real or computed: the hatch alone marks the
    // render-only rows.
    for (const bar of svg.querySelectorAll(
      '[data-testid="sankey-income"], [data-testid="sankey-group"], [data-testid="sankey-node"]'
    )) {
      expect(bar.getAttribute("stroke")).toBe("none");
      expect(bar.getAttribute("stroke-dasharray")).toBeNull();
      expect(bar.getAttribute("stroke-width")).toBeNull();
    }
    // One hatch overlay per computed bar, painted from the shared pattern.
    const hatches = svg.querySelectorAll('[data-testid="sankey-bucket-hatch"]');
    expect(hatches).toHaveLength(4);
    for (const h of hatches) {
      expect(h.getAttribute("fill")).toBe(`url(#${SANKEY_BUCKET_HATCH_ID})`);
    }
    expect(svg.querySelector(`#${SANKEY_BUCKET_HATCH_ID}`)).not.toBeNull();
  });

  it("explains the over-income gap in tooltips instead of grey bar segments when spending exceeds income", () => {
    const { container } = render(
      <SpendingReport
        categoryFlow={sampleCategoryFlow}
        merchantFlow={sampleMerchantFlow}
        income={[{ name: "Payroll", value: 100000 }]}
      />
    );
    // $1,550 out vs $1,000 in: $550 short, no Remaining anywhere, and no
    // invented Overspent income.
    expect(screen.getByText("Over:")).toBeInTheDocument();
    expect(screen.getByText("$550.00")).toBeInTheDocument();
    expect(screen.queryByText("Remaining")).not.toBeInTheDocument();
    expect(screen.queryByText("Overspent")).not.toBeInTheDocument();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Two income→group ribbons plus three group→category ribbons; every
    // middle and right bar draws in full with no grey shortfall segment —
    // the gap lives in the tooltip, since every bar shares the same
    // unfunded fraction.
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(5);
    expect(svg.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-testid="sankey-shortfall"]')).toHaveLength(0);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-group-shortfall"]')).toHaveLength(0);
    expect(svg.querySelector('[data-testid="sankey-total"]')).toBeNull();
    // Hovering a bar explains the gap: spending ran $550 past income.
    const node = svg.querySelectorAll('[data-testid="sankey-node"]')[0]!;
    fireEvent.mouseMove(node, { clientX: 600, clientY: 100 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Over income")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).queryByText("Unfunded")).not.toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).queryByText("Shortfall")).not.toBeInTheDocument();
    // No explainer lines: the Over-income amount carries the gap.
    expect(
      within(tip as unknown as HTMLElement).queryByText(
        "Spending exceeded income by $550.00 — covered from savings or debt"
      )
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(node);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("anchors income labels into the left gutter, clear of the source bars", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const barX = Number(svg.querySelector('[data-testid="sankey-income"]')!.getAttribute("x"));
    // Both income label lines are right-aligned into the gutter, ending
    // before the source bar — never over the bar, never clipped.
    for (const text of ["Payroll", "$2,000.00 · 100%"]) {
      const el = within(svg as unknown as HTMLElement).getByText(text);
      expect(el.getAttribute("text-anchor")).toBe("end");
      expect(Number(el.getAttribute("x"))).toBeLessThanOrEqual(barX - 8);
    }
  });

  it("truncates long income names with ellipsis inside the visible area, amounts inset from the edge", () => {
    const { container } = render(
      <SpendingReport
        categoryFlow={sampleCategoryFlow}
        merchantFlow={sampleMerchantFlow}
        income={[{ name: "Canada Revenue Agency", value: 200000 }]}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // 21 chars exceeds the label budget, so the name truncates with an
    // ellipsis — and the truncation itself must fit inside the viewport.
    const nameEl = svg.querySelector('[data-testid="sankey-income-label"]')!;
    const name = nameEl.textContent ?? "";
    expect(name).toBe("Canada Revenue Agen…");
    expect(nameEl.getAttribute("text-anchor")).toBe("end");
    const nameX = Number(nameEl.getAttribute("x"));
    expect(nameX - name.length * SOURCE_NAME_PX_PER_CHAR).toBeGreaterThanOrEqual(
      SANKEY_LEFT_LABEL_INSET
    );
    // The $ amount line keeps the same safe inset from the left edge.
    const amountEl = svg.querySelector('[data-testid="sankey-income-amount"]')!;
    expect(amountEl.getAttribute("text-anchor")).toBe("end");
    const amountX = Number(amountEl.getAttribute("x"));
    const amount = amountEl.textContent ?? "";
    expect(amount).toBe("$2,000.00 · 100%");
    expect(amountX - amount.length * SOURCE_AMOUNT_PX_PER_CHAR).toBeGreaterThanOrEqual(
      SANKEY_LEFT_LABEL_INSET
    );
  });

  it("grows the chart with a minimum row pitch so crowded labels never overlap", () => {
    const targets: SpendingItem[] = Array.from({ length: 60 }, (_, i) => ({
      name: `Merchant ${i + 1}`,
      value: 200000 - i * 1000,
    }));
    // Three even groups so the middle column stays short while the right
    // column carries the long tail.
    const groupSums = [0, 1, 2].map((g) =>
      targets.filter((_, j) => j % 3 === g).reduce((s, t) => s + t.value, 0)
    );
    const crowdedFlow: SpendingGroupFlow = {
      groups: groupSums.map((v, g) => ({ name: `Group ${g + 1}`, value: v })),
      targets,
      links: targets.map((t, j) => ({ groupIndex: j % 3, targetIndex: j, value: t.value })),
    };
    const { container } = render(
      <SpendingReport categoryFlow={emptyFlow} merchantFlow={crowdedFlow} income={[]} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    // Initial load auto-merges to fit the viewport, so all 60 rows are no
    // longer the initial state — drop the slider to Off to restore every
    // row before asserting the pitch geometry.
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    fireEvent.change(slider, { target: { value: "0" } });
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Two-line labels need 32px of vertical pitch each; the SVG grows past
    // the 400px viewport (the container scrolls) instead of crushing rows.
    expect(Number(svg.getAttribute("height"))).toBeGreaterThanOrEqual(60 * 32);
    const ys = Array.from(svg.querySelectorAll('[data-testid="sankey-node"]')).map((n) =>
      Number(n.getAttribute("y"))
    );
    expect(ys).toHaveLength(60);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(32);
    }
    // No income: no ribbons, and every middle and right bar draws in
    // full with no grey shortfall segment (the unfunded state shows in
    // tooltips instead).
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(0);
    expect(svg.querySelectorAll('[data-testid="sankey-shortfall"]')).toHaveLength(0);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-testid="sankey-group-shortfall"]')).toHaveLength(0);
  });

  it("shows empty state when income and spending are both empty", () => {
    renderReport(emptyFlow, emptyFlow, []);
    expect(screen.getByText("No data for this timeframe.")).toBeInTheDocument();
    expect(screen.getByText("0 categories")).toBeInTheDocument();
  });

  it("uses the singular noun for a single item", () => {
    const soloFlow: SpendingGroupFlow = {
      groups: [{ name: "Solo", value: 1000 }],
      targets: [{ name: "Only One", value: 1000 }],
      links: [{ groupIndex: 0, targetIndex: 0, value: 1000 }],
    };
    renderReport(soloFlow, emptyFlow);
    expect(screen.getByText("1 category")).toBeInTheDocument();
  });

  it("displays row count in the header", () => {
    renderReport();
    expect(screen.getByText("3 categories")).toBeInTheDocument();
  });

  it("shows amount, member count, and spending share when hovering a group", () => {
    const { container } = renderReport();
    // Middles run in group order: Bills, then Everyday.
    const group = container.querySelectorAll('[data-testid="sankey-group"]')[0]!;
    fireEvent.mouseMove(group, { clientX: 380, clientY: 100 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Bills")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$1,150.00")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("(57%)")).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("2 categories · 74% of $1,550.00 spending")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(group);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows the over-income gap when hovering a group under a shortfall", () => {
    const { container } = render(
      <SpendingReport
        categoryFlow={sampleCategoryFlow}
        merchantFlow={sampleMerchantFlow}
        income={[{ name: "Payroll", value: 100000 }]}
      />
    );
    const group = container.querySelectorAll('[data-testid="sankey-group"]')[1]!;
    fireEvent.mouseMove(group, { clientX: 380, clientY: 200 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Everyday")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Over income")).toBeInTheDocument();
    // No explainer lines: the Over-income amount carries the gap.
    expect(
      within(tip as unknown as HTMLElement).queryByText(
        "Spending exceeded income by $550.00 — covered from savings or debt"
      )
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(group);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows merged-group detail when hovering the middle Other bucket", () => {
    const { container } = renderReport();
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    // $500 threshold folds Everyday ($400) into the middle Other bucket.
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });
    const otherGroup = container.querySelectorAll('[data-testid="sankey-group"]')[1]!;
    fireEvent.mouseMove(otherGroup, { clientX: 380, clientY: 250 });
    expect(screen.getByText("1 smaller group under $500.00")).toBeInTheDocument();
    fireEvent.mouseLeave(otherGroup);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("uses singular nouns when an Other bucket holds a single row", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 10000 },
    ]);
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    // $200 threshold: Electric Bill ($150) folds on the right, Bonus ($100)
    // folds on the left; groups all stay.
    fireEvent.change(slider, { target: { value: stepFor(2000, 200) } });
    expect(screen.getByText("(2 in Other)")).toBeInTheDocument();
    const otherIncome = container.querySelectorAll('[data-testid="sankey-income"]')[1]!;
    fireEvent.mouseMove(otherIncome, { clientX: 100, clientY: 300 });
    expect(screen.getByText("1 smaller income under $200.00")).toBeInTheDocument();
    fireEvent.mouseLeave(otherIncome);
    const nodes = container.querySelectorAll('[data-testid="sankey-node"]');
    const otherNode = nodes[nodes.length - 2]!;
    fireEvent.mouseMove(otherNode, { clientX: 600, clientY: 200 });
    expect(screen.getByText("1 smaller category under $200.00")).toBeInTheDocument();
    fireEvent.mouseLeave(otherNode);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("dims ribbons and bars outside the hovered group's flow path", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const group = svg.querySelectorAll('[data-testid="sankey-group"]')[0]!;
    fireEvent.mouseMove(group, { clientX: 380, clientY: 100 });
    const links = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]'));
    // Bills feeds two of the three right ribbons: those brighten and render
    // above the dimmed Everyday ribbon (dimmed first in the DOM).
    expect(links[3]!.getAttribute("fill-opacity")).toBe("0.12");
    expect(links[4]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(links[5]!.getAttribute("fill-opacity")).toBe("0.85");
    // The hovered group brightens with its path; the off-path sibling
    // dims; the connected targets stay lit.
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[0]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.12");
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    expect(nodes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    expect(nodes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    fireEvent.mouseLeave(group);
  });

  it("shows a tooltip with amount and share when hovering a bar in Bars view", () => {
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    const row = container.querySelectorAll(".y-bar-track")[0]!.parentElement!;
    fireEvent.mouseMove(row, { clientX: 400, clientY: 200 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Mortgage Interest")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$1,000.00")).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("highlights the hovered Bars row and names its parent group in the tooltip", () => {
    // The old Bars tooltip restated the row (amount + share, both already
    // visible) plus the header total — no new information. It now carries
    // what the row cannot show: the category's parent group.
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    const tracks = container.querySelectorAll(".y-bar-track");
    const row = tracks[0]!.parentElement!;
    const sibling = tracks[1]!.parentElement!;
    expect(row).toHaveStyle({ background: "transparent" });
    fireEvent.mouseMove(row, { clientX: 400, clientY: 200 });
    // The hovered row highlights; its siblings do not.
    expect(row).toHaveStyle({ background: "var(--y-row-sel)" });
    expect(sibling).toHaveStyle({ background: "transparent" });
    const tip = within(document.querySelector(".y-tip")! as unknown as HTMLElement);
    expect(tip.getByText("Mortgage Interest")).toBeInTheDocument();
    expect(tip.getByText("$1,000.00")).toBeInTheDocument();
    expect(tip.getByText("65% of $1,550.00 spending · in Bills")).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    expect(document.querySelector(".y-tip")).toBeNull();
    expect(row).toHaveStyle({ background: "transparent" });
  });

  it("shows the group split when hovering a Bars merchant spanning groups", () => {
    const splitMerchantFlow: SpendingGroupFlow = {
      groups: [
        { name: "Bills", value: 30000 },
        { name: "Everyday", value: 20000 },
      ],
      targets: [{ name: "Amazon", value: 50000 }],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 30000 },
        { groupIndex: 1, targetIndex: 0, value: 20000 },
      ],
    };
    const { container } = renderReport(sampleCategoryFlow, splitMerchantFlow);
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    const row = container.querySelectorAll(".y-bar-track")[0]!.parentElement!;
    fireEvent.mouseMove(row, { clientX: 400, clientY: 200 });
    const tip = within(document.querySelector(".y-tip")! as unknown as HTMLElement);
    expect(tip.getByText("Amazon")).toBeInTheDocument();
    expect(
      tip.getByText("100% of $500.00 spending · across 2 groups")
    ).toBeInTheDocument();
    // One factual line per group, largest first: name, amount, share.
    expect(tip.getByText("Bills")).toBeInTheDocument();
    expect(tip.getByText("$300.00")).toBeInTheDocument();
    expect(tip.getByText("(60%)")).toBeInTheDocument();
    expect(tip.getByText("Everyday")).toBeInTheDocument();
    expect(tip.getByText("$200.00")).toBeInTheDocument();
    expect(tip.getByText("(40%)")).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("keeps the Bars Other-bucket tooltip useful under the threshold", () => {
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });
    // Mortgage Interest + the merged Other bucket.
    const row = container.querySelectorAll(".y-bar-track")[1]!.parentElement!;
    fireEvent.mouseMove(row, { clientX: 400, clientY: 240 });
    const tip = within(document.querySelector(".y-tip")! as unknown as HTMLElement);
    expect(tip.getByText("Other")).toBeInTheDocument();
    expect(tip.getByText("$550.00")).toBeInTheDocument();
    expect(tip.getByText("2 smaller categories under $500.00")).toBeInTheDocument();
    expect(
      tip.getByText("Render-only — grouped by the Under threshold")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("lands a direct Bars row-to-row switch in one commit without blinking the tooltip off", () => {
    // Bars leaves ride the same rAF throttle as the moves (never a
    // synchronous clear): leave(A)+move(B) commits once, carrying B.
    const queue: FrameRequestCallback[] = [];
    const syncRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    };
    try {
      const { container } = renderReport();
      fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
      const tracks = container.querySelectorAll(".y-bar-track");
      const rowA = tracks[0]!.parentElement!;
      const rowB = tracks[1]!.parentElement!;
      fireEvent.mouseMove(rowA, { clientX: 400, clientY: 200 });
      act(() => {
        queue.splice(0).forEach((cb) => cb(0));
      });
      const tipOf = () =>
        within(document.querySelector(".y-tip")! as unknown as HTMLElement);
      expect(tipOf().getByText("Mortgage Interest")).toBeInTheDocument();
      fireEvent.mouseLeave(rowA);
      fireEvent.mouseMove(rowB, { clientX: 400, clientY: 240 });
      // Nothing commits before the frame boundary — the old tooltip stays
      // up instead of flashing to null in between.
      expect(tipOf().getByText("Mortgage Interest")).toBeInTheDocument();
      act(() => {
        queue.splice(0).forEach((cb) => cb(0));
      });
      expect(tipOf().getByText("Groceries")).toBeInTheDocument();
    } finally {
      globalThis.requestAnimationFrame = syncRaf;
    }
  });

  it("paints Bars rows in their own stable colors", () => {
    // Each row keeps its own full-brightness stable color — the same color
    // its Sankey bar carries, so the two views agree row for row.
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    const swatches = container.querySelectorAll("span.h-3.w-3");
    expect(swatches).toHaveLength(3);
    ["Mortgage Interest", "Groceries", "Electric Bill"].forEach((name, i) => {
      expect(swatches[i]).toHaveStyle({ background: colorForName(name) });
    });
  });

  it("renders a literal Other row beside the merged Other bucket with no duplicate key warning", () => {
    // Task-35 regression: Bars rows were keyed by name alone, so a literal
    // "Other" category beside the merged "Other" bucket produced two
    // children with the same key — React duplicated/omitted rows and logged
    // a console error. Rows are keyed by position now, so both render.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const targets: SpendingItem[] = [
        { name: "Big", value: 100000 },
        { name: "Other", value: 60000 },
        { name: "Small A", value: 5000 },
        { name: "Small B", value: 4000 },
      ];
      const categoryFlow: SpendingGroupFlow = {
        groups: [{ name: "Stuff", value: 169000 }],
        targets,
        links: targets.map((t, i) => ({ groupIndex: 0, targetIndex: i, value: t.value })),
      };
      const { container } = render(
        <SpendingReport
          categoryFlow={categoryFlow}
          merchantFlow={{ groups: [], targets: [], links: [] }}
          income={[{ name: "Payroll", value: 200000 }]}
          initialView="bars"
        />
      );
      // $500 threshold: Small A + Small B merge into the bucket while the
      // literal "Other" ($600) stays its own row — two rows named "Other".
      const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
      fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });
      expect(screen.getAllByText("Other")).toHaveLength(2);
      expect(screen.getByText("(2 merged)")).toBeInTheDocument();
      expect(container.querySelectorAll(".y-bar-track")).toHaveLength(3);
      // No duplicate-key warning (or any other React error) was logged.
      expect(
        errSpy.mock.calls.filter(([msg]) => String(msg).includes("same key"))
      ).toHaveLength(0);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("coalesces rapid hover updates into one commit per animation frame", () => {
    // Mousemove fires far more often than the display refreshes; committing
    // a full multi-hundred-element chart re-render per event drops frames
    // and restarts every ribbon's opacity transition mid-flight — visible
    // jitter. Hover commits coalesce to at most one per frame (latest wins),
    // like the other reports.
    const queue: FrameRequestCallback[] = [];
    const syncRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    };
    try {
      const { container } = renderReport();
      const svg = container.querySelector('[data-testid="sankey-svg"]')!;
      const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
      fireEvent.mouseMove(nodes[0]!, { clientX: 600, clientY: 100 });
      fireEvent.mouseMove(nodes[1]!, { clientX: 600, clientY: 140 });
      fireEvent.mouseMove(nodes[2]!, { clientX: 600, clientY: 180 });
      // Nothing commits before the frame boundary.
      expect(document.querySelector(".y-tip")).toBeNull();
      act(() => {
        queue.splice(0).forEach((cb) => cb(0));
      });
      // Exactly one commit, carrying the latest hover.
      const tip = document.querySelector(".y-tip")!;
      expect(tip).toBeInTheDocument();
      expect(
        within(tip as unknown as HTMLElement).getByText("Electric Bill")
      ).toBeInTheDocument();
    } finally {
      globalThis.requestAnimationFrame = syncRaf;
    }
  });

  it("shows node tooltips when hovering labels, not just bars", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Income label.
    const incomeLabel = svg.querySelector('[data-testid="sankey-income-label"]')!;
    fireEvent.mouseMove(incomeLabel, { clientX: 100, clientY: 200 });
    expect(
      within(document.querySelector(".y-tip")! as unknown as HTMLElement).getByText(
        "100% of $2,000.00 income"
      )
    ).toBeInTheDocument();
    fireEvent.mouseLeave(incomeLabel);
    expect(document.querySelector(".y-tip")).toBeNull();
    // Middle label.
    const groupLabel = svg.querySelectorAll('[data-testid="sankey-group-label"]')[0]!;
    fireEvent.mouseMove(groupLabel, { clientX: 380, clientY: 100 });
    expect(
      within(document.querySelector(".y-tip")! as unknown as HTMLElement).getByText("Bills")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(groupLabel);
    expect(document.querySelector(".y-tip")).toBeNull();
    // Target label.
    const targetLabel = svg.querySelectorAll('[data-testid="sankey-target-label"]')[1]!;
    fireEvent.mouseMove(targetLabel, { clientX: 600, clientY: 200 });
    expect(
      within(document.querySelector(".y-tip")! as unknown as HTMLElement).getByText("Groceries")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(targetLabel);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("labels each column as plain text with no hover tooltip", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const heads = svg.querySelectorAll('[data-testid="sankey-colhead"]');
    expect(heads).toHaveLength(3);
    expect(Array.from(heads).map((h) => h.textContent)).toEqual([
      "INCOME",
      "GROUPS",
      "CATEGORIES",
    ]);
    // Headers are plain labels: hovering one shows no tooltip and leaves
    // the chart untouched.
    const incomeHead = svg.querySelector('[data-testid="sankey-colhead"][data-col="income"]')!;
    fireEvent.mouseMove(incomeHead, { clientX: 160, clientY: 20 });
    expect(document.querySelector(".y-tip")).toBeNull();
    for (const bar of svg.querySelectorAll('[data-testid="sankey-node"]')) {
      expect(bar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
    }
    // The right header follows the dimension toggle.
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    expect(
      svg.querySelector('[data-testid="sankey-colhead"][data-col="target"]')!.textContent
    ).toBe("MERCHANTS");
  });

  it("shows no transfer-money lines on either side of the chart", () => {
    // Flow-through attribution traces money through off-budget accounts
    // instead of counting either transfer leg, so no row carries a
    // transfer flag and no tooltip mentions moved money.
    const flow: SpendingGroupFlow = {
      groups: [{ name: "Bills", value: 100000 }],
      targets: [
        { name: "Mortgage Interest", value: 70000 },
        { name: "Brokerage", value: 30000 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 70000 },
        { groupIndex: 0, targetIndex: 1, value: 30000 },
      ],
    };
    const { container } = renderReport(flow, emptyFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Dividends", value: 50000 },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    fireEvent.mouseMove(incomes[1]!, { clientX: 100, clientY: 300 });
    expect(
      screen.queryByText("Includes withdrawals from off-budget accounts")
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(incomes[1]!);
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    fireEvent.mouseMove(nodes[1]!, { clientX: 600, clientY: 200 });
    expect(
      screen.queryByText("Includes money moved to off-budget accounts")
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(nodes[1]!);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("explains the Uncategorized pseudo-group as spending with no category", () => {
    const merchantFlow: SpendingGroupFlow = {
      groups: [
        { name: "Everyday", value: 40000 },
        { name: "Uncategorized", value: 15000 },
      ],
      targets: [
        { name: "Whole Foods", value: 40000 },
        { name: "Corner Shop", value: 15000 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 40000 },
        { groupIndex: 1, targetIndex: 1, value: 15000 },
      ],
    };
    const { container } = renderReport(sampleCategoryFlow, merchantFlow, sampleIncome);
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    fireEvent.mouseMove(groups[1]!, { clientX: 380, clientY: 250 });
    const tip = document.querySelector(".y-tip")!;
    expect(
      within(tip as unknown as HTMLElement).getByText("Spending with no category set")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(groups[1]!);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("renders no How-to-read explainer in the Sankey header", () => {
    renderReport();
    // The explainer was removed entirely: no hint text, no button, no
    // tooltip content.
    expect(screen.queryByTestId("sankey-how-to-read")).not.toBeInTheDocument();
    expect(screen.queryByText(/how to read/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /how to read/i })).not.toBeInTheDocument();
  });

  it("draws every Sankey bar and hatch with square corners", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Rectangular nodes take no rounding: bars, bucket hatches, and the
    // income gradients all paint square.
    const rects = svg.querySelectorAll(
      '[data-testid="sankey-income"], [data-testid="sankey-group"], ' +
        '[data-testid="sankey-node"], [data-testid="sankey-bucket-hatch"]'
    );
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      expect(rect.getAttribute("rx")).toBeNull();
      expect(rect.getAttribute("ry")).toBeNull();
    }
  });

  it("matches each right-column bar to its incoming ribbons in every spotlight state", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // At rest every node shares its ribbons' fill at the shared rest step.
    const restLinks = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(restLinks.length).toBeGreaterThan(0);
    for (const link of restLinks) {
      expect(link.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
    }
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    // Bills→Mortgage is links[0]: same fill and opacity as the Mortgage bar.
    expect(restLinks[0]!.getAttribute("fill")).toBe(nodes[0]!.getAttribute("fill"));
    expect(restLinks[0]!.getAttribute("fill-opacity")).toBe(
      nodes[0]!.getAttribute("fill-opacity")
    );
    // Hovering the Groceries cell keeps the match at the bright step for
    // the on-path pair and at the dim step for the off-path pair.
    fireEvent.mouseMove(restLinks[2]!, { clientX: 500, clientY: 200 });
    expect(nodes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    expect(restLinks[2]!.getAttribute("fill-opacity")).toBe(
      nodes[1]!.getAttribute("fill-opacity")
    );
    expect(nodes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    expect(restLinks[0]!.getAttribute("fill-opacity")).toBe(
      nodes[0]!.getAttribute("fill-opacity")
    );
    fireEvent.mouseLeave(restLinks[2]!);
    expect(nodes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
  });

  it("renders rest ribbons nearly as solid as hover, with a clearly dimmer off-path step", () => {
    // Rest sits one small step below hover so the chart reads solid at a
    // glance while the spotlight still brightens; the dim step stays far
    // below rest so the off-path wash never passes for the resting chart.
    expect(SANKEY_RIBBON_OPACITY).toBeLessThan(SANKEY_RIBBON_HOVER_OPACITY);
    expect(SANKEY_RIBBON_HOVER_OPACITY - SANKEY_RIBBON_OPACITY).toBeLessThanOrEqual(0.15);
    expect(SANKEY_RIBBON_DIM_OPACITY).toBeLessThan(SANKEY_RIBBON_OPACITY / 2);
  });

  it("pins the chart scroll container so scrollbars can never shift the geometry", () => {
    // The SVG is sized exactly to the container's client box, so a
    // horizontal scrollbar is never legitimate — but fractionally-wide flex
    // boxes round clientWidth up, squeezing out a stray one that steals
    // vertical space and re-flows the whole chart. And a vertical scrollbar
    // appearing mid-session (threshold slider, new data) must not step the
    // width. Horizontal overflow is clipped and the gutter is reserved, so
    // the first paint is already the final geometry.
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const scroller = svg.parentElement!;
    expect(scroller.className).toMatch(/\boverflow-x-hidden\b/);
    expect(scroller.className).toMatch(/\boverflow-y-auto\b/);
    expect(scroller.style.scrollbarGutter).toBe("stable");
  });

  it("auto-raises the Under threshold on load so the Sankey fits the viewport", () => {
    // Thirty $5..$150 categories in two groups with a $10,000 income: at
    // most 10 rows fit the mocked 400px viewport, so the initial load
    // merges up to the smallest fitting stop ($150) instead of starting
    // with amounts under the fold.
    const targets: SpendingItem[] = Array.from({ length: 30 }, (_, i) => ({
      name: `Category ${i + 1}`,
      value: (i + 1) * 500,
    }));
    const groupSums = [0, 1].map((g) =>
      targets.filter((_, j) => j % 2 === g).reduce((s, t) => s + t.value, 0)
    );
    const categoryFlow: SpendingGroupFlow = {
      groups: groupSums.map((v, g) => ({ name: `Group ${g + 1}`, value: v })),
      targets,
      links: targets.map((t, j) => ({ groupIndex: j % 2, targetIndex: j, value: t.value })),
    };
    const { container } = render(
      <SpendingReport
        categoryFlow={categoryFlow}
        merchantFlow={sampleMerchantFlow}
        income={[{ name: "Payroll", value: 1000000 }]}
      />
    );
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    expect(slider.getAttribute("aria-valuetext")).toBe("$150.00");
    // The merged chart needs no scrolling: the SVG is exactly the viewport.
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    expect(svg.getAttribute("height")).toBe("400");
  });

  it("leaves the Under threshold off when every row already fits", () => {
    renderReport();
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    expect(slider.getAttribute("aria-valuetext")).toBe("Off");
  });

  it("keeps a stored threshold that already fits the viewport", () => {
    window.localStorage.setItem("ynab:reports:spendingThreshold", "500");
    renderReport();
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    expect(slider.getAttribute("aria-valuetext")).toBe("$500.00");
  });

  it("auto-fits once per session and never overrides the user's slider", () => {
    const targets: SpendingItem[] = Array.from({ length: 30 }, (_, i) => ({
      name: `Category ${i + 1}`,
      value: (i + 1) * 500,
    }));
    const groups = [{ name: "Group", value: targets.reduce((s, t) => s + t.value, 0) }];
    const categoryFlow: SpendingGroupFlow = {
      groups,
      targets,
      links: targets.map((t, j) => ({ groupIndex: 0, targetIndex: j, value: t.value })),
    };
    const income = [{ name: "Payroll", value: 1000000 }];
    const first = render(
      <SpendingReport categoryFlow={categoryFlow} merchantFlow={emptyFlow} income={income} />
    );
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    expect(slider.getAttribute("aria-valuetext")).toBe("$150.00");
    // The user opts back into full detail; a remount (report tab switch)
    // must keep that choice instead of re-fitting.
    fireEvent.change(slider, { target: { value: "0" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("Off");
    first.unmount();
    const second = render(
      <SpendingReport categoryFlow={categoryFlow} merchantFlow={emptyFlow} income={income} />
    );
    expect(
      screen.getByRole("slider", { name: /merge smaller groups/i }).getAttribute("aria-valuetext")
    ).toBe("Off");
    const svg = second.container.querySelector('[data-testid="sankey-svg"]')!;
    expect(Number(svg.getAttribute("height"))).toBeGreaterThan(400);
  });

  it("keeps a hovered category/merchant bar's geometry identical — no stroke, only brightness", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const node = svg.querySelectorAll('[data-testid="sankey-node"]')[0]!;
    // No border at rest.
    expect(node.getAttribute("stroke")).toBe("none");
    expect(node.getAttribute("stroke-width")).toBeNull();
    const rest = {
      x: node.getAttribute("x"),
      y: node.getAttribute("y"),
      width: node.getAttribute("width"),
      height: node.getAttribute("height"),
    };
    fireEvent.mouseMove(node, { clientX: 600, clientY: 100 });
    // Hovered: still no stroke of any kind — an SVG stroke centers on the
    // edge, so even a same-color stroke would paint 1px outside the bar and
    // make it look bigger than the ribbon stack feeding it. Geometry stays
    // pixel-identical; brightness carries the highlight instead.
    expect(node.getAttribute("stroke")).toBe("none");
    expect(node.getAttribute("stroke-width")).toBeNull();
    expect(node.getAttribute("stroke-opacity")).toBeNull();
    expect({
      x: node.getAttribute("x"),
      y: node.getAttribute("y"),
      width: node.getAttribute("width"),
      height: node.getAttribute("height"),
    }).toEqual(rest);
    expect(node.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    fireEvent.mouseLeave(node);
    expect(node.getAttribute("stroke")).toBe("none");
    expect(node.getAttribute("stroke-width")).toBeNull();
    expect(node.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
  });

  it("keeps a ribbon's endpoint node strokeless with identical geometry while hovered", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Right ribbons trail the left ones: Bills→Mortgage is links[3].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[3]!;
    expect(link.getAttribute("data-side")).toBe("right");
    const node = svg.querySelectorAll('[data-testid="sankey-node"]')[0]!;
    const rest = {
      x: node.getAttribute("x"),
      y: node.getAttribute("y"),
      width: node.getAttribute("width"),
      height: node.getAttribute("height"),
    };
    fireEvent.mouseMove(link, { clientX: 500, clientY: 120 });
    expect(node.getAttribute("stroke")).toBe("none");
    expect(node.getAttribute("stroke-width")).toBeNull();
    expect(node.getAttribute("stroke-opacity")).toBeNull();
    expect({
      x: node.getAttribute("x"),
      y: node.getAttribute("y"),
      width: node.getAttribute("width"),
      height: node.getAttribute("height"),
    }).toEqual(rest);
    expect(node.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    fireEvent.mouseLeave(link);
    expect(node.getAttribute("stroke")).toBe("none");
    expect(node.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
  });

  it("highlights the parent group in the same bright color when hovering a ribbon", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Everyday→Groceries trails the right ribbons (links[5]).
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[5]!;
    expect(link.getAttribute("data-side")).toBe("right");
    fireEvent.mouseMove(link, { clientX: 500, clientY: 200 });
    // The parent group brightens to the spotlight level — the same
    // brightness as its lit ribbon, in its own hue — while Bills dims.
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[1]!.getAttribute("fill")).toBe(colorForName("Everyday"));
    expect(groups[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    expect(groups[0]!.getAttribute("fill-opacity")).toBe("0.12");
    const litRibbon = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    ).find((l) => l.getAttribute("fill-opacity") === String(SANKEY_RIBBON_HOVER_OPACITY))!;
    expect(litRibbon.getAttribute("fill-opacity")).toBe(
      groups[1]!.getAttribute("fill-opacity")
    );
    fireEvent.mouseLeave(link);
    // A left ribbon lights its middle the same way: Payroll→Bills.
    const leftLink = container.querySelectorAll('[data-testid="sankey-link"]')[0]!;
    expect(leftLink.getAttribute("data-side")).toBe("left");
    fireEvent.mouseMove(leftLink, { clientX: 300, clientY: 100 });
    const regrouped = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(regrouped[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    expect(regrouped[1]!.getAttribute("fill-opacity")).toBe("0.12");
    fireEvent.mouseLeave(leftLink);
  });

  it("stacks each income bar's outgoing ribbon colors into its gradient at rest, with no overlay", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const bar = svg.querySelector('[data-testid="sankey-income"]')!;
    // The gradient is the bar's fill from the first paint — no hover
    // overlay, no translucent glass on top of gray.
    expect(bar.getAttribute("fill")).toBe(`url(#${SANKEY_INCOME_GRADIENT_ID_PREFIX}0)`);
    expect(svg.querySelector('[data-testid="sankey-income-hover"]')).toBeNull();
    // No border on the bar, hovered or not.
    expect(bar.getAttribute("stroke")).toBe("none");
    expect(bar.getAttribute("stroke-width")).toBeNull();
    // Payroll's three outgoing bands run Bills, Everyday, Remaining: the
    // gradient stacks those destination colors top-to-bottom with hard
    // edges on the ribbon boundaries — two stops per band, sharing the
    // boundary offsets — so each bar segment matches its ribbon exactly.
    const stops = Array.from(
      svg.querySelectorAll(`#${SANKEY_INCOME_GRADIENT_ID_PREFIX}0 stop`)
    ).map((s) => ({
      offset: Number(s.getAttribute("offset")),
      color: s.getAttribute("stop-color"),
    }));
    expect(stops).toHaveLength(6);
    expect(stops[0]).toEqual({ offset: 0, color: colorForName("Bills") });
    expect(stops[stops.length - 1]).toEqual({ offset: 1, color: REMAINING_COLOR });
    expect(stops.some((s) => s.color === colorForName("Everyday"))).toBe(true);
    const colorOrder = stops.map((s) => s.color);
    expect(colorOrder.indexOf(colorForName("Bills"))).toBeLessThan(
      colorOrder.indexOf(colorForName("Everyday"))
    );
    expect(colorOrder.indexOf(colorForName("Everyday"))).toBeLessThan(
      colorOrder.lastIndexOf(REMAINING_COLOR)
    );
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]!.offset).toBeGreaterThanOrEqual(stops[i - 1]!.offset);
    }
    // The shared boundary offsets are the hard edges between bands.
    expect(stops[1]!.offset).toBe(stops[2]!.offset);
    expect(stops[1]!.color).not.toBe(stops[2]!.color);
    expect(stops[3]!.offset).toBe(stops[4]!.offset);
    expect(stops[3]!.color).not.toBe(stops[4]!.color);
    // Hovering brightens the bar through the spotlight steps without
    // swapping its fill: gradient in, gradient out.
    expect(bar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
    fireEvent.mouseMove(bar, { clientX: 100, clientY: 200 });
    expect(bar.getAttribute("fill")).toBe(`url(#${SANKEY_INCOME_GRADIENT_ID_PREFIX}0)`);
    expect(bar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    expect(bar.getAttribute("stroke")).toBe("none");
    expect(svg.querySelector('[data-testid="sankey-income-hover"]')).toBeNull();
    fireEvent.mouseLeave(bar);
    expect(bar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
  });

  it("sizes shortfall bars to their funded flow with a legible minimum", () => {
    // $1,000 in over $1,550 out: ~65% coverage, no Remaining.
    const { container } = render(
      <SpendingReport
        categoryFlow={sampleCategoryFlow}
        merchantFlow={sampleMerchantFlow}
        income={[{ name: "Payroll", value: 100000 }]}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // The 328px band splits by funded share of the $1,550 flow — not by
    // full value — with the tiniest row floored at the 24px label minimum.
    const coverage = 100000 / 155000;
    const heights = Array.from(svg.querySelectorAll('[data-testid="sankey-node"]')).map(
      (n) => Number(n.getAttribute("height"))
    );
    expect(heights).toHaveLength(3);
    expect(heights[0]).toBeCloseTo(((100000 * coverage) / 155000) * 328, 6);
    expect(heights[1]).toBeCloseTo(((40000 * coverage) / 155000) * 328, 6);
    expect(heights[2]).toBe(24);
    // Middle bars wrap their funded bands the same way: Bills stacks the
    // Mortgage and Electric bands, Everyday matches Groceries.
    const midHeights = Array.from(svg.querySelectorAll('[data-testid="sankey-group"]')).map(
      (g) => Number(g.getAttribute("height"))
    );
    expect(midHeights[0]).toBeCloseTo(heights[0]! + 24, 6);
    expect(midHeights[1]).toBeCloseTo(heights[1]!, 6);
  });

  it("sorts the Sankey columns by parent group in Budget order or by amount", () => {
    // Amount order puts Bills ($1,150) before Everyday ($400); the Budget
    // order passed in reverses them.
    const { container } = renderReport(
      sampleCategoryFlow,
      sampleMerchantFlow,
      sampleIncome,
      ["Everyday", "Bills"]
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const targetLabels = () =>
      Array.from(svg.querySelectorAll('[data-testid="sankey-target-label"]')).map(
        (t) => t.textContent
      );
    const groupLabels = () =>
      Array.from(svg.querySelectorAll('[data-testid="sankey-group-label"]')).map(
        (t) => t.textContent
      );
    // Amount mode is the default: value-descending on both columns.
    expect(targetLabels()).toEqual(["Mortgage Interest", "Groceries", "Electric Bill", "Remaining"]);
    expect(groupLabels()).toEqual(["Bills", "Everyday"]);

    fireEvent.click(screen.getByRole("button", { name: "Group", exact: true }));
    // Group mode: Everyday's Groceries first, then the Bills family by
    // amount; the Remaining plug still trails; middles follow Budget order.
    expect(targetLabels()).toEqual(["Groceries", "Mortgage Interest", "Electric Bill", "Remaining"]);
    expect(groupLabels()).toEqual(["Everyday", "Bills"]);
    expect(screen.getByText("3 categories")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Amount", exact: true }));
    expect(targetLabels()).toEqual(["Mortgage Interest", "Groceries", "Electric Bill", "Remaining"]);
    expect(groupLabels()).toEqual(["Bills", "Everyday"]);
  });

  it("orders categories within their parent group by Budget category order in Group mode", () => {
    // Electric Bill ($150) trails Mortgage Interest ($1,000) by amount,
    // but Budget order lists it first inside Bills.
    const { container } = renderReport(
      sampleCategoryFlow,
      sampleMerchantFlow,
      sampleIncome,
      ["Bills", "Everyday"],
      ["Electric Bill", "Mortgage Interest", "Groceries"]
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const targetLabels = () =>
      Array.from(svg.querySelectorAll('[data-testid="sankey-target-label"]')).map(
        (t) => t.textContent
      );
    // Amount mode ignores Budget order.
    expect(targetLabels()).toEqual(["Mortgage Interest", "Groceries", "Electric Bill", "Remaining"]);
    fireEvent.click(screen.getByRole("button", { name: "Group", exact: true }));
    // Group mode follows it: Electric Bill leads the Bills family, the
    // Remaining plug still trails.
    expect(targetLabels()).toEqual(["Electric Bill", "Mortgage Interest", "Groceries", "Remaining"]);
    fireEvent.click(screen.getByRole("button", { name: "Amount", exact: true }));
    expect(targetLabels()).toEqual(["Mortgage Interest", "Groceries", "Electric Bill", "Remaining"]);
  });

  it("shows the sort control only in the Sankey view", () => {
    renderReport();
    expect(screen.getByRole("button", { name: "Amount", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Group", exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    // Bars always stay by amount, so the control hides with the Sankey.
    expect(screen.queryByRole("button", { name: "Amount", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Group", exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sankey", exact: true }));
    expect(screen.getByRole("button", { name: "Group", exact: true })).toBeInTheDocument();
  });

  it("stacks Bars rows gaplessly and scrolls naturally on overflow", () => {
    // Task-32/36: rows stack directly one after another at a fixed natural
    // height — each row's bottom edge touches the next row's top edge — and
    // a long list scrolls instead of compressing, stretching, shrinking, or
    // truncating. jsdom performs no layout, so this pins the class contract
    // the geometry derives from (no inter-row gap/space utilities on the
    // list, no vertical margins on the rows, and no flex stretching to fill
    // the viewport — consecutive rows' offsets then differ by exactly one
    // row height in the browser) plus the scroller's overflow behavior.
    const checkGapless = (container: HTMLElement, rowCount: number) => {
      const tracks = container.querySelectorAll(".y-bar-track");
      expect(tracks).toHaveLength(rowCount);
      const rows = Array.from(tracks, (t) => t.parentElement!);
      const list = rows[0]!.parentElement!;
      expect(list.className).not.toMatch(/gap-|space-/);
      // No viewport-fill stretching: the list is a plain block container
      // (never a h-full flex column centering stretched rows).
      expect(list.className).not.toMatch(/(^|\s)flex($|\s)/);
      expect(list.className).not.toMatch(/h-full|justify-center/);
      for (const row of rows) {
        expect(row.className).not.toMatch(/(^|\s)m[xytrbl]?-/);
        // Fixed natural row height: rows never grow to fill free space.
        expect(row.className).not.toMatch(/flex-1|min-h-/);
      }
      const scroller = list.parentElement!;
      expect(scroller.className).toMatch(/overflow-y-auto/);
      expect(scroller.className).not.toMatch(/overflow-y-(hidden|clip)/);
    };
    // Few rows: short lists sit at the top at the same fixed row height.
    const few = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    checkGapless(few.container, 3);
    few.unmount();
    // Many rows: the overflowing list scrolls instead of compressing.
    const targets: SpendingItem[] = Array.from({ length: 16 }, (_, i) => ({
      name: `Category ${i}`,
      value: (16 - i) * 1000,
    }));
    const manyFlow: SpendingGroupFlow = {
      groups: [{ name: "Group", value: targets.reduce((s, t) => s + t.value, 0) }],
      targets,
      links: targets.map((t, i) => ({ groupIndex: 0, targetIndex: i, value: t.value })),
    };
    const many = renderReport(manyFlow, emptyFlow, sampleIncome);
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    checkGapless(many.container, 16);
  });

  it("paints Bars Other buckets with the shared Sankey hatch in rest and hover", () => {
    // Task-34: the merged Other bucket bar reuses the Sankey's exact hatch
    // pattern def (same id, same geometry — not a lookalike), so the two
    // views cannot drift. The row hover highlight paints behind the bar, so
    // the hatch reads in rest and hover alike; normal rows carry no hatch.
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    const slider = screen.getByRole("slider", { name: /merge smaller groups/i });
    fireEvent.change(slider, { target: { value: stepFor(2000, 500) } });
    // Mortgage Interest + the merged Other bucket.
    const tracks = container.querySelectorAll(".y-bar-track");
    expect(tracks).toHaveLength(2);
    // Exactly one hatch overlay: on the bucket bar, none on the normal row.
    expect(container.querySelectorAll('[data-testid="bars-bucket-hatch"]')).toHaveLength(1);
    expect(tracks[0]!.querySelector('[data-testid="bars-bucket-hatch"]')).toBeNull();
    const overlay = tracks[1]!.querySelector('[data-testid="bars-bucket-hatch"]')!;
    expect(overlay.querySelector("rect")!.getAttribute("fill")).toBe(
      `url(#${SANKEY_BUCKET_HATCH_ID})`
    );
    // The shared def is the Sankey's exact pattern: same spacing, angle,
    // line color, and line width.
    const def = container.querySelector(`#${SANKEY_BUCKET_HATCH_ID}`)!;
    expect(def.tagName).toBe("pattern");
    expect(def.getAttribute("width")).toBe("6");
    expect(def.getAttribute("height")).toBe("6");
    expect(def.getAttribute("patternTransform")).toBe("rotate(45)");
    const line = def.querySelector("line")!;
    expect(line.getAttribute("stroke")).toBe("rgba(255,255,255,0.65)");
    expect(line.getAttribute("stroke-width")).toBe("1.6");
    // Hovering the bucket row keeps the hatch painted above the highlight.
    const row = tracks[1]!.parentElement!;
    fireEvent.mouseMove(row, { clientX: 400, clientY: 240 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    expect(row.style.background).toBe("var(--y-row-sel)");
    const overlayAfter = tracks[1]!.querySelector('[data-testid="bars-bucket-hatch"]')!;
    expect(overlayAfter.querySelector("rect")!.getAttribute("fill")).toBe(
      `url(#${SANKEY_BUCKET_HATCH_ID})`
    );
    fireEvent.mouseLeave(row);
    expect(document.querySelector(".y-tip")).toBeNull();
    expect(tracks[1]!.querySelector('[data-testid="bars-bucket-hatch"]')).not.toBeNull();
  });
});
