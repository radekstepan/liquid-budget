ALTER TABLE `transactions` ADD `reconciliation_id` integer;--> statement-breakpoint
CREATE INDEX `transactions_reconciliation_id_idx` ON `transactions` (`reconciliation_id`);--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`reconciled_at` text NOT NULL,
	`statement_date` text NOT NULL,
	`statement_balance` integer NOT NULL,
	`adjustment_transaction_id` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `reconciliations_account_idx` ON `reconciliations` (`account_id`);
