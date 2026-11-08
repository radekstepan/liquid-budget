"@ynab/logic": patch
---

## Locale-aware amount separators (g-money-parse)

YNAB4-style unknown-separator fallback (`parseCurrencyStringWithUnknownDecimalSeparator`
in YNAB4's `CurrencyUtilities.as`): when a string contains both `.` and `,`,
the LAST occurring separator is the decimal and all others are stripped as
thousands grouping. `packages/logic/src/format.ts` gains a shared
`normalizeSeparators` helper used by `num()`, `dollarsToCents()` (string
inputs), and `evalAmount()`.

- de-DE `"1.234,56"` now parses as 1234.56 (dollars) / 1235 (cents) instead
  of 1.23456 / 1 — previously off by ~1000x. `"1.234.567,89"` works too.
- en-US `"1,234.56"` is unchanged; comma-only keeps the existing
  per-occurrence rule (trailing `,\d{1,2}` = decimal comma, else
  thousands), so `"12,34"` → 12.34 and `"1,234"` → 1234.
- Dot-only keeps current behavior (dot = decimal).

Notes: `num()` input is integer cents (it rounds), so `"1.234,56"` → 1235
cents, while `dollarsToCents("1.234,56")` → 123456 cents. Strict `numCents`
is intentionally untouched — grouped input there still throws. CSV import
already handled both locales via `parseAmount` in `csv-import.ts` and is
unchanged; mixed-locale single expressions (e.g. `"1,5 + 2.5"`) follow
YNAB4's global last-wins rule and may misparse — pathological, out of scope.
