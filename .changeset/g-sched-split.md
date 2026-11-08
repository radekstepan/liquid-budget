---
"@ynab/server": patch
"@ynab/logic": patch
---

## Scheduled split repair + unbounded catch-up + frozen twice-a-month start day (g-sched-split)

Story: three scheduled-transaction gaps vs YNAB4 are closed. Unbalanced
scheduled splits on import no longer silently rebase the parent to the
children sum — the file parent is preserved and an auto-balance filler leg
is appended YNAB4-style, with the existing split-repair warning now covering
scheduled rows too. Catch-up posting is unbounded like YNAB4's
`enterDueOccurrences` instead of stopping after 5 occurrences per rule; the
cap survives as an opt-in `maxOccurrencesPerRule` for callers that want an
anti-runaway guard. Twice-a-month schedules finally read the persisted
`second_anchor_day` (YNAB4 `twiceAMonthStartDay`): it is derived from the
date at create/hand-edit time (`resetTwiceAMonthStartDay`), frozen while
posting, and pins the first leg in `nextDateFor`, so imported phases like
(date 9-05, start-day 20) advance to 10-20 instead of collapsing to 9-20.

Notes: `nextDateFor` gains an optional 4th `secondAnchor` param (ignored by
other frequencies; derivation unchanged when absent). `createRecurring` /
`updateRecurring` accept `secondAnchorDay`; switching frequency away from
twice-a-month clears it. The BUG-11 default-cap expectation was updated to
pass the cap explicitly — the old default contradicted YNAB4 — and the
BUG-01/BUG-03 scheduled-split integration assertion was updated from
"rebase to children sum" to "preserve parent + filler leg"; both tests
encoded the divergences fixed here. The deterministic-id taken-probe no
longer scans the `recurring` table (a posted id can never collide with a
rule id by construction); that extra query served no production purpose and
broke mock nth-sequencing (BUG-21 OOM, BUG-09 short-post). No UI/API
changes; the REST layer does not send `secondAnchorDay` yet.
