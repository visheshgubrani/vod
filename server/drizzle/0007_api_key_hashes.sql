CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "key_hash" text;
--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "key_last4" text;
--> statement-breakpoint
UPDATE "api_key"
SET
  "key_hash" = encode(digest("key", 'sha256'), 'hex'),
  "key_last4" = right("key", 4)
WHERE "key_hash" IS NULL;
--> statement-breakpoint
ALTER TABLE "api_key" ALTER COLUMN "key_hash" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_key" ALTER COLUMN "key_last4" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_key" DROP CONSTRAINT "api_key_key_unique";
--> statement-breakpoint
ALTER TABLE "api_key" DROP COLUMN "key";
--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_key_hash_idx" ON "api_key" USING btree ("key_hash");
