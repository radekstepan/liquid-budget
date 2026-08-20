CREATE TABLE `rename_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_pattern` text NOT NULL,
	`target_payee` text NOT NULL,
	`created_at` text DEFAULT '' NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rename_rules_source_target_uniq` ON `rename_rules` (`source_pattern`,`target_payee`);