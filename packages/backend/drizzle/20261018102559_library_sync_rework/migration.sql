ALTER TABLE `artists` ADD `albumCount` integer;--> statement-breakpoint
ALTER TABLE `artists` ADD `musicBrainzId` text;--> statement-breakpoint
ALTER TABLE `artists` ADD `sortName` text;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `serverScan` text;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `lastSyncedAt` text;--> statement-breakpoint
ALTER TABLE `artists` DROP COLUMN `userRating`;--> statement-breakpoint
ALTER TABLE `artists` DROP COLUMN `averageRating`;--> statement-breakpoint
ALTER TABLE `sync_state` DROP COLUMN `indexesLastModified`;--> statement-breakpoint
ALTER TABLE `sync_state` DROP COLUMN `lastFullSyncAt`;--> statement-breakpoint
ALTER TABLE `sync_state` DROP COLUMN `lastQuickSyncAt`;