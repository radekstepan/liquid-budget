import { describe, expect, it, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SpendingReport, type SpendingItem } from "../src/SpendingReport.js";
import { colorForName } from "../src/chartUtils.js";

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

// Income $2,000 vs spending $1,550: flow is $2,000 with a $450 Remaining plug.
const sampleIncome: SpendingItem[] = [{ name: "Payroll", value: 200000 }];

function renderReport(
  categories: SpendingItem[] = sampleCategories,
  merchants: SpendingItem[] = sampleMerchants,
  income: SpendingItem[] = sampleIncome
) {
  return render(<SpendingReport categories={categories} merchants={merchants} income={income} />);
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

  it("defaults to the 3-column Sankey with income, Total, and spending sides", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]');
    expect(svg).not.toBeNull();
    // Left: one income source; right: 3 groups plus the Remaining plug.
    expect(svg!.querySelectorAll('[data-testid="sankey-in-link"]')).toHaveLength(1);
    expect(svg!.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(1);
    expect(svg!.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(4);
    expect(svg!.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(4);
    expect(svg!.querySelector('[data-testid="sankey-total"]')).not.toBeNull();
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
    expect(scope.getByText("$400.00 · 20%")).toBeInTheDocument();
    expect(scope.getByText("$150.00 · 8%")).toBeInTheDocument();
    expect(scope.getByText("Payroll")).toBeInTheDocument();
    expect(scope.getByText("$2,000.00 · 100%")).toBeInTheDocument();
    expect(scope.getByText("Remaining")).toBeInTheDocument();
    expect(scope.getByText("$450.00 · 23%")).toBeInTheDocument();
  });

  it("colors nodes by stable name hash, not by rank", () => {
    const { container, rerender } = renderReport();
    const fillsBefore = Array.from(
      container.querySelectorAll('[data-testid="sankey-node"]')
    ).map((n) => n.getAttribute("fill"));
    expect(fillsBefore[0]).toBe(colorForName("Mortgage Interest"));
    // Reordering the input keeps each name on its own color.
    rerender(
      <SpendingReport
        categories={[...sampleCategories].reverse()}
        merchants={sampleMerchants}
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

  it("merges groups under the slider threshold into an Other bucket", () => {
    const { container } = renderReport();
    const slider = screen.getByRole("slider", { name: /merge smaller expenses/i });
    // $500 threshold: Groceries ($400) and Electric Bill ($150) merge.
    fireEvent.change(slider, { target: { value: "500" } });

    expect(screen.getByText("(2 in Other)")).toBeInTheDocument();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Mortgage + Other + Remaining on the right.
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(3);
    expect(within(svg as unknown as HTMLElement).getByText("Other")).toBeInTheDocument();
    expect(within(svg as unknown as HTMLElement).getByText("$550.00 · 28%")).toBeInTheDocument();
    // Out total is unchanged by merging.
    expect(screen.getByText("$1,550.00")).toBeInTheDocument();
  });

  it("merges everything into a single Other row when the threshold exceeds all values", () => {
    // Non-round top value so the slider ceiling ($1000) sits above it.
    const { container } = renderReport(
      [
        { name: "Almost All", value: 99900 },
        { name: "Dust", value: 100 },
      ],
      []
    );
    const slider = screen.getByRole("slider", { name: /merge smaller expenses/i });
    expect(slider).toHaveAttribute("max", "1000");
    fireEvent.change(slider, { target: { value: "1000" } });
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(2);
    expect(within(svg as unknown as HTMLElement).getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("(2 in Other)")).toBeInTheDocument();
  });

  it("applies the threshold merge to the Bars view too", () => {
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Bars", exact: true }));
    const slider = screen.getByRole("slider", { name: /merge smaller expenses/i });
    fireEvent.change(slider, { target: { value: "500" } });
    expect(container.querySelectorAll(".y-bar-track")).toHaveLength(2);
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("(2 merged)")).toBeInTheDocument();
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
    const slider = screen.getByRole("slider", { name: /merge smaller expenses/i });
    fireEvent.change(slider, { target: { value: "500" } });
    // Out-links are Mortgage, Other, Remaining — Other sits in the middle.
    const otherLink = container.querySelectorAll('[data-testid="sankey-link"]')[1]!;
    fireEvent.mouseMove(otherLink, { clientX: 400, clientY: 200 });
    expect(screen.getByText("2 smaller categories under $500.00")).toBeInTheDocument();
  });

  it("shows the income breakdown when hovering the Total middle node", () => {
    const { container } = renderReport();
    const total = container.querySelector('[data-testid="sankey-total"]')!;
    fireEvent.mouseMove(total, { clientX: 400, clientY: 200 });
    expect(screen.getByText("Total flow")).toBeInTheDocument();
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Spent")).toBeInTheDocument();
    expect(screen.getByText("Left")).toBeInTheDocument();
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

  it("shows an Overspent plug on the income side when spending exceeds income", () => {
    const { container } = render(
      <SpendingReport
        categories={sampleCategories}
        merchants={sampleMerchants}
        income={[{ name: "Payroll", value: 100000 }]}
      />
    );
    // $1,550 out vs $1,000 in: $550 short, no Remaining anywhere.
    expect(screen.getByText("Over:")).toBeInTheDocument();
    expect(screen.getByText("$550.00")).toBeInTheDocument();
    expect(screen.queryByText("Remaining")).not.toBeInTheDocument();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    expect(within(svg as unknown as HTMLElement).getByText("Overspent")).toBeInTheDocument();
    expect(svg.querySelectorAll('[data-testid="sankey-in-link"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(3);
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

  it("grows the chart with a minimum row pitch so crowded labels never overlap", () => {
    const many: SpendingItem[] = Array.from({ length: 60 }, (_, i) => ({
      name: `Merchant ${i + 1}`,
      value: 200000 - i * 1000,
    }));
    const { container } = render(
      <SpendingReport categories={[]} merchants={many} income={[]} />
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
  });

  it("shows empty state when income and spending are both empty", () => {
    renderReport([], [], []);
    expect(screen.getByText("No data for this timeframe.")).toBeInTheDocument();
    expect(screen.getByText("0 categories")).toBeInTheDocument();
  });

  it("uses the singular noun for a single item", () => {
    renderReport([{ name: "Only One", value: 1000 }], []);
    expect(screen.getByText("1 category")).toBeInTheDocument();
  });

  it("displays row count in the header", () => {
    renderReport();
    expect(screen.getByText("3 categories")).toBeInTheDocument();
  });
});
