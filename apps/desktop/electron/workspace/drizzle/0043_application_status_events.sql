CREATE TABLE `application_status_events` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`event_version` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`source` text NOT NULL,
	`via` text NOT NULL,
	`attempt_id` text,
	`evidence` text,
	`occurred_on` text,
	`observed_at` integer,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `application_status_events_application_idx` ON `application_status_events` (`application_id`,`recorded_at`);