# Toolchain ADR (P2 toolchain remediation)

Status: accepted. Each item below was a P2 toolchain follow-up; the marker is
removed where the decision is applied, except the Vitest remainder (item 6).

## 1. SQLite driver: stay on better-sqlite3

`packages/server/src/client.ts` (plus `migrate.ts`, `snapshots.ts`, and the
server test harness) imports `better-sqlite3` 11.10.0, a native binding that
must be rebuilt after every Node switch (see `AGENTS.md` Gotchas).

`node:sqlite` (stable since Node 22; `.nvmrc` pins 24.15.0, so the floor is
met) would remove that fragility, but the in-repo `drizzle-orm` 0.45.2 ships
drivers only for `better-sqlite3`, `bun-sqlite`, `durable-sqlite`,
`expo-sqlite`, `op-sqlite`, and `sqlite-proxy` — there is **no**
`node:sqlite` driver in `node_modules/drizzle-orm/`. Migrating now would mean
upgrading `drizzle-orm` past a driver addition or hand-rolling a dialect
adapter, plus touching every `better-sqlite3` import site for zero query-level
gain (both drivers are synchronous, which is what the route/CLI usage needs).

Decision: stay on `better-sqlite3`. Revisit when a `drizzle-orm` upgrade
brings a first-party `node:sqlite` driver; the migration surface is
`client.ts`, `migrate.ts`, `snapshots.ts`, server tests, and item 2 below.

## 2. Web build pins `next build --webpack`

`apps/web/package.json` builds with `next build --webpack` instead of the
Next 16 Turbopack default. Deliberate: API routes import `@ynab/server`,
which is in `transpilePackages` (bundled, not in `serverExternalPackages`),
so `better-sqlite3`'s native `.node` binding flows through the bundler —
and Turbopack cannot bundle native modules. Dropping the flag breaks
`yarn build`. Revisit together with item 1: a stdlib-only driver
(`node:sqlite`) or marking the server external removes the need for it.

## 3. Turbo `^build` ordering: lint drops it, typecheck/test keep it

`lint` (`eslint .`) is pure source analysis — no `dist` input — so its
`dependsOn: ["^build"]` was pure latency and is removed. `typecheck` keeps
the dependency: `packages/server` and `packages/ui` use TypeScript project
references (`server → logic`, `ui → logic + theme`), and `tsc -p --noEmit`
resolves the referenced projects' `dist` declarations. `test` keeps it too:
`@ynab/web`, `@ynab/ui`, and `@ynab/server` test suites resolve workspace
deps through `dist` (see `AGENTS.md` Gotchas), so a stale `dist` would test
stale code.

## 4. `db:generate` is owned by `@ynab/server`

`apps/web/drizzle.config.json` and `packages/server/drizzle.config.ts`
pointed at the same schema (`packages/server/src/schema.ts`) and the same
output dir (`packages/server/src/migrations`); the web-side config existed
only so the root script could run generation from `apps/web`. Single owner
now: root `yarn db:generate` runs `yarn workspace @ynab/server db:generate`,
and the web config plus the web `db:generate` script are deleted.

## 5. `@types/node` tracks the `.nvmrc` major

`@types/node` is exact-pinned (repo convention: no carets) at the major
matching `.nvmrc` — currently 24.19.2 against Node 24.15.0 — in every
workspace that declares it (`@ynab/logic`, `@ynab/server`, `@ynab/web`).
When `.nvmrc` moves majors, bump the pin in the same change; a drifted
major (previously 22 types on a 24 runtime) silently mistypes stdlib APIs.

## 6. Vitest unification: BLOCKED on a v8 coverage artifact (stays split)

Attempted: logic/server/ui 2.1.9 → ^4.1.12 to match `@ynab/web`, plus the
knock-ons the bump required (`vite` 5.4.11 → ^6 for the `module-runner`
export vitest 4 needs; `@testing-library/jest-dom` 6.6.3 → 7.0.1, since
6.x matchers never register under v4). Test runs were green on v4 in all
four workspaces — but the coverage gate broke through no test change:
`@ynab/logic` measured 96.41 / 87.97 / **93.4** (statements/branches/
functions) under 2.1.9 and 94.54 / 82.88 / **74.73** under 4.1.12 on the
identical tree. The v4 `coverage-final.json` records every top-level
function twice (same name, same range — one 0-hit twin, one with real
hits), so the function/branch denominators are phantom-inflated and the
90% gate can never pass without threshold cuts.

Reverted to the split (logic/server/ui on 2.1.9, web on ^4.1.x) to keep the
enforced gate meaningful. Revisit when vitest fixes the function
dedup/merge upstream (or vitest 5 re-measures cleanly): re-apply the bump
above and confirm `yarn workspace @ynab/logic coverage` is green before
keeping it. Follow-up marker lives in `eslint.config.mjs`.
