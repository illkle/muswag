ALTER TABLE `songs` ADD `artistOrderKey` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `songs` ADD `albumOrderKey` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- The songs already stored get keys as near to `albumOrderKey` and `artistOrderKey` as SQLite comes: it
-- lowercases only ASCII, keeps accents and trims only spaces. Until the next full sync rewrites each song
-- whose key differs, a few are out of place. The keys are written before the indexes are built.
UPDATE `songs` SET `albumOrderKey` = lower(trim(ifnull(`album`, ''))) || char(1) || ifnull(`albumId`, '') || char(1)
  || CASE WHEN `discNumber` IS NULL THEN '' ELSE printf('%06d', max(0, `discNumber`)) END || char(1)
  || CASE WHEN `track` IS NULL THEN '' ELSE printf('%06d', max(0, `track`)) END;--> statement-breakpoint
UPDATE `songs` SET `artistOrderKey` = lower(trim(ifnull(`artist`, ''))) || char(1) || `albumOrderKey`;--> statement-breakpoint
CREATE INDEX `songs_artist_sort` ON `songs` (`artistOrderKey`,`id`);--> statement-breakpoint
CREATE INDEX `songs_album_sort` ON `songs` (`albumOrderKey`,`id`);