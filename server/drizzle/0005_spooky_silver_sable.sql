CREATE TABLE "upload_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" text,
	"max_files" integer DEFAULT 1,
	"used_files" integer DEFAULT 0,
	"max_size_bytes" bigint,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "upload_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "transcoded_time" integer;--> statement-breakpoint
ALTER TABLE "upload_token" ADD CONSTRAINT "upload_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_token" ADD CONSTRAINT "upload_token_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;