CREATE TABLE `cv_tailoring_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`grant_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text NOT NULL,
	`case_revision_at_proposal` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cv_evidence_overlays`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `mcp_client_grants`(`id`) ON UPDATE no action ON DELETE set null
);
