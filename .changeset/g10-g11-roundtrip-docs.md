---
"@ynab/server": patch
---

## YNAB4 account-mapping docs + export/import round-trip (g10/g11)

Story: stock-shaped backups can now survive a full export/import loop
without silent loss. Importing a `.y4backup` and re-exporting it used
to drop rename rules and payee defaults even though both have a native
YNAB4 home; those gaps are closed, everything else that still drops is
now either warned about or documented as intentional.

Notes: `accountMappings` (G-10) are intentionally dropped — YNAB4's
`AccountMappingVO` (`fid`, `shortenedAccountId`, `hash`, `salt`,
`targetYNABAccountId`, `dateSequence`, `shouldFlipPayeesMemos`,
`shouldImportMemos`, `skipImport`) is OFX-import config with no budget
source, and no OFX import is modeled. Non-empty mappings now produce
one aggregated `ImportSummary` warning instead of going silent; if OFX
import is ever built, revisit storing at least the three per-account
booleans. The exporter now writes back `autoFillCategoryId` per payee
(verbatim when resolvable, null otherwise) and emits our
`rename_rules` as `Is` `renameConditions` on the owning payee, so both
round-trip; in-app `[N]`/`[X]` wildcard patterns ride as `Is` operands
(verbatim through our own import, literal-match in stock YNAB4).
Still local-only by design (asserted in the new round-trip test):
`categories.goal_target` (no YNAB4 counterpart),
`transactions.needs_review` and `duplicate_ignores` (review state),
`accounts.groupLabel` (recomputed from kind/onBudget).
`accepted: true`, `isTombstone: false`, and synthetic
`entityVersion` stubs are intentional — our match workflow differs
from YNAB4's, so rows export accepted and the importer reports
`accepted === false` / match-link / schedule-link rows as warnings.
This satisfies suggested-fix-order item 6 (document, then round-trip
test). New suite: `packages/server/tests/import-ynab4-roundtrip.test.ts`.
