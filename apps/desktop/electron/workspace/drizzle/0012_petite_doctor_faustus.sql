ALTER TABLE `application_attempts` ADD `employer_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `requisition_id` text;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `canonical_url_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `completion_evidence` text;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `supersedes_attempt_id` text;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `reapply_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_attempts` ADD `reapply_previous_cv_content_hash` text;