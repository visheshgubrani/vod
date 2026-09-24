CREATE TABLE "local_control_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_worker" (
	"id" text PRIMARY KEY NOT NULL,
	"capabilities" jsonb,
	"worker_version" text,
	"hostname" text,
	"capacity_jobs" integer DEFAULT 1 NOT NULL,
	"capacity_renditions" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_worker_singleton_ck" CHECK ("id" = 'local')
);
--> statement-breakpoint
INSERT INTO "local_worker" ("id") VALUES ('local') ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "agent_control_request" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transcoder_agent" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transcoder_pairing" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_control_request" CASCADE;--> statement-breakpoint
DROP TABLE "transcoder_agent" CASCADE;--> statement-breakpoint
DROP TABLE "transcoder_pairing" CASCADE;--> statement-breakpoint
DROP INDEX "transcode_job_state_agent_idx";--> statement-breakpoint
DROP INDEX "transcode_source_agent_idx";--> statement-breakpoint
ALTER TABLE "local_control_request" ADD CONSTRAINT "local_control_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_control_status_idx" ON "local_control_request" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "local_control_org_created_idx" ON "local_control_request" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "transcode_job_state_created_idx" ON "transcode_job" USING btree ("state","created_at");--> statement-breakpoint
ALTER TABLE "transcode_job" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "transcode_source" DROP COLUMN "agent_id";