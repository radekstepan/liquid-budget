# Codebase Concerns — Full Repo

Date: 2026-10-10 (refresh of the 2026-09-04 audit) | Workspace: ynab4-alternative-spa-implementation (yarn 4 monorepo: `apps/*`, `packages/*`, turbo)
Scope note: this refresh re-verified every claim below against the current tree. Items marked ✅ RESOLVED were confirmed fixed; the rest are current risks with fresh evidence.

## 1. Overview

- Stack: Yarn 4.9.1 workspaces + Turbo 2.5.0; root TS 5.9.3, Vitest 2.1.9 (web: ^4.1.10), Node >= 20. App: `apps/web` (Next.js + Drizzle + PostCSS, Playwright + Vitest configs present).
- Since the last audit the repo gained: snapshots, payee manager, global search, split templates, transaction merge, themes, and optional AI rename suggestions (`server/llm.ts`).
- Largest current risk themes: (a) no working lint gate and no CI config in-repo, (b) data-layer surface (SQLite files + snapshots + YNAB import path + LLM key handling), (c) test-runner version drift.

## 2. Risks (security / correctness / data loss)

1. **No lint gate, no CI in-repo** — every workspace `lint` script is a no-op echo, and no `.github/workflows/` exists. `typecheck` + `test` + `check:artifacts` are the only real gates, and nothing runs them automatically. A broken or secret-leaking commit lands silently.
2. **`db:reset` wipes the dev database** — `yarn db:reset` rebuilds and destroys repo-root `budget.db` with no confirmation and no backup prompt. Take a snapshot (`/api/snapshots`) before resetting a database you care about.
3. **YNAB import surface** — `backup.y4backup` and `import.csv` at root (both git-ignored), plus `db:import` and `/api/import`. Untrusted CSV/backup parsing remains the most likely malformed-data sink. Mitigated in part by import test suites (`import-ynab4*.test.ts`, `import-csv.test.ts`, `import.spec.ts`, scale tests); still worth fuzz/edge-case review for new formats.
4. **LLM API key handling** — `LLM_API_KEY` lives in git-ignored `.env.local` and is read server-side only (`server/llm.ts` never sends it to the browser — verified). Residual risks: payee names leave the machine on every "Suggest with AI" click (batches of 10, up to `LLM_MAX_PAYEES`), and there is no audit log of what was sent. Fine for personal use; disclose before sharing the app.
5. **Snapshot disk growth** — each snapshot is a full multi-MB `.db` copy in repo-root `snapshots/` (git-ignored via `*.db` + `snapshots/*.json`, but nothing caps count or total size). Old snapshots accumulate silently; prune them periodically.
6. **E2E stale-server footgun** — Playwright `reuseExistingServer` reuses whatever listens on port 3100, so a leftover `next start` silently poisons `yarn e2e` (stale bundle, dirty DB handle). Mitigated by root `yarn e2e` running `e2e:clean` first — always use it instead of invoking `playwright test` directly.
7. **Dependency drift** — root pins look current (TS 5.9, turbo 2.5.0), but `@ynab/web` runs Vitest 4 while the other packages run Vitest 2.1.9 (behavior/plugin differences possible). Per-workspace transitive deps were not audited. Check `yarn npm audit` / Dependabot and Next.js/Drizzle advisories.

## 3. Resolved since the last audit (verified 2026-10-10)

- ✅ **`.gitignore` coverage** — `*.db*`, `*.sqlite*`, `*.y4backup`, `*.csv`, `repomix-output.xml`, `test-results/`, `coverage/`, `.next/`, `snapshots/*.json` are all ignored; `git ls-files` confirms zero tracked artifacts. `yarn check:artifacts` (BUG-18.6) enforces this as a runnable gate.
- ✅ **TODO/debt inventory** — `rg -n "TODO|FIXME|HACK|XXX|DEPRECATED"` over `apps`/`packages`/`scripts` returns zero hits.
- ✅ **Risky-sink review** — the only `dangerouslySetInnerHTML` is the static `THEME_INIT_SCRIPT` in `apps/web/src/app/layout.tsx` (no user input); no `eval`; `execSync`/`spawn` appear only in the `check-artifacts` script (`git ls-files`) and e2e helpers; `localStorage` access is centralized in `ui/useLocalStorage.ts`.
- ✅ **`node_modules` tracking** — `node_modules/` is git-ignored; the earlier listing was on-disk presence only.
- ✅ **Test isolation** — verified by config: unit tests run with `DATABASE_URL=:memory:`, E2E runs against `budget.test.db` on port 3100, `/api/reset` returns 403 without `RESET_ENABLED=true`. The dev `budget.db` is unreachable from tests unless the env is deliberately overridden.
- ✅ **Convention drift** — `AGENTS.md` now documents both `*.test.ts` and `*.test.tsx`, the full script surface, and the key gotchas; ESM-only holds (`"type": "module"` everywhere).
- ✅ **Import-path documentation** — import/export/snapshot flows are now covered in ARCHITECTURE/STRUCTURE/INTEGRATIONS.

## 4. Testing gaps

- **Coverage is enforced but was not run here** — thresholds exist (logic 90/85/90/90, server 85/70/70/85, ui 85/80/50/85) and `yarn coverage` fails below them. No suite was executed in this audit; run `yarn build && yarn test && yarn e2e` for a baseline.
- **Highest-value tests to add/confirm**: CSV/`y4backup` malformed-input fuzz, migration up-cheapness on large DBs, budget-math rounding edges, concurrent-write behavior under the `AsyncMutex`, snapshot restore round-trips, and LLM-suggest failure modes (timeout, bad key, provider outage).
- **Auth/session flows** — still a single-user local app with no auth layer; if multi-user or network exposure is ever planned, auth/CSRF/session review becomes the top item (no action needed while local-only).

## 5. Opportunities (cheap wins)

1. Wire the installed `eslint` + `eslint-config-next` into `@ynab/web`'s `lint` script (or drop the dep) so `yarn lint` means something.
2. Add a minimal CI workflow (`.github/workflows/`) running `yarn build && yarn typecheck && yarn test && yarn check:artifacts` — every gate already exists, just nothing calls them.
3. Align Vitest majors (web on 4 vs 2.1.9 elsewhere) or record why the drift is intentional.
4. Add snapshot retention (count/size cap or prune command) to `server/snapshots.ts`.
5. Confirm before destroy: make `db:reset` require a flag or print the DB path + size before wiping.
6. Record baseline: `yarn typecheck`, `yarn test`, `yarn coverage`, `yarn e2e` outputs in `.planning/STATE.md`.

## 6. Suggested next steps

- [ ] `yarn build && yarn typecheck && yarn test` for `apps/web` and each `packages/*`; capture failures
- [ ] `yarn e2e` baseline (build first; uses port 3100 + `budget.test.db`)
- [ ] `yarn npm audit` for workspaces; triage Next.js/Drizzle advisories
- [ ] Decide on `lint` (wire eslint or remove) and CI workflow
- [ ] Write `.planning/STATE.md` baseline from the above results
