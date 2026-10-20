CREATE INDEX `albums_year` ON `albums` ("year" desc,`id`);--> statement-breakpoint
CREATE INDEX `albums_artist_id` ON `albums` (`artistId`);