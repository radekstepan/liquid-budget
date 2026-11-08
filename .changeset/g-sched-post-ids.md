---
"@ynab/server": patch
---

## Deterministic scheduled-post ids (g-sched-post-ids)

Story: posting a scheduled transaction, deleting the posted row, and
re-posting the same occurrence used to mint a brand-new row id, so the
re-post never restored the deleted row. Posting is now deterministic like
YNAB4: every (schedule, date) occurrence stamps `<schedule>_<yyyy-MM-dd>_<count>`
as its entity id (bumping the count while taken, mirroring
`YNABGuidCreator.createTransactionIdForEnteredScheduledTransaction`), and a
new `scheduled_postings` lineage table records the posted row id per
occurrence. Re-posting a deleted occurrence reuses its freed id, so the
restored row is identical to the deleted one.

Notes: split re-posts restore the parent id; children still mint fresh ids.
Re-posting while the row still lives creates a count-bumped sibling row
(same as YNAB4's conflict loop). `migrate.test.ts` table count updated
12 → 13 for the new table. Split-rebase import warnings and the
catch-up cap-5 remain intentionally untouched for later tasks.
