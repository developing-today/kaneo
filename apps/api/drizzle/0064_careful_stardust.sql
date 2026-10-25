CREATE TABLE "integration_repository" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"repository_id" integer,
	"installation_id" integer,
	"verified_github_account_id" text,
	"verified_by_user_id" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "integration_repository_integration_owner_name_unique" UNIQUE("integration_id","repository_owner","repository_name")
);
--> statement-breakpoint
ALTER TABLE "external_link" ADD COLUMN "integration_repository_id" text;--> statement-breakpoint
ALTER TABLE "integration_repository" ADD CONSTRAINT "integration_repository_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "integration_repository_integrationId_idx" ON "integration_repository" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "integration_repository_repositoryId_idx" ON "integration_repository" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "integration_repository_owner_name_idx" ON "integration_repository" USING btree ("repository_owner","repository_name");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_repository_integration_repositoryId_unique" ON "integration_repository" USING btree ("integration_id","repository_id") WHERE "integration_repository"."repository_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_repository_primary_unique" ON "integration_repository" USING btree ("integration_id") WHERE "integration_repository"."is_primary";--> statement-breakpoint
ALTER TABLE "external_link" ADD CONSTRAINT "external_link_integration_repository_id_integration_repository_id_fk" FOREIGN KEY ("integration_repository_id") REFERENCES "public"."integration_repository"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "external_link_integrationRepositoryId_idx" ON "external_link" USING btree ("integration_repository_id");