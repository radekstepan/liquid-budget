---
"@ynab/logic": patch
"@ynab/server": patch
---

## Rename learning on merge + case drift (g-rename-learn)

Two rename-learning gaps are closed (YNAB4 `PayeeManager.renamePayee` /
`StringCondition` parity, adapted to our free-text transaction payees).

- Merging two transactions now seeds a rename rule from each absorbed
  spelling to the surviving name, so future imports arrive with the merged
  name (picking the canonical payee in the merge preview teaches both
  spellings at once). Learned after the commit, best-effort: a
  rule-learning failure never rolls back or blocks the merge. Transfers
  never seed rules, in either direction.
- A case/punctuation-only rename (`"starbucks"` -> `"Starbucks"`) now
  learns an exact rule instead of no-op'ing on the normalized equality,
  so future imports converge on the curated casing. A surviving rule
  that already matches the spelling (e.g. a `BCF[N]` family covering
  `"bcf1"`) still wins over an exact hijack, and pattern-shaped sources
  learn nothing.
- The already-at-target skip in apply/count is now a raw (case-sensitive)
  comparison — matching YNAB4's case-sensitive affected-transactions scan —
  so drift rules actually rewrite and count the drifted rows instead of
  skipping everything whose normalized text already equals the target.

Notes: matching/normalization (fork #7) and exact-beats-everything
priority (fork #2) are unchanged; learn/apply guards for transfers and
split/transfer rows are unchanged. UI untouched.
