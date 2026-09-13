CREATE TABLE "agent_control_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
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
CREATE TABLE "artifact_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"job_id" uuid,
	"attempt_id" text NOT NULL,
	"prefix" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"verified_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_inventory_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_id" uuid NOT NULL,
	"path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text,
	"role" text DEFAULT 'segment' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"uploaded_at" timestamp with time zone,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transcode_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"source_id" uuid,
	"agent_id" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"waiting_reason" text,
	"attempt_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"source_wait_count" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"last_error" text,
	"idempotency_key" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcode_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text,
	"root_name" text,
	"relative_path" text,
	"file_name" text,
	"identity" text,
	"content_sha256" text,
	"r2_bucket" text,
	"r2_key" text,
	"input_url" text,
	"size_bytes" bigint,
	"availability" text DEFAULT 'available' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcoder_agent" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_last4" text NOT NULL,
	"capabilities" jsonb,
	"agent_version" text,
	"hostname" text,
	"last_seen_at" timestamp with time zone,
	"capacity_jobs" integer DEFAULT 1 NOT NULL,
	"capacity_renditions" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcoder_pairing" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"code_last4" text NOT NULL,
	"created_by" text,
	"suggested_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_control_request" ADD CONSTRAINT "agent_control_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_inventory" ADD CONSTRAINT "artifact_inventory_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_inventory" ADD CONSTRAINT "artifact_inventory_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_inventory" ADD CONSTRAINT "artifact_inventory_job_id_transcode_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."transcode_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_inventory_item" ADD CONSTRAINT "artifact_inventory_item_inventory_id_artifact_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."artifact_inventory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcode_job" ADD CONSTRAINT "transcode_job_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcode_job" ADD CONSTRAINT "transcode_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcode_job" ADD CONSTRAINT "transcode_job_source_id_transcode_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."transcode_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcode_source" ADD CONSTRAINT "transcode_source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcoder_agent" ADD CONSTRAINT "transcoder_agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcoder_pairing" ADD CONSTRAINT "transcoder_pairing_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcoder_pairing" ADD CONSTRAINT "transcoder_pairing_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_control_agent_status_idx" ON "agent_control_request" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_control_org_created_idx" ON "agent_control_request" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_inventory_attempt_uidx" ON "artifact_inventory" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "artifact_inventory_video_idx" ON "artifact_inventory" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "artifact_inventory_status_idx" ON "artifact_inventory" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_item_inventory_path_uidx" ON "artifact_inventory_item" USING btree ("inventory_id","path");--> statement-breakpoint
CREATE INDEX "artifact_item_status_idx" ON "artifact_inventory_item" USING btree ("inventory_id","status");--> statement-breakpoint
CREATE INDEX "transcode_job_state_agent_idx" ON "transcode_job" USING btree ("state","agent_id");--> statement-breakpoint
CREATE INDEX "transcode_job_lease_idx" ON "transcode_job" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "transcode_job_video_idx" ON "transcode_job" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "transcode_job_org_created_idx" ON "transcode_job" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transcode_job_idempotency_uidx" ON "transcode_job" USING btree ("organization_id","idempotency_key") WHERE "transcode_job"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transcode_source_org_idx" ON "transcode_source" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "transcode_source_agent_idx" ON "transcode_source" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcoder_agent_token_hash_idx" ON "transcoder_agent" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "transcoder_agent_org_idx" ON "transcoder_agent" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "transcoder_pairing_code_hash_idx" ON "transcoder_pairing" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "transcoder_pairing_org_idx" ON "transcoder_pairing" USING btree ("organization_id","created_at");