---
"@ynab/server": patch
---

## YNAB4 payee rename rules + disabled flag (g04)

Story: importing a `.y4backup` used to drop real user data on the
payee side — disabled payees came back as normal, and every YNAB4
rename condition was silently discarded even though we own a
`rename_rules` table. Disabled payees now import as archived (and
export back as YNAB4 `enabled: false`), and `Is` rename conditions
become exact rename rules so OFX-style bank payees keep resolving to
their curated names.

Notes: operator audit first (`data/StringCondition.as`,
`data/StringOperator.as`, `com/ynab/enums/EnumBase.as`) — exactly
four operators exist (Contains, Is, StartsWith, EndsWith, parsed
case-insensitively). Only `Is` maps faithfully onto our full-match
`[N]`/`[X]` rule engine; the other three (plus blank/unparseable
conditions and transfer-like operands, which our engine rejects by
design) land in `ImportSummary.warnings`, never silently dropped.
`targetAccountId` transfer payees stay skipped by design (one
aggregated notice). `locations`/`payeeLocations` are deliberately
dropped (no maps feature) and `autoFillMemo`/`autoFillAmount` are
deliberately dropped (only default *categories* are imported — there
is no payee memo/amount autofill to hold them); both surface as
aggregated warnings when present. Reverse direction (our pattern
rules → YNAB4 conditions) is out of scope: `[N]`/`[X]` have no
faithful YNAB4 operator, so export still emits no rename conditions.
Migration `0027` adds `payees.archived` (same shape as
`accounts.archived`).
