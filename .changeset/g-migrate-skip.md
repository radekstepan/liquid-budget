---
"@ynab/server": patch
---

## Fix silently skipped migration 0034 (future-dated 0029 journal timestamp)

Story: `GET /api/budget` 500'd with `no such column: "auto_memo"` on
existing dev databases while fresh databases worked fine. Migration
`0029_early_havok` had been generated with a `when` timestamp two days
in the future (skewed clock), and drizzle-orm's sqlite migrator only
applies entries newer than `MAX(created_at)` — it never compares
per-migration hashes. The future timestamp raised that ceiling above
0034, so `migrate()` reported success while silently skipping it.

Fix: 0029's journal `when` is restored to chronological order
(midpoint between 0028 and 0030), and the stale `created_at` row was
repaired on the local dev and e2e databases. Two regression tests pin
the invariant: journal `when` values must be strictly increasing, and
a newly generated (current-time) migration must apply on top of a
fully migrated database.
