CREATE TABLE `eve_connections` (
	`user_id` text NOT NULL,
	`character_id` integer NOT NULL,
	`name` text NOT NULL,
	`corporation_id` integer NOT NULL,
	`scopes` text NOT NULL,
	`encrypted` text NOT NULL,
	`expires` integer NOT NULL,
	`refresh_lock` text,
	`refresh_until` integer,
	PRIMARY KEY(`user_id`, `character_id`)
);
--> statement-breakpoint
CREATE TABLE `eve_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`encrypted` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eve_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL
);
