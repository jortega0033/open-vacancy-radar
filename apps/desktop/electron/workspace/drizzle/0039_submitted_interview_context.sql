CREATE TABLE `application_interview_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`round_type` text NOT NULL,
	`scheduled_on` text,
	`state` text NOT NULL,
	`feedback` text DEFAULT '' NOT NULL,
	`open_topics` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_interview_rounds_application_idx` ON `application_interview_rounds` (`application_id`);--> statement-breakpoint
CREATE TABLE `application_submission_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_key` text NOT NULL,
	`attempt_id` text,
	`application_id` text,
	`version` integer NOT NULL,
	`status` text DEFAULT 'current' NOT NULL,
	`bound_by` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_submission_packages_version_idx` ON `application_submission_packages` (`subject_key`,`version`);--> statement-breakpoint
CREATE INDEX `application_submission_packages_attempt_idx` ON `application_submission_packages` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `application_submission_packages_application_idx` ON `application_submission_packages` (`application_id`);