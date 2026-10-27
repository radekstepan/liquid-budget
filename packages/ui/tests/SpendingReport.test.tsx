import { describe, expect, it, beforeAll } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import {
  SANKEY_LEFT_LABEL_INSET,
  sankeyThresholdStops,
  type SpendingGroupFlow,
} from "@ynab/logic";
import {
  SpendingReport,
  sankeyRibbonGradientId,
  SOURCE_AMOUNT_PX_PER_CHAR,
  SOURCE_NAME_PX_PER_CHAR,
  type SpendingItem,
} from "../src/SpendingReport.js";
import { colorForName, sankeyRibbonShade } from "../src/chartUtils.js";

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
  income: SpendingItem[] = sampleIncome
) {
  return render(
    <SpendingReport categoryFlow={categoryFlow} merchantFlow={merchantFlow} income={income} />
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
      // Light halo so the text stays readable over the ribbons.
      expect(label.getAttribute("paint-order")).toBe("stroke");
      expect(label.getAttribute("stroke")).toBe("rgba(255,255,255,0.9)");
    }
  });

  it("colors nodes by stable name hash, not by rank", () => {
    const { container, rerender } = renderReport();
    const fillsBefore = Array.from(
      container.querySelectorAll('[data-testid="sankey-node"]')
    ).map((n) => n.getAttribute("fill"));
    expect(fillsBefore[0]).toBe(colorForName("Mortgage Interest"));
    // Reordering the input keeps each name on its own color.
    const reversedFlow: SpendingGroupFlow = {
      groups: sampleCategoryFlow.groups,
      targets: [...sampleCategoryFlow.targets].reverse(),
      links: [
        { groupIndex: 0, targetIndex: 0, value: 15000 },
        { groupIndex: 0, targetIndex: 2, value: 100000 },
        { groupIndex: 1, targetIndex: 1, value: 40000 },
      ],
    };
    rerender(
      <SpendingReport
        categoryFlow={reversedFlow}
        merchantFlow={sampleMerchantFlow}
        income={sampleIncome}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const nodes = Array.from(svg.querySelectorAll('[data-testid="sankey-node"]'));
    // "Electric Bill" is now first but keeps its hash color.
    expect(nodes[0]!.getAttribute("fill")).toBe(colorForName("Electric Bill"));
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
    // Other + Remaining. Left ribbons run 2 x 3, right sub-ribbons run
    // 3 cells x 2 incomes.
    expect(svg.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(12);
    expect(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
    ).toHaveLength(6);
    expect(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    ).toHaveLength(6);
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
    expect(
      within(tip as unknown as HTMLElement).getByText("Proportional split — money is fungible")
    ).toBeInTheDocument();
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
    // Through-color: the sub-ribbon reads as its income flowing into the
    // target, with the middle group as the via context.
    expect(
      within(tip as unknown as HTMLElement).getByText("Payroll → Mortgage Interest")
    ).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("via Bills")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$1,000.00")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("(100%)")).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("Rolls up into its group — no splitting")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(link);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows the merchant share wording when hovering a group→merchant ribbon", () => {
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    // Right ribbons: [Bills→Bank of Example, Everyday→Whole Foods, ...].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[4]!;
    expect(link.getAttribute("data-side")).toBe("right");
    fireEvent.mouseMove(link, { clientX: 500, clientY: 200 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("Payroll → Whole Foods")
    ).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("via Everyday")
    ).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$300.00")).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("The merchant's exact share in this group")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(link);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("colors every ribbon by the node it flows into, not its income source", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 50000 },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // 3 cells x 2 incomes: each cell keeps one sub-ribbon per income so a
    // hovered income can spotlight its share — but every band renders in
    // the final category's color.
    const right = svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]');
    expect(right).toHaveLength(6);
    const left = svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]');
    // 2 incomes x 2 groups plus 2 full-width Remaining ribbons on the left.
    expect(left).toHaveLength(6);
    // One gradient per middle and per target (2 groups + 3 categories +
    // Remaining) — no income gradients.
    expect(svg.querySelectorAll("linearGradient")).toHaveLength(2 + 4);
    // Right sub-bands fill from their target's gradient, cell-major:
    // Bills→Mortgage x2, Bills→Electric x2, Everyday→Groceries x2.
    const targetOrder = [0, 0, 2, 2, 1, 1];
    right.forEach((link, k) => {
      expect(link.getAttribute("fill")).toBe(
        `url(#${sankeyRibbonGradientId("target", targetOrder[k]!)})`
      );
      // The funding income is still recorded for the hover highlight.
      expect(link.getAttribute("data-income")).toBe(String(k % 2));
    });
    // Left ribbons fill from their middle's gradient; the plug ribbons run
    // Remaining green full-width. Links run middle-major, incomes within.
    const leftFills = [
      sankeyRibbonGradientId("middle", 0),
      sankeyRibbonGradientId("middle", 0),
      sankeyRibbonGradientId("middle", 1),
      sankeyRibbonGradientId("middle", 1),
      sankeyRibbonGradientId("target", 3),
      sankeyRibbonGradientId("target", 3),
    ];
    left.forEach((link, k) => {
      expect(link.getAttribute("fill")).toBe(`url(#${leftFills[k]!})`);
    });
    // Each gradient holds its node color through the midpoint, then settles
    // into a shade of that same hue at the target end.
    const grad = svg.querySelector(`#${sankeyRibbonGradientId("target", 0)}`)!;
    const stops = Array.from(grad.querySelectorAll("stop"));
    expect(stops.map((s) => s.getAttribute("offset"))).toEqual(["0", "0.5", "1"]);
    const mortgage = colorForName("Mortgage Interest");
    expect(stops.map((s) => s.getAttribute("stop-color"))).toEqual([
      mortgage,
      mortgage,
      sankeyRibbonShade(mortgage),
    ]);
    const billsGrad = svg.querySelector(`#${sankeyRibbonGradientId("middle", 0)}`)!;
    expect(billsGrad.querySelector("stop")!.getAttribute("stop-color")).toBe(
      colorForName("Bills")
    );
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

  it("highlights every benefiting category when hovering an income source", () => {
    // Money is fungible, so one income reaches every group and target: the
    // hover lights the whole downstream path plus its own share of each
    // cell, and dims only the OTHER income's bars and bands.
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 50000 },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const income = svg.querySelectorAll('[data-testid="sankey-income"]')[0]!;
    fireEvent.mouseMove(income, { clientX: 100, clientY: 200 });
    // Every middle and right bar stays lit — all benefit from Payroll.
    for (const bar of svg.querySelectorAll('[data-testid="sankey-group"]')) {
      expect(bar.getAttribute("fill-opacity")).toBe("1");
    }
    for (const bar of svg.querySelectorAll('[data-testid="sankey-node"]')) {
      expect(bar.getAttribute("fill-opacity")).toBe("1");
    }
    // Payroll's own bar stays lit; the Bonus bar dims.
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    expect(incomes[0]!.getAttribute("fill-opacity")).toBe("1");
    expect(incomes[1]!.getAttribute("fill-opacity")).toBe("0.35");
    // Left ribbons from Payroll stay lit; Bonus ribbons dim.
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.35",
      "0.18",
      "0.35",
      "0.18",
      "0.35",
      "0.18",
    ]);
    // Right sub-bands alternate Payroll/Bonus within each cell: only
    // Payroll's share of every cell stays lit.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.35",
      "0.18",
      "0.35",
      "0.18",
      "0.35",
      "0.18",
    ]);
    fireEvent.mouseLeave(income);
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
    expect(
      within(tip as unknown as HTMLElement).getByText("Proportional split — money is fungible")
    ).toBeInTheDocument();
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
  });

  it("shows neutral Over income segments instead of an Overspent income source when spending exceeds income", () => {
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
    // middle and right bar carries a neutral unfunded segment for its
    // shortfall share.
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(5);
    expect(svg.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-testid="sankey-shortfall"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-group-shortfall"]')).toHaveLength(2);
    expect(svg.querySelector('[data-testid="sankey-total"]')).toBeNull();
    // Hovering a bar explains the gap: spending ran $550 past income.
    const node = svg.querySelectorAll('[data-testid="sankey-node"]')[0]!;
    fireEvent.mouseMove(node, { clientX: 600, clientY: 100 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Over income")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).queryByText("Unfunded")).not.toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).queryByText("Shortfall")).not.toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText(
        "Spending exceeded income by $550.00 — covered from savings or debt"
      )
    ).toBeInTheDocument();
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
    // No income: no ribbons, and every middle and right bar is fully unfunded.
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(0);
    expect(svg.querySelectorAll('[data-testid="sankey-shortfall"]')).toHaveLength(60);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-testid="sankey-group-shortfall"]')).toHaveLength(3);
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

  it("shows the over-income gap and its explainer when hovering a group under a shortfall", () => {
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
    expect(
      within(tip as unknown as HTMLElement).getByText(
        "Spending exceeded income by $550.00 — covered from savings or debt"
      )
    ).toBeInTheDocument();
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
    // Bills feeds the first two right ribbons; the Everyday ribbon dims.
    expect(links[3]!.getAttribute("fill-opacity")).toBe("0.35");
    expect(links[4]!.getAttribute("fill-opacity")).toBe("0.35");
    expect(links[5]!.getAttribute("fill-opacity")).toBe("0.18");
    // The Everyday bar dims; the connected targets stay lit.
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.35");
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    expect(nodes[0]!.getAttribute("fill-opacity")).toBe("1");
    expect(nodes[1]!.getAttribute("fill-opacity")).toBe("0.35");
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

  it("labels each column and explains it on hover", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const heads = svg.querySelectorAll('[data-testid="sankey-colhead"]');
    expect(heads).toHaveLength(3);
    expect(Array.from(heads).map((h) => h.textContent)).toEqual([
      "INCOME",
      "GROUPS",
      "CATEGORIES",
    ]);
    // Hovering a header explains the column without dimming the chart.
    const incomeHead = svg.querySelector('[data-testid="sankey-colhead"][data-col="income"]')!;
    fireEvent.mouseMove(incomeHead, { clientX: 160, clientY: 20 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("Money received this period.")
    ).toBeInTheDocument();
    for (const bar of svg.querySelectorAll('[data-testid="sankey-node"]')) {
      expect(bar.getAttribute("fill-opacity")).toBe("1");
    }
    fireEvent.mouseLeave(incomeHead);
    expect(document.querySelector(".y-tip")).toBeNull();
    // The right header follows the dimension toggle.
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    expect(
      svg.querySelector('[data-testid="sankey-colhead"][data-col="target"]')!.textContent
    ).toBe("MERCHANTS");
  });

  it("explains transfer money on both sides of the chart", () => {
    const flow: SpendingGroupFlow = {
      groups: [{ name: "Bills", value: 100000 }],
      targets: [
        { name: "Mortgage Interest", value: 70000 },
        { name: "Transfer : Broker", value: 30000, transfer: true },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 70000 },
        { groupIndex: 0, targetIndex: 1, value: 30000 },
      ],
    };
    const { container } = renderReport(flow, emptyFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Transfer : Broker", value: 50000, transfer: true },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Left: the withdrawal counts as income.
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    fireEvent.mouseMove(incomes[1]!, { clientX: 100, clientY: 300 });
    expect(
      screen.getByText("Includes withdrawals from off-budget accounts")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(incomes[1]!);
    // Right: the contribution counts as spending.
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    fireEvent.mouseMove(nodes[1]!, { clientX: 600, clientY: 200 });
    expect(
      screen.getByText("Includes money moved to off-budget accounts")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(nodes[1]!);
    // Plain rows carry no transfer line.
    fireEvent.mouseMove(nodes[0]!, { clientX: 600, clientY: 100 });
    expect(
      screen.queryByText("Includes money moved to off-budget accounts")
    ).not.toBeInTheDocument();
    fireEvent.mouseLeave(nodes[0]!);
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

  it("offers a How-to-read explainer in the header", () => {
    renderReport();
    expect(
      screen.getByRole("button", { name: "How to read this chart" })
    ).toBeInTheDocument();
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
});
