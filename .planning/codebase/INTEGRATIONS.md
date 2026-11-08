# INTEGRATIONS

## Overview

Self-contained budgeting app. The browser UI talks to the Next.js server over a local REST API (`/api/*`); the API routes call `@ynab/server` in-process (no separate backend service). All data is local: embedded SQLite database files, snapshot copies, and local YNAB4 import artifacts (`.y4backup` zip / CSV). The only outbound network call is the optional AI payee-rename feature, which hits a user-configured OpenAI-compatible chat endpoint.

## Internal Integrations (workspace)

| From | To | Mechanism | Notes |
|---|---|---|---|
| `@ynab/web` | `@ynab/logic` | `workspace:*` import | Domain/budget calculations, zod contracts, page titles |
| `@ynab/web` | `@ynab/server` | `workspace:*` import, in-process | API routes call server queries directly (same Node process); no separate backend to deploy |
| `@ynab/web` | `@ynab/ui` | `workspace:*` import | React components via `BudgetAppShell` |
| Browser UI | `@ynab/web` API routes | HTTP `fetch` to `/api/*` | The UI package never touches the DB; all data flows through REST handlers validated by `schemas.ts` + zod |
| `@ynab/ui` | `@ynab/logic`, `@ynab/theme` | `workspace:*` imports | Components consume logic + theme tokens/CSS |
| `@ynab/server` | `@ynab/logic` | `workspace:*` import | Server reuses domain logic (import, rename, budgets) |

## Data / Persistence

| Integration | Details (observed) |
|---|---|
| SQLite via better-sqlite3 `11.10.0` + drizzle-orm `0.45.2` | Primary store. Live files at repo root: `budget.db` (+ `-shm`/`-wal`), `budget.test.db` (+ `-shm`/`-wal`). Path overridable via `DATABASE_URL` (`:memory:` in unit tests). Writes serialized through an `AsyncMutex` in `server/transaction.ts` |
| Migrations via drizzle-kit `0.31.10` | `packages/server` build copies `src/migrations` → `dist/migrations`; scripts: `db:reset` (`dist/db-reset.js`), `db:migrate` (`dist/migrate.js`), `db:import` (`dist/db-import.js`), `db:generate`/`db:check` |
| Web-side drizzle config | `apps/web/drizzle.config.json` + `db:generate` (`drizzle-kit generate`); schema and migration output both point into `packages/server` |
| Snapshots | Full `.db` copies + `.json` sidecars in `snapshots/` next to the DB file (`server/snapshots.ts`, `SNAPSHOTS_DIR` override, `snapshots/*.json` git-ignored) |

## File-Import Integrations (local, no network)

| Integration | Details (observed) |
|---|---|
| YNAB4 backup import (`.y4backup`) | Zip parsing via `adm-zip ^0.6.0` in `@ynab/web` and `@ynab/server`; sample artifact `backup.y4backup` at root (git-ignored) |
| CSV import | Sample artifact `import.csv` at root (git-ignored); import runner `apps/web/scripts/do-import.ts` invoked as root `db:import` via `npx tsx` |
| YNAB4 export | `server/export-ynab4.ts` produces a `.y4backup`-compatible zip via `/api/export` |

## YNAB4 fidelity vs deliberate forks

We import/export `.y4backup`, but the engine intentionally differs from YNAB4
(`4.3.855`) in the eight places below. Do not "fix" these back toward YNAB4.
Our-side refs are exact; YNAB4-side refs live in the sibling decompiled tree
(`/home/radek/dev/ynab4/ynab4-swf-analysis/src/scripts/com/ynab/`, read-only,
outside this repo). Import/export data losses (as opposed to behavior forks)
are tracked separately in the untracked working notes `docs/ynab4-import-gaps.md`
(deliberately not committed; user-visible import warnings already surface in
`ImportSummary.warnings` — `packages/server/src/import-ynab4.ts:1718-1794` —
and export caveats in `packages/server/src/export-ynab4.ts:429-434,758-770`,
so nothing here duplicates them).

