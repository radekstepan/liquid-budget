-- Repair split transfer legs that show uncleared under a cleared or
-- reconciled split parent. Before the split-status propagation fix,
-- clearing a split updated children's `status` but left each transfer
-- leg's `transfer_status` behind at 'u', so the destination account
-- kept showing (and counting) the leg as uncleared.
--
-- This only ever raises a leg from 'u' to 'c': it never lowers a
-- cleared leg, never touches reconciled ('r') legs, and never touches
-- regular (non-split) transfers, whose per-side states are legitimate.
-- Legs on reconciled source rows land at 'c' (not 'r'): the destination
-- side still needs its own reconcile.
UPDATE `transactions`
SET `transfer_status` = 'c',
    `transfer_reconciled_at` = NULL,
    `transfer_reconciliation_id` = NULL
WHERE `parent_id` IS NOT NULL
  AND `transfer_account_id` IS NOT NULL
  AND `transfer_status` = 'u'
  AND `status` IN ('c', 'r');
