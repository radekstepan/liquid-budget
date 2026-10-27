# AGENTS.md

## Commands

- `yarn test` - run the full test suite (turbo; depends on `^build`)
- `yarn build` - build the project
- `yarn lint` - run the lint task (currently a no-op echo in every package)
- `yarn typecheck` - typecheck every workspace
- `yarn dev` - run the development task (`next dev` on port 3000)
- `yarn e2e` - frees the e2e port (3100) via `e2e:clean`, then runs the Playwright suite
- `yarn e2e:clean` - stop any stale server on the e2e port (3100)
- `yarn e2e:headed` / `yarn e2e:ui` / `yarn e2e:install` - headed run / interactive UI / install browsers
- `yarn db:reset` - rebuild + wipe the dev database (`budget.db`)
- `yarn db:migrate` - rebuild + apply pending migrations to the dev database
- `yarn db:import` - run the CSV import script (`apps/web/scripts/do-import.ts` via tsx)
- `yarn db:generate` - regenerate Drizzle migrations from the schema
- `yarn coverage` - coverage reports (per-workspace thresholds enforced)
- `yarn check:artifacts` - fail if any `.db`/`y4backup`/CSV artifact is git-tracked

## Code Map

- `apps/web` - Next.js host: routes + REST handlers + shell (thin glue, no domain logic)
- `packages/logic` - pure domain rules, no I/O (budget math, transfers, splits, search, AI contracts)
- `packages/server` - SQLite persistence, migrations, import/export, snapshots, LLM client
- `packages/ui` - all React views, modals, and client state
- `packages/theme` - design tokens + themes (`./styles.css` export)

## Conventions

- Use ESM `import` and `export` syntax.
- Name test files `*.test.ts` (logic/server) or `*.test.tsx` (components); both match the Vitest includes.
- Never `console.log` in code under test: every Vitest config throws on any console output.
- Never commit `budget.db*`, `*.y4backup`, `import.csv`, or `snapshots/*.json` (git-ignored; see `yarn check:artifacts`).

## Gotchas

- E2E runs a production server (`next start`) on port 3100 against `budget.test.db` — build first, and always run via root `yarn e2e` so a stale server can't poison the run.
- Agent sessions need `--sandbox-network enabled` (or `--disable-sandbox`) at launch to run `yarn e2e` — the default network sandbox denies `listen()`, so `next start` fails with `EPERM` on port 3100. Even with networking, the sandboxed Chromium headless shell can SIGSEGV at `browserType.launch` (all browser specs fail identically, API-contract specs pass) — that is an environment block, not a regression; confirm `yarn e2e` in a normal terminal.
- `/api/reset` returns 403 unless `RESET_ENABLED=true`.
- `DATABASE_URL` overrides the DB path; unit tests use `:memory:`.
- Optional AI rename suggestions need both `LLM_API_KEY` and `LLM_MODEL` (see `apps/web/.env.example`).
