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

- Test files: `*.test.tsx` (per `AGENTS.md`) — applies even to non-component tests.
- Workspace packages: `@ynab/*` scope (e.g. `@ynab/web`, `@ynab/server`).
- Turbo task names double as per-package script names: `dev`, `build`, `lint`, `typecheck`, `test`, `test:watch`, `coverage`, `clean`.
- Database scripts live under `yarn workspace @ynab/server` (`db:reset`, `db:migrate`); web-side DB scripts under `@ynab/web` (`db:generate`).

### Lint / format configs

- No root `eslint*`, `.prettier*`, or `biome*` config files observed.
- Linting is delegated per package: `yarn lint` runs `turbo run lint` (each workspace defines its own `lint` script).
- Check a package's own `package.json` + local config files before assuming a shared linter.
- `scripts/check-artifacts.mjs` (`yarn check:artifacts`) guards build artifacts.

### Styling / app specifics

- `apps/web` uses `postcss.config.mjs` + `next.config.ts`; theming split into `packages/theme`, shared UI into `packages/ui`.
- Drizzle ORM config at `apps/web/drizzle.config.json`.

## How to run the gates

```sh
yarn lint       # turbo run lint (per-package linters)
yarn typecheck  # turbo run typecheck
yarn build      # turbo run build (lint depends on ^build per turbo.json)
```
