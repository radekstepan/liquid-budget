# STACK

## Overview

TypeScript ESM monorepo (Yarn 4 workspaces + Turborepo) implementing a YNAB4-alternative personal budgeting app. One Next.js app (`apps/web`) plus four shared packages (`logic`, `server`, `ui`, `theme`). Backend is embedded SQLite via server package; no standalone API server.

## Languages & Runtimes

| Item | Observed |
|---|---|
| Language | TypeScript (strict, `ES2022` target, `ESNext` modules, `Bundler` resolution — see `tsconfig.base.json`) |
| Module system | ESM only (`"type": "module"` in every workspace package) |
| Runtime | Node.js `>=20` (root `engines`); pinned dev version `24.15.0` (`.nvmrc`) |
| Conventions | ESM `import`/`export` only; tests named `*.test.tsx` (see `AGENTS.md`) |

## Frameworks

| Layer | Framework | Version observed |
|---|---|---|
| Web app | Next.js (webpack build: `next build --webpack`) | `16.2.6` |
| UI runtime | React + React DOM | `19.2.6` |
| Styling | Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/postcss`, `postcss`) | `4.1.17` / `8.5.8` |
| Validation | Zod | `^4.4.3` |
| ORM / migrations | Drizzle ORM + Drizzle Kit | `0.45.2` / `0.31.10` |
| SQLite driver | better-sqlite3 (synchronous) | `11.10.0` |
| YNAB import | adm-zip (+ `@types/adm-zip`) | `^0.6.0` |

## Build Tools & Orchestration

| Tool | Version observed | Role |
|---|---|---|
| Yarn (node-modules linker, global cache) | `4.9.1` (`packageManager`, `.yarnrc.yml`, `.yarn/`) | Workspaces, install |
| Turborepo | `2.5.0` (`turbo.json`) | Task graph: `build` (depends `^build`), `dev`/`test:watch` persistent, `test`/`coverage` emit `coverage/**`, web build outputs `dist/**`, `.next/**` |
| TypeScript compiler | `5.9.3` (root + every workspace) | `tsc -b` builds, per-package `typecheck` |
| Vite (UI package only) | `5.4.11` (+ `@vitejs/plugin-react` `4.3.4`) | Component test bundling |
| Next compiler | via `next@16.2.6` | `apps/web` dev/build/start |
| ESLint / eslint-config-next | `9.39.4` / `16.2.6` (web devDeps) | Installed but `lint` script is a no-op echo in all packages |
| drizzle-kit | `0.31.10` | `db:generate`, `db:check` |
| tsx (root invocation) | via `npx tsx apps/web/scripts/do-import.ts` | `db:import` script |
| scripts/check-artifacts.mjs | repo script | `check:artifacts` gate |

## Test Stack

| Scope | Runner | Version observed | Extras |
|---|---|---|---|
| Root | Vitest | `2.1.9` | Orchestrated via `turbo run test` |
| apps/web | Vitest | `^4.1.10` (+ `vitest.config.ts`) | E2E separately via Playwright `@playwright/test ^1.61.1` (`playwright.config.ts`, `tests/`, `test-results/`) |
| packages/logic | Vitest | `2.1.9` | `@vitest/coverage-v8 2.1.9` |
| packages/server | Vitest | `2.1.9` | `@vitest/coverage-v8 2.1.9` |
| packages/ui | Vitest | `2.1.9` | `jsdom 25.0.1`, Testing Library (`dom 10.4.0`, `jest-dom 6.6.3`, `react 16.1.0`) |
| packages/theme | — | — | No test script (build/typecheck only) |

## Workspace Packages

| Package | Entry | Deps |
|---|---|---|
| `apps/web` (`@ynab/web`, private) | Next.js app (`next dev/build/start`), `drizzle.config.json`, `next.config.ts`, `postcss.config.mjs` | `workspace:*` on logic/server/ui; `adm-zip`, `next`, `react`, `react-dom`, `zod` |
| `packages/logic` (`@ynab/logic`) | Pure logic, `dist/index.js` | Zero runtime deps |
| `packages/server` (`@ynab/server`) | SQLite persistence, ships `dist/migrations` (copied in build) | `@ynab/logic`, `adm-zip`, `better-sqlite3`, `drizzle-orm` |
| `packages/ui` (`@ynab/ui`) | React components, `dist/index.js` | `@ynab/logic`, `@ynab/theme`; peer `react/react-dom 19.2.6` |
| `packages/theme` (`@ynab/theme`) | Tokens + `src/index.css` (`./styles.css` export) | Peer `react/react-dom 19.2.6`; no runtime deps |

## Key Configs (versions observed)

- `package.json` — workspaces `apps/*`, `packages/*`; scripts `dev/build/lint/typecheck/test/test:watch/e2e*/clean/db:* /coverage/check:artifacts`.
- `turbo.json` — task pipeline as above.
- `tsconfig.base.json` — `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `declaration`+maps+sourceMap.
- `.yarnrc.yml` — `nodeLinker: node-modules`, `enableGlobalCache: true`.
- `.nvmrc` — `24.15.0`.
- `apps/web/next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `drizzle.config.json`.
