CREATE TABLE `eve_wallet_history` (
	`user_id` text NOT NULL,
	`character_id` integer NOT NULL,
	`generation` text NOT NULL,
	`enabled` integer NOT NULL,
	`retention_days` integer NOT NULL,
	`encrypted` text NOT NULL,
	PRIMARY KEY(`user_id`, `character_id`),
	FOREIGN KEY (`user_id`,`character_id`) REFERENCES `eve_connections`(`user_id`,`character_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `eve_connections` ADD `history_epoch` text DEFAULT '' NOT NULL;