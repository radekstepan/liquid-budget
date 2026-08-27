PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`carryover` integer DEFAULT 0 NOT NULL,
	`goal_target` integer,
	`linked_account_id` integer,
	`overspend_carries_over` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `category_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_categories`("id", "group_id", "name", "sort", "carryover", "goal_target", "linked_account_id", "overspend_carries_over") SELECT "id", "group_id", "name", "sort", "carryover", "goal_target", "linked_account_id", "overspend_carries_over" FROM `categories`;--> statement-breakpoint
DROP TABLE `categories`;--> statement-breakpoint
ALTER TABLE `__new_categories` RENAME TO `categories`;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_group_name_uniq` ON `categories` (`group_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_linked_account_uniq` ON `categories` (`linked_account_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
