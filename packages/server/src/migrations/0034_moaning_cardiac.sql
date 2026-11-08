PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recurring_sub_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_id` text,
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
INSERT INTO `__new_recurring_sub_transactions`("id", "entity_id", "recurring_id", "category_id", "amount", "memo", "sort", "transfer_account_id") SELECT "id", "entity_id", "recurring_id", "category_id", "amount", "memo", "sort", "transfer_account_id" FROM `recurring_sub_transactions`;--> statement-breakpoint
DROP TABLE `recurring_sub_transactions`;--> statement-breakpoint
ALTER TABLE `__new_recurring_sub_transactions` RENAME TO `recurring_sub_transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `recurring_sub_transactions_recurring_id_idx` ON `recurring_sub_transactions` (`recurring_id`);--> statement-breakpoint
ALTER TABLE `payees` ADD `auto_memo` text;--> statement-breakpoint
ALTER TABLE `payees` ADD `auto_amount` integer;