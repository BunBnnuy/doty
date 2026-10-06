DROP INDEX "integrations_provider_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_provider_account_unique" ON "integrations" USING btree ("provider","account");
