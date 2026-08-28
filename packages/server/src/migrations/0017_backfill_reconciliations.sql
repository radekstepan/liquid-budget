INSERT INTO `reconciliations` (`account_id`, `reconciled_at`, `statement_date`, `statement_balance`, `adjustment_transaction_id`)
SELECT
  t.account_id,
  t.reconciled_at,
  t.reconciled_at,
  0,
  (
    SELECT adj.id
    FROM `transactions` adj
    WHERE adj.account_id = t.account_id
      AND adj.memo = 'Reconciliation balance'
      AND adj.status = 'r'
      AND adj.reconciled_at = t.reconciled_at
    ORDER BY adj.date DESC, adj.id DESC
    LIMIT 1
  )
FROM `transactions` t
JOIN `accounts` a ON a.id = t.account_id
WHERE t.status = 'r'
  AND t.reconciled_at IS NOT NULL
  AND (a.last_reconciled_at IS NULL OR t.reconciled_at < a.last_reconciled_at)
  AND NOT EXISTS (
    SELECT 1 FROM `reconciliations` r
    WHERE r.account_id = t.account_id AND r.reconciled_at = t.reconciled_at
  )
GROUP BY t.account_id, t.reconciled_at
ORDER BY t.reconciled_at ASC;--> statement-breakpoint
INSERT INTO `reconciliations` (`account_id`, `reconciled_at`, `statement_date`, `statement_balance`, `adjustment_transaction_id`)
SELECT
  a.id,
  a.last_reconciled_at,
  a.last_reconciled_at,
  COALESCE(a.last_reconciled_balance, 0),
  (
    SELECT t.id
    FROM `transactions` t
    WHERE t.account_id = a.id
      AND t.memo = 'Reconciliation balance'
      AND t.status = 'r'
      AND (t.reconciled_at = a.last_reconciled_at OR (t.reconciled_at IS NULL AND t.date <= a.last_reconciled_at))
    ORDER BY t.date DESC, t.id DESC
    LIMIT 1
  )
FROM `accounts` a
WHERE a.last_reconciled_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `reconciliations` r
    WHERE r.account_id = a.id AND r.reconciled_at = a.last_reconciled_at
  );--> statement-breakpoint
UPDATE `transactions`
SET `reconciliation_id` = (
  SELECT r.id
  FROM `reconciliations` r
  WHERE r.account_id = `transactions`.account_id
    AND (
      `transactions`.reconciled_at = r.reconciled_at
      OR `transactions`.reconciled_at IS NULL
    )
  ORDER BY r.id DESC
  LIMIT 1
)
WHERE `status` = 'r'
  AND `reconciliation_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `reconciliations` r
    WHERE r.account_id = `transactions`.account_id
      AND (
        `transactions`.reconciled_at = r.reconciled_at
        OR `transactions`.reconciled_at IS NULL
      )
  );--> statement-breakpoint
UPDATE `transactions`
SET `reconciliation_id` = (
  SELECT r.id
  FROM `reconciliations` r
  WHERE r.account_id = `transactions`.transfer_account_id
    AND (
      `transactions`.reconciled_at = r.reconciled_at
      OR `transactions`.reconciled_at IS NULL
    )
  ORDER BY r.id DESC
  LIMIT 1
)
WHERE `status` = 'r'
  AND `reconciliation_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `reconciliations` r
    WHERE r.account_id = `transactions`.transfer_account_id
      AND (
        `transactions`.reconciled_at = r.reconciled_at
        OR `transactions`.reconciled_at IS NULL
      )
  );--> statement-breakpoint
UPDATE `transactions`
SET `reconciled_at` = (
  SELECT r.reconciled_at
  FROM `reconciliations` r
  WHERE r.id = `transactions`.reconciliation_id
)
WHERE `status` = 'r'
  AND `reconciled_at` IS NULL
  AND `reconciliation_id` IS NOT NULL;--> statement-breakpoint
UPDATE `transactions`
SET `reconciliation_id` = (
  SELECT r.id
  FROM `reconciliations` r
  WHERE r.adjustment_transaction_id = `transactions`.id
  ORDER BY r.id DESC
  LIMIT 1
)
WHERE `reconciliation_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `reconciliations` r
    WHERE r.adjustment_transaction_id = `transactions`.id
  );
