DROP INDEX `rename_rules_source_target_uniq`;--> statement-breakpoint
ALTER TABLE `rename_rules` ADD `operator` text DEFAULT 'is' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rename_rules_source_target_uniq` ON `rename_rules` (`source_pattern`,`target_payee`,`operator`);