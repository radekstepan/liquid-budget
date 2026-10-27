# Tasks

How to work through the task list below. Follow the steps in order, every run.

## 1. Read the preamble

Before touching any task, read all of this for context:

- `AGENTS.md` — commands, code map, conventions, gotchas (source of truth for workflow).
- `README.md` — product context.
- `.planning/codebase/*.md` — architecture, conventions, testing, integrations.
- `git status` / `git log --oneline -5` — current state and recent work.

Do not skip this even if you have read it before — it may have changed (see step 5).

## 2. Work through tasks in series with subagents

- Take tasks from the list below **in order, one at a time**. Finish a task fully before starting the next.
- Run each task in a **fresh subagent** with the task text plus the preamble files above as context.
- A task is done only when its acceptance criteria hold **and** step 3 passes.
- If a task is blocked, stop the series, note the blocker on the task, and report back. Do not skip ahead.

## 3. Tests must pass

After each task, before committing:

- `yarn test` — full suite must pass.
- `yarn typecheck` — must pass.
- `yarn e2e` — required if the task touched `apps/web`, `packages/ui`, or e2e specs (always via root `yarn e2e` so the port is cleaned; see `AGENTS.md` gotchas).

Never move to the next task with red tests. Fix the code, not the test — unless the test itself is wrong, in which case say so explicitly.

## 4. Commit each task with a changeset

One commit per task, pairing the code with a changeset file that carries the story details:

1. Add `.changeset/<task-id>-<short-slug>.md`:

   ```md
   ---
   "@ynab/web": patch
   "@ynab/logic": patch
   ---

   ## <Task title> (<task-id>)

   <Story: what changed from the user's perspective and why.>
   <Notes: behavior changes, migration steps, follow-ups.>
   ```

   List only the workspaces actually changed; use `minor` for new features, `patch` otherwise.

2. Commit code + changeset together: `git commit -am "<task-id>: <title>"`.
3. Never commit `budget.db*`, `*.y4backup`, `import.csv`, or `snapshots/*.json` (see `yarn check:artifacts`).

## 5. Write major learnings back to markdown

If a task taught you something durable (a gotcha, a convention, an architectural fact, a corrected assumption), update the docs in the same commit:

- Repo workflow / commands / gotchas → `AGENTS.md`.
- Architecture / conventions / testing / integrations → the matching `.planning/codebase/*.md`.
- User-visible behavior → `README.md`.

Small, task-local details stay in the changeset, not the docs.

---

## Task list (in order)

The Spending by Category sankey has issues. The sources on the left are sometimes so small that you can't fit income names with amounts both. So stop showing amounts if there is not enough space. The other issue is that iw ant the snakey lines have the same color and highlight all the way from source. If you can do shades of that color from half way that'd be even better. So income might be my job, category needs (all blue) and then the lines turn shades of blue to reach the actual needs subcategories. That'd be ideal.
It still doesn't work that way. I see SAP Concur in brown which goes to Wants which is blue. This needs to be a solid line going throiugh, not 2 segments.
In addition there is extreme amount of jitter when I open the chart.
