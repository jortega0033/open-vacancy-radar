CREATE TABLE `letter_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`letter_id` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`tone` text NOT NULL,
	`length` text NOT NULL,
	`cv_id` text,
	`body` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`letter_id`) REFERENCES `letters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cv_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `letter_versions_version_idx` ON `letter_versions` (`letter_id`,`version`);--> statement-breakpoint
ALTER TABLE `letters` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `letters` ADD `current_version_id` text;--> statement-breakpoint
ALTER TABLE `letters` ADD `deleted_at` integer;