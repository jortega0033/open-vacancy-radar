CREATE TABLE `application_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`file_name` text DEFAULT '' NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_hash` text NOT NULL,
	`storage_path` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text,
	`vacancy_key` text,
	`canonical_url` text DEFAULT '' NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`source_cv_id` text,
	`source_cv_content_hash` text NOT NULL,
	`jd_snapshot` text DEFAULT '' NOT NULL,
	`jd_snapshot_hash` text NOT NULL,
	`jd_complete` integer DEFAULT true NOT NULL,
	`workflow_version` text DEFAULT '' NOT NULL,
	`checkpoint` text DEFAULT 'queued' NOT NULL,
	`checkpoint_detail` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_cv_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE set null
);
