ALTER TABLE `accounts` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `category_groups` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `categories` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `payees` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `transfer_entity_id` text;--> statement-breakpoint
ALTER TABLE `reconciliations` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `recurring` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `recurring_sub_transactions` ADD `entity_id` text;
