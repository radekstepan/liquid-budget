CREATE INDEX IF NOT EXISTS `assignments_month_cat_idx` ON `assignments` (`month`,`category_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `transactions_account_date_id_idx` ON `transactions` (`account_id`,`date`,`id`);
