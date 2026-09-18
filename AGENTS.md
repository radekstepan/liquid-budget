# AGENTS.md

## Commands

- `yarn test` - run the full test suite
- `yarn build` - build the project
- `yarn lint` - run the lint task
- `yarn dev` - run the development task
- `yarn e2e` - frees the e2e port (3100) via `e2e:clean`, then runs the Playwright suite
- `yarn e2e:clean` - stop any stale server on the e2e port (3100)

## Code Map

- `apps` - application source
- `packages` - packages

## Conventions

- Use ESM `import` and `export` syntax.
- Name test files `*.test.tsx`.
