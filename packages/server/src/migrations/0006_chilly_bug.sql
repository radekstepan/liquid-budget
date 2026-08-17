CREATE UNIQUE INDEX `categories_group_name_uniq` ON `categories` (`group_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `category_groups_name_uniq` ON `category_groups` (`name`);