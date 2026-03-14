CREATE TABLE `album_artist_roles` (
	`album_id` text NOT NULL,
	`artist_position` integer NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`album_id`, `artist_position`, `position`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_artists` (
	`album_id` text NOT NULL,
	`position` integer NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`cover_art` text,
	`artist_image_url` text,
	`album_count` integer,
	`starred` text,
	`music_brainz_id` text,
	`sort_name` text,
	PRIMARY KEY(`album_id`, `position`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_disc_titles` (
	`album_id` text NOT NULL,
	`position` integer NOT NULL,
	`disc` integer NOT NULL,
	`title` text NOT NULL,
	PRIMARY KEY(`album_id`, `position`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_genres` (
	`album_id` text NOT NULL,
	`position` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`album_id`, `position`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_moods` (
	`album_id` text NOT NULL,
	`position` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`album_id`, `position`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_record_labels` (
	`album_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`album_id`, `position`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_release_types` (
	`album_id` text NOT NULL,
	`position` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`album_id`, `position`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `albums` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text,
	`artist` text,
	`artist_id` text,
	`cover_art` text,
	`cover_art_path` text,
	`song_count` integer NOT NULL,
	`duration` integer NOT NULL,
	`play_count` integer,
	`created` text NOT NULL,
	`starred` text,
	`year` integer,
	`genre` text,
	`played` text,
	`user_rating` integer,
	`music_brainz_id` text,
	`display_artist` text,
	`sort_name` text,
	`original_release_date` text,
	`release_date` text,
	`is_compilation` integer,
	`explicit_status` text
);
--> statement-breakpoint
CREATE TABLE `song_album_artist_roles` (
	`song_id` text NOT NULL,
	`artist_position` integer NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`song_id`, `artist_position`, `position`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_album_artists` (
	`song_id` text NOT NULL,
	`position` integer NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`cover_art` text,
	`artist_image_url` text,
	`album_count` integer,
	`starred` text,
	`music_brainz_id` text,
	`sort_name` text,
	PRIMARY KEY(`song_id`, `position`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_artist_roles` (
	`song_id` text NOT NULL,
	`artist_position` integer NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`song_id`, `artist_position`, `position`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_artists` (
	`song_id` text NOT NULL,
	`position` integer NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`cover_art` text,
	`artist_image_url` text,
	`album_count` integer,
	`starred` text,
	`music_brainz_id` text,
	`sort_name` text,
	PRIMARY KEY(`song_id`, `position`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_contributors` (
	`song_id` text NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	`sub_role` text,
	`artist_id` text,
	`artist_name` text,
	`cover_art` text,
	`artist_image_url` text,
	`album_count` integer,
	`starred` text,
	`music_brainz_id` text,
	`sort_name` text,
	PRIMARY KEY(`song_id`, `position`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_genres` (
	`song_id` text NOT NULL,
	`position` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`song_id`, `position`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_moods` (
	`song_id` text NOT NULL,
	`position` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`song_id`, `position`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_replay_gain` (
	`song_id` text PRIMARY KEY NOT NULL,
	`track_gain` real,
	`album_gain` real,
	`track_peak` real,
	`album_peak` real,
	`base_gain` real,
	`fallback_gain` real,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`id` text PRIMARY KEY NOT NULL,
	`album` text NOT NULL,
	`album_id` text NOT NULL,
	`artist` text,
	`artist_id` text,
	`average_rating` integer,
	`bit_rate` integer,
	`bookmark_position` integer,
	`content_type` text,
	`cover_art` text,
	`created` text,
	`disc_number` integer,
	`duration` integer,
	`genre` text,
	`is_dir` integer NOT NULL,
	`is_video` integer,
	`original_height` integer,
	`original_width` integer,
	`parent` text,
	`path` text,
	`play_count` integer,
	`size` integer,
	`starred` text,
	`suffix` text,
	`title` text NOT NULL,
	`track` integer,
	`transcoded_content_type` text,
	`transcoded_suffix` text,
	`type` text,
	`user_rating` integer,
	`year` integer,
	`played` text,
	`bpm` integer,
	`comment` text,
	`sort_name` text,
	`music_brainz_id` text,
	`display_artist` text,
	`display_album_artist` text,
	`display_composer` text,
	`explicit_status` text,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_album_ids` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_credentials` (
	`id` integer PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`last_sync` text
);
