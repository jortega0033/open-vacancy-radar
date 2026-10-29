CREATE TABLE `application_critiques` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`reviewed_at` integer,
	`fence` text,
	`findings` text DEFAULT '[]' NOT NULL,
	`refused` text DEFAULT '[]' NOT NULL,
	`proposals` text DEFAULT '[]' NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`model` text,
	`call_count` integer DEFAULT 0 NOT NULL,
	`usage` text,
	`last_run_outcome` text,
	`last_run_detail` text DEFAULT '' NOT NULL,
	`last_run_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_document_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`origin` text NOT NULL,
	`status` text DEFAULT 'current' NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`jd_hash` text NOT NULL,
	`source_cv_hash` text NOT NULL,
	`critique_run_id` text,
	`created_at` integer NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_document_drafts_version_idx` ON `application_document_drafts` (`attempt_id`,`kind`,`version`);--> statement-breakpoint
CREATE INDEX `application_document_drafts_attempt_idx` ON `application_document_drafts` (`attempt_id`);