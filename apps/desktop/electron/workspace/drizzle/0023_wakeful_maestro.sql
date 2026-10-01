CREATE TABLE `mcp_audit_log_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text,
	`tool_name` text NOT NULL,
	`case_id` text,
	`outcome` text NOT NULL,
	`revision` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `mcp_client_grants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `mcp_client_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope_type` text NOT NULL,
	`source_cv_id` text DEFAULT '' NOT NULL,
	`case_ids` text DEFAULT '[]' NOT NULL,
	`can_read_final_snapshot` integer DEFAULT false NOT NULL,
	`credential_verifier_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `mcp_endpoint_enabled` integer DEFAULT false NOT NULL;