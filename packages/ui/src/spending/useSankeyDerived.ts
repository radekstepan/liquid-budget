"use client";

import { useMemo } from "react";
import { STILL_HELD_GROUP_LABEL, type GroupedLeftCellLayout } from "@ynab/logic";
import {
  SANKEY_RIBBON_DIM_OPACITY,
  SANKEY_RIBBON_HOVER_OPACITY,
  SANKEY_RIBBON_OPACITY,
} from "./sankeyConstants.js";
import { isHeldTarget } from "./sankeyHelpers.js";
import type { Hover } from "./types.js";
import type { SpendingData } from "./useSpendingData.js";

export function useSankeyDerived({
  data,
  hover,
}: {
  data: SpendingData;
  hover: Hover | null;
}) {
  const { sankey, totals, merged } = data;
  // Label/tooltip rows follow the layout (which appends Remaining and drops
  // non-positive values), so labels and bars always agree. Colors come from
  // the layout's own fills — recomputing them here would let the two drift.
  const srcRows = useMemo(
    () =>
      (sankey?.sources ?? []).map((s, i) => ({
        ...s,
        flowPct:
          totals.flowTotal !== 0 ? Math.round((s.value / totals.flowTotal) * 100) : 0,
        // The layout's fill doubles as the tooltip dot. The bars themselves
        // paint their gradient stops; no single color can stand for one.
        color: s.fill,
        i,
      })),
    [sankey, totals.flowTotal]
  );
  const midRows = useMemo(
    () =>
      (sankey?.middles ?? []).map((m, i) => ({
        ...m,
        flowPct:
          totals.flowTotal !== 0 ? Math.round((m.value / totals.flowTotal) * 100) : 0,
        // The layout's fill doubles as the tooltip dot. The bars themselves
        // paint their gradient stops; no single color can stand for one.
        color: m.fill,
        // How many right-column rows this group feeds (distinct targets —
        // one ribbon per group→target cell).
        memberCount: new Set(
          sankey?.linksRight.filter((l) => l.sourceIndex === i).map((l) => l.targetIndex)
        ).size,
        i,
      })),
    [sankey, totals.flowTotal]
  );
  const tgtRows = useMemo(() => {
    const targets = sankey?.targets ?? [];
    return targets.map((t, i) => {
      // By position, never by name: a literal "Remaining" category is
      // still just a category.
      const isPlug = sankey?.remainingTargetIndex === i;
      return {
        ...t,
        flowPct:
          totals.flowTotal !== 0 ? Math.round((t.value / totals.flowTotal) * 100) : 0,
        // The layout's fill, shared with every incoming ribbon: the line
        // into this bar reads as one color throughout, whichever middle
        // group each ribbon arrives from.
        color: t.fill,
        isPlug,
        i,
      };
    });
  }, [sankey, totals.flowTotal]);

  // Subdivided left-hop bands grouped for band-level hover: the layout's
  // leftCells carry their own paths and fills (rendered verbatim below),
  // and this only groups them so each band stays one hover target.
  const leftCellsByBand = useMemo(() => {
    const groups = new Map<string, GroupedLeftCellLayout[]>();
    if (sankey == null) return groups;
    for (const c of sankey.leftCells) {
      const key = `${c.sourceIndex}:${c.middleIndex}`;
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    return groups;
  }, [sankey]);

  // Right-column targets that are 100% held money (Sankey indices): kept
  // non-plug rows whose every incoming cell routes through the Still-held
  // pseudo-group (see isHeldTarget). Buckets stay out even when every
  // folded row was held — a bucket is mixed by definition, and mixed
  // elements never hatch. Drives the held hatch on target bars, right-hop
  // ribbons into these targets, and left-hop sub-ribbons funding them.
  const heldTargets = useMemo(() => {
    const set = new Set<number>();
    if (sankey == null) return set;
    for (let i = 0; i < sankey.targets.length; i++) {
      if (i === sankey.remainingTargetIndex) continue;
      if (sankey.targets[i]?.bucket === true) continue;
      if (
        isHeldTarget(
          sankey.linksRight.filter((l) => l.targetIndex === i).map((l) => l.sourceIndex),
          (g) => sankey.middles[g]?.name
        )
      ) {
        set.add(i);
      }
    }
    return set;
  }, [sankey]);

  // Kept Still-held pseudo-group bars that are 100% held money (Sankey
  // middle indices): every outgoing cell lands in a held target or a
  // merged bucket (a bucket may have folded held rows — the money leaving
  // this bar through that link is still held). In real data the Still-held
  // group carries only held cells, so this is exactly the kept bar; the
  // outgoing check keeps the whole-held rule exact instead of trusting
  // the name alone.
  const heldMiddles = useMemo(() => {
    const set = new Set<number>();
    if (sankey == null) return set;
    sankey.middles.forEach((m, i) => {
      if (m.bucket === true || m.name !== STILL_HELD_GROUP_LABEL) return;
      const outs = sankey.linksRight.filter((l) => l.sourceIndex === i);
      if (
        outs.length > 0 &&
        outs.every(
          (l) =>
            heldTargets.has(l.targetIndex) ||
            sankey.targets[l.targetIndex]?.bucket === true
        )
      ) {
        set.add(i);
      }
    });
    return set;
  }, [sankey, heldTargets]);

  // Same rule over the merged columns for the Bars rows (merged target
  // indices — the same indices the Bars rows and tooltips use).
  const heldBars = useMemo(() => {
    const set = new Set<number>();
    merged.targets.forEach((t, i) => {
      if (t.bucket === true) return;
      if (
        isHeldTarget(
          merged.links.filter((l) => l.targetIndex === i).map((l) => l.groupIndex),
          (g) => merged.groups[g]?.name
        )
      ) {
        set.add(i);
      }
    });
    return set;
  }, [merged]);

  // Right-column rows whose ribbons hatch with the BUCKET pattern: a
  // merged Other bucket target or the Remaining plug (by position, never
  // by name). Held rows hatch under their own testid instead (see
  // heldTargets); the sets are disjoint, so a ribbon never
  // double-hatches. Destination-driven: a ribbon hatches iff the money
  // it carries ENDS IN (right-hop) or FUNDS (left-hop) one of these
  // rows — the middle it routes through never matters, so a ribbon out
  // of a middle bucket into a real target stays solid.
  const isBucketOrPlugTarget = (t: number): boolean =>
    sankey?.targets[t]?.bucket === true || t === (sankey?.remainingTargetIndex ?? -1);

  // Per-income-bar hatch spans for the derived-money segments: every
  // left-hop sub-ribbon funding a held, bucket, or plug cell hatches its
  // source span (like the sub itself), and every plug-lane band hatches
  // its source span (the plug ribbon hatches, so the bar segment it
  // leaves hatches too). Spans reuse the layout's own sy0/sy1 — the same
  // spans the bar's gradient segments paint — mapped verbatim, never
  // recomputed. Degenerate whole bands into a middle stay solid: a middle
  // is never a hatched row. One span per hatched sub/band (no merging),
  // so each overlay maps 1:1 to its hatched ribbon.
  const sourceHatchSpans = useMemo(() => {
    const spans: { y0: number; y1: number; held: boolean }[][] = (
      sankey?.sources ?? []
    ).map(() => []);
    if (sankey == null) return spans;
    for (const c of sankey.leftCells) {
      if (!(c.sy1 > c.sy0)) continue;
      const held = heldTargets.has(c.targetIndex);
      // Same rule as isBucketOrPlugTarget, inlined so the memo deps stay
      // honest (the helper itself is re-created every render).
      const bucketOrPlug =
        sankey.targets[c.targetIndex]?.bucket === true ||
        c.targetIndex === sankey.remainingTargetIndex;
      if (!held && !bucketOrPlug) continue;
      spans[c.sourceIndex]?.push({ y0: c.sy0, y1: c.sy1, held });
    }
    for (const l of sankey.linksLeft) {
      if (l.targetIndex !== sankey.middles.length) continue;
      if (!(l.sy1 > l.sy0)) continue;
      spans[l.sourceIndex]?.push({ y0: l.sy0, y1: l.sy1, held: false });
    }
    for (const list of spans) list.sort((a, b) => a.y0 - b.y0);
    return spans;
  }, [sankey, heldTargets]);

  // Per-middle-bar hatch spans for the derived-money segments: the same
  // rule as the income bars, one column over — every outgoing cell into
  // a held, bucket, or plug target hatches its source span (the same
  // spans the bar's gradient segments and right-hop ribbons paint),
  // mapped verbatim from the layout's own linksRight geometry. One span
  // per hatched cell, so each overlay maps 1:1 to its hatched ribbon.
  const middleHatchSpans = useMemo(() => {
    const spans: { y0: number; y1: number; held: boolean }[][] = (
      sankey?.middles ?? []
    ).map(() => []);
    if (sankey == null) return spans;
    for (const l of sankey.linksRight) {
      if (!(l.sy1 > l.sy0)) continue;
      const held = heldTargets.has(l.targetIndex);
      const bucketOrPlug =
        sankey.targets[l.targetIndex]?.bucket === true ||
        l.targetIndex === sankey.remainingTargetIndex;
      if (!held && !bucketOrPlug) continue;
      spans[l.sourceIndex]?.push({ y0: l.sy0, y1: l.sy1, held });
    }
    for (const list of spans) list.sort((a, b) => a.y0 - b.y0);
    return spans;
  }, [sankey, heldTargets]);

  // Connected-highlight sets per hover (null = unconstrained, everything
  // stays at rest opacity). Hovering any bar spotlights its flow path: an
  // income lights every line leading from it — its left ribbons plus the
  // downstream cells it actually funds (its sub-ribbons), each in full —
  // and only the other incomes' bars dim; a target lights itself, EVERY
  // cell arriving at it (including ribbons from non-dominant parent
  // groups), every parent group feeding those cells, and the income
  // ribbons feeding those groups — so a merchant split across groups
  // traces its full path, never a single home — while each income bar
  // lights only when one of its slices into the target lights, so an
  // income that never funded the target stays dim even when it funded the
  // target's group for other rows; a group lights every line leading into
  // it from every income plus every line leading out of it, with the bars
  // on both ends. Ribbon hovers trace the through-line end to end: a right
  // ribbon lights its group and target plus the left sub-ribbons funding
  // that cell (one income CAN be traced through it — the cell's own
  // slices), and a left ribbon lights the cells its band's slices
  // continue into. Spotlighted ribbons brighten in place — brightness
  // alone carries the spotlight, never paint order.
  const hl = useMemo(() => {
    const none = {
      src: null as Set<number> | null,
      mid: null as Set<number> | null,
      tgt: null as Set<number> | null,
      ll: null as Set<string> | null,
      rl: null as Set<string> | null,
    };
    if (!hover || hover.kind === "bar" || !sankey) return none;
    const key = (a: number, b: number) => `${a}:${b}`;
    const midCount = sankey.middles.length;
    if (hover.kind === "income") {
      const ll = new Set<string>();
      const rl = new Set<string>();
      const mid = new Set<number>();
      const tgt = new Set<number>();
      for (const l of sankey.linksLeft) {
        if (l.sourceIndex !== hover.idx) continue;
        ll.add(key(l.sourceIndex, l.targetIndex));
        if (l.targetIndex < midCount) mid.add(l.targetIndex);
        else if (sankey.remainingTargetIndex != null) tgt.add(sankey.remainingTargetIndex);
      }
      // Only the cells this income actually funds (its sub-ribbons) light —
      // each in full. Under the legacy proportional split that is every
      // cell, so this matches the old "every line" behavior there.
      for (const c of sankey.leftCells) {
        if (c.sourceIndex !== hover.idx) continue;
        rl.add(key(c.middleIndex, c.targetIndex));
        tgt.add(c.targetIndex);
      }
      return { src: new Set([hover.idx]), mid, tgt, ll, rl };
    }
    if (hover.kind === "group") {
      const ll = new Set<string>();
      const rl = new Set<string>();
      const src = new Set<number>();
      const tgt = new Set<number>();
      for (const l of sankey.linksLeft) {
        if (l.targetIndex !== hover.idx) continue;
        ll.add(key(l.sourceIndex, l.targetIndex));
        src.add(l.sourceIndex);
      }
      for (const l of sankey.linksRight) {
        if (l.sourceIndex !== hover.idx) continue;
        rl.add(key(l.sourceIndex, l.targetIndex));
        tgt.add(l.targetIndex);
      }
      return { src, mid: new Set([hover.idx]), tgt, ll, rl };
    }
    if (hover.kind === "node") {
      // Every ribbon arriving at the target lights — including cells from
      // non-dominant parent groups — plus every group feeding those cells
      // and the income ribbons feeding those groups. A single dominant
      // path used to spotlight here, leaving the smaller legs of a
      // merchant split across groups dim; the full path is the target's
      // whole story, so it all lights.
      const isPlug = sankey.remainingTargetIndex === hover.idx;
      const rl = new Set<string>();
      const mid = new Set<number>();
      for (const l of sankey.linksRight) {
        if (l.targetIndex !== hover.idx) continue;
        rl.add(key(l.sourceIndex, l.targetIndex));
        mid.add(l.sourceIndex);
      }
      const ll = new Set<string>();
      for (const l of sankey.linksLeft) {
        const plugLink = l.targetIndex >= midCount;
        if (isPlug ? !plugLink : !mid.has(l.targetIndex)) continue;
        ll.add(key(l.sourceIndex, l.targetIndex));
      }
      // An income bar lights only when one of its slices into the target
      // lights (band AND cell on the path — the same predicate as
      // leftCellLit below): funding the target's group for other rows is
      // not enough. The plug path keeps its band sources (plug bands have
      // no slices). Under the legacy split every band slices into every
      // cell, so this matches the old band-level behavior there.
      const src = new Set<number>();
      if (isPlug) {
        for (const l of sankey.linksLeft) {
          if (l.targetIndex >= midCount) src.add(l.sourceIndex);
        }
      } else {
        for (const c of sankey.leftCells) {
          if (c.targetIndex !== hover.idx || !mid.has(c.middleIndex)) continue;
          if (!ll.has(key(c.sourceIndex, c.middleIndex))) continue;
          src.add(c.sourceIndex);
        }
      }
      return { src, mid, tgt: new Set([hover.idx]), ll, rl };
    }
    // Ribbon hover: the ribbon plus its endpoint bars.
    if (hover.side === "left") {
      const isPlug = hover.b >= midCount;
      // A group-bound left ribbon continues through its middle as the cells
      // its band's slices fund; a plug ribbon ends at Remaining. Under the
      // legacy split that is every cell out of the middle.
      const contKeys = new Set<string>();
      const contTgt = new Set<number>();
      if (!isPlug) {
        for (const c of sankey.leftCells) {
          if (c.sourceIndex !== hover.a || c.middleIndex !== hover.b) continue;
          contKeys.add(key(c.middleIndex, c.targetIndex));
          contTgt.add(c.targetIndex);
        }
      }
      return {
        src: new Set([hover.a]),
        mid: isPlug ? new Set<number>() : new Set([hover.b]),
        tgt:
          isPlug && sankey.remainingTargetIndex != null
            ? new Set([sankey.remainingTargetIndex])
            : contTgt,
        ll: new Set([key(hover.a, hover.b)]),
        rl: contKeys,
      };
    }
    // The through-line runs back through the left slices funding this cell:
    // only incomes with a slice in it light. Under the legacy split that
    // is every left ribbon feeding its middle.
    const rk = sankey.linksRight.findIndex(
      (l) => l.sourceIndex === hover.a && l.targetIndex === hover.b
    );
    const backSrc = new Set<number>();
    const backLl = new Set<string>();
    if (rk >= 0) {
      for (const c of sankey.leftCells) {
        if (c.rightLinkIndex !== rk) continue;
        backSrc.add(c.sourceIndex);
        backLl.add(key(c.sourceIndex, c.middleIndex));
      }
    }
    return {
      src: backSrc,
      mid: new Set([hover.a]),
      tgt: new Set([hover.b]),
      ll: backLl,
      rl: new Set([key(hover.a, hover.b)]),
    };
  }, [hover, sankey]);

  const hoverBarIdx = hover != null && hover.kind === "bar" ? hover.idx : null;

  // Spotlight state per ribbon: while a flow path is hovered (the hl sets
  // are non-null) ribbons in the path brighten and the rest dims; with no
  // path hover every ribbon sits at rest opacity.
  const leftLit = (a: number, b: number) =>
    hl.ll != null && hl.ll.has(`${a}:${b}`);
  const rightLit = (a: number, b: number) =>
    hl.rl != null && hl.rl.has(`${a}:${b}`);
  // Sub-ribbon spotlight: a subdivided band's subs each feed one downstream
  // cell, so a sub lights only when BOTH its band and its cell sit on the
  // hovered path. Hovering a target (or one of its cell ribbons) lights that
  // target's slices — never the sibling categories nested in the same bands.
  // Income, group, and left-ribbon hovers light every downstream cell of
  // their bands, so all subs of a lit band still light there, unchanged.
  const leftCellLit = (s: GroupedLeftCellLayout) =>
    hl.ll != null &&
    hl.rl != null &&
    hl.ll.has(`${s.sourceIndex}:${s.middleIndex}`) &&
    hl.rl.has(`${s.middleIndex}:${s.targetIndex}`);
  const ribbonOpacity = (lit: boolean, active: boolean) =>
    !active
      ? SANKEY_RIBBON_OPACITY
      : lit
        ? SANKEY_RIBBON_HOVER_OPACITY
        : SANKEY_RIBBON_DIM_OPACITY;

  // Z-order is stable: ribbons always render in layout order, hovered or
  // not — the spotlight never re-sequences the DOM. That is what makes the
  // brightness cross-fade flash-safe: with no reorder there is no instant
  // final z-order to show at pre-transition brightness (the task-29
  // flash), so the steps can glide instead of snapping. The off-path wash
  // sits far below rest, so a lit leg painting under a nearly-transparent
  // dim leg reads pure. (An earlier design rendered lit legs above the dim
  // rest; brightness alone reads the same at these steps without the
  // reorder.)
  const linksLeft = sankey?.linksLeft ?? [];
  const linksRight = sankey?.linksRight ?? [];

  return {
    srcRows,
    midRows,
    tgtRows,
    leftCellsByBand,
    heldTargets,
    heldMiddles,
    heldBars,
    isBucketOrPlugTarget,
    sourceHatchSpans,
    middleHatchSpans,
    hl,
    hoverBarIdx,
    leftLit,
    rightLit,
    leftCellLit,
    ribbonOpacity,
    linksLeft,
    linksRight,
  };
}

export type SankeyDerived = ReturnType<typeof useSankeyDerived>;
