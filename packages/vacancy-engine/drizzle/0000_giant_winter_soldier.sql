CREATE TABLE `application_status` (
	`vacancy_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`notes` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`vacancy_id`) REFERENCES `vacancies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `career_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`source_type` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`board_identifier` text,
	`canonical_key` text,
	`discovery_method` text NOT NULL,
	`discovery_evidence` text DEFAULT '{}' NOT NULL,
	`last_success_at` integer,
	`last_failure_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`retired_at` integer,
	`consecutive_complete_misses` integer DEFAULT 0 NOT NULL,
	`catalog_managed` integer DEFAULT true NOT NULL,
	`discovery_managed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `career_sources_company_url_unique` ON `career_sources` (`company_id`,`base_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `career_sources_canonical_key_unique` ON `career_sources` (`canonical_key`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_name` text NOT NULL,
	`domain` text,
	`mapping_confidence` text DEFAULT 'unknown' NOT NULL,
	`mapping_source` text DEFAULT 'unknown' NOT NULL,
	`mapping_evidence` text DEFAULT '{}' NOT NULL,
	`last_verified_at` integer,
	`catalog_hash` text,
	`last_scanned_at` integer,
	`scan_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_domain_unique` ON `companies` (`domain`);--> statement-breakpoint
CREATE TABLE `company_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`alias` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`source` text NOT NULL,
	`confidence` text DEFAULT 'unknown' NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_aliases_company_alias_unique` ON `company_aliases` (`company_id`,`normalized_alias`);--> statement-breakpoint
CREATE TABLE `company_discovery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_run_id` text NOT NULL,
	`sponsor_id` text NOT NULL,
	`official_url` text NOT NULL,
	`candidate_source` text NOT NULL,
	`candidate_version` text NOT NULL,
	`candidate_hash` text NOT NULL,
	`inspection_policy_version` text NOT NULL,
	`outcome` text NOT NULL,
	`pages_inspected` integer DEFAULT 0 NOT NULL,
	`physical_request_count` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`http_status` integer,
	`category` text,
	`diagnostic` text,
	`result` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`scan_run_id`) REFERENCES `scan_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsor_discovery`(`sponsor_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "company_discovery_attempts_official_url_check" CHECK(("company_discovery_attempts"."official_url" glob 'http://?*' or "company_discovery_attempts"."official_url" glob 'https://?*') and "company_discovery_attempts"."official_url" not glob '*[?#@]*'),
	CONSTRAINT "company_discovery_attempts_candidate_hash_check" CHECK(length("company_discovery_attempts"."candidate_hash") = 64 and "company_discovery_attempts"."candidate_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "company_discovery_attempts_provenance_check" CHECK(length("company_discovery_attempts"."candidate_source") > 0
        and length("company_discovery_attempts"."candidate_version") > 0
        and length("company_discovery_attempts"."inspection_policy_version") > 0),
	CONSTRAINT "company_discovery_attempts_outcome_check" CHECK("company_discovery_attempts"."outcome" in (
        'careers_found',
        'no_public_careers',
        'unsupported',
        'blocked',
        'manual_review',
        'error'
      )),
	CONSTRAINT "company_discovery_attempts_pages_check" CHECK("company_discovery_attempts"."pages_inspected" between 0 and 2),
	CONSTRAINT "company_discovery_attempts_request_count_check" CHECK("company_discovery_attempts"."physical_request_count" >= 0),
	CONSTRAINT "company_discovery_attempts_duration_check" CHECK("company_discovery_attempts"."duration_ms" >= 0),
	CONSTRAINT "company_discovery_attempts_diagnostic_length_check" CHECK("company_discovery_attempts"."diagnostic" is null or length("company_discovery_attempts"."diagnostic") <= 4000),
	CONSTRAINT "company_discovery_attempts_http_status_check" CHECK("company_discovery_attempts"."http_status" is null or "company_discovery_attempts"."http_status" between 100 and 599),
	CONSTRAINT "company_discovery_attempts_result_object_check" CHECK(json_type("company_discovery_attempts"."result") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_discovery_attempts_run_sponsor_unique` ON `company_discovery_attempts` (`scan_run_id`,`sponsor_id`);--> statement-breakpoint
CREATE INDEX `company_discovery_attempts_sponsor_created_idx` ON `company_discovery_attempts` (`sponsor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `company_discovery_campaign_items` (
	`campaign_run_id` text NOT NULL,
	`sponsor_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_identity_key_snapshot` text NOT NULL,
	`legal_name_snapshot` text NOT NULL,
	`kvk_number_snapshot` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`final_phase` text,
	`outcome` text,
	`reason_code` text,
	`network_attempted` integer DEFAULT false NOT NULL,
	`pages_attempted` integer DEFAULT 0 NOT NULL,
	`pages_fetched` integer DEFAULT 0 NOT NULL,
	`physical_request_count` integer DEFAULT 0 NOT NULL,
	`http_status` integer,
	`details` text DEFAULT '{}' NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`campaign_run_id`, `sponsor_id`),
	FOREIGN KEY (`campaign_run_id`) REFERENCES `scan_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sponsor_id`) REFERENCES `ind_sponsors`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "company_discovery_campaign_items_ordinal_check" CHECK("company_discovery_campaign_items"."ordinal" > 0),
	CONSTRAINT "company_discovery_campaign_items_pages_check" CHECK("company_discovery_campaign_items"."pages_attempted" between 0 and 2
        and "company_discovery_campaign_items"."pages_fetched" between 0 and "company_discovery_campaign_items"."pages_attempted"),
	CONSTRAINT "company_discovery_campaign_items_request_count_check" CHECK("company_discovery_campaign_items"."physical_request_count" >= 0),
	CONSTRAINT "company_discovery_campaign_items_network_check" CHECK((
        "company_discovery_campaign_items"."network_attempted" = true
        and "company_discovery_campaign_items"."pages_attempted" > 0
      ) or (
        "company_discovery_campaign_items"."network_attempted" = false
        and "company_discovery_campaign_items"."pages_attempted" = 0
        and "company_discovery_campaign_items"."pages_fetched" = 0
        and "company_discovery_campaign_items"."physical_request_count" = 0
        and "company_discovery_campaign_items"."http_status" is null
      )),
	CONSTRAINT "company_discovery_campaign_items_http_status_check" CHECK("company_discovery_campaign_items"."http_status" is null or "company_discovery_campaign_items"."http_status" between 100 and 599),
	CONSTRAINT "company_discovery_campaign_items_details_object_check" CHECK(json_type("company_discovery_campaign_items"."details") = 'object'),
	CONSTRAINT "company_discovery_campaign_items_terminal_check" CHECK((
        "company_discovery_campaign_items"."state" = 'pending'
        and "company_discovery_campaign_items"."final_phase" is null
        and "company_discovery_campaign_items"."outcome" is null
        and "company_discovery_campaign_items"."reason_code" is null
        and "company_discovery_campaign_items"."completed_at" is null
      ) or (
        "company_discovery_campaign_items"."state" = 'terminal'
        and "company_discovery_campaign_items"."final_phase" is not null
        and length("company_discovery_campaign_items"."final_phase") between 1 and 100
        and "company_discovery_campaign_items"."outcome" is not null
        and "company_discovery_campaign_items"."reason_code" is not null
        and length("company_discovery_campaign_items"."reason_code") between 1 and 100
        and "company_discovery_campaign_items"."completed_at" is not null
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_discovery_campaign_items_run_ordinal_unique` ON `company_discovery_campaign_items` (`campaign_run_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `company_discovery_campaign_items_queue_idx` ON `company_discovery_campaign_items` (`campaign_run_id`,`state`,`ordinal`);--> statement-breakpoint
CREATE TABLE `company_sponsors` (
	`company_id` text NOT NULL,
	`sponsor_id` text NOT NULL,
	`relationship` text DEFAULT 'legal_entity' NOT NULL,
	`confidence` text NOT NULL,
	`source` text NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`catalog_managed` integer DEFAULT true NOT NULL,
	`discovery_managed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`company_id`, `sponsor_id`),
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sponsor_id`) REFERENCES `ind_sponsors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `http_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`final_url` text NOT NULL,
	`status` integer NOT NULL,
	`content_type` text,
	`response_headers` text DEFAULT '{}' NOT NULL,
	`etag` text,
	`last_modified` text,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `ind_sponsor_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`source_last_updated` integer NOT NULL,
	`retrieved_at` integer NOT NULL,
	`raw_row_count` integer NOT NULL,
	`unique_sponsor_count` integer NOT NULL,
	`duplicate_row_count` integer NOT NULL,
	`membership_hash` text NOT NULL,
	`accepted` integer NOT NULL,
	`rejection_reason` text
);
--> statement-breakpoint
CREATE INDEX `ind_sponsor_snapshots_accepted_retrieved_idx` ON `ind_sponsor_snapshots` (`accepted`,`retrieved_at`);--> statement-breakpoint
CREATE TABLE `ind_sponsors` (
	`id` text PRIMARY KEY NOT NULL,
	`source_identity_key` text NOT NULL,
	`legal_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`search_name` text NOT NULL,
	`kvk_number` text,
	`source_url` text NOT NULL,
	`source_retrieved_at` integer NOT NULL,
	`source_last_updated` integer,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ind_sponsors_source_identity_unique` ON `ind_sponsors` (`source_identity_key`);--> statement-breakpoint
CREATE INDEX `ind_sponsors_kvk_idx` ON `ind_sponsors` (`kvk_number`);--> statement-breakpoint
CREATE INDEX `ind_sponsors_normalized_name_idx` ON `ind_sponsors` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `scan_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_run_id` text,
	`company_id` text,
	`career_source_id` text,
	`category` text NOT NULL,
	`message` text NOT NULL,
	`http_status` integer,
	`context` text DEFAULT '{}' NOT NULL,
	`occurred_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`scan_run_id`) REFERENCES `scan_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`career_source_id`) REFERENCES `career_sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`command` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`ai_enabled` integer DEFAULT false NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	`statistics` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scan_source_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_run_id` text NOT NULL,
	`career_source_id` text NOT NULL,
	`status` text NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`vacancies_seen` integer DEFAULT 0 NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`scan_run_id`) REFERENCES `scan_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`career_source_id`) REFERENCES `career_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_source_outcomes_run_source_unique` ON `scan_source_outcomes` (`scan_run_id`,`career_source_id`);--> statement-breakpoint
CREATE TABLE `sponsor_discovery` (
	`sponsor_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'needs_domain' NOT NULL,
	`brand_name` text,
	`official_url` text,
	`official_hostname` text,
	`candidate_source` text,
	`candidate_version` text,
	`candidate_hash` text,
	`confidence` text DEFAULT 'unknown' NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`careers_url` text,
	`provider` text,
	`source_base_url` text,
	`board_identifier` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`next_check_at` integer,
	`last_http_status` integer,
	`diagnostic` text,
	`candidate_verified_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`sponsor_id`) REFERENCES `ind_sponsors`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sponsor_discovery_priority_check" CHECK("sponsor_discovery"."priority" between 0 and 100),
	CONSTRAINT "sponsor_discovery_attempt_count_check" CHECK("sponsor_discovery"."attempt_count" >= 0),
	CONSTRAINT "sponsor_discovery_diagnostic_length_check" CHECK("sponsor_discovery"."diagnostic" is null or length("sponsor_discovery"."diagnostic") <= 4000),
	CONSTRAINT "sponsor_discovery_http_status_check" CHECK("sponsor_discovery"."last_http_status" is null or "sponsor_discovery"."last_http_status" between 100 and 599),
	CONSTRAINT "sponsor_discovery_evidence_object_check" CHECK(json_type("sponsor_discovery"."evidence") = 'object'),
	CONSTRAINT "sponsor_discovery_candidate_contract_check" CHECK("sponsor_discovery"."status" not in (
        'candidate_ready',
        'domain_verified',
        'careers_found',
        'source_verified',
        'no_public_careers',
        'unsupported',
        'blocked',
        'error'
      ) or (
        ("sponsor_discovery"."official_url" glob 'http://?*' or "sponsor_discovery"."official_url" glob 'https://?*') and "sponsor_discovery"."official_url" not glob '*[?#@]*'
        and "sponsor_discovery"."official_hostname" is not null
        and length("sponsor_discovery"."official_hostname") > 0
        and "sponsor_discovery"."candidate_source" is not null
        and length("sponsor_discovery"."candidate_source") > 0
        and "sponsor_discovery"."candidate_version" is not null
        and length("sponsor_discovery"."candidate_version") > 0
        and length("sponsor_discovery"."candidate_hash") = 64 and "sponsor_discovery"."candidate_hash" not glob '*[^0-9a-f]*'
        and "sponsor_discovery"."confidence" = 'high'
        and "sponsor_discovery"."evidence" <> '{}'
        and "sponsor_discovery"."candidate_verified_at" is not null
      ))
);
--> statement-breakpoint
CREATE INDEX `sponsor_discovery_candidate_queue_idx` ON `sponsor_discovery` (`status`,`priority`,`next_check_at`,`sponsor_id`);--> statement-breakpoint
CREATE INDEX `sponsor_discovery_official_hostname_idx` ON `sponsor_discovery` (`official_hostname`);--> statement-breakpoint
CREATE TABLE `vacancies` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`career_source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`description` text NOT NULL,
	`url` text NOT NULL,
	`employment_type` text,
	`remote` integer,
	`workplace_mode` text DEFAULT 'unknown' NOT NULL,
	`posted_at` integer,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`content_hash` text NOT NULL,
	`hash_version` text DEFAULT 'vacancy-content-v2' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`missing_complete_scans` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`career_source_id`) REFERENCES `career_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vacancies_source_external_unique` ON `vacancies` (`career_source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `vacancies_active_score_idx` ON `vacancies` (`active`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `vacancies_content_hash_idx` ON `vacancies` (`content_hash`);--> statement-breakpoint
CREATE TABLE `vacancy_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`vacancy_id` text NOT NULL,
	`candidate_profile_version` text NOT NULL,
	`scoring_version` text NOT NULL,
	`deterministic_score` integer NOT NULL,
	`semantic_score` integer,
	`semantic_config_version` text,
	`final_score` integer NOT NULL,
	`technical_fit` integer NOT NULL,
	`role_fit` integer NOT NULL,
	`seniority_fit` integer NOT NULL,
	`language_fit` integer NOT NULL,
	`location_fit` integer NOT NULL,
	`dutch_required` integer NOT NULL,
	`dutch_preferred` integer NOT NULL,
	`language_evidence` text DEFAULT '[]' NOT NULL,
	`primary_fit` text NOT NULL,
	`matching_skills` text DEFAULT '[]' NOT NULL,
	`gaps` text DEFAULT '[]' NOT NULL,
	`reasons` text DEFAULT '[]' NOT NULL,
	`content_hash` text NOT NULL,
	`scored_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`vacancy_id`) REFERENCES `vacancies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vacancy_scores_cache_unique` ON `vacancy_scores` (`vacancy_id`,`content_hash`,`candidate_profile_version`,`scoring_version`);--> statement-breakpoint
CREATE TABLE `vacancy_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`vacancy_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`hash_version` text NOT NULL,
	`payload` text NOT NULL,
	`observed_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`vacancy_id`) REFERENCES `vacancies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vacancy_snapshots_vacancy_hash_unique` ON `vacancy_snapshots` (`vacancy_id`,`content_hash`);