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
