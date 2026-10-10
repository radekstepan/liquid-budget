# Codebase Conventions

## Overview

Monorepo (Yarn 4.9.1 workspaces + Turborepo 2.5.0) for a YNAB4-alternative SPA.
Node >= 20, TypeScript 5.9.3, ESM throughout.

| Area | Location |
|---|---|
| Web app (Next.js) | `apps/web` (+ `src/`, `scripts/`, `tests/`) |
| Shared packages | `packages/logic`, `packages/server`, `packages/theme`, `packages/ui` |
| Repo-wide tasks | Root `package.json` scripts via `turbo run` |
| Agent entry point | `AGENTS.md` |

## Observed conventions

### Modules

- ESM `import` / `export` syntax only (per `AGENTS.md`).
- Bundler-style module resolution (`moduleResolution: Bundler` in `tsconfig.base.json`).
- `resolveJsonModule` enabled; `isolatedModules` enabled (each file independently transpilable — no cross-file type-only re-export tricks).

### TypeScript (strict)

Base config (`tsconfig.base.json`): `strict: true`, plus:

- `noUncheckedIndexedAccess` — index access yields `T | undefined`; always guard or narrow.
- `noImplicitOverride` — overriding class members need explicit `override`.
- `forceConsistentCasingInFileNames` — import paths must match file casing exactly.
- `skipLibCheck: true`; `declaration` + `sourceMap` on for packages.

### Naming patterns

- Test files: `*.test.ts` for node tests, `*.test.tsx` for component tests (Vitest `include` patterns accept both; E2E specs are `*.spec.ts` under `apps/web/tests/e2e/`).
- Workspace packages: `@ynab/*` scope (e.g. `@ynab/web`, `@ynab/server`).
- Turbo task names double as per-package script names: `dev`, `build`, `lint`, `typecheck`, `test`, `test:watch`, `coverage`, `clean`.
- Database scripts: root `yarn db:reset` / `db:migrate` delegate to `@ynab/server` (each rebuilds `dist` first); root `yarn db:import` runs `apps/web/scripts/do-import.ts` via tsx (a different path from `@ynab/server`'s own `db:import`, which runs `dist/db-import.js`); `db:generate` runs drizzle-kit from `@ynab/web` but writes into `packages/server/src/migrations` (see `drizzle.config.json` `out`).

### Test hygiene

- Every Vitest config sets `onConsoleLog` to throw: any `console.*` output from code under test fails the suite. Keep tests and sources silent (or spy on console explicitly).
- Shared UI-test helpers live in `packages/ui/tests/` (`dropdown.ts`); web route tests live in `apps/web/tests/` with `DATABASE_URL=:memory:`.

### Lint / format configs

- No root `eslint*`, `.prettier*`, or `biome*` config files observed.
- Linting is delegated per package: `yarn lint` runs `turbo run lint` — but every workspace's `lint` script is currently a no-op echo, so `yarn lint` always passes. (eslint + eslint-config-next are installed in `@ynab/web` devDeps but unwired.)
- Check a package's own `package.json` + local config files before assuming a shared linter.
- `scripts/check-artifacts.mjs` (`yarn check:artifacts`, BUG-18.6 guard) fails if any `.db*`/`.sqlite*`/`.y4backup`/`.DS_Store`/`import.csv` is git-tracked.
- `scripts/free-port.sh` (`yarn e2e:clean`) kills stale listeners on the e2e port before Playwright runs.

### Styling / app specifics

- `apps/web` uses `postcss.config.mjs` + `next.config.ts` (`transpilePackages` covers all four workspaces); theming split into `packages/theme`, shared UI into `packages/ui`.
- Drizzle ORM config at `apps/web/drizzle.config.json` (schema + migrations both point into `packages/server`).
- Env-var surface: `DATABASE_URL` (DB path, default repo-root `budget.db`), `RESET_ENABLED` (gates `/api/reset`), `SNAPSHOTS_DIR` (snapshot storage), `LLM_*` (optional AI features, see `apps/web/.env.example`). `E2E_TESTING` is set by `e2e:server` but currently read by nothing.

## How to run the gates

```sh
yarn lint       # turbo run lint (no-op echo in every package — always passes)
yarn typecheck  # turbo run typecheck
yarn build      # turbo run build (lint/typecheck/test all depend on ^build per turbo.json)
yarn check:artifacts  # hygiene guard: no DB/backup artifacts tracked in git
```
