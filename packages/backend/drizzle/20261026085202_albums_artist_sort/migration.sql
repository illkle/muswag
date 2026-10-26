ALTER TABLE `albums` ADD `artistSortKey` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- The albums already stored get keys as near to `sortKey` as SQLite comes: it lowercases only ASCII,
-- keeps accents and trims only spaces. The next sync lists every album and rewrites each whose key
-- differs. The keys are written before the index is built.
UPDATE `albums` SET `artistSortKey` = lower(trim(ifnull(`artist`, '')));--> statement-breakpoint
CREATE INDEX `albums_artist_sort` ON `albums` (`artistSortKey`,"year" desc,`id`);
