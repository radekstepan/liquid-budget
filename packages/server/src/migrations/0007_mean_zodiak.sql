CREATE INDEX `recurring_account_id_idx` ON `recurring` (`account_id`);--> statement-breakpoint
CREATE INDEX `recurring_next_date_idx` ON `recurring` (`next_date`);--> statement-breakpoint
CREATE INDEX `recurring_sub_transactions_recurring_id_idx` ON `recurring_sub_transactions` (`recurring_id`);