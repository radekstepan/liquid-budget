---
"@ynab/theme": patch
---

## Searchable Select keeps its query across parent re-renders

Fixed the searchable `Select` dropdown wiping its typed filter query whenever
the parent re-renders while the dropdown is open. Every modal picker
(Account/Transfer-to/Category) passes inline `<option>` children — a fresh
array identity on each render — which re-triggered the open-time snapshot
effect and reset the query to `""`. A toast expiring, the sync indicator
toggling, or typing in another field of the same modal could all clear what
the user was typing.

Notes: the snapshot effect is now keyed on the closed→open transition only,
matching its documented intent (the visible list stays stable for the
lifetime of the open dropdown). Regression test added in
`packages/ui/tests/Dropdown.test.tsx`.
