ALTER TABLE `category_groups` ADD `is_hidden` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `category_groups` SET `is_hidden` = 1 WHERE lower(`name`) = 'hidden categories';
