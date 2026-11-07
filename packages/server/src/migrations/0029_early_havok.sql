ALTER TABLE `accounts` ADD `account_type_raw` text;--> statement-breakpoint
ALTER TABLE `assignments` ADD `note` text DEFAULT '' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_id` text,
	`transfer_entity_id` text,
	`account_id` integer NOT NULL,
	`category_id` integer,
	`date` text NOT NULL,
	`payee` text DEFAULT '' NOT NULL,
	`payee_id` integer,
	`memo` text DEFAULT '' NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'c' NOT NULL,
	`check_number` text,
	`fitid` text,
	`ynab_id` text,
	`imported_payee` text,
	`source` text,
	`flag_color` text,
	`created_at` text DEFAULT '' NOT NULL,
	`parent_id` integer,
	`transfer_account_id` integer,
	`transfer_status` text DEFAULT 'c',
	`is_income` integer DEFAULT false NOT NULL,
	`income_month` text,
	`needs_review` integer DEFAULT false NOT NULL,
	`reconciled_at` text,
	`reconciliation_id` integer,
	`transfer_reconciled_at` text,
	`transfer_reconciliation_id` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `__new_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transfer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reconciliation_id`) REFERENCES `reconciliations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transfer_reconciliation_id`) REFERENCES `reconciliations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "transactions_status_check" CHECK("__new_transactions"."status" IN ('u', 'c', 'r')),
	CONSTRAINT "transactions_transfer_status_check" CHECK("__new_transactions"."transfer_status" IS NULL OR "__new_transactions"."transfer_status" IN ('u', 'c', 'r')),
	CONSTRAINT "transactions_transfer_not_self_check" CHECK("__new_transactions"."transfer_account_id" IS NULL OR "__new_transactions"."account_id" != "__new_transactions"."transfer_account_id")
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "entity_id", "transfer_entity_id", "account_id", "category_id", "date", "payee", "payee_id", "memo", "amount", "status", "check_number", "fitid", "ynab_id", "imported_payee", "source", "flag_color", "created_at", "parent_id", "transfer_account_id", "transfer_status", "is_income", "income_month", "needs_review", "reconciled_at", "reconciliation_id", "transfer_reconciled_at", "transfer_reconciliation_id") SELECT "id", "entity_id", "transfer_entity_id", "account_id", "category_id", "date", "payee", "payee_id", "memo", "amount", "status", "check_number", "fitid", "ynab_id", "imported_payee", "source", "flag_color", "created_at", "parent_id", "transfer_account_id", "transfer_status", "is_income", "income_month", "needs_review", "reconciled_at", "reconciliation_id", "transfer_reconciled_at", "transfer_reconciliation_id" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_account_date_id_idx` ON `transactions` (`account_id`,`date`,`id`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `transactions_parent_id_idx` ON `transactions` (`parent_id`);--> statement-breakpoint
CREATE INDEX `transactions_reconciliation_id_idx` ON `transactions` (`reconciliation_id`);--> statement-breakpoint
CREATE INDEX `transactions_transfer_reconciliation_id_idx` ON `transactions` (`transfer_reconciliation_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
