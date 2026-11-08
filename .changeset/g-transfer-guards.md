---
"@ynab/logic": patch
---

## Transfer eligibility guards (g-transfer)

Pure-logic port of YNAB4's transfer eligibility rules
(`TransactionList.as`, `BaseTransaction.as`, `TransferUtilities.as`).
`packages/logic/src/transfers.ts` gains `validateTransferEligibility`
(throwing, with injectable `errorFactory`), its boolean counterpart
`isTransferEligible`, and `validateTransferPayeeConsistency`:

- Self-transfer (`accountId == transferAccountId`) is rejected,
  mirroring `checkAccountDoesntConflictWithTransferAccount` (also
  enforced by the `transactions_transfer_not_self_check` DB CHECK and
  the server's entity invariants).
- A split parent carrying its own transfer leg is rejected; split-child
  transfer legs remain legitimate.
- A same-boundary (on↔on, off↔off) transfer carrying a category is
  rejected, mirroring YNAB4's `NeedsCategory`/`Error` invariants.
- A `Transfer : <account>` payee with no `transferAccountId` is
  rejected (YNAB4 derives transfer payees from the target account).
  The reverse — a leg with free-text payee — stays allowed.

Notes: `classifyBoundaryTransfer` is intentionally unchanged (it sees
only boundary booleans and runs on read paths over stored rows, so
strict write-path checks live in the validator — validate first, then
classify). `isTransferPayee` is reused from `rename-rules.ts`, not
duplicated or re-exported (the barrel `export *`s both modules, so a
second export would turn the name ambiguous). YNAB4's
Scheduled/Matched-transaction bans have no representable check: this
package's `Transaction` carries no scheduled/matched markers, and the
`recurring` transfer flavour is retained for import/seed compatibility.
No persistence changes; server callers can adopt the validator later.
