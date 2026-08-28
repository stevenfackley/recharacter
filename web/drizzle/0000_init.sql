-- NOT `CREATE SCHEMA IF NOT EXISTS`: Postgres checks CREATE on the database
-- before it honours IF NOT EXISTS, so that form raises 42501 for the qavren-db
-- role even though the schema is pre-created and owned by it. Guarding on
-- pg_namespace means the statement is never issued when the schema exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'recharacter') THEN
    EXECUTE 'CREATE SCHEMA "recharacter"';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "recharacter"."ai_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"task" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recharacter"."ai_credentials" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recharacter"."ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"byok" boolean DEFAULT false NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recharacter"."case_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"condition_category" text NOT NULL,
	"mst_involved" boolean DEFAULT false NOT NULL,
	"treated_in_service" boolean DEFAULT false NOT NULL,
	"has_va_rating" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_context_case_id_unique" UNIQUE("case_id"),
	CONSTRAINT "case_context_condition_category_check" CHECK ("recharacter"."case_context"."condition_category" in ('ptsd','tbi','depression_anxiety','adjustment_disorder','other_mh','unsure'))
);
--> statement-breakpoint
CREATE TABLE "recharacter"."cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_id_owner_key" UNIQUE("id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "recharacter"."drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_kind_check" CHECK ("recharacter"."drafts"."kind" in ('personal_statement','cover_letter'))
);
--> statement-breakpoint
CREATE TABLE "recharacter"."entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text DEFAULT 'case_unlock' NOT NULL,
	"stripe_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_owner_id_unique" UNIQUE("owner_id"),
	CONSTRAINT "entitlements_stripe_session_id_unique" UNIQUE("stripe_session_id"),
	CONSTRAINT "entitlements_kind_check" CHECK ("recharacter"."entitlements"."kind" in ('case_unlock'))
);
--> statement-breakpoint
CREATE TABLE "recharacter"."evidence_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"status" text DEFAULT 'needed' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_items_item_type_check" CHECK ("recharacter"."evidence_items"."item_type" in ('dd214','service_treatment_records','va_rating_letter','civilian_mh_records','buddy_statement','nexus_letter','personal_statement')),
	CONSTRAINT "evidence_items_status_check" CHECK ("recharacter"."evidence_items"."status" in ('needed','requested','collected','not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "recharacter"."nexus_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"q1_condition" text DEFAULT '' NOT NULL,
	"q2_during_service" text DEFAULT '' NOT NULL,
	"q3_mitigation" text DEFAULT '' NOT NULL,
	"q4_outweigh" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nexus_answers_case_id_unique" UNIQUE("case_id")
);
--> statement-breakpoint
CREATE TABLE "recharacter"."pending_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"stripe_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_checkouts_stripe_session_id_unique" UNIQUE("stripe_session_id")
);
--> statement-breakpoint
CREATE TABLE "recharacter"."service_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"discharge_date" date NOT NULL,
	"characterization" text NOT NULL,
	"was_general_court_martial" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_facts_case_id_unique" UNIQUE("case_id"),
	CONSTRAINT "service_facts_branch_check" CHECK ("recharacter"."service_facts"."branch" in ('Army','Navy','MarineCorps','AirForce','SpaceForce','CoastGuard')),
	CONSTRAINT "service_facts_characterization_check" CHECK ("recharacter"."service_facts"."characterization" in ('Honorable','GeneralUnderHonorable','OtherThanHonorable','BadConductDischarge','DishonorableDischarge','Uncharacterized')),
	CONSTRAINT "service_facts_source_check" CHECK ("recharacter"."service_facts"."source" in ('manual','extracted'))
);
--> statement-breakpoint
ALTER TABLE "recharacter"."case_context" ADD CONSTRAINT "case_context_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "recharacter"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."case_context" ADD CONSTRAINT "case_context_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "recharacter"."cases"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."drafts" ADD CONSTRAINT "drafts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "recharacter"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."drafts" ADD CONSTRAINT "drafts_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "recharacter"."cases"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."evidence_items" ADD CONSTRAINT "evidence_items_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "recharacter"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."evidence_items" ADD CONSTRAINT "evidence_items_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "recharacter"."cases"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."nexus_answers" ADD CONSTRAINT "nexus_answers_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "recharacter"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."nexus_answers" ADD CONSTRAINT "nexus_answers_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "recharacter"."cases"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."service_facts" ADD CONSTRAINT "service_facts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "recharacter"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharacter"."service_facts" ADD CONSTRAINT "service_facts_case_owner_fk" FOREIGN KEY ("case_id","owner_id") REFERENCES "recharacter"."cases"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_attempts_owner_created_idx" ON "recharacter"."ai_attempts" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_usage_owner_created_idx" ON "recharacter"."ai_usage" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_usage_managed_created_idx" ON "recharacter"."ai_usage" USING btree ("created_at") WHERE "recharacter"."ai_usage"."byok" = false;--> statement-breakpoint
CREATE INDEX "case_context_owner_idx" ON "recharacter"."case_context" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_one_per_owner" ON "recharacter"."cases" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "drafts_owner_idx" ON "recharacter"."drafts" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_case_kind_key" ON "recharacter"."drafts" USING btree ("case_id","kind");--> statement-breakpoint
CREATE INDEX "evidence_items_owner_idx" ON "recharacter"."evidence_items" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_items_case_type_key" ON "recharacter"."evidence_items" USING btree ("case_id","item_type");--> statement-breakpoint
CREATE INDEX "nexus_answers_owner_idx" ON "recharacter"."nexus_answers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "pending_checkouts_owner_idx" ON "recharacter"."pending_checkouts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "service_facts_owner_idx" ON "recharacter"."service_facts" USING btree ("owner_id");
--> statement-breakpoint
-- Defence in depth against application bugs, NOT a security boundary: one role
-- owns this schema, and an owner can ALTER TABLE ... DISABLE TRIGGER or replace
-- this function. It stops a stray UPDATE/DELETE/TRUNCATE in app code from
-- rewriting billing or usage history; it does not contain an attacker who
-- already has the app role's credentials.
CREATE OR REPLACE FUNCTION "recharacter"."ledger_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Account deletion is the ONLY sanctioned delete; it runs inside a transaction
  -- that sets this GUC (SET LOCAL). Everything else — including TRUNCATE, which
  -- reaches this function with TG_OP = 'TRUNCATE' and falls through — is refused
  -- as 42501.
  IF TG_OP = 'DELETE' AND current_setting('recharacter.allow_ledger_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER "ai_usage_ledger_guard" BEFORE UPDATE OR DELETE ON "recharacter"."ai_usage" FOR EACH ROW EXECUTE FUNCTION "recharacter"."ledger_guard"();
--> statement-breakpoint
CREATE TRIGGER "entitlements_ledger_guard" BEFORE UPDATE OR DELETE ON "recharacter"."entitlements" FOR EACH ROW EXECUTE FUNCTION "recharacter"."ledger_guard"();
--> statement-breakpoint
-- TRUNCATE bypasses row-level triggers entirely, so it needs its own
-- statement-level trigger on each ledger.
CREATE TRIGGER "ai_usage_ledger_guard_truncate" BEFORE TRUNCATE ON "recharacter"."ai_usage" FOR EACH STATEMENT EXECUTE FUNCTION "recharacter"."ledger_guard"();
--> statement-breakpoint
CREATE TRIGGER "entitlements_ledger_guard_truncate" BEFORE TRUNCATE ON "recharacter"."entitlements" FOR EACH STATEMENT EXECUTE FUNCTION "recharacter"."ledger_guard"();