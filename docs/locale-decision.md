# Locale decision: single-locale en-US display

Status: accepted. This records the single-locale decision offered by
`TODO(P2) [i18n]` in `packages/ui/src/BudgetApp.tsx` (marker removed);
the alternative — locale plumbing — stays out of scope.

## Decision

- **Display locale is fixed `en-US`; display currency is USD `$`.**
  `fmt`/`fmtSigned` (`packages/logic/src/format.ts:31-45`) render
  `toLocaleString("en-US")` with a hardcoded `$`/`-$` prefix. There is no
  locale parameter, no `Intl` negotiation, no per-budget currency display.
- **Input parsing stays locale-agnostic.** `num`/`dollarsToCents`/`evalAmount`
  use last-separator-wins (`normalizeSeparators`, `format.ts:56-70`), so both
  `1,234.56` (en-US) and `1.234,56` (de-DE) parse. The asymmetry is
  intentional: accept either convention on input, always render en-US.
- **Ordering/case-folding uses the host default.** Bare `localeCompare` /
  `toLowerCase` (e.g. `BudgetApp.tsx:277`, `searchQuery.ts:639`,
  `useRegisterData.ts:394`) carry no locale argument. List/suggestion order
  is a UI convenience, not part of the display contract, so host collation
  is accepted.
- **Other hardcoded `en-US` sites are covered by this decision:**
  `searchQuery.ts:236,258,592` (`toLocaleDateString("en-US", …)` for
  suggestion/date rendering). Before adding any new formatter, route display
  through `fmt` (the display choke point) — do not add a second convention.

## Non-goals / known gaps

- Imported `.ybsettings` locale/currency (`currencyLocale`, `dateLocale`,
  separators) is persisted in the `settings` key-value table for export
  fidelity, but display does not consume it; export still writes
  `en_US` metadata. That work is tracked by G-02 in
  `docs/ynab4-import-gaps.md`, not here.
- If locale plumbing is ever funded, it starts at `fmt` (add a locale
  parameter sourced from the stored settings) plus the three
  `searchQuery.ts` date renders — the site list above is the whole surface.

## Pins

- `packages/logic/tests/format.test.ts` pins the behavior (`fmt` `$` +
  comma grouping; `num` last-separator-wins both conventions).
- `packages/ui/tests/i18nDecision.test.ts` pins this decision: the
  `[i18n]` marker is gone, this doc states single-locale en-US, and the
  display/input asymmetry holds.
