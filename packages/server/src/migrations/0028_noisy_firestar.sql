ALTER TABLE `recurring` ADD `second_anchor_day` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `check_number` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `fitid` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `ynab_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `imported_payee` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `source` text;