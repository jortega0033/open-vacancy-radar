CREATE TABLE `discovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`generated_at` integer NOT NULL,
	`vacancy_count` integer NOT NULL,
	`report_json_path` text NOT NULL,
	`report_html_path` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `discovery_runs_generated_at_idx` ON `discovery_runs` (`generated_at`);