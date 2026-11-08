---
"@ynab/logic": patch
"@ynab/server": patch
"@ynab/ui": patch
---

## Remove console output from amount parsing (g-format)

Story: `num()` in `@ynab/logic` used to `console.warn` on non-finite or
overflowing amounts, and several other library paths (net-worth unknown-account
skips, rename-rule learning fallbacks, `useLocalStorage` fallbacks, the error
boundary) logged to the console too. Every Vitest config throws on any console
output, so hitting any of these paths in a test failed the suite. All of them
are now silent: `num()` clamps to `sign * MAX_SAFE_INTEGER` with no logging
(strict mode still throws `RangeError`), unknown accounts are skipped quietly,
rename-rule learning failures stay best-effort swallows, storage fallbacks keep
their fallback values, and the error boundary relies on its fallback UI.
Server CLI entry scripts (`db-reset`, `migrate`, `db-import`) keep their terminal
output but write via `process.stdout/stderr` instead of `console.*`.

Notes: tests that previously asserted the warnings now assert silence
(`expect(spy).not.toHaveBeenCalled()`), and `format.test.ts` pins the
non-finite/overflow clamp values plus strict-mode `RangeError`s. No behavior
change besides the removed log lines. `apps/web` route logging is untouched.
