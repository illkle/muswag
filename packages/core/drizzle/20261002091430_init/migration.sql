CREATE TABLE `albums` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`artist` text,
	`artistId` text,
	`coverArt` text,
	`created` text NOT NULL,
	`duration` real NOT NULL,
	`genre` text,
	`playCount` real,
	`songCount` integer NOT NULL,
	`starred` text,
	`year` integer,
	`version` text,
	`played` text,
	`userRating` real,
	`recordLabels` text,
	`musicBrainzId` text,
	`genres` text,
	`artists` text,
	`displayArtist` text,
	`releaseTypes` text,
	`moods` text,
	`sortName` text,
	`originalReleaseDate` text,
	`releaseDate` text,
	`isCompilation` integer,
	`explicitStatus` text,
	`discTitles` text,
	`coverArtPath` text,
	`coverArtSourceId` text
);
--> statement-breakpoint
CREATE TABLE `artists` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`starred` text,
	`userRating` real,
	`averageRating` real,
	`coverArt` text,
	`artistImageUrl` text,
	`coverArtPath` text,
	`coverArtSourceId` text
);
--> statement-breakpoint
CREATE TABLE `covers` (
	`key` text PRIMARY KEY,
	`fileName` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` integer PRIMARY KEY,
	`url` text NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`encrypted` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `player_queue` (
	`id` integer PRIMARY KEY,
	`snapshot` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` text PRIMARY KEY,
	`serverId` text,
	`base` text,
	`local` text,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`isDir` integer NOT NULL,
	`album` text,
	`albumId` text,
	`artist` text,
	`artistId` text,
	`averageRating` real,
	`bitRate` real,
	`bookmarkPosition` real,
	`contentType` text,
	`coverArt` text,
	`created` text,
	`discNumber` integer,
	`duration` real,
	`genre` text,
	`isVideo` integer,
	`originalHeight` integer,
	`originalWidth` integer,
	`parent` text,
	`path` text,
	`playCount` real,
	`size` real,
	`starred` text,
	`suffix` text,
	`track` integer,
	`transcodedContentType` text,
	`transcodedSuffix` text,
	`type` text,
	`userRating` real,
	`year` integer,
	`played` text,
	`bpm` real,
	`comment` text,
	`sortName` text,
	`musicBrainzId` text,
	`genres` text,
	`artists` text,
	`displayArtist` text,
	`albumArtists` text,
	`displayAlbumArtist` text,
	`contributors` text,
	`displayComposer` text,
	`moods` text,
	`replayGain` text,
	`explicitStatus` text
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` integer PRIMARY KEY,
	`indexesLastModified` integer,
	`lastFullSyncAt` text,
	`lastQuickSyncAt` text
);
--> statement-breakpoint
CREATE INDEX `albums_artist_id` ON `albums` (`artistId`);--> statement-breakpoint
CREATE INDEX `playlists_server_id` ON `playlists` (`serverId`);--> statement-breakpoint
CREATE INDEX `songs_album_id` ON `songs` (`albumId`);