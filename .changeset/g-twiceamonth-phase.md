---
"@ynab/logic": patch
---

## Twice-a-month off-grid phase holds into next month (g-twiceamonth-phase)

Story: a twice-a-month schedule sitting on an off-grid date before its
first leg (e.g. a clamped/imported February leg, or a hand-edited date)
used to snap forward within the same month, shifting the schedule's
phase. It now follows YNAB4 (`ScheduledTransaction.getNextOccurrence`,
`ScheduledTransaction.as:81-100`): any date that is not the start-day
leg advances to the start day of the next month, so the second leg stays
pinned to the original phase.

Notes: the same-month snap for hand-set dates strictly *between* the two
legs (BUG-13) is intentionally retained — covered behavior outside this
repro's scope. The BUG-26 expectations for dates *before* the first leg
were updated to the YNAB4 phase-hold; that test encoded the branch
removed here. Poster/`updateRecurring` anchor handling is unchanged. No
UI changes.
