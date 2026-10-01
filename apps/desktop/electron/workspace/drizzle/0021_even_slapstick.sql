CREATE TABLE `cv_evidence_overlays` (
	`id` text PRIMARY KEY NOT NULL,
	`cv_id` text NOT NULL,
	`vacancy_key` text NOT NULL,
	`source_cv_content_hash` text NOT NULL,
	`jd_snapshot` text DEFAULT '' NOT NULL,
	`jd_snapshot_hash` text NOT NULL,
	`jd_complete` integer DEFAULT true NOT NULL,
	`listing_status` text DEFAULT 'unknown' NOT NULL,
	`state` text DEFAULT 'needs_input' NOT NULL,
	`requirements` text DEFAULT '[]' NOT NULL,
	`facts` text DEFAULT '[]' NOT NULL,
	`wording_variants` text DEFAULT '[]' NOT NULL,
	`captured_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cv_id`) REFERENCES `cv_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
