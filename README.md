# YNAB4 Alternative

## What This App Is

This app helps you plan and track your money. It uses envelope budgeting. You give each dollar a job. You track spending against your plan.

It reads YNAB4 backup files. If you used YNAB4, you can move your data here.

## What You Can Do

- Plan each month: assign money to categories, carry leftover amounts forward, and see overspending at once.
- Track accounts: record transactions, split one payment across categories, and link transfers between accounts.
- Manage payees: rename many payees at one time, and set rules to rename them automatically.
- Use AI help (optional): get payee rename suggestions from an AI service. You must add your own API key.
- Automate repeats: create schedules for bills and income, and preview future transactions.
- Reconcile: compare your records with bank statements, and lock reconciled amounts.
- Remove duplicates: find possible duplicate entries, and merge them safely.
- Search: find any transaction fast with global search.
- See reports: spending by category, spending trends, net worth, and expense breakdown.
- Protect your data: make full snapshots, restore them when necessary, and run checks that prove balances are correct.
- Change the look: select from built-in color themes.

## Start the App

1. Install Node.js 22 or a newer version.
2. Run `yarn install` to install dependencies.
3. Run `yarn build` to build all packages.
4. Run `yarn db:migrate` to prepare the database.
5. Run `yarn dev` to start the app.
6. Open `http://localhost:3000` in your browser.

The app imports `.y4backup` files and CSV files. Use the import screens in the app.

## Useful Commands

- `yarn dev` — start the app for development.
- `yarn test` — run all unit and component tests.
- `yarn e2e` — run end-to-end tests in a browser.
- `yarn typecheck` — check types in all packages.
- `yarn db:reset` — delete the local database and start again. This step destroys data.

## Project Layout

- `apps/web` — the Next.js host. It holds routes and API handlers.
- `packages/logic` — budget rules and calculations. It has no database access.
- `packages/server` — the database, migrations, imports, exports, and snapshots.
- `packages/ui` — all screens and components.
- `packages/theme` — color themes and design tokens.

## Your Data

The app stores data in `budget.db` in the project root. This file stays on your computer. Git does not track it. Make snapshots to keep copies of important states.
