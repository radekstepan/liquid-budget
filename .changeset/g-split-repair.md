---
"@ynab/logic": patch
"@ynab/server": patch
---

## Split import repair policy (g-split)

YNAB4 renders an unbalanced split with an auto-filler sub-transaction
for the difference instead of rejecting it; our UI/server writes
correctly keep rejecting such splits via `assertSplitsBalanced`. The
YNAB4 backup import now has an explicit repair policy bridging the two.

`packages/logic/src/split.ts` gains the pure, non-throwing
`repairSplitForImport` helper (plus `SPLIT_IMPORT_FILLER_MEMO`,
`SplitRepairChild`, `SplitRepairKind`, `SplitRepairResult`): balanced
splits return verbatim; a sum mismatch appends a filler leg for the
difference (parent amount preserved, YNAB4-style); single-leg splits
are kept verbatim with the parent rebased to the leg; empty splits
report `empty` for the caller to skip. Inputs are never mutated; only
new arrays are returned. `assertSplitsBalanced` is unchanged and stays
the single source of truth for UI writes.

Notes: `importYnab4` transaction splits now call the helper instead of
silently rebasing the parent to the legs sum — YNAB4's register total
is preserved and each repair is counted once in
`ImportSummary.warnings` ("Repaired N split transaction(s) ...;
an auto-balance leg was added"). The synthetic filler leg never claims
reconciled precision (imports as merely cleared) and opts out of the
all-children-reconciled parent upgrade. Scheduled splits keep their
existing policy (rebalance to nonzero legs, collapse single-child to a
plain row). No persistence changes; no e2e touched (no UI changes).
