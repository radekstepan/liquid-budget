---
"@ynab/web": patch
"@ynab/ui": patch
---

## Fix 4 stale e2e specs, diagnose agent e2e sandbox block (task-2)

Fixed the four failing Playwright specs. In all four cases the app behaves
as designed and the spec was stale after shipped features (page-load
auto-post of scheduled rows, sidebar "new" badge pills, duplicate
inspector), so the specs were updated, not the app:

- `rename-suggest`: the Suggest-with-AI candidate count now derives from
  the live queue (imports plus ambient auto-posted scheduled rows) instead
  of asserting an import-only count.
- `splits-edge-cases` / `transactions`: sidebar clicks target the account
  name, since the badge pill intercepts center clicks and filters instead
  of toggling.
- `transactions-flag`: the D badge is asserted as the duplicate-inspector
  button (opened, Escape-dismissed, flag picker never shown).

Added unit regression tests pinning each intended behavior
(auto-post grows the rename pool, row-vs-badge click semantics, D badge
never opens the flag picker).

Also diagnosed why agent sessions can't run `yarn e2e`: the default
network sandbox denies `listen()`, so `next start` fails with `EPERM` on
port 3100. Relaunch with `--sandbox-network enabled` (or
`--disable-sandbox`) to run e2e from an agent.

Notes: test-only changes, no app behavior changed. `yarn build`,
`yarn test` (8/8), and `yarn typecheck` (9/9) pass; `yarn e2e` could not
run in the sandboxed agent session — run `yarn e2e` in a normal terminal
to confirm the four spec fixes.
