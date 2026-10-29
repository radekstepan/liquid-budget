---
"@ynab/ui": patch
---

## Sankey hover cross-fades with a stable z-order; every column is one hover target (task-42)

Story: in the Spending by Category Sankey view, moving the pointer across
arms, labels, and groups felt jarring — the highlight snapped instantly
and groups flickered. Hover changes now cross-fade smoothly instead of
snapping, and every column behaves as one hover target per row, so
traveling between a row's bar, name, and amount never blinks the
spotlight. Spotlight semantics are unchanged (path brightens, rest dims,
tooltips correct).

Notes: two real causes, fixed separately. (1) Structural flicker: the
left (income) and middle (group) columns still used per-part hover
registrations with dead gaps between the parts, so bar→label travel
committed a clear before the re-set and blinked the spotlight. Both
columns now put the row's hover handlers on the wrapping `<g>` like the
right column (task-37); the left column also gains a transparent hit
band from the SVG's left edge to the bar's right edge bridging the
bar→label gutter. The middle column deliberately gets no band: its
labels sit in the ribbon zone, so a band painted with the row would
swallow ribbon hovers — the ribbons beneath already catch most gap
pixels (bands tile the bar's full height at its right edge, so bar→label
travel passes through ribbon pixels as a correct switch, not a blink).
(2) Instant snap: the brightness steps now glide over 120ms
(`SANKEY_SPOTLIGHT_TRANSITION_MS`) on ribbons, bars, hatch overlays, and
dimming labels — brightness-only easing, no scale/lift/bounce, and zero
duration under `prefers-reduced-motion` (same spotlight semantics,
instant). Flash-safety mechanism: the spotlight z-reorder is gone
— ribbons always render in layout order, hovered or not — so there is no
instant final z-order to show at pre-transition brightness (the task-29
flash); brightness alone carries the spotlight and rapid A→B→C sweeps
just retarget the in-flight cross-fade. The off-path wash sits far below
rest, so a lit leg painting under a nearly-transparent dim leg reads
pure. The task-30 single-commit invariant is untouched (rAF-throttled
sets incl. leave-clears, stable keys, memoized derivation), so unchanged
arms still keep identical attributes and DOM nodes with no repaint
trigger. Tests: left/middle hover-travel suites using
`fireEvent.mouseOut` with `relatedTarget` (asserting the held hover
before any re-enter), the left hit-band geometry, and a test pinning the
flash-safety mechanism itself (every spotlight element carries the
cross-fade; ribbon DOM identity and order are identical at rest, under
hover, and after leave). Existing tests that pinned the dim-first
z-order now pin layout order explicitly.
