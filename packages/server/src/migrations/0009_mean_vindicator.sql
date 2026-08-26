PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recurring` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`category_id` integer,
	`payee` text DEFAULT '' NOT NULL,
	`payee_id` integer,
	`amount` integer DEFAULT 0 NOT NULL,
	`frequency` text DEFAULT 'monthly' NOT NULL,
	`next_date` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`transfer_account_id` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transfer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_recurring`("id", "account_id", "category_id", "payee", "payee_id", "amount", "frequency", "next_date", "active", "transfer_account_id") SELECT "id", "account_id", "category_id", "payee", "payee_id", "amount", "frequency", "next_date", "active", "transfer_account_id" FROM `recurring`;--> statement-breakpoint
DROP TABLE `recurring`;--> statement-breakpoint
ALTER TABLE `__new_recurring` RENAME TO `recurring`;--> statement-breakpoint
CREATE INDEX `recurring_account_id_idx` ON `recurring` (`account_id`);--> statement-breakpoint
CREATE INDEX `recurring_next_date_idx` ON `recurring` (`next_date`);--> statement-breakpoint
CREATE TABLE `__new_recurring_sub_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recurring_id` integer NOT NULL,
	`category_id` integer,
	`amount` integer DEFAULT 0 NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`transfer_account_id` integer,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transfer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_recurring_sub_transactions`("id", "recurring_id", "category_id", "amount", "memo", "sort", "transfer_account_id") SELECT "id", "recurring_id", "category_id", "amount", "memo", "sort", "transfer_account_id" FROM `recurring_sub_transactions`;--> statement-breakpoint
DROP TABLE `recurring_sub_transactions`;--> statement-breakpoint
ALTER TABLE `__new_recurring_sub_transactions` RENAME TO `recurring_sub_transactions`;--> statement-breakpoint
CREATE INDEX `recurring_sub_transactions_recurring_id_idx` ON `recurring_sub_transactions` (`recurring_id`);--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`category_id` integer,
	`date` text NOT NULL,
	`payee` text DEFAULT '' NOT NULL,
	`payee_id` integer,
	`memo` text DEFAULT '' NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'c' NOT NULL,
	`created_at` text DEFAULT '' NOT NULL,
	`parent_id` integer,
	`transfer_account_id` integer,
	`is_income` integer DEFAULT false NOT NULL,
	`income_month` text,
	`reconciled_at` text,
	`reconciliation_id` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `__new_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transfer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "transactions_status_check" CHECK("__new_transactions"."status" IN ('u', 'c', 'r'))
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "account_id", "category_id", "date", "payee", "payee_id", "memo", "amount", "status", "created_at", "parent_id", "transfer_account_id", "is_income", "income_month", "reconciled_at", "reconciliation_id") SELECT "id", "account_id", "category_id", "date", "payee", "payee_id", "memo", "amount", "status", "created_at", "parent_id", "transfer_account_id", "is_income", "income_month", "reconciled_at", "reconciliation_id" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `transactions_parent_id_idx` ON `transactions` (`parent_id`);--> statement-breakpoint
CREATE INDEX `transactions_reconciliation_id_idx` ON `transactions` (`reconciliation_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;