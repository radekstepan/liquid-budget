CREATE TABLE `payees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`auto_category_id` integer,
	`created_at` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`auto_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payees_name_uniq` ON `payees` (`name`);--> statement-breakpoint
ALTER TABLE `recurring` ADD `payee_id` integer REFERENCES payees(id);--> statement-breakpoint
ALTER TABLE `transactions` ADD `payee_id` integer REFERENCES payees(id);