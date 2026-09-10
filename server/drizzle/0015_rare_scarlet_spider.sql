CREATE TABLE "maintenance_run" (
	"id" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_duration_ms" integer,
	"last_error" text
);
