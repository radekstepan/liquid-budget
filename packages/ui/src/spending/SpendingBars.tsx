"use client";

import { fmt } from "@ynab/logic";
import { SankeyBucketHatchPattern } from "../chartUtils.js";
import { SANKEY_BUCKET_HATCH_ID } from "./sankeyConstants.js";
import type { Hover } from "./types.js";
import type { SpendingData } from "./useSpendingData.js";
import type { SankeyDerived } from "./useSankeyDerived.js";

export function SpendingBars({
  data,
  derived,
  pushHover,
}: {
  data: SpendingData;
  derived: SankeyDerived;
  pushHover: (hover: Hover | null) => void;
}) {
  const { rows, empty } = data;
  const { heldBars, hoverBarIdx } = derived;
  return (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 y-scroll">
          {/* Bars rows stack gaplessly at a fixed natural height: no
              inter-row gap, space, or margin — each row's bottom edge
              touches the next row's top edge — and no flex stretching to
              fill the viewport either. Short lists sit at the top; a long
              list overflows and the outer scroller (overflow-y-auto) takes
              over. Rows never compress, stretch, or truncate to fit. */}
          <div className="mx-auto w-full max-w-[1100px]">
            {/* Shared hatch def for bucket and held bars: the SAME pattern
                element the Sankey overlays on its derived-money rows
                (identical angles, spacing, and colors — the two views
                cannot drift). Bars and Sankey never render together, so
                this id stays unique in the document. Zero-size and out of
                flow: no layout effect. */}
            {rows.some((r) => r.bucket === true || heldBars.has(r.i)) && (
              <svg
                data-testid="bars-bucket-hatch-defs"
                aria-hidden="true"
                width={0}
                height={0}
                style={{ position: "absolute" }}
              >
                <defs>
                  <SankeyBucketHatchPattern id={SANKEY_BUCKET_HATCH_ID} />
                </defs>
              </svg>
            )}
            {empty && <div className="grid place-items-center py-12 y-hint">No data for this timeframe.</div>}
            {rows.map((r) => {
              const isHover = hoverBarIdx === r.i;
              return (
                // Keyed by row position, never by name alone: a literal
                // "Other" category sits beside the merged "Other" bucket,
                // and two rows named "Other" share nothing but the label.
                <div
                  key={`${r.i}:${r.bucket === true ? "bucket" : "row"}:${r.name}`}
                  className="group flex cursor-default items-center gap-3 rounded-[4px] px-2 py-[7px] transition-colors"
                  style={{ background: isHover ? "var(--y-row-sel)" : "transparent" }}
                  onMouseMove={(e) => pushHover({ kind: "bar", idx: r.i, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => pushHover(null)}
                >
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-sm"
                    style={{
                      background: r.color,
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(0,0,0,0.1)",
                    }}
                  />
                  <span
                    className="shrink-0 w-[26%] truncate text-[12.5px]"
                    style={{ color: "var(--y-ink)" }}
                  >
                    {r.name}
                    {r.bucket === true && (
                      <span className="ml-1 text-[11px]" style={{ color: "var(--y-ink-faint)" }}>
                        ({r.mergedCount} merged)
                      </span>
                    )}
                  </span>
                  <div
                    className="y-bar-track relative h-[14px] flex-1 overflow-hidden rounded-[3px]"
                    style={{
                      boxShadow:
                        "inset 0 1px 2px rgba(0,0,0,0.18), 0 1px 0 rgba(255,255,255,0.6)",
                    }}
                  >
                    {(() => {
                      // Simple linear scale against the largest group; no
                      // truncation caps or axis breaks on this report.
                      const displayWidth = Math.round(Math.max(r.pctOfMax, r.value > 0 ? 1 : 0) * 100) / 100;
                      // Hatched rows (merged Other buckets and whole-held
                      // rows — disjoint sets) clip the hatch overlay to the
                      // bar's rounded corners; normal rows keep no children.
                      const hatched = r.bucket === true || heldBars.has(r.i);
                      return (
                        <div
                          className={
                            "relative h-full rounded-[3px] transition-[width] duration-150" +
                            (hatched ? " overflow-hidden" : "")
                          }
                          style={{
                            width: `${displayWidth}%`,
                            background: `linear-gradient(rgba(255,255,255,0.18), rgba(255,255,255,0)) , ${r.color}`,
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.18)",
                          }}
                        >
                          {/* Merged Other buckets carry the shared Sankey
                              hatch above the bar color (the same pattern def
                              the Sankey paints on its derived-money rows —
                              Bars render no Remaining plug, so only `bucket`
                              rows qualify for the bucket hatch). The row hover
                              highlight paints the row behind the bar, so the
                              hatch reads in rest and hover alike. */}
                          {r.bucket === true && (
                            <svg
                              data-testid="bars-bucket-hatch"
                              aria-hidden="true"
                              className="absolute inset-0 h-full w-full"
                              pointerEvents="none"
                            >
                              <rect
                                x={0}
                                y={0}
                                width="100%"
                                height="100%"
                                fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                              />
                            </svg>
                          )}
                          {/* Whole-held rows carry the same shared hatch:
                              still-held balances are derived money, like the
                              buckets — never terminal purchases. */}
                          {r.bucket !== true && heldBars.has(r.i) && (
                            <svg
                              data-testid="bars-held-hatch"
                              aria-hidden="true"
                              className="absolute inset-0 h-full w-full"
                              pointerEvents="none"
                            >
                              <rect
                                x={0}
                                y={0}
                                width="100%"
                                height="100%"
                                fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                              />
                            </svg>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  <span
                    className="y-num w-[110px] shrink-0 text-right text-[12px] font-semibold"
                    style={{ color: "var(--y-ink)" }}
                  >
                    {fmt(r.value)}
                  </span>
                  <span
                    className="y-num w-[52px] shrink-0 text-right text-[11px]"
                    style={{ color: "var(--y-ink-faint)" }}
                  >
                    {r.pctOfTotal}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
  );
}
