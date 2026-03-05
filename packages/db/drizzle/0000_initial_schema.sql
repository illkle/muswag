CREATE TABLE IF NOT EXISTS `albums` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `version` text,
  `artist` text,
  `artist_id` text,
  `cover_art` text,
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
CREATE TABLE IF NOT EXISTS `album_record_labels` (
  `album_id` text NOT NULL,
  `position` integer NOT NULL,
  `name` text NOT NULL,
  PRIMARY KEY(`album_id`, `position`),
  FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `album_genres` (
  `album_id` text NOT NULL,
  `position` integer NOT NULL,
  `value` text NOT NULL,
  PRIMARY KEY(`album_id`, `position`),
  FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `album_artists` (
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
CREATE TABLE IF NOT EXISTS `album_artist_roles` (
  `album_id` text NOT NULL,
  `artist_position` integer NOT NULL,
  `position` integer NOT NULL,
  `role` text NOT NULL,
  PRIMARY KEY(`album_id`, `artist_position`, `position`),
  FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `album_release_types` (
  `album_id` text NOT NULL,
  `position` integer NOT NULL,
  `value` text NOT NULL,
  PRIMARY KEY(`album_id`, `position`),
  FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `album_moods` (
  `album_id` text NOT NULL,
  `position` integer NOT NULL,
  `value` text NOT NULL,
  PRIMARY KEY(`album_id`, `position`),
  FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `album_disc_titles` (
  `album_id` text NOT NULL,
  `position` integer NOT NULL,
  `disc` integer NOT NULL,
  `title` text NOT NULL,
  PRIMARY KEY(`album_id`, `position`),
  FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sync_state` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sync_album_ids` (
  `id` text PRIMARY KEY NOT NULL
);
