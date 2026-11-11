"use client";

import { useMemo } from "react";
import type { SpendingTrendsResult } from "@ynab/logic";
import {
  colorAt,
  computeOutlierBreak,
  niceTicks,
  NO_BREAK,
  symlog,
  symlogTicks,
  TRUNC_RATIO,
  useElementSize,
} from "./chartUtils.js";
import type { ChartLayout } from "./StaticChart.js";

export type SpendingTrendsLayoutArgs = {
  trends: SpendingTrendsResult;
  colorMap: Map<number, string>;
  scaleMode: "linear" | "log";
};

export type SpendingTrendsLayout = {
  chartContainerRef: (node: HTMLDivElement | null) => void;
  chart: ChartLayout | null;
};

/** Chart geometry for spending trends (ui-split slice 10). Owns the
 * measured container size and the full layout aggregation: diverging
 * stack extents, linear/log/break axis scaling with ticks, bar widths,
 * per-month stacked segments with truncation flags, the average line,
 * and the x-axis label stride. Returns null until measured or when
 * there are no months. */
export function useSpendingTrendsLayout({
  trends,
  colorMap,
  scaleMode,
}: SpendingTrendsLayoutArgs): SpendingTrendsLayout {
  const { ref: chartContainerRef, size } = useElementSize<HTMLDivElement>();

  // Chart layout calculations with dynamic scaling based on data width
  const chart: ChartLayout | null = useMemo(() => {
    if (size.width === 0 || size.height === 0 || trends.months.length === 0) return null;

    const W = size.width;
    const H = size.height;
    const padL = 58;
    const padR = 18;
    const padT = 16;
    const padB = 32;

    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padT - padB);

    // Diverging stacks: positive segments stack upward from zero and negative
    // segments downward, so equal dollars render at equal heights. Axis extents
    // follow stack sums (not net totals) so every stack fits in the chart.
    const stackSums = trends.months.map((m) => {
      let pos = 0;
      let neg = 0;
      for (const s of m.segments) {
        if (s.amount < 0) neg += s.amount;
        else pos += s.amount;
      }
      return { pos, neg };
    });
    const maxPosStack = Math.max(0, ...stackSums.map((s) => s.pos));
    const maxNegStack = Math.max(0, ...stackSums.map((s) => -s.neg));

    const hasNegData = maxNegStack > 0;
    const hasPosData = maxPosStack > 0;

    const isLog = scaleMode === "log";
    const posBreak = isLog
      ? NO_BREAK
      : computeOutlierBreak(stackSums.map((s) => s.pos).filter((v) => v > 0));
    const negBreak = isLog
      ? NO_BREAK
      : computeOutlierBreak(stackSums.map((s) => -s.neg).filter((v) => v > 0));
    const hasBreak = posBreak.hasBreak || negBreak.hasBreak;

    const MIN_SIDE = 0.22;
    let ticks: { v: number; grid: boolean }[];
    let y: (v: number) => number;
    let zeroY: number;

    const posTopVal = Math.max(1, maxPosStack);
    const negTopVal = Math.max(1, maxNegStack);

    let posShare = hasNegData ? posTopVal / (posTopVal + negTopVal) : 1;
    if (hasNegData) {
      if (posShare < MIN_SIDE) posShare = MIN_SIDE;
      if (posShare > 1 - MIN_SIDE) posShare = 1 - MIN_SIDE;
    }
    zeroY = padT + innerH * posShare;

    const posNorm = (v: number) => {
      if (v <= 0) return 0;
      if (posBreak.hasBreak) {
        if (v <= posBreak.breakTop) return (v / posBreak.breakTop) * posBreak.split;
        return (
          posBreak.split +
          ((v - posBreak.breakTop) / (posBreak.topVal - posBreak.breakTop)) *
            (1 - posBreak.split)
        );
      }
      return v / posTopVal;
    };

    const negNorm = (d: number) => {
      if (d <= 0) return 0;
      if (negBreak.hasBreak) {
        if (d <= negBreak.breakTop) return (d / negBreak.breakTop) * negBreak.split;
        return (
          negBreak.split +
          ((d - negBreak.breakTop) / (negBreak.topVal - negBreak.breakTop)) *
            (1 - negBreak.split)
        );
      }
      return d / negTopVal;
    };

    if (isLog) {
      if (hasNegData) {
        const minVal = -maxNegStack;
        const maxVal = maxPosStack;
        const rawTicks = symlogTicks(minVal, maxVal);
        ticks = rawTicks.map((v) => ({ v, grid: true }));

        const minLog = symlog(Math.abs(minVal));
        const maxLog = symlog(Math.max(1000, maxVal));
        const totalLog = minLog + maxLog;
        let logPosShare = totalLog > 0 ? maxLog / totalLog : 0.5;
        if (logPosShare < MIN_SIDE) logPosShare = MIN_SIDE;
        if (logPosShare > 1 - MIN_SIDE) logPosShare = 1 - MIN_SIDE;

        zeroY = padT + innerH * logPosShare;
        y = (v: number) => {
          if (v > 0) {
            const norm = maxLog > 0 ? symlog(v) / maxLog : 0;
            return zeroY - (zeroY - padT) * Math.min(1, Math.max(0, norm));
          } else if (v < 0) {
            const norm = minLog > 0 ? symlog(Math.abs(v)) / minLog : 0;
            return zeroY + (padT + innerH - zeroY) * Math.min(1, Math.max(0, norm));
          }
          return zeroY;
        };
      } else {
        const maxVal = Math.max(1000, maxPosStack);
        const rawTicks = symlogTicks(0, maxVal);
        ticks = rawTicks.filter((t) => t >= 0).map((v) => ({ v, grid: true }));
        if (!ticks.some((t) => t.v === 0)) ticks.unshift({ v: 0, grid: true });

        const maxLog = symlog(maxVal);
        zeroY = padT + innerH;
        y = (v: number) => {
          if (v <= 0) return zeroY;
          const norm = maxLog > 0 ? symlog(v) / maxLog : 0;
          return padT + innerH * (1 - Math.min(1, Math.max(0, norm)));
        };
      }
    } else if (hasBreak) {
      ticks = [];
      y = (v: number) => {
        if (v > 0) return zeroY - posNorm(v) * (zeroY - padT);
        if (v < 0) return zeroY + negNorm(-v) * (padT + innerH - zeroY);
        return zeroY;
      };

      if (posBreak.hasBreak) {
        for (const t of posBreak.ticks) ticks.push({ v: t, grid: true });
        ticks.push({ v: posBreak.topVal, grid: false });
      } else if (hasPosData) {
        const rawPosTicks = niceTicks(0, posTopVal * 1.1, 3).filter((t) => t > 0);
        for (const t of rawPosTicks) ticks.push({ v: t, grid: true });
      }

      ticks.push({ v: 0, grid: true });

      if (negBreak.hasBreak) {
        for (const t of negBreak.ticks) ticks.push({ v: -t, grid: true });
        ticks.push({ v: -negBreak.topVal, grid: false });
      } else if (hasNegData) {
        const rawNegTicks = niceTicks(-negTopVal * 1.1, 0, 3).filter((t) => t < 0);
        for (const t of rawNegTicks) ticks.push({ v: t, grid: true });
      }

      ticks.sort((a, b) => b.v - a.v);
    } else {
      // Linear scale without outlier break
      if (hasNegData) {
        const posPt = Math.max(100, maxPosStack * 1.1);
        const negPt = Math.max(100, maxNegStack * 1.1);
        let linearPosShare = posPt / (posPt + negPt);
        if (linearPosShare < MIN_SIDE) linearPosShare = MIN_SIDE;
        if (linearPosShare > 1 - MIN_SIDE) linearPosShare = 1 - MIN_SIDE;

        const posTop = padT;
        const posBot = padT + innerH * linearPosShare;
        const negBot = padT + innerH;
        zeroY = posBot;

        const rawPosTicks = niceTicks(0, posPt, 3);
        const posTicks = rawPosTicks.filter((t) => t > 0 && t <= posPt * 1.05);
        const maxPosTick = posTicks[posTicks.length - 1] ?? posPt;

        const rawNegTicks = niceTicks(-negPt, 0, 3);
        const negTicks = rawNegTicks.filter((t) => t < 0 && t >= -negPt * 1.05);
        const minNegTick = negTicks[0] ?? -negPt;

        ticks = [
          ...posTicks.map((v) => ({ v, grid: true })),
          { v: 0, grid: true },
          ...negTicks.map((v) => ({ v, grid: true })),
        ].sort((a, b) => b.v - a.v);

        y = (v: number) => {
          if (v > 0) {
            const norm = Math.min(1, Math.max(0, v / maxPosTick));
            return zeroY - (zeroY - posTop) * norm;
          } else if (v < 0) {
            const norm = Math.min(1, Math.max(0, Math.abs(v) / Math.abs(minNegTick)));
            return zeroY + (negBot - zeroY) * norm;
          }
          return zeroY;
        };
      } else {
        const maxVal = Math.max(100, maxPosStack * 1.1);
        const rawTicks = niceTicks(0, maxVal, 4);
        ticks = rawTicks
          .filter((t) => t >= 0 && t <= maxVal * 1.05)
          .map((v) => ({ v, grid: true }));
        if (!ticks.some((t) => t.v === 0)) ticks.unshift({ v: 0, grid: true });

        const maxTick = ticks[ticks.length - 1]?.v || maxVal;
        y = (v: number) => padT + innerH * (1 - Math.min(1, Math.max(0, v / maxTick)));
        zeroY = y(0);
      }
    }

    const n = trends.months.length;
    const colW = innerW / n;

    // Dynamic bar width and gap calculation: ensures clear visual gap between adjacent bars
    // whether showing 3 months or 144 months (12 years)
    let barW: number;
    if (colW >= 32) {
      barW = Math.min(42, Math.round(colW * 0.55));
    } else if (colW >= 14) {
      barW = Math.max(8, Math.round(colW * 0.65));
    } else if (colW >= 6) {
      barW = Math.max(3, Math.round(colW - 2));
    } else {
      barW = Math.max(1, Math.round(colW - 1));
    }

    const cornerRadius = Math.min(3, Math.max(1, Math.floor(barW / 3)));

    // Stacks scale against the largest stack so the tallest stack always reaches
    // the visual cap; the axis keeps its own ticks computed from stack extents.
    const barScaleMax = Math.max(1, maxPosStack);
    const barScaleNegMax = Math.max(1, maxNegStack);
    const maxBarH = (zeroY - padT) * TRUNC_RATIO;
    const maxBarHNeg = (padT + innerH - zeroY) * TRUNC_RATIO;

    const monthBars = trends.months.map((mPoint, i) => {
      const cx = padL + colW * (i + 0.5);
      const barX = cx - barW / 2;
      const posSum = stackSums[i]?.pos ?? 0;
      const negSum = stackSums[i]?.neg ?? 0;
      const hasPos = posSum > 0;
      const hasNeg = negSum < 0;

      const useBreakBars = hasBreak;
      const truncUp =
        !useBreakBars && hasPos && posSum >= barScaleMax * TRUNC_RATIO;
      const truncDown =
        !useBreakBars && hasNeg && -negSum >= barScaleNegMax * TRUNC_RATIO;

      let upH = 0;
      let downH = 0;

      if (hasPos) {
        if (useBreakBars) {
          upH = Math.max(0, zeroY - y(posSum));
        } else if (isLog) {
          const maxLog = symlog(Math.max(1000, barScaleMax));
          upH = Math.max(0, (zeroY - padT) * (maxLog > 0 ? symlog(posSum) / maxLog : 0));
        } else {
          upH = Math.max(0, maxBarH * (posSum / barScaleMax));
        }
      }
      if (hasNeg) {
        if (useBreakBars) {
          downH = Math.max(0, y(negSum) - zeroY);
        } else if (isLog) {
          const minLog = symlog(Math.max(1000, barScaleNegMax));
          downH = Math.max(0, (padT + innerH - zeroY) * (minLog > 0 ? symlog(-negSum) / minLog : 0));
        } else {
          downH = Math.max(0, maxBarHNeg * (-negSum / barScaleNegMax));
        }
      }

      const barTopY = zeroY - upH;
      const totalH = upH + downH;

      // Truncation markers sit on the outermost segment of each capped stack.
      let lastPosIdx = -1;
      let lastNegIdx = -1;
      mPoint.segments.forEach((s, idx) => {
        if (s.amount < 0) lastNegIdx = idx;
        else lastPosIdx = idx;
      });

      let upOffset = zeroY;
      let downOffset = zeroY;
      const renderedSegments = mPoint.segments.map((seg, sIdx) => {
        const isSegNeg = seg.amount < 0;
        const stackTotal = isSegNeg ? -negSum : posSum;
        const stackH = isSegNeg ? downH : upH;
        const segHeight =
          stackTotal > 0 ? Math.max(0, stackH * (Math.abs(seg.amount) / stackTotal)) : 0;

        let segY = zeroY;
        if (!isSegNeg) {
          segY = upOffset - segHeight;
          upOffset = segY;
        } else {
          segY = downOffset;
          downOffset = segY + segHeight;
        }

        const color = colorMap.get(seg.id) ?? colorAt(sIdx);

        return {
          id: seg.id,
          name: seg.name,
          amount: seg.amount,
          x: barX,
          y: segY,
          width: barW,
          height: segHeight,
          color,
          neg: isSegNeg,
          truncated: (truncUp && sIdx === lastPosIdx) || (truncDown && sIdx === lastNegIdx),
        };
      });

      return {
        month: mPoint.month,
        monthTotal: mPoint.total,
        totalH,
        barTopY,
        cx,
        barX,
        barW,
        colW,
        colX: padL + colW * i,
        segments: renderedSegments,
      };
    });

    const avgY = trends.avgPerMonth !== 0 ? y(trends.avgPerMonth) : null;
    const avgInBreak =
      hasBreak &&
      avgY != null &&
      ((posBreak.hasBreak && Math.abs(avgY - y(posBreak.breakTop)) < 7) ||
        (negBreak.hasBreak && Math.abs(avgY - y(-negBreak.breakTop)) < 7));

    // Smart X-axis label stride calculation to prevent overlap over multi-year spans
    const maxLabels = Math.max(2, Math.min(10, Math.floor(innerW / 65)));
    const stride = n <= maxLabels ? 1 : Math.ceil((n - 1) / (maxLabels - 1));
    const tickIndices: number[] = [];
    for (let i = 0; i < n; i += stride) {
      tickIndices.push(i);
    }
    const lastIdx = n - 1;
    if (tickIndices.length > 0 && tickIndices[tickIndices.length - 1] !== lastIdx) {
      if (lastIdx - tickIndices[tickIndices.length - 1]! < Math.round(stride * 0.7)) {
        tickIndices[tickIndices.length - 1] = lastIdx;
      } else {
        tickIndices.push(lastIdx);
      }
    }
    const tickSet = new Set(tickIndices);

    return {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      innerW,
      innerH,
      y,
      zeroY,
      ticks,
      colW,
      barW,
      cornerRadius,
      n,
      monthBars,
      avgY,
      avgInBreak,
      hasBreak,
      posBreak: posBreak.hasBreak ? posBreak : null,
      negBreak: negBreak.hasBreak ? negBreak : null,
      tickSet,
    };
  }, [size, trends, colorMap, scaleMode]);

  return { chartContainerRef, chart };
}
