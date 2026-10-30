import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import {
  SANKEY_LEFT_LABEL_INSET,
  SANKEY_NODE_GAP,
  sankeyThresholdStops,
  type MonthlySankeySeries,
  type SpendingGroupFlow,
} from "@ynab/logic";
import {
  SpendingReport,
  SANKEY_AUTOFIT_SESSION_KEY,
  SANKEY_BUCKET_HATCH_ID,
  SANKEY_INCOME_GRADIENT_ID_PREFIX,
  SANKEY_MIDDLE_GRADIENT_ID_PREFIX,
  SANKEY_RIBBON_DIM_OPACITY,
  SANKEY_RIBBON_HOVER_OPACITY,
  SANKEY_RIBBON_OPACITY,
  SANKEY_SPOTLIGHT_TRANSITION_MS,
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

// Still-held fixture (task-49): an $800 purchase plus a $400 remainder held
// in the RRSP, routed through the Still-held pseudo-group; $1,200 income
// covers both exactly, so no Remaining plug draws.
const heldCategoryFlow: SpendingGroupFlow = {
  groups: [
    { name: "Everyday", value: 80000 },
    { name: "Still held", value: 40000 },
  ],
  targets: [
    { name: "Downpayment", value: 80000 },
    { name: "Wealthsimple RRSP", value: 40000 },
  ],
  links: [
    { groupIndex: 0, targetIndex: 0, value: 80000 },
    { groupIndex: 1, targetIndex: 1, value: 40000 },
  ],
};

const heldIncome: SpendingItem[] = [{ name: "Payroll", value: 120000 }];

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

  it("draws still-held accounts as first-class Sankey rows under the Still-held group (no strip, shared held hatch)", () => {
    // Task-49 replaces the task-48 Still-held strip with chart rows: one
    // target row per held account, routed through the Still-held
    // pseudo-group, in the account's own stable color. Task-50 hatches
    // whole-held elements with the shared bucket pattern: held money is
    // derived money, like the buckets — never a terminal purchase.
    render(
      <SpendingReport
        categoryFlow={heldCategoryFlow}
        merchantFlow={emptyFlow}
        income={heldIncome}
      />
    );
    expect(screen.queryByTestId("still-held")).not.toBeInTheDocument();
    // Middle column: the Still-held pseudo-group bar + label.
    const groupLabels = screen.getAllByTestId("sankey-group-label");
    expect(groupLabels.map((el) => el.textContent)).toContain("Still held");
    // Right column: the held account row with its value…
    const targetLabels = screen.getAllByTestId("sankey-target-label");
    expect(targetLabels.map((el) => el.textContent)).toContain("Wealthsimple RRSP");
    const targetAmounts = screen.getAllByTestId("sankey-target-amount");
    expect(targetAmounts.map((el) => el.textContent)).toContain("$400.00 · 33%");
    // …painted in its own stable hash color (never the bucket slate or the
    // Remaining green).
    const nodes = screen.getAllByTestId("sankey-node");
    const heldNode = nodes.find(
      (n) => n.getAttribute("fill") === colorForName("Wealthsimple RRSP")
    );
    expect(heldNode).toBeDefined();
    expect(heldNode?.getAttribute("fill")).toBe(
      sankeyTargetColor({ name: "Wealthsimple RRSP", bucket: false, isPlug: false })
    );
    // No buckets and no plug (income exactly covers spending + held), so
    // no bucket hatch anywhere — but the held target bar carries the
    // shared held hatch, painted from the same pattern def.
    expect(screen.queryByTestId("sankey-bucket-hatch")).not.toBeInTheDocument();
    const heldRow = heldNode!.parentElement!;
    const heldOverlay = heldRow.querySelector('[data-testid="sankey-held-hatch"]')!;
    expect(heldOverlay).toBeInTheDocument();
    expect(heldOverlay.getAttribute("fill")).toBe(`url(#${SANKEY_BUCKET_HATCH_ID})`);
    expect(heldOverlay.getAttribute("x")).toBe(heldNode!.getAttribute("x"));
    expect(heldOverlay.getAttribute("y")).toBe(heldNode!.getAttribute("y"));
    expect(heldOverlay.getAttribute("width")).toBe(heldNode!.getAttribute("width"));
    expect(heldOverlay.getAttribute("height")).toBe(heldNode!.getAttribute("height"));
    // The spending row carries no hatch of either kind.
    const spentNode = nodes.find(
      (n) => n.getAttribute("fill") === colorForName("Downpayment")
    )!;
    expect(spentNode.parentElement!.querySelector('[data-testid="sankey-held-hatch"]')).toBeNull();
    expect(spentNode.parentElement!.querySelector('[data-testid="sankey-bucket-hatch"]')).toBeNull();
    // One ribbon per group→target cell, held cell included.
    const rightLinks = screen
      .getAllByTestId("sankey-link")
      .filter((el) => el.getAttribute("data-side") === "right");
    expect(rightLinks).toHaveLength(2);
    // Header: Out covers spending + held, so Left reconciles to zero.
    expect(screen.getAllByText("$1,200.00")).toHaveLength(2);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("draws still-held accounts as Bars rows with the shared held hatch", () => {
    const { container } = render(
      <SpendingReport
        categoryFlow={heldCategoryFlow}
        merchantFlow={emptyFlow}
        income={heldIncome}
        initialView="bars"
      />
    );
    expect(screen.queryByTestId("still-held")).not.toBeInTheDocument();
    expect(screen.getByText("Wealthsimple RRSP")).toBeInTheDocument();
    expect(screen.getByText("$400.00")).toBeInTheDocument();
    // No merged buckets, so no bucket hatch — but the held row carries the
    // shared held hatch, painted from the same pattern def (which renders
    // for held rows too).
    expect(screen.queryByTestId("bars-bucket-hatch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bars-bucket-hatch-defs")).toBeInTheDocument();
    const tracks = container.querySelectorAll(".y-bar-track");
    expect(tracks).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="bars-held-hatch"]')).toHaveLength(1);
    const overlays = Array.from(tracks, (t) =>
      t.querySelector('[data-testid="bars-held-hatch"]')
    );
    // Downpayment first (larger), the held RRSP second.
    expect(overlays[0]).toBeNull();
    expect(overlays[1]).not.toBeNull();
    expect(overlays[1]!.querySelector("rect")!.getAttribute("fill")).toBe(
      `url(#${SANKEY_BUCKET_HATCH_ID})`
    );
  });

  it("reads held rows as holdings in tooltips (Held, never Spent)", () => {
    render(
      <SpendingReport
        categoryFlow={heldCategoryFlow}
        merchantFlow={emptyFlow}
        income={heldIncome}
      />
    );
    // Held target tooltip: "Held" + the still-in-account line.
    const targetLabels = screen.getAllByTestId("sankey-target-label");
    const heldLabel = targetLabels.find((el) => el.textContent === "Wealthsimple RRSP")!;
    fireEvent.mouseMove(heldLabel, { clientX: 700, clientY: 100 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Wealthsimple RRSP")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Held")).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("Unspent — still in this account")
    ).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).queryByText("Spent")
    ).not.toBeInTheDocument();
    // Still-held group tooltip: "Held" + the account count + explainer.
    const groupLabels = screen.getAllByTestId("sankey-group-label");
    const heldGroup = groupLabels.find((el) => el.textContent === "Still held")!;
    fireEvent.mouseMove(heldGroup, { clientX: 380, clientY: 100 });
    const groupTip = document.querySelector(".y-tip")!;
    expect(groupTip).toBeInTheDocument();
    expect(within(groupTip as unknown as HTMLElement).getByText("Held")).toBeInTheDocument();
    expect(within(groupTip as unknown as HTMLElement).getByText("1 account")).toBeInTheDocument();
    expect(
      within(groupTip as unknown as HTMLElement).getByText("Money that never left these accounts")
    ).toBeInTheDocument();
  });

  it("spotlights a held target's full path without reordering the DOM (no z-reorder)", () => {
    const { container } = render(
      <SpendingReport
        categoryFlow={heldCategoryFlow}
        merchantFlow={emptyFlow}
        income={heldIncome}
      />
    );
    const orderOf = () =>
      Array.from(container.querySelectorAll('[data-testid="sankey-link"]')).map((el) =>
        el.getAttribute("d")
      );
    const before = orderOf();
    // Hover the held target: its cell ribbon + Still-held group + funding
    // income brighten, the spending leg dims — in place.
    const targetLabels = screen.getAllByTestId("sankey-target-label");
    const heldLabel = targetLabels.find((el) => el.textContent === "Wealthsimple RRSP")!;
    fireEvent.mouseMove(heldLabel, { clientX: 700, clientY: 100 });
    const rightLinks = screen
      .getAllByTestId("sankey-link")
      .filter((el) => el.getAttribute("data-side") === "right");
    const fills = new Map(
      rightLinks.map((el) => [el.getAttribute("fill"), el.getAttribute("fill-opacity")])
    );
    expect(fills.get(colorForName("Wealthsimple RRSP"))).toBe(
      String(SANKEY_RIBBON_HOVER_OPACITY)
    );
    expect(fills.get(colorForName("Downpayment"))).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    expect(orderOf()).toEqual(before);
  });

  it("hatches the Still-held group bar and never a spending group bar", () => {
    // Task-50 (iv): the middle Still-held bar is entirely held money, so
    // it carries the shared hatch; the Everyday bar stays solid.
    render(
      <SpendingReport
        categoryFlow={heldCategoryFlow}
        merchantFlow={emptyFlow}
        income={heldIncome}
      />
    );
    const groups = screen.getAllByTestId("sankey-group");
    const labels = screen.getAllByTestId("sankey-group-label");
    expect(groups).toHaveLength(2);
    for (let i = 0; i < groups.length; i++) {
      const overlay = groups[i]!.parentElement!.querySelector(
        '[data-testid="sankey-held-hatch"]'
      );
      if (labels[i]!.textContent === "Still held") {
        expect(overlay).toBeInTheDocument();
        expect(overlay!.getAttribute("fill")).toBe(`url(#${SANKEY_BUCKET_HATCH_ID})`);
        expect(overlay!.getAttribute("x")).toBe(groups[i]!.getAttribute("x"));
        expect(overlay!.getAttribute("y")).toBe(groups[i]!.getAttribute("y"));
        expect(overlay!.getAttribute("width")).toBe(groups[i]!.getAttribute("width"));
        expect(overlay!.getAttribute("height")).toBe(groups[i]!.getAttribute("height"));
      } else {
        expect(overlay).toBeNull();
      }
    }
  });

  it("overlays right-hop ribbons into held targets with the identical path", () => {
    // Task-50 (ii): the ribbon into the held account carries a hatch
    // overlay path with the EXACT same `d` as the solid ribbon, painted
    // from the shared pattern def; the ribbon into the spending category
    // carries none.
    const { container } = render(
      <SpendingReport
        categoryFlow={heldCategoryFlow}
        merchantFlow={emptyFlow}
        income={heldIncome}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const rightSolids = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(rightSolids).toHaveLength(2);
    const heldSolid = rightSolids.find(
      (el) => el.getAttribute("fill") === colorForName("Wealthsimple RRSP")
    )!;
    const spentSolid = rightSolids.find(
      (el) => el.getAttribute("fill") === colorForName("Downpayment")
    )!;
    // The overlay rides immediately after its solid ribbon with the
    // identical path — no minimum-size hiding drops thin ribbons.
    const heldOverlay = heldSolid.nextElementSibling!;
    expect(heldOverlay.getAttribute("data-testid")).toBe("sankey-held-hatch");
    expect(heldOverlay.getAttribute("d")).toBe(heldSolid.getAttribute("d"));
    expect(heldOverlay.getAttribute("fill")).toBe(`url(#${SANKEY_BUCKET_HATCH_ID})`);
    // No overlay follows the spending ribbon (its next sibling is the next
    // solid element, never a held hatch).
    const spentNext = spentSolid.nextElementSibling;
    expect(spentNext?.getAttribute("data-testid")).not.toBe("sankey-held-hatch");
    expect(
      svg.querySelectorAll('[data-testid="sankey-held-hatch"][data-side="right"]')
    ).toHaveLength(1);
  });

  it("hatches only the held-funded sub-ribbons within a shared band", () => {
    // Task-50 (iii): per-sub-ribbon granularity, mirroring the task-45
    // spotlight. The Still-held band below funds two cells: the RRSP cell
    // (held) and a Downpayment cell (spending — mixed incoming disqualifies
    // the target). Only the held sub carries the overlay. (Artificial
    // fixture: real flows never route a spending cell through the
    // Still-held group — it exists to pin the per-sub rule.)
    const mixedFlow: SpendingGroupFlow = {
      groups: [
        { name: "Everyday", value: 40000 },
        { name: "Still held", value: 80000 },
      ],
      targets: [
        { name: "Downpayment", value: 80000 },
        { name: "Wealthsimple RRSP", value: 40000 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 40000 },
        { groupIndex: 1, targetIndex: 0, value: 40000 },
        { groupIndex: 1, targetIndex: 1, value: 40000 },
      ],
    };
    const { container } = render(
      <SpendingReport
        categoryFlow={mixedFlow}
        merchantFlow={emptyFlow}
        income={[{ name: "Payroll", value: 120000 }]}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // The Payroll→Still-held band subdivides into two subs in one <g>:
    // Downpayment (spending) and RRSP (held).
    const rrspSub = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
    ).find((el) => el.getAttribute("fill") === colorForName("Wealthsimple RRSP"))!;
    const band = rrspSub.parentElement!;
    const spendingSibling = Array.from(
      band.querySelectorAll('[data-testid="sankey-link"]')
    ).find((el) => el.getAttribute("fill") === colorForName("Downpayment"))!;
    // The spending sibling in the SAME band stays solid…
    expect(spendingSibling.nextElementSibling?.getAttribute("data-testid")).not.toBe(
      "sankey-held-hatch"
    );
    // …while the held sub carries the overlay over its identical path.
    const subOverlay = rrspSub.nextElementSibling!;
    expect(subOverlay.getAttribute("data-testid")).toBe("sankey-held-hatch");
    expect(subOverlay.getAttribute("data-side")).toBe("left");
    expect(subOverlay.getAttribute("d")).toBe(rrspSub.getAttribute("d"));
    expect(subOverlay.getAttribute("fill")).toBe(`url(#${SANKEY_BUCKET_HATCH_ID})`);
    // No other left sub in the chart carries one (the Everyday band's
    // Downpayment sub is spending too).
    expect(
      svg.querySelectorAll('[data-testid="sankey-held-hatch"][data-side="left"]')
    ).toHaveLength(1);
    // …and the Still-held middle bar itself stays solid here: with a
    // spending cell among its outgoing links it is mixed, not whole-held.
    const groups = screen.getAllByTestId("sankey-group");
    const labels = screen.getAllByTestId("sankey-group-label");
    const stillHeld = groups[labels.findIndex((el) => el.textContent === "Still held")]!;
    expect(
      stillHeld.parentElement!.querySelector('[data-testid="sankey-held-hatch"]')
    ).toBeNull();
  });

  it("brightens and dims held overlays with their ribbons (hover parity, no z-reorder)", () => {
    // Task-50 (v): two held accounts — hovering one lights its own
    // overlays (bar, right ribbon, funding sub) and dims the other's, at
    // the ribbons' own rest/bright/dim steps with the same cross-fade, in
    // place.
    const twoHeldFlow: SpendingGroupFlow = {
      groups: [
        { name: "Everyday", value: 80000 },
        { name: "Still held", value: 80000 },
      ],
      targets: [
        { name: "Downpayment", value: 80000 },
        { name: "Wealthsimple RRSP", value: 40000 },
        { name: "Questrade TFSA", value: 40000 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 80000 },
        { groupIndex: 1, targetIndex: 1, value: 40000 },
        { groupIndex: 1, targetIndex: 2, value: 40000 },
      ],
    };
    const { container } = render(
      <SpendingReport
        categoryFlow={twoHeldFlow}
        merchantFlow={emptyFlow}
        income={[{ name: "Payroll", value: 160000 }]}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Every held overlay sits immediately after its solid element (same
    // path/geometry) and carries the spotlight cross-fade.
    const overlays = Array.from(svg.querySelectorAll('[data-testid="sankey-held-hatch"]'));
    expect(overlays.length).toBeGreaterThan(0);
    for (const o of overlays) {
      expect(o.getAttribute("style") ?? "").toMatch(
        new RegExp(`fill-opacity ${SANKEY_SPOTLIGHT_TRANSITION_MS}ms`)
      );
    }
    const opacityOf = (el: Element) => el.getAttribute("fill-opacity");
    const solidOf = (o: Element) => {
      const prev = o.previousElementSibling!;
      expect(prev.getAttribute("data-testid")).not.toBe("sankey-held-hatch");
      return prev;
    };
    // Rest: every overlay matches its solid at the rest step.
    for (const o of overlays) {
      expect(opacityOf(o)).toBe(String(SANKEY_RIBBON_OPACITY));
      expect(opacityOf(o)).toBe(opacityOf(solidOf(o)));
    }
    const orderOf = () =>
      Array.from(svg.querySelectorAll('[data-testid="sankey-held-hatch"]')).map((el) =>
        el.tagName === "path" ? el.getAttribute("d") : el.getAttribute("y")
      );
    const before = orderOf();
    // Hover the RRSP target: its overlays brighten with their solids, the
    // TFSA overlays dim with theirs — in place.
    const targetLabels = screen.getAllByTestId("sankey-target-label");
    const heldLabel = targetLabels.find((el) => el.textContent === "Wealthsimple RRSP")!;
    fireEvent.mouseMove(heldLabel, { clientX: 700, clientY: 100 });
    const ownerOf = (o: Element): string | null => {
      // Bar overlays live in the row's <g> beside its label (direct
      // children only — right-hop overlays sit at the svg root, where a
      // descendant query would catch unrelated rows' labels); ribbon
      // overlays follow the solid ribbon in the target's color.
      const g = o.parentElement!;
      const label = g.querySelector(
        ':scope > [data-testid="sankey-target-label"], :scope > [data-testid="sankey-group-label"]'
      );
      if (label?.textContent === "Wealthsimple RRSP") return "rrsp";
      if (label?.textContent === "Questrade TFSA") return "tfsa";
      const solidFill = solidOf(o).getAttribute("fill");
      if (solidFill === colorForName("Wealthsimple RRSP")) return "rrsp";
      if (solidFill === colorForName("Questrade TFSA")) return "tfsa";
      return null;
    };
    let bright = 0;
    let dim = 0;
    for (const o of overlays) {
      const owner = ownerOf(o);
      // The Still-held middle bar straddles both accounts (it feeds both
      // cells), so it stays on the hovered path and brightens.
      const want =
        owner === "tfsa" ? String(SANKEY_RIBBON_DIM_OPACITY) : String(SANKEY_RIBBON_HOVER_OPACITY);
      expect(opacityOf(o)).toBe(want);
      expect(opacityOf(o)).toBe(opacityOf(solidOf(o)));
      if (want === String(SANKEY_RIBBON_HOVER_OPACITY)) bright++;
      else dim++;
    }
    expect(bright).toBeGreaterThan(0);
    expect(dim).toBeGreaterThan(0);
    expect(orderOf()).toEqual(before);
    // Clearing the hover returns every overlay to rest with its solid.
    fireEvent.mouseLeave(heldLabel);
    for (const o of overlays) {
      expect(opacityOf(o)).toBe(String(SANKEY_RIBBON_OPACITY));
      expect(opacityOf(o)).toBe(opacityOf(solidOf(o)));
    }
    expect(orderOf()).toEqual(before);
  });

  it("never captures pointer events on held overlays (hover passes through)", () => {
    // Task-50 (vi): every held overlay — Sankey bars, ribbons, sub-ribbons,
    // and Bars rows — is pointer-events none, so hovering "through" one
    // still hits the underlying target.
    const { container, unmount } = render(
      <SpendingReport
        categoryFlow={heldCategoryFlow}
        merchantFlow={emptyFlow}
        income={heldIncome}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const overlays = svg.querySelectorAll('[data-testid="sankey-held-hatch"]');
    expect(overlays.length).toBeGreaterThan(0);
    for (const o of overlays) {
      expect(o.getAttribute("pointer-events")).toBe("none");
    }
    // The solid ribbon beneath its overlay still takes the hover: moving
    // onto the held right-hop ribbon spotlights its through-line and tips
    // it, exactly as without the overlay.
    const heldRibbon = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    ).find((el) => el.getAttribute("fill") === colorForName("Wealthsimple RRSP"))!;
    fireEvent.mouseMove(heldRibbon, { clientX: 550, clientY: 200 });
    expect(heldRibbon.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(
      within(tip as unknown as HTMLElement).getByText("Still held → Wealthsimple RRSP")
    ).toBeInTheDocument();
    unmount();
    // Bars rows: the overlay svg itself is pointer-events none.
    const bars = render(
      <SpendingReport
        categoryFlow={heldCategoryFlow}
        merchantFlow={emptyFlow}
        income={heldIncome}
        initialView="bars"
      />
    );
    const barsOverlays = bars.container.querySelectorAll('[data-testid="bars-held-hatch"]');
    expect(barsOverlays).toHaveLength(1);
    expect(barsOverlays[0]!.getAttribute("pointer-events")).toBe("none");
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
    // categories plus the Remaining plug. Left bands run income → groups
    // (1 x 2) plus the full-width Remaining ribbon, but the Bills band
    // nests two category sub-ribbons, so 4 left paths render; right
    // ribbons run groups → categories (3 exact cells).
    expect(svg!.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(1);
    expect(svg!.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg!.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(4);
    expect(svg!.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(7);
    expect(svg!.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')).toHaveLength(4);
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
    // The middle bars segment by their outgoing cells' target colors —
    // one gradient per bar, like the income bars — so every segment meets
    // its ribbon exactly; no bar keeps its flat group hue.
    const groups = Array.from(svg.querySelectorAll('[data-testid="sankey-group"]'));
    expect(groups.map((g) => g.getAttribute("fill"))).toEqual([
      `url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}0)`,
      `url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}1)`,
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
    // middle. The Bills band nests Mortgage + Other sub-ribbons, so 4
    // left paths render beside the 3 right ribbons.
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(7);
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
    // Other + Remaining. Each income's Bills band nests Mortgage + Other
    // sub-ribbons, so 4 left paths per income (8) beside the 3 right
    // ribbons — one per cell, never one per income.
    expect(svg.querySelectorAll('[data-testid="sankey-income"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-group"]')).toHaveLength(2);
    expect(svg.querySelectorAll('[data-testid="sankey-node"]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(11);
    expect(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
    ).toHaveLength(8);
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

  it("keeps one hover across a right-column row's bar, title, and amount", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const bar = svg.querySelectorAll('[data-testid="sankey-node"]')[1]!;
    const label = svg.querySelectorAll('[data-testid="sankey-target-label"]')[1]!;
    const amount = svg.querySelectorAll('[data-testid="sankey-target-amount"]')[1]!;
    // Hover the bar: the row's spotlight + tooltip show.
    fireEvent.mouseMove(bar, { clientX: 700, clientY: 100 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Moving bar → title stays inside the row (a mouseout whose
    // relatedTarget never leaves the row): hover must not clear — no
    // leave+enter flicker of the spotlight. Assert before any re-enter,
    // so a transient clear cannot hide behind the next set.
    fireEvent.mouseOut(bar, { relatedTarget: label });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Groceries")).toBeInTheDocument();
    fireEvent.mouseMove(label, { clientX: 720, clientY: 100 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Same for title → amount within the row.
    fireEvent.mouseOut(label, { relatedTarget: amount });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    fireEvent.mouseMove(amount, { clientX: 720, clientY: 112 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Leaving the row entirely clears.
    fireEvent.mouseLeave(amount);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("bridges the bar→label gap so dead space holds the row hover", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const bars = svg.querySelectorAll('[data-testid="sankey-node"]');
    const hits = svg.querySelectorAll('[data-testid="sankey-target-hit"]');
    // One invisible hit band per right-column row.
    expect(hits).toHaveLength(bars.length);
    const hit = hits[1]!;
    const bar = bars[1]!;
    const label = svg.querySelectorAll('[data-testid="sankey-target-label"]')[1]!;
    // The band covers the bar's exact vertical extent (adjacent rows never
    // overlap) and reaches past the label start — with no visible paint.
    expect(hit.getAttribute("x")).toBe(bar.getAttribute("x"));
    expect(hit.getAttribute("y")).toBe(bar.getAttribute("y"));
    expect(hit.getAttribute("height")).toBe(bar.getAttribute("height"));
    expect(hit.getAttribute("fill")).toBe("transparent");
    const hitRight = Number(hit.getAttribute("x")) + Number(hit.getAttribute("width"));
    expect(hitRight).toBeGreaterThan(Number(label.getAttribute("x")));
    // Hovering the dead gap between bar and label keeps the row's hover
    // instead of clearing it.
    fireEvent.mouseMove(bar, { clientX: 700, clientY: 100 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    fireEvent.mouseMove(hit, { clientX: 712, clientY: 100 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    fireEvent.mouseLeave(hit);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("keeps one hover across a left-column row's bar, name, and amount", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const bar = svg.querySelector('[data-testid="sankey-income"]')!;
    const label = svg.querySelector('[data-testid="sankey-income-label"]')!;
    const amount = svg.querySelector('[data-testid="sankey-income-amount"]')!;
    // Hover the bar: the row's spotlight + tooltip show.
    fireEvent.mouseMove(bar, { clientX: 170, clientY: 200 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Moving bar → name stays inside the row (a mouseout whose
    // relatedTarget never leaves the row): hover must not clear — no
    // leave+enter flicker of the spotlight. Assert before any re-enter,
    // so a transient clear cannot hide behind the next set.
    fireEvent.mouseOut(bar, { relatedTarget: label });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Payroll")).toBeInTheDocument();
    fireEvent.mouseMove(label, { clientX: 100, clientY: 200 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Same for name → amount within the row.
    fireEvent.mouseOut(label, { relatedTarget: amount });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    fireEvent.mouseMove(amount, { clientX: 100, clientY: 212 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Leaving the row entirely clears.
    fireEvent.mouseLeave(amount);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("bridges the left bar→label gap so gutter dead space holds the row hover", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const bars = svg.querySelectorAll('[data-testid="sankey-income"]');
    const hits = svg.querySelectorAll('[data-testid="sankey-income-hit"]');
    // One invisible hit band per left-column row.
    expect(hits).toHaveLength(bars.length);
    const hit = hits[0]!;
    const bar = bars[0]!;
    const label = svg.querySelector('[data-testid="sankey-income-label"]')!;
    // The band covers the bar's exact vertical extent (adjacent rows never
    // overlap) and runs from the SVG's left edge to the bar's right edge —
    // past the label anchor — with no visible paint.
    expect(hit.getAttribute("x")).toBe("0");
    expect(hit.getAttribute("y")).toBe(bar.getAttribute("y"));
    expect(hit.getAttribute("height")).toBe(bar.getAttribute("height"));
    expect(hit.getAttribute("fill")).toBe("transparent");
    const hitRight = Number(hit.getAttribute("x")) + Number(hit.getAttribute("width"));
    expect(hitRight).toBe(Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")));
    expect(hitRight).toBeGreaterThan(Number(label.getAttribute("x")));
    // Hovering the dead gutter between bar and label keeps the row's hover
    // instead of clearing it.
    fireEvent.mouseMove(bar, { clientX: 170, clientY: 200 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    fireEvent.mouseMove(hit, { clientX: 165, clientY: 200 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    fireEvent.mouseLeave(hit);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("keeps one hover across a middle-column row's bar, name, and amount", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Deliberately no middle hit band: the middle labels sit in the ribbon
    // zone, so a band painted with the row would swallow ribbon hovers —
    // the unified row <g> alone kills the part↔part leave+enter.
    expect(svg.querySelector('[data-testid="sankey-group-hit"]')).toBeNull();
    const bar = svg.querySelectorAll('[data-testid="sankey-group"]')[0]!;
    const label = svg.querySelectorAll('[data-testid="sankey-group-label"]')[0]!;
    const amount = svg.querySelectorAll('[data-testid="sankey-group-amount"]')[0]!;
    // Hover the bar: the row's spotlight + tooltip show.
    fireEvent.mouseMove(bar, { clientX: 380, clientY: 100 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Moving bar → name stays inside the row (a mouseout whose
    // relatedTarget never leaves the row): hover must not clear — no
    // leave+enter flicker of the spotlight. Assert before any re-enter,
    // so a transient clear cannot hide behind the next set.
    fireEvent.mouseOut(bar, { relatedTarget: label });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Bills")).toBeInTheDocument();
    fireEvent.mouseMove(label, { clientX: 400, clientY: 100 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Same for name → amount within the row.
    fireEvent.mouseOut(label, { relatedTarget: amount });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    fireEvent.mouseMove(amount, { clientX: 400, clientY: 112 });
    expect(document.querySelector(".y-tip")).toBeInTheDocument();
    // Leaving the row entirely clears.
    fireEvent.mouseLeave(amount);
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
    // Left paths run middle-major with the Bills band subdivided:
    // [Bills/Mortgage, Bills/Electric, Everyday/Groceries, plug, ...].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[2]!;
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
    // Right ribbons trail the 4 left paths, group-major: [Bills→Mortgage,
    // Bills→Electric, ...].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[4]!;
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
    // Left paths: Bills nests Bank of Example, Everyday nests Whole Foods +
    // Corner Shop, plus the plug — so the right ribbons
    // [Bills→Bank of Example, Everyday→Whole Foods, ...] start at index 4.
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[5]!;
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

  it("colors every ribbon flat by its final destination, not its income source", () => {
    // Unmerged fixture: pin the auto-fit flag so the initial load keeps the
    // threshold off instead of raising it to fit the 400px mock viewport.
    sessionStorage.setItem(SANKEY_AUTOFIT_SESSION_KEY, "1");
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
    // 2 incomes x (Bills nesting 2 categories + Everyday nesting 1) plus
    // 2 full-width Remaining ribbons on the left.
    expect(left).toHaveLength(8);
    // Each ribbon carries one flat color through its whole length,
    // exactly its final destination node's fill — gradients live only on
    // the income and middle bars (one per bar), never on a ribbon.
    for (const link of svg.querySelectorAll('[data-testid="sankey-link"]')) {
      expect(link.getAttribute("fill")).not.toMatch(/^url\(/);
    }
    // Two incomes plus two middles, one gradient each.
    expect(svg.querySelectorAll("linearGradient")).toHaveLength(4);
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
    // Left sub-ribbons fill with their final category's color; the plug
    // ribbons run Remaining green full-width. Links run middle-major,
    // incomes within, sub-ribbons expanding inline per band.
    const leftFills = [
      colorForName("Mortgage Interest"),
      colorForName("Electric Bill"),
      colorForName("Mortgage Interest"),
      colorForName("Electric Bill"),
      colorForName("Groceries"),
      colorForName("Groceries"),
      REMAINING_COLOR,
      REMAINING_COLOR,
    ];
    left.forEach((link, k) => {
      expect(link.getAttribute("fill")).toBe(leftFills[k]);
    });
    // Ribbon fills equal their final destination bars' fills exactly: the
    // line from an income to a category reads as one color throughout. The
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
    // Nodes run in target order (Mortgage, Groceries, Electric,
    // Remaining); each left sub-ribbon matches its final category's bar.
    const leftDestBySub = [
      nodeFills[0],
      nodeFills[2],
      nodeFills[0],
      nodeFills[2],
      nodeFills[1],
      nodeFills[1],
      nodeFills[3],
      nodeFills[3],
    ];
    // The middle bars segment by their outgoing cells (one gradient per
    // bar), so the group's own hue appears on no bar — only on the tooltip
    // dot (and the no-outgoing-ribbons fallback gradient).
    expect(groupFills).toEqual([
      `url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}0)`,
      `url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}1)`,
    ]);
    left.forEach((link, k) => {
      const destFill = leftDestBySub[k];
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
    // Payroll's left ribbons brighten in place while the Bonus legs dim
    // — no z-reorder, so brightness alone carries the spotlight.
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    // Layout order: middle-major, incomes within, plugs trailing —
    // Bills/Payroll subs, Bills/Bonus subs, Everyday/Payroll,
    // Everyday/Bonus, plug/Payroll, plug/Bonus.
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.85",
      "0.85",
      "0.12",
      "0.12",
      "0.85",
      "0.12",
      "0.85",
      "0.12",
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
    // Unmerged fixture: pin the auto-fit flag so the initial load keeps the
    // threshold off instead of raising it to fit the 400px mock viewport.
    sessionStorage.setItem(SANKEY_AUTOFIT_SESSION_KEY, "1");
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
    // Everyday→Groceries): only the Groceries cell brightens, in place —
    // the spotlight never reorders, so brightness alone carries it.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual(["0.12", "0.12", "0.85"]);
    // The parent group joins the spotlight in the same bright color as
    // its ribbon while the off-path group dims.
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[0]!.getAttribute("fill-opacity")).toBe("0.12");
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.85");
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    // Only the two Everyday sub-ribbons (one per income) join the
    // spotlight; the Bills sub-ribbons and plugs dim — all in layout
    // order (Bills/Payroll subs, Bills/Bonus subs, Everyday legs, plugs).
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.12",
      "0.12",
      "0.12",
      "0.12",
      "0.85",
      "0.85",
      "0.12",
      "0.12",
    ]);
    // Sibling targets dim.
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    expect(nodes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    expect(nodes[2]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    fireEvent.mouseLeave(node);
  });

  it("lights only the hovered target's sub-ribbons inside a shared group band", () => {
    // Bills feeds TWO categories (Mortgage Interest + Electric Bill), so its
    // income band subdivides into two sub-ribbons. Hovering one category must
    // light only ITS slice — the sibling's sub-ribbon dims with the rest of
    // the off-path wash, or unrelated categories light up to the left.
    sessionStorage.setItem(SANKEY_AUTOFIT_SESSION_KEY, "1");
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Left paths: [Bills/Mortgage, Bills/Electric, Everyday/Groceries, plug].
    const node = svg.querySelectorAll('[data-testid="sankey-node"]')[0]!;
    fireEvent.mouseMove(node, { clientX: 600, clientY: 100 });
    const left = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
    );
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.85", // Mortgage Interest's own slice
      "0.12", // Electric Bill's slice — same band, different category
      "0.12", // Everyday band
      "0.12", // plug
    ]);
    // The lit slice reads as the hovered category; the dimmed sibling keeps
    // its own color (dimmed, not relit).
    expect(left[0]!.getAttribute("fill")).toBe(colorForName("Mortgage Interest"));
    expect(left[1]!.getAttribute("fill")).toBe(colorForName("Electric Bill"));
    // Right side: only the Mortgage cell lights; the parent group joins the
    // spotlight while the off-path group dims.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.85",
      "0.12",
      "0.12",
    ]);
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[0]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.12");
    fireEvent.mouseLeave(node);
  });

  it("lights only the hovered cell's sub-ribbons when hovering a group→category ribbon", () => {
    // The through-line of a right-hop ribbon runs back through the income
    // bands feeding its middle — but only the hovered cell's slices, not the
    // sibling categories nested in the same bands.
    sessionStorage.setItem(SANKEY_AUTOFIT_SESSION_KEY, "1");
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Right ribbons trail the 4 left paths: Bills→Mortgage first.
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[4]!;
    expect(link.getAttribute("data-side")).toBe("right");
    fireEvent.mouseMove(link, { clientX: 500, clientY: 120 });
    const left = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
    );
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.85", // Mortgage Interest's slice of the Bills band
      "0.12", // Electric Bill's slice — same band, not on this path
      "0.12", // Everyday band
      "0.12", // plug
    ]);
    fireEvent.mouseLeave(link);
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
    // merchant's own color, in place (no z-reorder: brightness alone
    // carries the spotlight). Right links run cell-major: Bills→Airbnb,
    // Bills→Bank, Everyday→Airbnb, Everyday→Whole Foods.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.85",
      "0.12",
      "0.85",
      "0.12",
    ]);
    const airbnb = colorForName("Airbnb");
    expect(node.getAttribute("fill")).toBe(airbnb);
    expect(right[0]!.getAttribute("fill")).toBe(airbnb);
    expect(right[2]!.getAttribute("fill")).toBe(airbnb);
    // Both parent groups join the spotlight — the non-dominant Bills bar
    // brightens with its ribbon instead of dimming away from it.
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[0]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.85");
    // The income fans of both groups brighten with per-sub-ribbon
    // granularity (Categories hover parity): each band's Airbnb slice lights
    // while its sibling slices (Bank, Whole Foods) dim — the merchant's own
    // color flowing all the way to income. Left paths run band-major with
    // cells inline: Bills/Payroll, Bills/Bonus, Everyday/Payroll,
    // Everyday/Bonus.
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual([
      "0.85",
      "0.12",
      "0.85",
      "0.12",
      "0.85",
      "0.12",
      "0.85",
      "0.12",
    ]);
    // Every lit slice reads as the hovered merchant; the dimmed siblings
    // keep their own colors (dimmed, not relit).
    expect(left.map((l) => l.getAttribute("fill"))).toEqual([
      airbnb,
      colorForName("Bank of Example"),
      airbnb,
      colorForName("Bank of Example"),
      airbnb,
      colorForName("Whole Foods"),
      airbnb,
      colorForName("Whole Foods"),
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
    // The bar's segments match its ribbons exactly: gradient fill at the
    // shared rest opacity.
    expect(group.getAttribute("fill")).toBe(`url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}0)`);
    expect(group.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
    fireEvent.mouseMove(group, { clientX: 380, clientY: 100 });
    expect(group.getAttribute("stroke")).toBe("none");
    expect(group.getAttribute("stroke-width")).toBeNull();
    // The hovered group brightens to the spotlight level with its ribbons
    // while the off-path sibling dims.
    expect(group.getAttribute("fill-opacity")).toBe("0.85");
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[1]!.getAttribute("fill-opacity")).toBe("0.12");
    // The connected ribbons brighten in place — no z-reorder, so the
    // right block keeps layout order (Bills→Mortgage, Bills→Electric lit,
    // Everyday→Groceries dim). The right block trails 4 left paths now
    // that Bills nests two subs.
    const links = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]'));
    expect(links[4]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(links[5]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(links[6]!.getAttribute("fill-opacity")).toBe("0.12");
    fireEvent.mouseLeave(group);
    // Rest state returns once the hover clears.
    expect(group.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
    expect(groups[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
  });

  it("cross-fades the spotlight with a stable z-order so no reorder can flash mid-transition", () => {
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Flash-safety mechanism (replaces the task-29 no-transition rule):
    // the spotlight never re-sequences the DOM, so the brightness steps
    // can glide without ever showing final z-order at pre-transition
    // brightness. Every spotlight element carries the cross-fade; the DOM
    // order never changes with hover.
    const ribbonLike = Array.from(
      svg.querySelectorAll(
        '[data-testid="sankey-link"], [data-testid="sankey-group"], [data-testid="sankey-node"], [data-testid="sankey-income"], [data-testid="sankey-bucket-hatch"], [data-testid="sankey-held-hatch"]'
      )
    );
    expect(ribbonLike.length).toBeGreaterThan(0);
    for (const el of ribbonLike) {
      expect(el.getAttribute("style") ?? "").toMatch(
        new RegExp(`fill-opacity ${SANKEY_SPOTLIGHT_TRANSITION_MS}ms`)
      );
    }
    const labels = Array.from(
      svg.querySelectorAll(
        '[data-testid="sankey-income-label"], [data-testid="sankey-income-amount"], [data-testid="sankey-group-label"], [data-testid="sankey-group-amount"], [data-testid="sankey-target-label"], [data-testid="sankey-target-amount"]'
      )
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const el of labels) {
      expect(el.getAttribute("style") ?? "").toMatch(
        new RegExp(`opacity ${SANKEY_SPOTLIGHT_TRANSITION_MS}ms`)
      );
    }
    // Rest DOM order: every ribbon's identity and position.
    const restLinks = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]'));
    const group = svg.querySelectorAll('[data-testid="sankey-group"]')[0]!;
    fireEvent.mouseMove(group, { clientX: 380, clientY: 100 });
    // Same commit, same brightness: the bar and every ribbon on its path
    // share the hover step. The left-hop sub-ribbons carry their final
    // category's color (right-hop ribbons too, by design), and the group
    // bar segments by the same outgoing cells.
    const barFill = group.getAttribute("fill");
    expect(group.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    const lit = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]')).filter(
      (l) => l.getAttribute("fill-opacity") === String(SANKEY_RIBBON_HOVER_OPACITY)
    );
    expect(lit.length).toBeGreaterThan(0);
    const leftLit = lit.filter((l) => l.getAttribute("data-side") === "left");
    expect(leftLit).toHaveLength(2);
    // The lit Bills sub-ribbons read as their final categories — never
    // the middle group's own hue.
    const billsChildren = [colorForName("Mortgage Interest"), colorForName("Electric Bill")];
    expect(leftLit.map((l) => l.getAttribute("fill"))).toEqual(billsChildren);
    expect(barFill).toBe(`url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}0)`);
    // Stable z-order: the hover re-sequences nothing — identical nodes in
    // identical positions, so the cross-fade above cannot flash.
    const hoveredLinks = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]'));
    expect(hoveredLinks).toHaveLength(restLinks.length);
    hoveredLinks.forEach((l, i) => expect(l).toBe(restLinks[i]));
    fireEvent.mouseLeave(group);
    const restAgain = Array.from(svg.querySelectorAll('[data-testid="sankey-link"]'));
    expect(restAgain).toHaveLength(restLinks.length);
    restAgain.forEach((l, i) => expect(l).toBe(restLinks[i]));
  });

  it("drops the spotlight cross-fade to zero duration under prefers-reduced-motion", () => {
    // jsdom ships no matchMedia: stub the media query as matching reduce.
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const { container, unmount } = renderReport();
      const svg = container.querySelector('[data-testid="sankey-svg"]')!;
      // Every spotlight step is instant — same semantics, no glide.
      for (const el of svg.querySelectorAll(
        '[data-testid="sankey-link"], [data-testid="sankey-group"], [data-testid="sankey-node"], [data-testid="sankey-income"]'
      )) {
        expect(el.getAttribute("style") ?? "").toMatch(/fill-opacity 0ms/);
      }
      // The spotlight itself still works: hover brightens the path.
      const group = svg.querySelectorAll('[data-testid="sankey-group"]')[0]!;
      fireEvent.mouseMove(group, { clientX: 380, clientY: 100 });
      expect(group.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
      fireEvent.mouseLeave(group);
      expect(group.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_OPACITY));
      unmount();
    } finally {
      if (realMatchMedia == null) {
        delete (window as unknown as Record<string, unknown>).matchMedia;
      } else {
        window.matchMedia = realMatchMedia;
      }
    }
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
      // by index — robust to layout-order position either way.
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
    // The plug ribbon trails the subdivided left bands: [Bills/Mortgage,
    // Bills/Electric, Everyday/Groceries, Payroll→Remaining, ...].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[3]!;
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

  it("routes the Remaining ribbon through a dedicated lane below the middle column", () => {
    const { container } = renderReport();
    const checkLane = () => {
      const svg = container.querySelector('[data-testid="sankey-svg"]')!;
      // The plug ribbon stays whole and green in both groupings.
      const left = Array.from(
        svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
      );
      const plugs = left.filter((l) => l.getAttribute("fill") === REMAINING_COLOR);
      expect(plugs).toHaveLength(1);
      const d = plugs[0]!.getAttribute("d") ?? "";
      // Lane shape: drop + bridge + traverse runs (three L-runs: bridge,
      // target edge, bridge) instead of one straight diagonal bezier.
      expect(d.split(" L ")).toHaveLength(4);
      // The bridge runs one row gap below the last middle bar: parse the
      // lane top (the drop's landing y) out of the path.
      const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect(nums).toHaveLength(32);
      const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
      const last = groups[groups.length - 1]!;
      const midBottom = Number(last.getAttribute("y")) + Number(last.getAttribute("height"));
      expect(nums[5]).toBeCloseTo(midBottom + SANKEY_NODE_GAP, 2);
      // The plug bar keeps its stacked trailing spot below the last
      // spending row — the lane is transit-only, no bar moves.
      const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
      const spendLast = nodes[nodes.length - 2]!;
      const plugBar = nodes[nodes.length - 1]!;
      expect(Number(plugBar.getAttribute("y"))).toBeCloseTo(
        Number(spendLast.getAttribute("y")) +
          Number(spendLast.getAttribute("height")) +
          SANKEY_NODE_GAP,
        2
      );
    };
    checkLane();
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    checkLane();
  });

  it("spotlights the Remaining flow path when hovering the Remaining plug", () => {
    const { container } = renderReport(sampleCategoryFlow, sampleMerchantFlow, [
      { name: "Payroll", value: 200000 },
      { name: "Bonus", value: 50000 },
    ]);
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    const plugBar = nodes[nodes.length - 1]!;
    fireEvent.mouseMove(plugBar, { clientX: 600, clientY: 350 });
    // The plug bar and both lane-routed plug ribbons brighten; the plug
    // path touches no middle or spending target, so every group and
    // category leg dims.
    expect(plugBar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    const plugs = left.filter((l) => l.getAttribute("fill") === REMAINING_COLOR);
    expect(plugs).toHaveLength(2);
    for (const p of plugs) {
      expect(p.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    }
    for (const l of left) {
      if (l.getAttribute("fill") !== REMAINING_COLOR) {
        expect(l.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
      }
    }
    for (const l of svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')) {
      expect(l.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    }
    // Both income bars join the path (each feeds the surplus); groups and
    // spending targets dim.
    for (const bar of svg.querySelectorAll('[data-testid="sankey-income"]')) {
      expect(bar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    }
    for (const bar of svg.querySelectorAll('[data-testid="sankey-group"]')) {
      expect(bar.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    }
    nodes.forEach((n, i) => {
      if (i < nodes.length - 1) {
        expect(n.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
      }
    });
    fireEvent.mouseLeave(plugBar);
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
    // Three income→group sub-ribbons (Bills nests two categories) plus
    // three group→category ribbons; every middle and right bar draws in
    // full with no grey shortfall segment — the gap lives in the tooltip,
    // since every bar shares the same unfunded fraction.
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(6);
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
    // Bills feeds two of the three right ribbons: those brighten in place
    // while the Everyday ribbon dims — no z-reorder, so the right block
    // keeps layout order (lit, lit, dim). The right block trails 4 left
    // paths now that Bills nests two subs.
    expect(links[4]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(links[5]!.getAttribute("fill-opacity")).toBe("0.85");
    expect(links[6]!.getAttribute("fill-opacity")).toBe("0.12");
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
    // Thirty $5..$150 categories in two groups with a $10,000 income: the
    // initial load merges up to the smallest stop whose layout fits the
    // mocked 400px viewport instead of starting with amounts under the
    // fold. Merging the targets alone is not enough — the fat Remaining
    // plug and its transit lane bind the fit — so the auto-fit keeps both
    // middle rows only until $1,500, which folds the middles into one and
    // lifts the lane into the viewport.
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
    expect(slider.getAttribute("aria-valuetext")).toBe("$1,500.00");
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
    // Single middle group: $200 folds every target into one Other row and
    // the layout fits the viewport.
    expect(slider.getAttribute("aria-valuetext")).toBe("$200.00");
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
    // Right ribbons trail the 4 left paths: Bills→Mortgage is links[4].
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[4]!;
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
    // Everyday→Groceries trails the right ribbons (links[6]).
    const link = container.querySelectorAll('[data-testid="sankey-link"]')[6]!;
    expect(link.getAttribute("data-side")).toBe("right");
    fireEvent.mouseMove(link, { clientX: 500, clientY: 200 });
    // The parent group brightens to the spotlight level — the same
    // brightness as its lit ribbon — while Bills dims; the bar keeps its
    // segmented fill, only the opacity step changes.
    const groups = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(groups[1]!.getAttribute("fill")).toBe(`url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}1)`);
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

  it("stacks each income bar's category colors into its gradient at rest, with no overlay", () => {
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
    // Categories grouping: each income→group band subdivides by the
    // group's downstream categories — Payroll's Bills band nests Mortgage
    // Interest + Electric Bill, Everyday nests Groceries — so the category
    // colors drive the bar's segments, with the Remaining plug green last.
    // Two stops per sub-band, sharing the boundary offsets (hard edges).
    const stops = Array.from(
      svg.querySelectorAll(`#${SANKEY_INCOME_GRADIENT_ID_PREFIX}0 stop`)
    ).map((s) => ({
      offset: Number(s.getAttribute("offset")),
      color: s.getAttribute("stop-color"),
    }));
    const mortgage = colorForName("Mortgage Interest");
    const electric = colorForName("Electric Bill");
    const groceries = colorForName("Groceries");
    expect(stops.map((s) => s.color)).toEqual([
      mortgage,
      mortgage,
      electric,
      electric,
      groceries,
      groceries,
      REMAINING_COLOR,
      REMAINING_COLOR,
    ]);
    expect(stops[0]!.offset).toBe(0);
    expect(stops[stops.length - 1]!.offset).toBe(1);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]!.offset).toBeGreaterThanOrEqual(stops[i - 1]!.offset);
    }
    // The shared boundary offsets are the hard edges between sub-bands.
    for (const [a, b] of [
      [1, 2],
      [3, 4],
      [5, 6],
    ]) {
      expect(stops[a]!.offset).toBe(stops[b]!.offset);
      expect(stops[a]!.color).not.toBe(stops[b]!.color);
    }
    // Sub-bands nest inside their group bands: Bills ($1,150 of $2,000)
    // ends at 0.575, Everyday ($400 more) at 0.775 — each category span is
    // its exact share of the bar.
    expect(stops[1]!.offset).toBeCloseTo((100000 / 200000), 6);
    expect(stops[3]!.offset).toBeCloseTo(115000 / 200000, 6);
    expect(stops[5]!.offset).toBeCloseTo(155000 / 200000, 6);
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

  it("carries each merchant's color through the left hop in Merchants grouping", () => {
    // Through-color parity with Categories grouping: each income→group band
    // subdivides into one sub-ribbon per downstream merchant cell, in the
    // merchant's own final color — the same color flows from the merchant
    // bar on the right all the way to the income bar on the left. A merchant
    // spanning groups repeats its color down the bar (once per band it funds);
    // no group-colored ribbon survives on the left hop.
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // Left paths: Bills nests Bank of Example, Everyday nests Whole Foods +
    // Corner Shop, and the plug stays whole and green.
    const left = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
    );
    const bank = colorForName("Bank of Example");
    const whole = colorForName("Whole Foods");
    const corner = colorForName("Corner Shop");
    expect(left.map((l) => l.getAttribute("fill"))).toEqual([
      bank,
      whole,
      corner,
      REMAINING_COLOR,
    ]);
    // No group color survives on the left hop: every ribbon reads as its
    // final merchant.
    for (const name of ["Bills", "Everyday"]) {
      expect(left.some((l) => l.getAttribute("fill") === colorForName(name))).toBe(false);
    }
    // The income bar segments by the same merchant sub-ribbons — Bills
    // ($1,000 of $2,000) ends at 0.5, Whole Foods ($300 more) at 0.65,
    // Corner Shop ($200 more) at 0.75 — with the Remaining plug green last.
    // Two stops per sub-band, sharing the boundary offsets (hard edges).
    const stops = Array.from(
      svg.querySelectorAll(`#${SANKEY_INCOME_GRADIENT_ID_PREFIX}0 stop`)
    ).map((s) => ({
      offset: Number(s.getAttribute("offset")),
      color: s.getAttribute("stop-color"),
    }));
    expect(stops.map((s) => s.color)).toEqual([
      bank,
      bank,
      whole,
      whole,
      corner,
      corner,
      REMAINING_COLOR,
      REMAINING_COLOR,
    ]);
    expect(stops[0]!.offset).toBe(0);
    expect(stops[stops.length - 1]!.offset).toBe(1);
    expect(stops[1]!.offset).toBeCloseTo(100000 / 200000, 6);
    expect(stops[3]!.offset).toBeCloseTo(130000 / 200000, 6);
    expect(stops[5]!.offset).toBeCloseTo(150000 / 200000, 6);
    // Each sub-ribbon meets its bar segment pixel for pixel: parse the
    // source slices out of the paths and land them on the gradient edges.
    const bar = svg.querySelector('[data-testid="sankey-income"]')!;
    const barY = Number(bar.getAttribute("y"));
    const barH = Number(bar.getAttribute("height"));
    const edges = [stops[0]!, stops[1]!, stops[3]!, stops[5]!, stops[7]!].map(
      (s) => barY + s.offset * barH
    );
    const slices = left.map((l) => {
      const nums = (l.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      return nums.length === 32
        ? { sy0: nums[1]!, sy1: nums[31]!, ty0: nums[15]!, ty1: nums[17]! }
        : { sy0: nums[1]!, sy1: nums[15]!, ty0: nums[7]!, ty1: nums[9]! };
    });
    slices.forEach((s, i) => {
      expect(s.sy0).toBeCloseTo(edges[i]!, 1);
      expect(s.sy1).toBeCloseTo(edges[i + 1]!, 1);
      expect(s.sy1 - s.sy0).toBeCloseTo(s.ty1 - s.ty0, 2);
    });
  });

  it("nests each income→group ribbon's downstream categories so ribbons match the bar", () => {
    // Categories grouping: a blue bar segment must meet a blue ribbon of
    // the same width — never a wider brown group band. Each income→group
    // band subdivides into one sub-ribbon per downstream cell, in the
    // cell's category color, tiling the band edge to edge exactly where
    // the income gradient nests the same categories.
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const left = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]')
    );
    // Payroll's Bills band nests Mortgage Interest + Electric Bill,
    // Everyday nests Groceries, and the plug stays whole and green.
    const mortgage = colorForName("Mortgage Interest");
    const electric = colorForName("Electric Bill");
    const groceries = colorForName("Groceries");
    expect(left.map((l) => l.getAttribute("fill"))).toEqual([
      mortgage,
      electric,
      groceries,
      REMAINING_COLOR,
    ]);
    // No group color survives on the left hop: the middle groups keep
    // their own bars, but every ribbon reads as its final category.
    for (const name of ["Bills", "Everyday"]) {
      expect(left.some((l) => l.getAttribute("fill") === colorForName(name))).toBe(false);
    }
    // Each sub-ribbon is a closed bezier running left-to-right; parse
    // its source/target slices out of the path. The lane-routed plug ribbon
    // carries drop + bridge + traverse runs (32 numbers) instead of one
    // bezier (16) — its source band still opens the path and its target
    // band still sits at the target edge, just at wider indices.
    const slices = left.map((l) => {
      const nums = (l.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      return nums.length === 32
        ? { sy0: nums[1]!, sy1: nums[31]!, ty0: nums[15]!, ty1: nums[17]! }
        : { sy0: nums[1]!, sy1: nums[15]!, ty0: nums[7]!, ty1: nums[9]! };
    });
    // Source slices tile the income bar edge to edge with no gaps and
    // no taper (each sub-ribbon keeps one width end to end).
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i]!.sy0).toBeCloseTo(slices[i - 1]!.sy1, 2);
    }
    for (const s of slices) {
      expect(s.sy1 - s.sy0).toBeCloseTo(s.ty1 - s.ty0, 2);
    }
    // ... and they land exactly on the income gradient's hard edges, so
    // every bar segment meets its ribbon pixel for pixel.
    const bar = svg.querySelector('[data-testid="sankey-income"]')!;
    const barY = Number(bar.getAttribute("y"));
    const barH = Number(bar.getAttribute("height"));
    const stops = Array.from(
      svg.querySelectorAll(`#${SANKEY_INCOME_GRADIENT_ID_PREFIX}0 stop`)
    ).map((s) => barY + Number(s.getAttribute("offset")) * barH);
    const edges = [stops[0]!, stops[1]!, stops[3]!, stops[5]!, stops[7]!];
    slices.forEach((s, i) => {
      expect(s.sy0).toBeCloseTo(edges[i]!, 1);
      expect(s.sy1).toBeCloseTo(edges[i + 1]!, 1);
    });
    // Interaction stays at band level: hovering any sub-ribbon of the
    // Bills band reads as the whole Payroll → Bills band.
    fireEvent.mouseMove(left[1]!, { clientX: 400, clientY: 200 });
    const tip = document.querySelector(".y-tip")!;
    expect(tip).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("Payroll → Bills")).toBeInTheDocument();
    expect(within(tip as unknown as HTMLElement).getByText("$1,150.00")).toBeInTheDocument();
    fireEvent.mouseLeave(left[1]!);
    expect(document.querySelector(".y-tip")).toBeNull();
  });

  it("segments each middle bar by its outgoing cells so segments meet their ribbons pixel for pixel", () => {
    // Categories grouping: a blue bar segment must meet a blue ribbon of
    // the same width — never a flat group-hued bar with category-colored
    // arms leaving it. Each middle bar stacks its outgoing cells in the
    // cells' target colors, tiling the bar edge to edge exactly where the
    // right-hop ribbons leave it.
    const { container } = renderReport();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const bars = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(bars).toHaveLength(2);
    bars.forEach((bar, i) => {
      expect(bar.getAttribute("fill")).toBe(`url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${i})`);
    });
    const mortgage = colorForName("Mortgage Interest");
    const electric = colorForName("Electric Bill");
    const groceries = colorForName("Groceries");
    // Bills stacks Mortgage Interest + Electric Bill; Everyday is one
    // Groceries band, solid. Two stops per band, sharing the boundary
    // offsets (hard edges).
    const stopsOf = (i: number) =>
      Array.from(svg.querySelectorAll(`#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${i} stop`)).map(
        (s) => ({
          offset: Number(s.getAttribute("offset")),
          color: s.getAttribute("stop-color"),
        })
      );
    const billsStops = stopsOf(0);
    const everydayStops = stopsOf(1);
    expect(billsStops.map((s) => s.color)).toEqual([mortgage, mortgage, electric, electric]);
    expect(everydayStops.map((s) => s.color)).toEqual([groceries, groceries]);
    expect(everydayStops.map((s) => s.offset)).toEqual([0, 1]);
    // Right ribbons run middle-major: Bills→Mortgage, Bills→Electric,
    // Everyday→Groceries. Each is a closed bezier running left-to-right;
    // parse its source/target slices out of the path.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right).toHaveLength(3);
    const slices = right.map((l) => {
      const nums = (l.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      return {
        sy0: nums[1]!,
        sy1: nums[15]!,
        ty0: nums[7]!,
        ty1: nums[9]!,
        fill: l.getAttribute("fill"),
      };
    });
    expect(slices.map((s) => s.fill)).toEqual([mortgage, electric, groceries]);
    // No taper: each ribbon keeps one width end to end.
    for (const s of slices) {
      expect(s.sy1 - s.sy0).toBeCloseTo(s.ty1 - s.ty0, 2);
    }
    // Source slices tile each middle bar edge to edge with no gaps, and
    // land exactly on the gradient's hard edges — every bar segment meets
    // its ribbon pixel for pixel, in the same color.
    const checkBar = (barIdx: number, bandIdx: number[]) => {
      const bar = bars[barIdx]!;
      const barY = Number(bar.getAttribute("y"));
      const barH = Number(bar.getAttribute("height"));
      const stops = barIdx === 0 ? billsStops : everydayStops;
      expect(slices[bandIdx[0]!]!.sy0).toBeCloseTo(barY, 2);
      bandIdx.forEach((k, j) => {
        const s = slices[k]!;
        expect(s.sy0).toBeCloseTo(barY + stops[2 * j]!.offset * barH, 1);
        expect(s.sy1).toBeCloseTo(barY + stops[2 * j + 1]!.offset * barH, 1);
        expect(s.fill).toBe(stops[2 * j]!.color);
        if (j > 0) expect(s.sy0).toBeCloseTo(slices[bandIdx[j - 1]!]!.sy1, 2);
      });
      const last = slices[bandIdx[bandIdx.length - 1]!]!;
      expect(last.sy1).toBeCloseTo(barY + barH, 2);
    };
    checkBar(0, [0, 1]);
    checkBar(1, [2]);
  });

  it("segments middle bars by their outgoing merchants in Merchants grouping", () => {
    // Merchants span groups, but each middle→merchant cell still draws one
    // ribbon in the merchant's color — so the same segmentation serves
    // Merchants grouping with no dimension split: Bills is one Bank of
    // Example band, Everyday stacks Whole Foods + Corner Shop.
    const { container } = renderReport();
    fireEvent.click(screen.getByRole("button", { name: "Merchants", exact: true }));
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const bars = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(bars).toHaveLength(2);
    bars.forEach((bar, i) => {
      expect(bar.getAttribute("fill")).toBe(`url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${i})`);
    });
    const bank = colorForName("Bank of Example");
    const whole = colorForName("Whole Foods");
    const corner = colorForName("Corner Shop");
    const stopsOf = (i: number) =>
      Array.from(svg.querySelectorAll(`#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${i} stop`)).map(
        (s) => ({
          offset: Number(s.getAttribute("offset")),
          color: s.getAttribute("stop-color"),
        })
      );
    expect(stopsOf(0).map((s) => s.color)).toEqual([bank, bank]);
    expect(stopsOf(1).map((s) => s.color)).toEqual([whole, whole, corner, corner]);
    // Right ribbons run middle-major: Bills→Bank, Everyday→Whole,
    // Everyday→Corner. Each segment meets its ribbon pixel for pixel.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill"))).toEqual([bank, whole, corner]);
    const slices = right.map((l) => {
      const nums = (l.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      return { sy0: nums[1]!, sy1: nums[15]! };
    });
    const bands: [number, number[]][] = [
      [0, [0]],
      [1, [1, 2]],
    ];
    for (const [barIdx, idxs] of bands) {
      const bar = bars[barIdx]!;
      const barY = Number(bar.getAttribute("y"));
      const barH = Number(bar.getAttribute("height"));
      const stops = stopsOf(barIdx);
      idxs.forEach((k, j) => {
        expect(slices[k]!.sy0).toBeCloseTo(barY + stops[2 * j]!.offset * barH, 1);
        expect(slices[k]!.sy1).toBeCloseTo(barY + stops[2 * j + 1]!.offset * barH, 1);
      });
      expect(slices[idxs[0]!]!.sy0).toBeCloseTo(barY, 2);
      expect(slices[idxs[idxs.length - 1]!]!.sy1).toBeCloseTo(barY + barH, 2);
    }
  });

  it("falls back to solid group color on middle bars with no outgoing ribbons", () => {
    // No income means no ribbons at all (coverage is zero): each middle
    // bar renders at the minimum label height in its solid group color —
    // there is nothing to segment by.
    const { container } = render(
      <SpendingReport
        categoryFlow={sampleCategoryFlow}
        merchantFlow={sampleMerchantFlow}
        income={[]}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    expect(svg.querySelectorAll('[data-testid="sankey-link"]')).toHaveLength(0);
    const bars = svg.querySelectorAll('[data-testid="sankey-group"]');
    expect(bars).toHaveLength(2);
    bars.forEach((bar, i) => {
      expect(bar.getAttribute("fill")).toBe(`url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${i})`);
    });
    const stopsOf = (i: number) =>
      Array.from(svg.querySelectorAll(`#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${i} stop`)).map(
        (s) => ({
          offset: Number(s.getAttribute("offset")),
          color: s.getAttribute("stop-color"),
        })
      );
    expect(stopsOf(0)).toEqual([
      { offset: 0, color: colorForName("Bills") },
      { offset: 1, color: colorForName("Bills") },
    ]);
    expect(stopsOf(1)).toEqual([
      { offset: 0, color: colorForName("Everyday") },
      { offset: 1, color: colorForName("Everyday") },
    ]);
  });

  it("sizes shortfall bars to their funded flow, wrapping bands exactly", () => {
    // $1,000 in over $1,550 out: ~65% coverage, no Remaining. Bars wrap
    // their funded bands exactly — no label minimum lifts small bars and
    // nothing is taken from large ones to fund one.
    const { container } = render(
      <SpendingReport
        categoryFlow={sampleCategoryFlow}
        merchantFlow={sampleMerchantFlow}
        income={[{ name: "Payroll", value: 100000 }]}
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    // The 328px band splits by funded share of the $1,550 flow — not by
    // full value — down to the tiniest row, which keeps its exact funded
    // share instead of a minimum.
    const coverage = 100000 / 155000;
    const heights = Array.from(svg.querySelectorAll('[data-testid="sankey-node"]')).map(
      (n) => Number(n.getAttribute("height"))
    );
    expect(heights).toHaveLength(3);
    expect(heights[0]).toBeCloseTo(((100000 * coverage) / 155000) * 328, 6);
    expect(heights[1]).toBeCloseTo(((40000 * coverage) / 155000) * 328, 6);
    expect(heights[2]).toBeCloseTo(((15000 * coverage) / 155000) * 328, 6);
    // Middle bars wrap their funded bands the same way: Bills stacks the
    // Mortgage and Electric bands, Everyday matches Groceries.
    const midHeights = Array.from(svg.querySelectorAll('[data-testid="sankey-group"]')).map(
      (g) => Number(g.getAttribute("height"))
    );
    expect(midHeights[0]).toBeCloseTo(heights[0]! + heights[2]!, 6);
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

  // Time-aware spotlight (task-47): the Realstar/Redman shape — one group
  // spanning two eras, an early income fully consumed by early spending, a
  // late merchant funded by late income. Hovering the late merchant must
  // NOT spotlight the early income even though both route through Needs.
  const eraMerchantFlow: SpendingGroupFlow = {
    groups: [{ name: "Needs", value: 800000 }],
    targets: [
      { name: "Old Shop", value: 500000 },
      { name: "New Shop", value: 300000 },
    ],
    links: [
      { groupIndex: 0, targetIndex: 0, value: 500000 },
      { groupIndex: 0, targetIndex: 1, value: 300000 },
    ],
  };
  const eraIncome: SpendingItem[] = [
    { name: "Early Pay", value: 500000 },
    { name: "Late Pay", value: 300000 },
  ];
  const eraMerchantSeries: MonthlySankeySeries = {
    months: ["2015-06", "2020-04"],
    incomeNames: ["Early Pay", "Late Pay"],
    groupNames: ["Needs"],
    targetNames: ["Old Shop", "New Shop"],
    incomeByMonth: [
      [500000, 0],
      [0, 300000],
    ],
    cellByMonth: [
      [500000, 0],
      [0, 300000],
    ],
  };
  function renderEras() {
    // Pin the auto-fit flag so the initial load keeps the threshold off.
    sessionStorage.setItem(SANKEY_AUTOFIT_SESSION_KEY, "1");
    return render(
      <SpendingReport
        categoryFlow={emptyFlow}
        merchantFlow={eraMerchantFlow}
        income={eraIncome}
        merchantSeries={eraMerchantSeries}
        initialView="sankey"
        initialDimension="merchants"
      />
    );
  }

  it("does not spotlight the early income when hovering the late merchant", () => {
    const { container } = renderEras();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    expect(nodes).toHaveLength(2);
    fireEvent.mouseMove(nodes[1]!, { clientX: 600, clientY: 200 });
    // The late income brightens; the early income — which funded Needs only
    // for the early merchant — dims.
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    expect(incomes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    expect(incomes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    // Only the late slice out of the Needs band lights.
    const left = Array.from(svg.querySelectorAll('[data-testid="sankey-link"][data-side="left"]'));
    expect(left.map((l) => l.getAttribute("fill-opacity"))).toEqual(["0.12", "0.85"]);
    // Only the late cell lights; the group bar still joins the path.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual(["0.12", "0.85"]);
    expect(svg.querySelector('[data-testid="sankey-group"]')!.getAttribute("fill-opacity")).toBe(
      String(SANKEY_RIBBON_HOVER_OPACITY)
    );
    fireEvent.mouseLeave(nodes[1]!);
  });

  it("spotlights only the funded merchant when hovering the early income", () => {
    const { container } = renderEras();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    fireEvent.mouseMove(incomes[0]!, { clientX: 100, clientY: 200 });
    // The early merchant's cell lights in full; the late merchant dims.
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    expect(right.map((l) => l.getAttribute("fill-opacity"))).toEqual(["0.85", "0.12"]);
    const nodes = svg.querySelectorAll('[data-testid="sankey-node"]');
    expect(nodes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    expect(nodes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    fireEvent.mouseLeave(incomes[0]!);
  });

  it("traces a right ribbon back only to the incomes funding its cell", () => {
    const { container } = renderEras();
    const svg = container.querySelector('[data-testid="sankey-svg"]')!;
    const right = Array.from(
      svg.querySelectorAll('[data-testid="sankey-link"][data-side="right"]')
    );
    fireEvent.mouseMove(right[1]!, { clientX: 500, clientY: 200 });
    const incomes = svg.querySelectorAll('[data-testid="sankey-income"]');
    expect(incomes[0]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_DIM_OPACITY));
    expect(incomes[1]!.getAttribute("fill-opacity")).toBe(String(SANKEY_RIBBON_HOVER_OPACITY));
    fireEvent.mouseLeave(right[1]!);
  });
});
