CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "embedding" TYPE vector
  USING "embedding"::text::vector;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_model" text;
