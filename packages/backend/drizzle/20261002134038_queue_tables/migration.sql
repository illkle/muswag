CREATE TABLE `queue_items` (
	`key` text PRIMARY KEY,
	`list` text NOT NULL,
	`position` integer NOT NULL,
	`track` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `queue_state` (
	`id` integer PRIMARY KEY,
	`nowPlayingKey` text,
	`nowPlayingOrigin` text,
	`source` text,
	`resumePositionSeconds` real NOT NULL
);
--> statement-breakpoint
DROP TABLE `player_queue`;