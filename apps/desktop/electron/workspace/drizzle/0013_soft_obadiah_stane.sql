CREATE TABLE `application_submission_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`outcome` text NOT NULL,
	`source` text NOT NULL,
	`destination` text DEFAULT '' NOT NULL,
	`evidence_kind` text NOT NULL,
	`evidence_reference` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`observed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `employer_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `requisition_id` text;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `canonical_url_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `completion_evidence` text;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `supersedes_attempt_id` text;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `reapply_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `reapply_previous_cv_content_hash` text;