ALTER TABLE `songs` ADD `titleSortKey` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `songs_title_sort` ON `songs` (`titleSortKey`,`id`);