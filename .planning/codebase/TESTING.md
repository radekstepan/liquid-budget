# Testing

## Overview

Two-layer strategy: unit/component tests with Vitest, end-to-end tests with
Playwright. Turbo orchestrates per-workspace runs; every workspace has its own
`vitest.config.ts`, and `@ynab/web` additionally owns the Playwright suite
(`playwright.config.ts`, specs in `tests/e2e/`, output in `test-results/`).

## Test stack

| Layer | Tool | Location |
|---|---|---|
| Unit / component | Vitest 2.1.9 (logic/server/ui) and ^4.1.10 (`apps/web` — note major-version drift) | Per-package `vitest.config.ts`; web config aliases `@` → `src` |
| E2E | Playwright | `apps/web/playwright.config.ts`, ~36 specs in `apps/web/tests/e2e/`, output in `apps/web/test-results/` |
| Orchestration | Turborepo (`test`, `coverage`, `test:watch` tasks) | Root `package.json`, `turbo.json` |
| Type safety net | `typecheck` (TS strict + `noUncheckedIndexedAccess`) | Per-package `tsconfig.json` extending `tsconfig.base.json` |
| Hygiene gate | `check:artifacts` | `scripts/check-artifacts.mjs` — fails if DB/backup artifacts are git-tracked |

## Coverage

- `turbo.json` wires `test` and `coverage` tasks with `outputs: ["coverage/**"]` (Turbo-cached).
- Root `yarn coverage` runs `turbo run coverage` across workspaces.
- `test` tasks declare `dependsOn: ["^build"]` — tests run against built dependencies.
- Coverage thresholds are enforced per package and fail the run when missed:
  - `logic`: statements/lines/functions 90, branches 85
  - `server`: statements/lines 85, branches/functions 70
  - `ui`: statements/lines 85, branches 80, functions 50

## How to run

```sh
yarn test         # full suite across all workspaces (turbo run test)
yarn test:watch   # watch mode (uncached, persistent)
yarn coverage     # coverage reports (coverage/ per workspace)

# E2E (web app only; boots production `next start` on port 3100 — build first)
yarn e2e          # headless Playwright run (frees port 3100 first via e2e:clean)
yarn e2e:headed   # headed run
yarn e2e:ui       # interactive Playwright UI
yarn e2e:install  # install browser binaries (first-time setup)
```

## Naming and placement

- Name tests `*.test.ts` (node) or `*.test.tsx` (components); web also accepts both. E2E specs are `*.spec.ts` in `apps/web/tests/e2e/`.
- Placement: `apps/web` keeps unit tests in `tests/` (excluding `tests/e2e/`, which Vitest ignores); `logic`/`server` accept `src/**/*.test.ts` and `tests/**/*.test.ts`; `ui` accepts both `src/` and `tests/` in `.ts` and `.tsx`.
- Never commit `test-results/` or `coverage/` output (build artifacts; git-ignored).

## Gotchas / constraints

- **No console output**: every Vitest config throws on any `console.*` call (`onConsoleLog`). Silence code under test or the suite fails.
- **No parallelism in web unit tests** (`fileParallelism: false`) and **serial E2E** (`workers: 1`): suites mutate a shared DB, so parallel runs race and corrupt absolute-value assertions.
- **E2E never touches the dev DB**: it runs with `DATABASE_URL=../../budget.test.db` on port 3100; unit tests use `DATABASE_URL=:memory:`. The dev `budget.db` on port 3000 is only for manual development.
- **Always run E2E via root `yarn e2e`**: Playwright's `reuseExistingServer` silently reuses a stale server on port 3100 (stale bundle, dirty DB handle); `e2e:clean` kills it first.
- **Never trust a gate's exit code through a pipe**: `yarn test | tail` reports `tail`'s exit code, so a red suite looks green — redirect to a file (`yarn e2e > /tmp/e2e.log 2>&1; echo $?`) and inspect the log instead. This masked a failing `yarn e2e` as exit 0 during task-21.
- **`/api/reset` needs `RESET_ENABLED=true`** (set by the Playwright `webServer` command); without it the route returns 403 and the E2E `global-setup`/import specs fail.
- **Sidebar e2e clicks must target the account name** (`span.truncate`), not the row center — the "new" badge pill is a nested clickable that intercepts center clicks and applies the Is:New filter instead of toggling selection.
- **Never assert absolute rename-candidate counts after a page load** — page-load auto-post materializes overdue scheduled rows into the rename pool, so ambient scheduled payees join freshly imported ones.
- **Serial-mode spec files skip after the first failure** — check skipped counts, not just failures, or a second broken test in the same file hides behind the first.
- **`E2E_TESTING=true` is currently read by nothing** — a seam for future MSW-style mocking, not an active behavior switch.
- **Vitest version drift**: `@ynab/web` runs Vitest 4 while the other packages run 2.1.9. Check the local config before assuming shared behavior/plugins.
- **Outlier-break chart tests must assert bar geometry, not just the break marker**: a zero-line placement bug collapsed every Cash Flow bar to a 1px sliver while the break-mark test stayed green. Assert bar heights (e.g. every bar > 50px on the plot).
- **`BudgetAppShell.test.tsx` BUG-15 tests are timing-sensitive**: they hold deferred fetch promises and can exceed the 5s default test timeout on a slow/loaded machine (observed failing on the untouched base too). If they time out, rerun the file with `--testTimeout=60000` — a pass there means slowness, not a regression.
- **`randomPrivacyFactor` range test is flaky by construction**: `(0.15 + Math.random() * 3.85)` rounds to exactly `4.00` about 0.13% per draw, so the 50-draw `toBeLessThan(4)` assertion fails roughly 6% of runs. A lone failure there (all else green) is the boundary draw, not a regression — rerun the file.
- **A failing UI assertion can mask itself as `path: \`key\` is not a prop`**: when a failure message serializes React elements (e.g. `toHaveLength` on an element array), pretty-format reads `props.key`, React logs the special-props warning, `onConsoleLog` throws, and the run aborts with an unattributed "Unhandled Rejection" — hiding the real failure and which test failed. Bisect with `-t` to isolate, or temporarily neuter the `onConsoleLog` throw in the workspace `vitest.config.ts` (restore it immediately after) to see the underlying assertion failure.

## Notes / gaps

- No `.github/workflows/` directory observed — no CI config to document; CI (if any) is external.
- Per-package `test`/`coverage` script flags (e.g. per-file runs like `vitest run <path>`) live in each workspace's `package.json` — check there for exact invocations.
