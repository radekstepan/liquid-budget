ALTER TABLE `recurring` ADD `anchor_day` integer;
--> statement-breakpoint
UPDATE `recurring` SET `anchor_day` = CAST(SUBSTR(`next_date`, 9, 2) AS INTEGER) WHERE `anchor_day` IS NULL;
