# TODO — Liquid (YNAB4 alternative) UI

Inventory of functionality that is currently not working, stubbed, or not yet implemented. Severity legend:

- 🔴 **Critical** — visibly broken or silently wrong; should be fixed first.
- 🟠 **Stub** — looks like a feature in the UI but does nothing.
- 🟡 **Missing** — YNAB4 has it; we don't.
- 🟢 **Polish** — code quality / minor / nice-to-have.

Each item: **name** · `file:line` · one-line fix.

---

## Budget view (`packages/ui/src/BudgetView.tsx`)

- 🟠 **Header Dots/Filter buttons are dead** · `BudgetView.tsx:93-94` · wire to a real menu (filter by account, hide categories, etc.) or remove.
- 🟠 **Drag handle on every category row does nothing** · `BudgetView.tsx:360` · add DnD (e.g. `@dnd-kit/sortable`) and persist via new `PATCH /api/categories` for `sort`.
- 🟡 **No month navigation across years** · `BudgetView.tsx:63-83` · add year tabs/arrows; current UI only shows Jan–Dec of one year.
- 🟡 **No "Move Money" between categories** · whole view · add modal: pick source → destination → amount → call new `/api/assignments/move`.
- 🟡 **No Quick Budget** · whole view · per-row button: "Up to amount", "Spent last month", "Set to zero", "Average".
- 🟡 **No "Underfunded this month"** auto-computed and surfaced.
- 🟡 **Cannot reduce / set a splurge** other than overwriting the cell.
- 🟡 **No "Hidden" categories** toggle (hide from screen, keep in db).

## Inspector (`packages/ui/src/Inspector.tsx`)

- 🟡 **No way to clear an over-budgeted amount from the Inspector** — only shows a warning.
- 🟡 **Settings panel is theme+reset only** · `Inspector.tsx:92-127` · add currency, locale, budget name.

## Transactions view (`packages/ui/src/TransactionsView.tsx`)

- 🟡 **No date-range filter** · `TransactionsView.tsx:25-33` · only text search; add from/to date pickers.
- 🟡 **No category filter** · same · filter chips at the top.
- 🟡 **No sorting / pagination**.
- 🟡 **No bulk select / bulk categorize**.
- 🟡 **No "Uncategorized" / "Needs Review" inbox** view.
- 🟡 **No split transaction**.
- 🟡 **No transfer linking** (seed uses two uncategorised transfers; no UX to mark a pair as a transfer).
- 🟡 **Cannot change category inline** — must delete + re-add.

## Recurring view (`packages/ui/src/RecurringView.tsx`)

- 🟠 **No quick pause/resume on recurring cards** · `RecurringView.tsx` · add inline switch directly on the card; modal toggle stays for new/edit.
- 🟡 **No automatic posting** — needs a scheduler (cron / on-load check / `setInterval`) to post due entries.
- 🟡 **No biweekly frequency** · `RecurringModal.tsx:241-247` · add option.
- 🟡 **No end date / occurrence count**.
- 🟡 **No history of past posts originating from a recurring** entry.

## Reports view (`packages/ui/src/ReportsView.tsx`)

- 🟡 **Cannot change the month from the Reports view** · `ReportsView.tsx:8` receives `month` as a prop but no month picker is rendered here. Surface the same month strip used in Budget, or add arrows.
- 🟡 **Always single month** — no range, no YoY, no trend.
- 🟡 **No net-worth-over-time chart**.
- 🟡 **No income/expense trend lines**.
- 🟡 **No savings-rate metric**.
- 🟡 **No CSV / PDF export**.
- 🟡 **No "by month" report type selection** (Spending / Income / Net worth tabs).

## Calendar view (`packages/ui/src/CalendarView.tsx`)

- 🟡 **Day cells are read-only** · `CalendarView.tsx:71-100` · click empty day → open `TransactionModal` pre-filled with that date; click chip → list/detail of that day's txns.
- 🟡 **Day chips show only payee** · same · also show category/amount on hover (or full row).
- 🟡 **No month/year picker** — only ←/→.
- 🟡 **Only first 3 transactions per day shown**; no "see all" affordance.

## Projections view (`packages/ui/src/ProjectionsView.tsx`)

- 🟡 **No "what-if" assumptions editor** · `ProjectionsView.tsx:11-20` · uses raw sum of recurring; let user override per-item.
- 🟡 **Fixed 12-month window** — can't extend.
- 🟡 **No account-by-account breakdown** (only `liquid` total).
- 🟡 **No net-worth projection** (only liquid).

## Accounts (sidebar + `AccountModal`)

- 🟡 **No edit account** — rename, retype (liquid/credit/off-budget), balance, group label.
- 🟡 **No close / archive** account.
- 🟡 **No reconciliation** flow.
- 🟡 **No account notes** field.
- 🟡 **Cannot reorder accounts** despite the `sort` column.
- 🟡 **No "transfer between accounts" UX** (just two transactions).
- 🟡 **"Demo Budget" is hardcoded** in `Sidebar.tsx:88` and `Inspector.tsx:80` — add a budget-name setting (DB or local).

## Categories & Groups

- 🟠 **No drag-to-reorder UI for categories/groups** · `BudgetView.tsx:250, 360` · wire `@dnd-kit/sortable`; API already supports `sort`.
- 🟡 **No hide category** toggle.
- 🟡 **No notes on category**.
- 🟡 **No category color / icon**.
- 🟡 **Goal type is only a single number** · `Category.goalTarget` · YNAB4 has "Target by date", "Monthly funding", etc. — schema/model is too narrow.
- 🟡 **No UI to set/unset `linkedAccountId`** for a non-CC category (or to make a category a CC payment category).

## API / server (`apps/web/src/app/api/*`, `packages/server/src/queries/*`)

- 🟠 **No `/api/assignments/move`** · new route · for Move Money between categories.
- 🟠 **No data import / export** endpoints.

## App shell / global

- 🟠 **No undo / no toast stack** for destructive actions.
- 🟡 **Only Esc is bound** · `ui.tsx:19-25` · add YNAB-style shortcuts (e.g. `n` new txn, `j/k` row nav, `g b/t` view switch).
- 🟡 **No multi-budget support** — single hardcoded "Demo Budget".
- 🟡 **No login / auth** — anyone with the URL has full access.
- 🟡 **No data import / export** UI.
- 🟡 **No help / "what's new" / onboarding**.

## Code quality / minor

- 🟡 **No tests for `Modals.tsx` or Next.js API routes** · `packages/ui/src/__tests__/`, `apps/web/src/app/api/**` · add coverage for modals + route handlers.
