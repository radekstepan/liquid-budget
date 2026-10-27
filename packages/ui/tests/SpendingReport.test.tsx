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

function renderReport(
  categories: SpendingItem[] = sampleCategories,
  merchants: SpendingItem[] = sampleMerchants
) {
  return render(<SpendingReport categories={categories} merchants={merchants} />);
}

describe("SpendingReport", () => {
  it("renders the panel title and total for the default Categories dimension", () => {
    renderReport();
    expect(screen.getByText("Spending by Category")).toBeInTheDocument();
    expect(screen.getByText(/Total:/)).toBeInTheDocument();
    // Total appears twice: the header readout and the Sankey source label.
    expect(screen.getAllByText("$1,550.00")).toHaveLength(2);
  });

  it("defaults to the Sankey view with one link and node per group", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(3);
    expect(svg!.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(3);
    expect(svg!.querySelector('[data-testid="sankey-source"]')).not.toBeNull();
    expect(container.querySelectorAll(".y-bar-track")).toHaveLength(0);
  });

  it("labels each Sankey node with its name, amount, and percent", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    expect(within(svg as unknown as HTMLElement).getByText("Mortgage Interest")).toBeInTheDocument();
    expect(within(svg as unknown as HTMLElement).getByText("Groceries")).toBeInTheDocument();
    // 100000/155000 = 65%, 40000/155000 = 26%, 15000/155000 = 10%.
    expect(within(svg as unknown as HTMLElement).getByText("$1,000.00 · 65%")).toBeInTheDocument();
    expect(within(svg as unknown as HTMLElement).getByText("$400.00 · 26%")).toBeInTheDocument();
    expect(within(svg as unknown as HTMLElement).getByText("$150.00 · 10%")).toBeInTheDocument();
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
    // Merchant total differs: 100000 + 30000 + 20000.
    expect(screen.getAllByText("$1,500.00")).toHaveLength(2);

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
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(2);
    expect(within(svg as unknown as HTMLElement).getByText("Other")).toBeInTheDocument();
    expect(within(svg as unknown as HTMLElement).getByText("$550.00 · 35%")).toBeInTheDocument();
    // Total is unchanged by merging.
    expect(screen.getAllByText("$1,550.00")).toHaveLength(2);
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
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(1);
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

  it("shows a tooltip with amount and share when hovering a Sankey node", () => {
    const { container } = renderReport();
    const node = container.querySelectorAll('[data-testid="sankey-node"]')[1]!;
    fireEvent.mouseMove(node, { clientX: 400, clientY: 200 });
    // The floating ChartTip carries the hovered details (node labels also
    // show the name, so scope to the .y-tip overlay).
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Groceries")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$400.00")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("(26%)")).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("of $1,550.00 total")
    ).toBeInTheDocument();
    fireEvent.mouseLeave(node);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("shows merged-group detail when hovering the Other bucket", () => {
    const { container } = renderReport();
    const slider = screen.getByRole("slider", { name: /merge smaller expenses/i });
    fireEvent.change(slider, { target: { value: "500" } });
    const otherLink = Array.from(
      container.querySelectorAll('[data-testid="sankey-link"]')
    ).pop()!;
    fireEvent.mouseMove(otherLink, { clientX: 400, clientY: 200 });
    expect(screen.getByText("2 smaller categories under $500.00")).toBeInTheDocument();
  });

  it("shows the group count when hovering the Total source node", () => {
    const { container } = renderReport();
    const source = container.querySelector('[data-testid="sankey-source"]')!;
    fireEvent.mouseMove(source, { clientX: 20, clientY: 200 });
    expect(screen.getByText("Total spending")).toBeInTheDocument();
    expect(screen.getByText("across 3 categories")).toBeInTheDocument();
  });

  it("shows empty state when both dimensions are empty", () => {
    renderReport([], []);
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
