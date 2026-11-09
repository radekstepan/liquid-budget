// Sankey/spending-view constants shared by the report, its subviews, and tests.
// Extracted verbatim from SpendingReport.tsx; that module re-exports the
// public names so existing imports keep resolving.

export const LABEL_ZONE = 190;

// Conservative per-character px estimates for the left-column labels (12px
// names, 11px tabular-nums amounts). SVG gives no text metrics, so name
// truncation budgets against these to stay clear of the left edge; tests
// reuse them to assert the same geometric contract.
export const SOURCE_NAME_PX_PER_CHAR = 7;
export const SOURCE_AMOUNT_PX_PER_CHAR = 6;

// Each ribbon carries one flat color — the color of its FINAL (right-column)
// destination — through its whole length: right-hop ribbons their
// category's or merchant's own color (one ribbon per group→target cell),
// and each left-hop income→group band subdivides into one sub-ribbon per
// downstream cell (layout leftCells), in the same target colors, landing
// in contiguous per-color blocks — so the line from an income bar to a
// category or merchant bar reads as one color throughout at one thickness
// in both groupings. The full-width Remaining ribbons carry the plug's
// green. The target determines the color and it flows backwards along
// every ribbon arriving at it, no matter which middle group each ribbon
// comes from — the parent group never tints a ribbon, and the income side
// never colors one either. Exported so tests can pin the fills.
//
// Spotlight scale: at rest every ribbon and every bar sits at
// SANKEY_RIBBON_OPACITY — nearly as solid as the hover step, one small
// step below it so the spotlight still reads as a brightening; while a
// flow path is hovered the path's ribbons and bars brighten to
// SANKEY_RIBBON_HOVER_OPACITY and everything outside the path dims to
// SANKEY_RIBBON_DIM_OPACITY, kept far below rest so the off-path wash
// stays clearly dimmer. Bars share their ribbons' exact fill at the same
// steps, so the line into a bar always matches the bar. Brightness alone
// carries the spotlight — the DOM order never changes with hover (no
// z-reorder), so the brightness steps glide over
// SANKEY_SPOTLIGHT_TRANSITION_MS instead of snapping: with a stable
// z-order there is no "final z-order at pre-transition brightness" to
// flash (the task-29 hazard), and rapid A→B→C sweeps just retarget the
// in-flight cross-fade. Unchanged arms keep identical attributes, so no
// transition triggers and nothing repaints (the task-30 invariant).
export const SANKEY_RIBBON_OPACITY = 0.75;
export const SANKEY_RIBBON_DIM_OPACITY = 0.12;
export const SANKEY_RIBBON_HOVER_OPACITY = 0.85;
// Cross-fade length for every spotlight brightness step (ribbons, bars,
// hatch overlays, and dimming labels alike) — brightness-only easing,
// never scale/lift/bounce, and zero under prefers-reduced-motion (see
// usePrefersReducedMotion). Flash-safe only because the z-order is
// stable — see above.
export const SANKEY_SPOTLIGHT_TRANSITION_MS = 120;

// The hatch marks computed/derived money — the merged "Other" buckets on
// every column, the "Remaining" surplus plug, and still-held balances —
// versus terminal purchase flows. Target bars hatch by row (bucket, plug,
// and whole-held bars); ribbons hatch by destination (right-hop ribbons
// into bucket, plug, or held targets, plug-lane ribbons, and left-hop
// sub-ribbons funding bucket, plug, or held cells — per-sub granularity,
// like the spotlight); income and middle bars hatch by segment (each bar
// segment funding a hatched ribbon hatches with it, since every segment
// meets its ribbon exactly). Ribbons out of a middle bucket into a real
// target stay solid — money ending as a terminal purchase reads solid no
// matter its middle routing. No bar carries a border; the hatch alone
// marks derived money.
export const SANKEY_BUCKET_HATCH_ID = "sankey-bucket-hatch";

// Income bars fill with a hard-edged top-to-bottom gradient from the
// layout's own stops (sourceFills) — one gradient per bar, so each bar
// segment matches its ribbon exactly. Bar i paints from
// `${SANKEY_INCOME_GRADIENT_ID_PREFIX}${i}`.
export const SANKEY_INCOME_GRADIENT_ID_PREFIX = "sankey-income-gradient-";

// Middle bars fill the same way — one gradient per bar from the layout's
// own stops (middleFills), so each bar segment matches its ribbon exactly
// instead of sitting flat in the group hue while category-colored arms
// leave it. Bar i paints from
// `${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${i}`.
export const SANKEY_MIDDLE_GRADIENT_ID_PREFIX = "sankey-middle-gradient-";

// Session flag for the Under auto-fit: it runs at most once per tab session —
// on the first Sankey paint with a measured container — and never again after
// the user drags the slider themselves. Report tab switches remount this
// component, so a mount-local ref alone would re-auto and fight the user's
// in-session choice; sessionStorage survives remounts but resets on a fresh
// tab load, which is exactly "initial load" semantics. Exported so tests can
// pin the flag and assert unmerged geometry without the auto-fit raising the
// threshold underneath them.
export const SANKEY_AUTOFIT_SESSION_KEY = "ynab:reports:spendingAutoFit";
