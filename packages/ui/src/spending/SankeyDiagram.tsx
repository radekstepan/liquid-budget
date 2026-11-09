"use client";

import { Fragment } from "react";
import { fmt, showSankeySourceAmount, SANKEY_PAD_TOP } from "@ynab/logic";
import { SankeyBucketHatchPattern } from "../chartUtils.js";
import {
  SANKEY_BUCKET_HATCH_ID,
  SANKEY_INCOME_GRADIENT_ID_PREFIX,
  SANKEY_MIDDLE_GRADIENT_ID_PREFIX,
  SANKEY_RIBBON_DIM_OPACITY,
  SANKEY_RIBBON_HOVER_OPACITY,
  SANKEY_RIBBON_OPACITY,
} from "./sankeyConstants.js";
import { truncateName } from "./sankeyHelpers.js";
import type { Hover } from "./types.js";
import type { SpendingData } from "./useSpendingData.js";
import type { SankeyDerived } from "./useSankeyDerived.js";
import type { SpendingFilters } from "./useSpendingFilters.js";

export function SankeyDiagram({
  filters,
  data,
  derived,
  chartRef,
  chartSize,
  transitionMs,
  pushHover,
}: {
  filters: SpendingFilters;
  data: SpendingData;
  derived: SankeyDerived;
  chartRef: (node: HTMLDivElement | null) => void;
  chartSize: { width: number; height: number };
  transitionMs: number;
  pushHover: (hover: Hover | null) => void;
}) {
  const { dimension } = filters;
  const { sankeyEmpty, sankey, contentH, sourceLabelMaxChars } = data;
  const {
    linksLeft,
    linksRight,
    leftCellsByBand,
    leftLit,
    rightLit,
    leftCellLit,
    ribbonOpacity,
    hl,
    heldTargets,
    heldMiddles,
    isBucketOrPlugTarget,
    srcRows,
    midRows,
    tgtRows,
    sourceHatchSpans,
    middleHatchSpans,
  } = derived;
  return (
        <div
          ref={chartRef}
          className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto y-scroll"
          style={{
            background: "linear-gradient(#ffffff, #f7f7f4)",
            // The SVG is sized exactly to this box, so horizontal scrolling
            // is never legitimate — clip it (a stray horizontal bar steals
            // vertical space and re-flows the chart). Reserve the vertical
            // gutter so a scrollbar appearing mid-session (threshold slider,
            // new data) never steps the width: the first paint is final.
            scrollbarGutter: "stable",
          }}
          onMouseLeave={() => pushHover(null)}
        >
          {sankeyEmpty && (
            <div className="grid h-full place-items-center y-hint">No data for this timeframe.</div>
          )}
          {!sankeyEmpty && sankey != null && chartSize.width > 0 && chartSize.height > 0 && (
            <svg
              data-testid="sankey-svg"
              width={chartSize.width}
              // The canvas fits the layout's own contentHeight (tallest
              // column or the transit-only Remaining lane, plus the bottom
              // pad) — never the row-count heuristic alone, which undercovers
              // fat bars and would clip them. Same geometry, no re-layout.
              height={Math.max(contentH, sankey.contentHeight)}
              className="block"
            >
              <defs>
                <SankeyBucketHatchPattern id={SANKEY_BUCKET_HATCH_ID} />
                {/* Bar fills come from the layout's own gradient stops,
                    rendered verbatim — the stops already tile each bar so
                    every segment meets its ribbon exactly. */}
                {sankey.sourceFills.map((stops, idx) => (
                  <linearGradient
                    key={`income-${idx}`}
                    id={`${SANKEY_INCOME_GRADIENT_ID_PREFIX}${idx}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    {stops.map((s, k) => (
                      <stop key={k} offset={s.offset} stopColor={s.color} />
                    ))}
                  </linearGradient>
                ))}
                {sankey.middleFills.map((stops, idx) => (
                  <linearGradient
                    key={`middle-${idx}`}
                    id={`${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${idx}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    {stops.map((s, k) => (
                      <stop key={k} offset={s.offset} stopColor={s.color} />
                    ))}
                  </linearGradient>
                ))}
              </defs>
              {/* Column headers: each column names what it holds, so the
                  chart reads without prior knowledge (left is income
                  received — not surplus — middle groups route it, right is
                  where it went). Plain labels — no hover. */}
              {(
                [
                  { col: "income" as const, label: "Income", node: sankey.sources[0] },
                  { col: "group" as const, label: "Groups", node: sankey.middles[0] },
                  {
                    col: "target" as const,
                    label: dimension === "categories" ? "Categories" : "Merchants",
                    node: sankey.targets[0],
                  },
                ] satisfies { col: "income" | "group" | "target"; label: string; node: { x: number; w: number } | undefined }[]
              ).map(
                (h) =>
                  h.node != null && (
                    <text
                      key={h.col}
                      data-testid="sankey-colhead"
                      data-col={h.col}
                      x={h.node.x + h.node.w / 2}
                      y={SANKEY_PAD_TOP - 10}
                      fontSize={10}
                      textAnchor="middle"
                      fill="var(--y-ink-faint)"
                      style={{ letterSpacing: "0.08em" }}
                    >
                      {h.label.toUpperCase()}
                    </text>
                  )
              )}
              {linksLeft.map((link) => {
                const subs = leftCellsByBand.get(`${link.sourceIndex}:${link.targetIndex}`);
                const lit = leftLit(link.sourceIndex, link.targetIndex);
                const opacity = ribbonOpacity(lit, hl.ll != null);
                const hoverPayload = (x: number, y: number) => ({
                  kind: "link" as const,
                  side: "left" as const,
                  a: link.sourceIndex,
                  b: link.targetIndex,
                  x,
                  y,
                });
                // A subdivided band renders one sub-ribbon per downstream
                // cell from the layout's own paths and fills — the band
                // stays one hover target (handlers on the wrapping <g>, so
                // moving between sub-ribbons never flickers the spotlight),
                // but each sub carries its own spotlight key: its band's AND
                // its downstream cell's, so a target hover lights only that
                // target's slices out of the shared bands.
                if (subs != null) {
                  return (
                    <g
                      key={`ll-${link.sourceIndex}-${link.targetIndex}`}
                      style={{ cursor: "pointer" }}
                      onMouseMove={(e) => pushHover(hoverPayload(e.clientX, e.clientY))}
                      onMouseLeave={() => pushHover(null)}
                    >
                      {subs.map((s, si) => (
                        <Fragment key={`llsub-${si}`}>
                          <path
                            data-testid="sankey-link"
                            data-side="left"
                            d={s.d}
                            fill={s.fill}
                            fillOpacity={ribbonOpacity(leftCellLit(s), hl.ll != null)}
                            stroke="none"
                            style={{
                              transition: `fill-opacity ${transitionMs}ms`,
                            }}
                          />
                          {/* Sub-ribbons funding a held cell carry the shared
                              hatch over the layout's own path (per-sub
                              granularity, like the spotlight: siblings
                              funding spending cells stay solid) — same
                              opacity step and cross-fade as the solid sub, so
                              the overlay brightens and dims with it. */}
                          {heldTargets.has(s.targetIndex) && (
                            <path
                              data-testid="sankey-held-hatch"
                              data-side="left"
                              d={s.d}
                              fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                              fillOpacity={ribbonOpacity(leftCellLit(s), hl.ll != null)}
                              stroke="none"
                              pointerEvents="none"
                              style={{
                                transition: `fill-opacity ${transitionMs}ms`,
                              }}
                            />
                          )}
                          {/* Sub-ribbons funding a bucket-target or plug cell
                              carry the same shared hatch under the bucket
                              testid (per-sub granularity, like the held
                              overlays: siblings funding real-category cells
                              in the same band stay solid) — same opacity step
                              and cross-fade as the solid sub. Disjoint from
                              the held set (see isBucketOrPlugTarget), so a
                              sub never double-hatches. */}
                          {isBucketOrPlugTarget(s.targetIndex) && (
                            <path
                              data-testid="sankey-bucket-hatch"
                              data-side="left"
                              d={s.d}
                              fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                              fillOpacity={ribbonOpacity(leftCellLit(s), hl.ll != null)}
                              stroke="none"
                              pointerEvents="none"
                              style={{
                                transition: `fill-opacity ${transitionMs}ms`,
                              }}
                            />
                          )}
                        </Fragment>
                      ))}
                    </g>
                  );
                }
                // Whole bands (the Remaining plug and the degenerate fallback)
                // render the layout's own path and fill: one flat ribbon
                // through the whole length, and the income side never colors
                // one.
                const solid = (
                  <path
                    data-testid="sankey-link"
                    data-side="left"
                    d={link.d}
                    fill={link.fill}
                    fillOpacity={opacity}
                    stroke="none"
                    style={{
                      cursor: "pointer",
                      transition: `fill-opacity ${transitionMs}ms`,
                    }}
                    onMouseMove={(e) => pushHover(hoverPayload(e.clientX, e.clientY))}
                    onMouseLeave={() => pushHover(null)}
                  />
                );
                // Only the full-width plug-lane ribbons hatch: b is the plug
                // index (one past the last middle). Degenerate whole bands
                // into a middle stay solid — the hatch follows the
                // destination, and a middle is never a hatched target row.
                if (link.targetIndex !== (sankey?.middles.length ?? -1)) {
                  return (
                    <Fragment key={`ll-${link.sourceIndex}-${link.targetIndex}`}>{solid}</Fragment>
                  );
                }
                // Plug-lane ribbons overlay the SAME layout path with the
                // shared hatch — same opacity step and cross-fade as the
                // solid ribbon, so the overlay brightens and dims with it.
                // Static DOM order (no z-reorder); pointer-events none so
                // hover still hits the solid ribbon beneath.
                return (
                  <Fragment key={`ll-${link.sourceIndex}-${link.targetIndex}`}>
                    {solid}
                    <path
                      data-testid="sankey-bucket-hatch"
                      data-side="left"
                      d={link.d}
                      fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                      fillOpacity={opacity}
                      stroke="none"
                      pointerEvents="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                  </Fragment>
                );
              })}
              {linksRight.map((link) => {
                // One ribbon per group→target cell, rendered from the
                // layout's own path and fill: each ribbon reads as where
                // the money lands, no matter which middle group it comes
                // from — hovering one traces its through-line end to end.
                const lit = rightLit(link.sourceIndex, link.targetIndex);
                const held = heldTargets.has(link.targetIndex);
                const bucket = !held && isBucketOrPlugTarget(link.targetIndex);
                const solid = (
                  <path
                    data-testid="sankey-link"
                    data-side="right"
                    d={link.d}
                    fill={link.fill}
                    fillOpacity={ribbonOpacity(lit, hl.rl != null)}
                    stroke="none"
                    style={{
                      cursor: "pointer",
                      transition: `fill-opacity ${transitionMs}ms`,
                    }}
                    onMouseMove={(e) =>
                      pushHover({
                        kind: "link",
                        side: "right",
                        a: link.sourceIndex,
                        b: link.targetIndex,
                        x: e.clientX,
                        y: e.clientY,
                      })
                    }
                    onMouseLeave={() => pushHover(null)}
                  />
                );
                if (!held && !bucket) {
                  return (
                    <Fragment key={`rl-${link.sourceIndex}-${link.targetIndex}`}>{solid}</Fragment>
                  );
                }
                // Ribbons into a held, bucket, or plug target overlay the
                // SAME layout path with the shared hatch — same opacity step
                // and cross-fade as the solid ribbon, so the overlay
                // brightens and dims with it. Static DOM order (no
                // z-reorder); pointer-events none so hover still hits the
                // solid ribbon beneath. One overlay at most: the held and
                // bucket/plug target sets are disjoint, and ribbons into
                // real targets from any middle (even a middle bucket) stay
                // solid — the hatch follows the destination.
                return (
                  <Fragment key={`rl-${link.sourceIndex}-${link.targetIndex}`}>
                    {solid}
                    <path
                      data-testid={held ? "sankey-held-hatch" : "sankey-bucket-hatch"}
                      data-side="right"
                      d={link.d}
                      fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                      fillOpacity={ribbonOpacity(lit, hl.rl != null)}
                      stroke="none"
                      pointerEvents="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                  </Fragment>
                );
              })}
              {sankey.sources.map((node, idx) => {
                const r = srcRows[idx]!;
                // Each income bar fills with its own gradient — never flat
                // gray, never a hover overlay, never a border. In both
                // groupings the segments are the downstream cells' target
                // colors, so every segment meets its sub-ribbon exactly. The
                // merged Other bucket adds the render-only hatch. The bar
                // joins the flow-path spotlight at the ribbons' own
                // brightness steps.
                const isBucket = r.bucket === true;
                const lit = hl.src != null && hl.src.has(idx);
                const dim = hl.src != null && !hl.src.has(idx);
                const barOpacity = hl.src == null
                  ? SANKEY_RIBBON_OPACITY
                  : lit
                    ? SANKEY_RIBBON_HOVER_OPACITY
                    : SANKEY_RIBBON_DIM_OPACITY;
                // Labels anchor at the layout's own labelY verbatim — never
                // recomputed here, so hairline bars keep their labels clear
                // of neighbors instead of centered on the sliver.
                const labelY = node.labelY;
                // Bars too short for two lines show the name only, centered
                // on the bar; taller bars keep name + amount.
                const twoLine = showSankeySourceAmount(node.h);
                // One hover target per row, like the right column: the <g>
                // owns the row's hover, so the bar, name, and amount all
                // spotlight the same path and moving between them never fires
                // leave+enter (spotlight flicker). The transparent hit band
                // bridges the dead space between the parts — the bar→label
                // gap and the space between the two label lines — so the
                // whole row band holds the hover. It spans the bar's exact
                // vertical extent (adjacent rows never overlap) and runs
                // from the SVG's left edge to the bar's right edge; nothing
                // else interactive lives in the left gutter. Rendered
                // beneath the bar and labels; invisible.
                return (
                  <g
                    key={`src-${node.name}-${idx}`}
                    style={{ cursor: "pointer" }}
                    onMouseMove={(e) =>
                      pushHover({ kind: "income", idx, x: e.clientX, y: e.clientY })
                    }
                    onMouseLeave={() => pushHover(null)}
                  >
                    <rect
                      data-testid="sankey-income-hit"
                      x={0}
                      y={node.y}
                      width={node.x + node.w}
                      height={Math.max(0, node.h)}
                      fill="transparent"
                    />
                    <rect
                      data-testid="sankey-income"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={`url(#${SANKEY_INCOME_GRADIENT_ID_PREFIX}${idx})`}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                    {isBucket && (
                      <rect
                        data-testid="sankey-bucket-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    {/* Derived-money segments hatch like their ribbons —
                        held spans under the held testid, bucket/plug spans
                        under the bucket one (disjoint, like the sub
                        overlays). Skipped on whole-bucket bars, which
                        already hatch end to end. Overlays ride the bar's
                        own opacity step, so the segments brighten and dim
                        with the bar instead of stroking it. */}
                    {!isBucket &&
                      (sourceHatchSpans[idx] ?? []).map((s, k) => (
                        <rect
                          key={`hatch-${k}`}
                          data-testid={s.held ? "sankey-held-hatch" : "sankey-bucket-hatch"}
                          x={node.x}
                          y={s.y0}
                          width={node.w}
                          height={Math.max(0, s.y1 - s.y0)}
                          fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                          fillOpacity={barOpacity}
                          pointerEvents="none"
                          style={{
                            transition: `fill-opacity ${transitionMs}ms`,
                          }}
                        />
                      ))}
                    <text
                      data-testid="sankey-income-label"
                      x={sankey.sourceLabelX}
                      y={twoLine ? labelY - 2 : labelY + 4}
                      fontSize={12}
                      textAnchor="end"
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {truncateName(node.name, sourceLabelMaxChars)}
                    </text>
                    {twoLine && (
                      <text
                        data-testid="sankey-income-amount"
                        x={sankey.sourceLabelX}
                        y={labelY + 13}
                        fontSize={11}
                        textAnchor="end"
                        fill="var(--y-ink-faint)"
                        className="y-num"
                        opacity={dim ? 0.4 : 1}
                        style={{
                          transition: `opacity ${transitionMs}ms`,
                        }}
                      >
                        {fmt(node.value)} · {r.flowPct}%
                      </text>
                    )}
                  </g>
                );
              })}
              {sankey.middles.map((node, idx) => {
                const r = midRows[idx]!;
                const isBucket = r.bucket === true;
                // Parent groups join the flow-path spotlight at the ribbons'
                // own brightness steps: rest opacity at rest, bright when the
                // hovered path runs through them, dimmed otherwise.
                const lit = hl.mid != null && hl.mid.has(idx);
                const dim = hl.mid != null && !hl.mid.has(idx);
                const barOpacity = hl.mid == null
                  ? SANKEY_RIBBON_OPACITY
                  : lit
                    ? SANKEY_RIBBON_HOVER_OPACITY
                    : SANKEY_RIBBON_DIM_OPACITY;
                // Labels anchor at the layout's own labelY verbatim — never
                // recomputed here, so hairline bars keep their labels clear
                // of neighbors instead of centered on the sliver.
                const labelY = node.labelY;
                // One hover target per row, like the other columns: the <g>
                // owns the row's hover, so the bar, name, and amount all
                // spotlight the same path and moving between them never fires
                // leave+enter (spotlight flicker). Deliberately no hit band
                // bridging the bar→label gap: the middle labels sit in the
                // ribbon zone, so a band painted with this row (above the
                // ribbons) would swallow the ribbon hovers crossing it.
                // Instead the ribbons beneath catch most gap pixels — the
                // bands tile the bar's full height at its right edge, so
                // bar→label travel passes through ribbon pixels (a correct
                // switch to the ribbon, not a blink) — and the unified <g>
                // kills the part↔part leave+enter outright.
                return (
                  <g
                    key={`mid-${node.name}-${idx}`}
                    style={{ cursor: "pointer" }}
                    onMouseMove={(e) =>
                      pushHover({ kind: "group", idx, x: e.clientX, y: e.clientY })
                    }
                    onMouseLeave={() => pushHover(null)}
                  >
                    {/* Each middle bar fills with its own gradient — never
                        flat group color, never a hover overlay, never a
                        border. The segments are the outgoing cells' target
                        colors, so every segment meets its ribbon exactly,
                        like the income bars. The merged Other bucket adds
                        only the shared hatch (as does the Still-held group
                        bar). The bar wraps the group's
                        funded flow; when spending exceeds income the gap
                        shows in the tooltip, not as a grey segment. */}
                    <rect
                      data-testid="sankey-group"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={`url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${idx})`}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                    {isBucket && (
                      <rect
                        data-testid="sankey-bucket-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    {/* A whole-held Still-held group bar carries the shared
                        hatch like the bucket bars (see heldMiddles). */}
                    {heldMiddles.has(idx) && (
                      <rect
                        data-testid="sankey-held-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    {/* Derived-money segments hatch like their ribbons —
                        held spans under the held testid, bucket/plug spans
                        under the bucket one (disjoint, like the right-hop
                        overlays). Skipped on whole-hatched bars, which
                        already hatch end to end. Overlays ride the bar's
                        own opacity step, so the segments brighten and dim
                        with the bar instead of stroking it. */}
                    {!isBucket &&
                      !heldMiddles.has(idx) &&
                      (middleHatchSpans[idx] ?? []).map((s, k) => (
                        <rect
                          key={`hatch-${k}`}
                          data-testid={s.held ? "sankey-held-hatch" : "sankey-bucket-hatch"}
                          x={node.x}
                          y={s.y0}
                          width={node.w}
                          height={Math.max(0, s.y1 - s.y0)}
                          fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                          fillOpacity={barOpacity}
                          pointerEvents="none"
                          style={{
                            transition: `fill-opacity ${transitionMs}ms`,
                          }}
                        />
                      ))}
                    {/* Middle labels sit in the ribbon zone, so they carry
                        a fully opaque halo: no ribbon color can bleed
                        through and tint it. */}
                    <text
                      data-testid="sankey-group-label"
                      x={sankey.middleLabelX}
                      y={node.h >= 26 ? labelY - 2 : labelY - 6}
                      fontSize={12}
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      stroke="#ffffff"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {truncateName(node.name)}
                    </text>
                    <text
                      data-testid="sankey-group-amount"
                      x={sankey.middleLabelX}
                      y={node.h >= 26 ? labelY + 13 : labelY + 7}
                      fontSize={11}
                      fill="var(--y-ink-faint)"
                      className="y-num"
                      opacity={dim ? 0.4 : 1}
                      stroke="#ffffff"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {fmt(node.value)} · {r.flowPct}%
                    </text>
                  </g>
                );
              })}
              {sankey.targets.map((node, idx) => {
                const r = tgtRows[idx]!;
                // The target's own color, shared with every incoming ribbon,
                // so each line into this bar reads as one color throughout —
                // whichever middle group it arrives from.
                // No borders, hovered or not: derived-money rows — the merged
                // Other bucket, the Remaining surplus plug, and whole-held
                // rows — add only the hatch, and hovering brightens via the
                // spotlight instead of stroking (an SVG stroke centers on the
                // edge, so even a same-color stroke would paint 1px outside
                // the bar and make it look bigger than the ribbon stack
                // feeding it). The bar wraps the row's funded flow; when
                // spending exceeds income the gap shows in the tooltip, not
                // as a grey segment.
                const color = r.color;
                const isComputed = r.bucket === true || r.isPlug;
                const isHeld = heldTargets.has(idx);
                // Like the middle bars: the same fill at the ribbons' own
                // rest/bright/dim steps, so each incoming line matches the
                // bar exactly in every spotlight state.
                const lit = hl.tgt != null && hl.tgt.has(idx);
                const dim = hl.tgt != null && !hl.tgt.has(idx);
                const barOpacity = hl.tgt == null
                  ? SANKEY_RIBBON_OPACITY
                  : lit
                    ? SANKEY_RIBBON_HOVER_OPACITY
                    : SANKEY_RIBBON_DIM_OPACITY;
                // Labels anchor at the layout's own labelY verbatim — never
                // recomputed here, so hairline bars keep their labels clear
                // of neighbors instead of centered on the sliver.
                const labelY = node.labelY;
                // One hover target per row: the <g> owns the row's hover, so
                // the bar, title, and amount all spotlight the same path and
                // moving between them never fires leave+enter (spotlight
                // flicker). The transparent hit band bridges the dead space
                // between the parts — the bar→label gap and the space between
                // the two label lines — so the whole row band holds the hover.
                // It spans the bar's exact vertical extent (adjacent rows
                // never overlap) and runs to the SVG edge; nothing else
                // interactive lives in the label zone. Rendered beneath the
                // bar and labels; invisible.
                return (
                  <g
                    key={`tgt-${node.name}-${idx}`}
                    style={{ cursor: "pointer" }}
                    onMouseMove={(e) =>
                      pushHover({ kind: "node", idx, x: e.clientX, y: e.clientY })
                    }
                    onMouseLeave={() => pushHover(null)}
                  >
                    <rect
                      data-testid="sankey-target-hit"
                      x={node.x}
                      y={node.y}
                      width={Math.max(0, chartSize.width - node.x)}
                      height={Math.max(0, node.h)}
                      fill="transparent"
                    />
                    <rect
                      data-testid="sankey-node"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={color}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                    {isComputed && (
                      <rect
                        data-testid="sankey-bucket-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    {/* Whole-held rows carry the shared hatch like the
                        buckets (disjoint sets — a held row is never a
                        bucket or the plug, so this never double-hatches). */}
                    {isHeld && (
                      <rect
                        data-testid="sankey-held-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    <text
                      data-testid="sankey-target-label"
                      x={sankey.targetLabelX}
                      y={node.h >= 26 ? labelY - 2 : labelY - 6}
                      fontSize={12}
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {truncateName(node.name)}
                    </text>
                    <text
                      data-testid="sankey-target-amount"
                      x={sankey.targetLabelX}
                      y={node.h >= 26 ? labelY + 13 : labelY + 7}
                      fontSize={11}
                      fill="var(--y-ink-faint)"
                      className="y-num"
                      opacity={dim ? 0.4 : 1}
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {fmt(node.value)} · {r.flowPct}%
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
  );
}
