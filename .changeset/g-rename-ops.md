---
"@ynab/logic": patch
"@ynab/server": patch
---

## Substring rename operators (g-rename-ops)

YNAB4's four rename-condition operators (`StringOperator.as`: Contains, Is,
StartsWith, EndsWith) now all import natively instead of warn-and-drop.
Rules carry an optional `operator` (`"is"` default; stored in a new
`rename_rules.operator` column, migration `0030_steep_post`) — pre-existing
rows without one keep their exact semantics.

- Matching folds both operand and payee with `normalizeRenameText`
  (lowercase + whitespace/punctuation folding), a documented superset of
  YNAB4's `toLocaleLowerCase`-only comparison, so one matcher serves
  exact, `[N]`/`[X]` pattern, and substring rules. Empty operands never
  match (YNAB4 parity); transfer-shaped payees never match substring
  rules.
- Priority is unchanged: exact beats everything, then all patterns and
  substring operators share one tier with newer-beats-older. `learnRenameRule`
  never strips or generalises substring rules and only seeds `[N]`/`[X]`
  generalisation from exact sources.
- The importer maps operators case-insensitively and warns only on truly
  unknown operator strings; the exporter writes each rule back under its
  own operator name (`[N]`/`[X]` patterns still ride as literal `Is`
  operands), so import → export → import restores substring rules verbatim.

Notes: API create/patch/response contracts accept the optional field
(backwards compatible; UI untouched). Server unique index is now
`(source_pattern, target_payee, operator)` so `Is "SAFEWAY"` and
`Contains "SAFEWAY"` coexist for one payee.
