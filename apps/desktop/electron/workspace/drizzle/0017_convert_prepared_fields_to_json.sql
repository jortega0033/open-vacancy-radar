PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_application_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text,
	`vacancy_key` text,
	`canonical_url` text DEFAULT '' NOT NULL,
	`employer_key` text DEFAULT '' NOT NULL,
	`requisition_id` text,
	`canonical_url_key` text DEFAULT '' NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`source_cv_id` text,
	`source_cv_content_hash` text NOT NULL,
	`jd_snapshot` text DEFAULT '' NOT NULL,
	`jd_snapshot_hash` text NOT NULL,
	`jd_complete` integer DEFAULT true NOT NULL,
	`workflow_version` text DEFAULT '' NOT NULL,
	`tailoring_mode` text DEFAULT 'ai' NOT NULL,
	`checkpoint` text DEFAULT 'queued' NOT NULL,
	`checkpoint_detail` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	`form_structure_hash` text,
	`scheduled_automatic_submit_at` integer,
	`submission_mode` text,
	`completion_evidence` text,
	`supersedes_attempt_id` text,
	`reapply_reason` text DEFAULT '' NOT NULL,
	`reapply_previous_cv_content_hash` text,
	`prepared_fields` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_cv_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- prepared_fields was a hand-rolled JSON-in-text column that used '' as its null sentinel (every
-- attempt from before #272, plus every attempt this app has since cleared back to "not yet
-- prepared"). The column is now Drizzle's typed `mode: 'json'`, which reads/writes real NULL for
-- "no value" -- so the copy below converts that sentinel to NULL rather than carrying it across as
-- the (invalid-JSON) empty string. Every non-empty value is untouched: it was already the JSON text
-- this column's new type expects.
INSERT INTO `__new_application_attempts`("id", "application_id", "vacancy_key", "canonical_url", "employer_key", "requisition_id", "canonical_url_key", "company", "role", "source_cv_id", "source_cv_content_hash", "jd_snapshot", "jd_snapshot_hash", "jd_complete", "workflow_version", "tailoring_mode", "checkpoint", "checkpoint_detail", "created_at", "updated_at", "submitted_at", "form_structure_hash", "scheduled_automatic_submit_at", "submission_mode", "completion_evidence", "supersedes_attempt_id", "reapply_reason", "reapply_previous_cv_content_hash", "prepared_fields") SELECT "id", "application_id", "vacancy_key", "canonical_url", "employer_key", "requisition_id", "canonical_url_key", "company", "role", "source_cv_id", "source_cv_content_hash", "jd_snapshot", "jd_snapshot_hash", "jd_complete", "workflow_version", "tailoring_mode", "checkpoint", "checkpoint_detail", "created_at", "updated_at", "submitted_at", "form_structure_hash", "scheduled_automatic_submit_at", "submission_mode", "completion_evidence", "supersedes_attempt_id", "reapply_reason", "reapply_previous_cv_content_hash", NULLIF("prepared_fields", '') FROM `application_attempts`;--> statement-breakpoint
DROP TABLE `application_attempts`;--> statement-breakpoint
ALTER TABLE `__new_application_attempts` RENAME TO `application_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;