| # | Area | Ours (deliberate) | YNAB4 |
|---|---|---|---|
| 1 | CC buffer | Automatic buffer machine: funded CC spending moves cash into the linked CC Payment category; paying the card draws it down (`packages/logic/src/budget-engine.ts:661-841`, synthetic "Credit Card Payments" group `budget-engine.ts:183-278`). New-budget-style; header comment states the split explicitly | No buffer machine. Pre-existing card debt lives in per-account "Pre-YNAB Debt" categories (`view/walkthroughs/WalkthroughStep.as:232`, `CCBasics`/`CCFirstPayment` walkthroughs) |
| 2 | Rename priority | Exact rules beat `[N]`/`[X]` patterns; newer rules beat older ones (`packages/logic/src/rename-rules.ts:227-245`, matcher `:214-224`) | Exact-hit-then-first-in-sorted-view (`utilities/PayeeUtilities.as:47` via `payeeManager.getExistingTransactionsThatAreAffectedByRule`; conditions in `ynabData/vo/StringConditionVO.as`) |
| 3 | Reconcile adjustment | Adjustment posts with status `r` and `date = statementDate` (`packages/server/src/queries/reconcile.ts:249-282`); export maps `r`→`Reconciled` (`packages/server/src/export-ynab4.ts:36-37`), so round-trip changes semantics | Adjustment posts `Cleared` with today's date (`view/register/dialogs/ReconciliationStatementDialog.as:538-544` reconciles through `clearedBalance` at the target date) |
| 4 | Transfers | Single row with `transferAccountId` + dual status (`status` / `transferStatus`, see `packages/logic/src/transfers.ts`, `packages/logic/src/contracts.ts`, `packages/logic/src/reconcile.ts:114`) — each side of a transfer reconciles independently | Paired mirror rows linked by `transferTransactionId`, each side with independent cleared state (`ynabData/vo/BaseTransactionVO.as:12,89-102`) |
| 5 | Duplicate matching / merge | Exact-only fingerprints: account + date + amount + normalized payee/memo (+fitId) (`packages/logic/src/duplicates.ts:128-152`, grouping `:160-206`). Merge takes primary date/status (`packages/logic/src/merge.ts:206-223`) | Fuzzy import matching via `findMatchingTransaction` plus FITID/YNABID lookup within ±4 days (`dataAccess/importing/ImportUtilities.as:292-332`); merge keeps user-entered date and max cleared state |
| 6 | Income month | `incomeMonth` is a superset: any N-month jump is honored and attributed across past/future buckets (`packages/logic/src/budget-engine.ts:567-585`, classification `transfers.ts:77+`, default `nextMonthKey` in `packages/logic/src/payload-builders.ts`) | Only two buckets — `__ImmediateIncome__` (this month) vs `__DeferredIncome__` (next month) (`constants/CategoryConstants.as:36-38`) |
| 7 | Rename normalization | `normalizeRenameText` lowercases AND folds separator punctuation (`* . - / …` → space) while keeping `[` `]` `#` significant so `[N]`/`[X]` wildcards and `#24` survive (`packages/logic/src/rename-rules.ts:75-82`) | Plain `toLocaleLowerCase` comparison, no punctuation folding |
| 8 | Money | Integer cents everywhere (`num()` in `packages/logic/src/format.ts:47+`), USD-centric 2dp display (`fmt()` `:31-40`); parsing accepts en-US and de-DE separators via YNAB4-style last-separator-wins fallback (`normalizeSeparators`) | Per-locale `decimalDigits` formatting (`managers/LocalizationManager.as`) with per-addend rounding (`safeAdd`-style accumulation) |

## External / SaaS / Network

| Integration | Status (observed) |
|---|---|
| AI rename suggestions (optional) | `server/llm.ts`: minimal OpenAI-compatible `POST {baseUrl}/chat/completions` client (native fetch, no SDK dep). Used by `queries/rename-suggest.ts` for "Suggest with AI". Enabled only when BOTH `LLM_API_KEY` and `LLM_MODEL` are set (see `apps/web/.env.example`); key is read server-side only, never sent to the browser. Supports local providers (Ollama, LM Studio) via `LLM_BASE_URL`; payees sent in batches of 10, max `LLM_MAX_PAYEES` (default 200) |
| Other external SaaS (auth, payments, analytics, email, error tracking) | None found in `package.json` manifests |
| Other outbound HTTP clients | None observed in dependencies |
| Inbound serving | Next.js: `next dev` (port 3000) for development; `next start` (port 3100, `DATABASE_URL=../../budget.test.db`, `RESET_ENABLED=true`) for the E2E harness |
| Browser E2E harness | Playwright `@playwright/test ^1.61.1` against the local server (`apps/web/tests/e2e/`, `test-results/`, serial `workers: 1`) |

## Dev-Environment Integrations

| Integration | Details (observed) |
|---|---|
| Node toolchain | `engines: node >=20`; `.nvmrc 24.15.0` |
| Package registry | Default Yarn 4 registry (no custom `npmRegistryServer` in `.yarnrc.yml`); `.yarn/` vendor dir present |
| Turborepo orchestration | Local task graph only; no remote-cache config observed in `turbo.json` |
| Artifact gate | `scripts/check-artifacts.mjs` (`check:artifacts`) — fails CI/pre-commit if DB/backup artifacts are tracked |
| Port hygiene | `scripts/free-port.sh` (`e2e:clean`) — kills stale listeners on the e2e port |

## Versions Observed (integration-relevant)

- `better-sqlite3 11.10.0`, `drizzle-orm 0.45.2`, `drizzle-kit 0.31.10`
- `adm-zip ^0.6.0`, `zod ^4.4.3`
- `next 16.2.6`, `react 19.2.6`, `react-dom 19.2.6`
- `@playwright/test ^1.61.1`
