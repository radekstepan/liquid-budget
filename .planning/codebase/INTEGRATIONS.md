# INTEGRATIONS

## Overview

Self-contained budgeting app with no external SaaS dependencies observed in manifests. All integrations are local: embedded SQLite database files, local YNAB4 import artifacts (`.y4backup` zip / CSV), and in-repo workspace cross-links. External network surface is limited to the Next.js web server itself.

## Internal Integrations (workspace)

| From | To | Mechanism | Notes |
|---|---|---|---|
| `@ynab/web` | `@ynab/logic` | `workspace:*` import | Domain/budget calculations shared with UI and server |
| `@ynab/web` | `@ynab/server` | `workspace:*` import | Direct in-process DB access (no HTTP API layer observed) |
| `@ynab/web` | `@ynab/ui` | `workspace:*` import | React components |
| `@ynab/ui` | `@ynab/logic`, `@ynab/theme` | `workspace:*` imports | Components consume logic + theme tokens/CSS |
| `@ynab/server` | `@ynab/logic` | `workspace:*` import | Server reuses domain logic (e.g. import) |

## Data / Persistence

| Integration | Details (observed) |
|---|---|
| SQLite via better-sqlite3 `11.10.0` + drizzle-orm `0.45.2` | Primary store. Live files at repo root: `budget.db` (+ `-shm`/`-wal`), `budget.test.db` (+ `-shm`/`-wal`) |
| Migrations via drizzle-kit `0.31.10` | `packages/server` build copies `src/migrations` → `dist/migrations`; scripts: `db:reset` (`dist/db-reset.js`), `db:migrate` (`dist/migrate.js`), `db:import` (`dist/db-import.js`), `db:generate`/`db:check` |
| Web-side drizzle config | `apps/web/drizzle.config.json` + `db:generate` (`drizzle-kit generate`) |

## File-Import Integrations (local, no network)

| Integration | Details (observed) |
|---|---|
| YNAB4 backup import (`.y4backup`) | Zip parsing via `adm-zip ^0.6.0` in `@ynab/web` and `@ynab/server`; sample artifact `backup.y4backup` at root |
| CSV import | Sample artifact `import.csv` at root; import runner `apps/web/scripts/do-import.ts` invoked as root `db:import` via `npx tsx` |

## External / SaaS / Network

| Integration | Status (observed) |
|---|---|
| External SaaS (auth, payments, analytics, email, error tracking) | None found in `package.json` manifests |
| Outbound HTTP clients | None observed in dependencies (no axios/fetch wrappers declared) |
| Inbound serving | Next.js (`next dev --port 3000` for E2E via `e2e:server` with `E2E_TESTING=true`; `next start` for prod) |
| Browser E2E harness | Playwright `@playwright/test ^1.61.1` against local dev server (`apps/web/tests`, `test-results/`) |

## Dev-Environment Integrations

| Integration | Details (observed) |
|---|---|
| Node toolchain | `engines: node >=20`; `.nvmrc 24.15.0` |
| Package registry | Default Yarn 4 registry (no custom `npmRegistryServer` in `.yarnrc.yml`); `.yarn/` vendor dir present |
| Turborepo orchestration | Local task graph only; no remote-cache config observed in `turbo.json` |
| Artifact gate | `scripts/check-artifacts.mjs` (`check:artifacts`) |

## Versions Observed (integration-relevant)

- `better-sqlite3 11.10.0`, `drizzle-orm 0.45.2`, `drizzle-kit 0.31.10`
- `adm-zip ^0.6.0`, `zod ^4.4.3`
- `next 16.2.6`, `react 19.2.6`, `react-dom 19.2.6`
- `@playwright/test ^1.61.1`
