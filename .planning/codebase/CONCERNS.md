# Codebase Concerns — Full Repo

Date: 2026-09-04 | Workspace: ynab4-alternative-spa-implementation (yarn 4 monorepo: `apps/*`, `packages/*`, turbo)
Prior context: `.planning/STATE.md` does not exist (no prior planning context). `.planning/` did not exist before this run.
Scope note: written under a two-batch discovery budget; content-search probes for TODO/FIXME and risky sinks returned no usable hits, so pattern-level claims below are structural risks to confirm, not confirmed findings.

## 1. Overview

- Stack: Yarn 4.9.1 workspaces + Turbo 2.5.0; root TS 5.9.3, Vitest 2.1.9, Node >= 20. App: `apps/web` (Next.js + Drizzle + PostCSS, Playwright + Vitest configs present).
- Largest visible risk themes: (a) live/generated artifacts sitting in repo root, (b) data-layer surface (SQLite files + YNAB import path), (c) unconfirmed test/lint/typecheck coverage.
- No `TODO/FIXME/HACK/@ts-ignore` inventory was obtainable in the discovery budget — treat that as an open item, not as "clean".

## 2. Risks (security / correctness / data loss)

1. **SQLite databases in workspace root** — `budget.db` (~4.3 MB) + `-wal`/`-shm` journals, plus `budget.test.db*` alongside them. Risk: real financial data co-located with code; WAL/SHM imply a live DB was open during dev; test DB can collide with dev DB. Confirm `.gitignore` coverage and whether any DB is tracked; move out of root / use per-env paths.
2. **YNAB import surface** — `backup.y4backup` (~1.4 MB) and `import.csv` at root, plus `db:import` script (`apps/web/scripts/do-import.ts`). Risk: untrusted CSV/backup parsing is the most likely injection/malformed-data sink. Needs fuzz/edge-case tests and validation review.
3. **Generated/derived artifacts at root** — `repomix-output.xml` (~3.4 MB) and committed `node_modules` listing observed. Risk: secret leakage via bulk dumps, stale context, repo bloat. Keep generated dumps out of the repo or gitignored.
4. **Auth/session handling unreviewed** — Next.js app with local SQLite; session, CSRF, and cookie flags need explicit review (not covered in budgeted scan).
5. **Dependency drift** — root pins look current (TS 5.9, turbo 2.5.0, vitest 2.1.9), but per-workspace deps (`apps/web/package.json`, `packages/*/package.json`) were not audited. Check for outdated/vulnerable transitive deps (`yarn npm audit` / Dependabot) and Next.js/Drizzle advisories.

## 3. Tech debt & risky patterns (to confirm)

- **TODO/debt inventory missing** — run `rg -n "TODO|FIXME|HACK|XXX|DEPRECATED|ts-ignore|ts-nocheck|\bany\b"` over `apps`/`packages` and triage; the budgeted probe returned nothing usable, so this is unverified.
- **Risky-sink review missing** — review `eval`, `exec/execSync/spawn`, `innerHTML`/`dangerouslySetInnerHTML`, `localStorage` keys, and any hardcoded secrets/keys. Budgeted probe returned nothing usable — must re-run with corrected scoping.
- **Broad `node_modules` committed or scanned** — `apps/web/node_modules` content appeared in directory listings; ensure it is ignored and not scanned by lint/tests/coverage.
- **`AGENTS.md` convention drift** — prescribes ESM and `*.test.tsx` names; verify actual compliance (e.g. `.test.ts` vs `.test.tsx`, CJS leftovers) and that `yarn lint/typecheck/test/build` gates actually pass.
- **Turbo task coupling** — `lint/typecheck/test` all `dependsOn: ^build`; slow or order-sensitive pipelines can hide fast feedback. Confirm caching/outputs (`dist/**`, `.next/**`, `coverage/**`) don't mask failures.
- **DB scripts sprawl** — `db:reset`, `db:import`, `db:generate`, `db:migrate` split across root and `@ynab/*` workspaces; confirm single source of truth for migrations and reset safety (no prod-data wipe footgun).

## 4. Testing gaps

- **Coverage unknown** — `vitest.config.ts`, `playwright.config.ts`, `tests/`, `test-results/` exist in `apps/web` but no suite was run here. Run `yarn test`, `yarn coverage`, and `yarn e2e` and record pass/fail + uncovered areas.
- **Highest-value tests to add/confirm**: CSV/`y4backup` import happy-path + malformed rows, sqlite migration up/down, budget-math edge cases (rounding, empty budgets, large files), concurrent-write behavior (WAL), and auth/session flows.
- **Test isolation** — `budget.db` vs `budget.test.db` naming suggests shared-directory isolation; confirm tests never touch the dev DB (env-var path override + CI guard).
- **Artifact check unused?** — `check:artifacts` (`scripts/check-artifacts.mjs`) exists; confirm CI runs it so `test-results/`, `.next/`, `coverage/` don't get committed.

## 5. Opportunities (cheap wins)

1. Add/verify `.gitignore` for `*.db*`, `*.y4backup`, `import.csv`, `repomix-output.xml`, `test-results/`, `coverage/`, `.next/`.
2. Move sample fixtures into `fixtures/` and document the import path (`backup` -> `db:import` -> `db:migrate`).
3. Enable `yarn npm audit` / Dependabot + `yarn dedupe` pass for workspaces.
4. Record baseline: `yarn lint`, `yarn typecheck`, `yarn test`, `yarn coverage` outputs in next planning state file.
5. Re-run the two deferred greps (TODO inventory, risky sinks) without batch limits and file findings.

## 6. Suggested next steps

- [ ] `git status --short --ignored | head -50` + `git check-ignore budget.db budget.test.db backup.y4backup import.csv repomix-output.xml`
- [ ] `rg -n "TODO|FIXME|HACK" apps packages scripts` and risky-sink grep; triage into issues
- [ ] `yarn lint && yarn typecheck && yarn test` for `apps/web` and each `packages/*`; capture failures
- [ ] Review `apps/web/scripts/do-import.ts` + drizzle schema/migrations for validation gaps
- [ ] Write `.planning/STATE.md` baseline from the above results
