-- A stored password cannot be turned into a token here, so the account is left without one: the app
-- starts at the login form, and a login as the same user keeps the library.
CREATE TABLE `__new_credentials` (
	`id` integer PRIMARY KEY,
	`url` text NOT NULL,
	`username` text NOT NULL,
	`salt` text NOT NULL,
	`token` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_credentials`(`id`, `url`, `username`, `salt`, `token`) SELECT `id`, `url`, `username`, '', '' FROM `credentials`;--> statement-breakpoint
DROP TABLE `credentials`;--> statement-breakpoint
ALTER TABLE `__new_credentials` RENAME TO `credentials`;
