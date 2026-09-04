# Testing

## Overview

Two-layer strategy: unit/component tests with Vitest, end-to-end tests with
Playwright. Turbo orchestrates per-workspace runs; `apps/web` is the primary
tested surface (`vitest.config.ts`, `playwright.config.ts`, `tests/`,
`test-results/` all live there).

## Test stack

| Layer | Tool | Location |
|---|---|---|
| Unit / component | Vitest 2.1.9 (root devDependency) | `*.test.tsx` colocated per `AGENTS.md`; `apps/web/vitest.config.ts` |
| E2E | Playwright | `apps/web/playwright.config.ts`, specs in `apps/web/tests/`, output in `apps/web/test-results/` |
| Orchestration | Turborepo (`test`, `coverage`, `test:watch` tasks) | Root `package.json`, `turbo.json` |
| Type safety net | `typecheck` (TS strict + `noUncheckedIndexedAccess`) | Per-package `tsconfig.json` extending `tsconfig.base.json` |

## Coverage

- `turbo.json` wires `test` and `coverage` tasks with `outputs: ["coverage/**"]` (Turbo-cached).
- Root `yarn coverage` runs `turbo run coverage` across workspaces.
- `test` tasks declare `dependsOn: ["^build"]` — tests run against built dependencies.

## How to run

```sh
yarn test         # full suite across all workspaces (turbo run test)
yarn test:watch   # watch mode (uncached, persistent)
yarn coverage     # coverage reports (coverage/ per workspace)

# E2E (web app only)
yarn e2e          # headless Playwright run
yarn e2e:headed   # headed run
yarn e2e:ui       # interactive Playwright UI
yarn e2e:install  # install browser binaries (first-time setup)
```

## Naming and placement

- Name test files `*.test.tsx` (repo convention per `AGENTS.md`).
- Unit tests live next to the code they cover; E2E specs live in `apps/web/tests/`.
- Never commit `test-results/` or `coverage/` output (build artifacts).

## Notes / gaps

- No `.github/workflows/` directory observed — no CI config to document; CI (if any) is external.
- Per-package `test`/`coverage` script flags (e.g. per-file runs like `vitest run <path>`) live in each workspace's `package.json` — check there for exact invocations.
