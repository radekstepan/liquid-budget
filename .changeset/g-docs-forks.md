---
"@ynab/logic": patch
---

## Document deliberate YNAB4 forks (g-docs)

Story: the `budget-engine.ts` header claimed "Full YNAB4-faithful budget
computation", which was misleading — the credit-card buffer machine has no
YNAB4 counterpart (YNAB4 uses Pre-YNAB-Debt categories). The header now states
exactly what is YNAB4-faithful (cumulative carryover, TBB, Rule-3 overspend,
outflow clamp) vs the deliberate CC-buffer extension, and
`.planning/codebase/INTEGRATIONS.md` gains a "YNAB4 fidelity vs deliberate
forks" table covering all eight known forks (CC buffer, rename priority,
reconcile adjustment, single-row transfers, exact-only matching, incomeMonth
superset, punctuation folding, integer-cents money) with file:line refs on
both sides.

Notes: docs/comments only, no behavior change. Import/export drop warnings
were verified already present (`import-ynab4.ts`, `export-ynab4.ts`) and left
untouched; the untracked `docs/ynab4-import-gaps.md` working notes stay
uncommitted.
