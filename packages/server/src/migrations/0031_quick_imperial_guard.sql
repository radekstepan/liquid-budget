CREATE TABLE `scheduled_postings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recurring_id` integer NOT NULL,
	`occurrence_date` text NOT NULL,
	`transaction_id` integer NOT NULL,
	`entity_id` text NOT NULL,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_postings_rule_date_uniq` ON `scheduled_postings` (`recurring_id`,`occurrence_date`);--> statement-breakpoint
CREATE INDEX `scheduled_postings_rule_idx` ON `scheduled_postings` (`recurring_id`);