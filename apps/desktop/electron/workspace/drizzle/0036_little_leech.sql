CREATE TABLE `application_attempt_evidence_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`used_in` text NOT NULL,
	`claim` text NOT NULL,
	`source_url` text NOT NULL,
	`scope` text NOT NULL,
	`retrieved_at` integer,
	`observed_at` integer NOT NULL,
	`verification` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `application_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_attempt_evidence_uses_attempt_idx` ON `application_attempt_evidence_uses` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `company_evidence_contradictions` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`fact_a_id` text NOT NULL,
	`fact_b_id` text NOT NULL,
	`topic` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_fact_id` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `company_evidence_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fact_a_id`) REFERENCES `company_evidence_facts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fact_b_id`) REFERENCES `company_evidence_facts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_evidence_contradictions_pair_idx` ON `company_evidence_contradictions` (`fact_a_id`,`fact_b_id`);--> statement-breakpoint
CREATE TABLE `company_evidence_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`scope` text NOT NULL,
	`role_key` text DEFAULT '' NOT NULL,
	`role_label` text DEFAULT '' NOT NULL,
	`topic` text DEFAULT 'general' NOT NULL,
	`claim` text NOT NULL,
	`source_url` text NOT NULL,
	`source_kind` text NOT NULL,
	`quote` text DEFAULT '' NOT NULL,
	`retrieved_at` integer,
	`observed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`verification` text NOT NULL,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`content_hash` text,
	`last_refresh_at` integer,
	`last_refresh_outcome` text,
	`last_refresh_reason` text,
	`correction` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `company_evidence_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `company_evidence_facts_record_idx` ON `company_evidence_facts` (`record_id`,`status`);--> statement-breakpoint
CREATE TABLE `company_evidence_identity_links` (
	`id` text PRIMARY KEY NOT NULL,
	`record_a_id` text NOT NULL,
	`record_b_id` text NOT NULL,
	`reason` text DEFAULT 'near_name' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`record_a_id`) REFERENCES `company_evidence_records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_b_id`) REFERENCES `company_evidence_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_evidence_identity_links_pair_idx` ON `company_evidence_identity_links` (`record_a_id`,`record_b_id`);--> statement-breakpoint
CREATE TABLE `company_evidence_records` (
	`id` text PRIMARY KEY NOT NULL,
	`verified_key` text NOT NULL,
	`key_kind` text NOT NULL,
	`entity_ref` text DEFAULT '' NOT NULL,
	`display_name` text NOT NULL,
	`name_key` text DEFAULT '' NOT NULL,
	`host` text,
	`confirmed_name_keys` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_research` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_evidence_records_identity_idx` ON `company_evidence_records` (`verified_key`,`entity_ref`);--> statement-breakpoint
CREATE INDEX `company_evidence_records_name_idx` ON `company_evidence_records` (`name_key`);