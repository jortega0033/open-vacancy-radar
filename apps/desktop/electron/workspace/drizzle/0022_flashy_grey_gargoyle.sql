ALTER TABLE `cv_evidence_overlays` ADD `jd_revisions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `cv_evidence_overlays` ADD `origin` text DEFAULT 'vacancy' NOT NULL;--> statement-breakpoint
ALTER TABLE `cv_evidence_overlays` ADD `case_revision` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `cv_evidence_overlays` ADD `approved_resume_snapshot` text DEFAULT 'null';