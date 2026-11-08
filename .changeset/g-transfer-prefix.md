---
"@ynab/logic": patch
---

## Transfer payee prefix matches YNAB4 space-stripping (g-transfer-prefix)

`isTransferPayee` now mirrors YNAB4's `TransferUtilities.isTransferPayee`: strip ALL literal spaces, then case-insensitive `Transfer:` prefix match. `Trans fer : X` counts as a transfer; `Transfer\t: X` does not (YNAB4 strips spaces only, not tabs).

Notes: rename-rule matching/normalization (forks #2 priority, #7 normalization) unchanged — this only affects the `Transfer:` prefix guard used by rename learning, transfer consistency checks, and payee guards.
