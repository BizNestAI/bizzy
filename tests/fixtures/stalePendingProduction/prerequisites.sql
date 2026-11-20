-- Generated from fresh public catalog; see scope.json for external boundaries.
create role "dashboard_user";
create role "authenticated";
create role "anon";
create role "service_role";
create role "authenticator";
create role "pgbouncer";
create role "supabase_auth_admin";
create role "supabase_storage_admin";
create role "supabase_replication_admin";
create role "supabase_read_only_user";
create role "supabase_realtime_admin";
create role "postgres";
create role "supabase_privileged_role";
create role "plaid_residual_hold_executor";
create role "cli_login_postgres";
alter role "dashboard_user" nosuperuser inherit createrole createdb nologin replication nobypassrls;
alter role "authenticated" nosuperuser inherit nocreaterole nocreatedb nologin noreplication nobypassrls;
alter role "anon" nosuperuser inherit nocreaterole nocreatedb nologin noreplication nobypassrls;
alter role "service_role" nosuperuser inherit nocreaterole nocreatedb nologin noreplication bypassrls;
alter role "supabase_admin" superuser inherit createrole createdb login replication bypassrls;
alter role "authenticator" nosuperuser noinherit nocreaterole nocreatedb login noreplication nobypassrls;
alter role "pgbouncer" nosuperuser inherit nocreaterole nocreatedb login noreplication nobypassrls;
alter role "supabase_auth_admin" nosuperuser noinherit createrole nocreatedb login noreplication nobypassrls;
alter role "supabase_storage_admin" nosuperuser noinherit createrole nocreatedb login noreplication nobypassrls;
alter role "supabase_replication_admin" nosuperuser inherit nocreaterole nocreatedb login replication nobypassrls;
alter role "supabase_read_only_user" nosuperuser inherit nocreaterole nocreatedb login noreplication bypassrls;
alter role "supabase_realtime_admin" nosuperuser noinherit nocreaterole nocreatedb nologin noreplication nobypassrls;
alter role "supabase_privileged_role" nosuperuser inherit nocreaterole nocreatedb nologin noreplication nobypassrls;
alter role "plaid_residual_hold_executor" nosuperuser noinherit nocreaterole nocreatedb nologin noreplication nobypassrls;
alter role "cli_login_postgres" nosuperuser noinherit nocreaterole nocreatedb login noreplication nobypassrls;
alter role "authenticated" set "statement_timeout" to '8s';
alter role "anon" set "statement_timeout" to '3s';
alter role "supabase_admin" set search_path to "$user", public, auth, extensions;
alter role "supabase_admin" set "statement_timeout" to '0';
alter role "authenticator" set "statement_timeout" to '8s';
alter role "authenticator" set "lock_timeout" to '8s';
alter role "supabase_auth_admin" set search_path to auth;
alter role "supabase_auth_admin" set "idle_in_transaction_session_timeout" to '60000';
alter role "supabase_storage_admin" set search_path to storage;
alter role "postgres" set search_path to "\$user", public, extensions;
create schema auth;create schema extensions;create table auth.users(id uuid primary key);
create extension if not exists "uuid-ossp" with schema "extensions" version '1.1';
create extension if not exists "pg_trgm" with schema "public" version '1.6';
set check_function_bodies=false;set search_path=public,extensions;
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$
;
create table public."accounting_period_closes" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"period_month" date not null,
"status" text default 'open'::text not null,
"authority_type" text,
"approved_snapshot_id" uuid,
"approved_by" uuid,
"approved_at" timestamp with time zone,
"reopened_by" uuid,
"reopened_at" timestamp with time zone,
"close_version" integer default 1 not null,
"is_active" boolean default true not null,
"pending_transaction_count_at_close" integer,
"readiness_evidence" jsonb default '{}'::jsonb not null,
"snapshot_fingerprint" text,
"source" text,
"requested_by" uuid,
"requested_at" timestamp with time zone,
"failure_code" text,
"failure_metadata" jsonb default '{}'::jsonb not null,
"forecast_run_id" uuid,
"created_at" timestamp with time zone default timezone('utc'::text, now()) not null,
"updated_at" timestamp with time zone default timezone('utc'::text, now()) not null
);
create table public."bank_qbo_match_history" (
"id" uuid default gen_random_uuid() not null,
"match_id" uuid,
"business_id" uuid not null,
"bank_transaction_id" uuid,
"action" text not null,
"previous_state" jsonb,
"new_state" jsonb,
"actor" uuid,
"actor_role" text,
"reason" text,
"supersedes_match_id" uuid,
"created_at" timestamp with time zone default now() not null
);
create table public."bank_qbo_match_items" (
"id" uuid default gen_random_uuid() not null,
"match_id" uuid not null,
"business_id" uuid not null,
"qbo_entity_type" text not null,
"qbo_entity_id" text not null,
"amount_allocated_minor" bigint,
"customer_ref" jsonb,
"invoice_ids" text[],
"qbo_sync_token" text,
"source_snapshot_at" timestamp with time zone,
"evidence_role" text default 'primary'::text not null,
"active_confirmed" boolean default false not null,
"created_at" timestamp with time zone default now() not null,
"meta" jsonb default '{}'::jsonb not null,
"qbo_realm_id" text
);
create table public."bank_qbo_matches" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"bank_transaction_id" uuid not null,
"status" text not null,
"match_type" text not null,
"confidence_tier" text not null,
"confidence_score" numeric,
"reason_codes" text[] default '{}'::text[] not null,
"gross_bank_amount_minor" bigint not null,
"matched_qbo_amount_minor" bigint,
"fee_amount_minor" bigint,
"currency" text,
"date_distance_days" integer,
"bank_account_match" text not null,
"plaid_account_id" text,
"qbo_bank_account_id" text,
"qbo_bank_account_name" text,
"mapping_source" text,
"mapping_confidence" text,
"source_freshness_at" timestamp with time zone,
"request_idempotency_key" text,
"created_by" uuid,
"actor_role" text,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"confirmed_at" timestamp with time zone,
"superseded_at" timestamp with time zone,
"meta" jsonb default '{}'::jsonb not null,
"qbo_realm_id" text
);
create table public."bank_sync_runs" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_item_id" text not null,
"started_at" timestamp with time zone default now() not null,
"finished_at" timestamp with time zone,
"status" text default 'ok'::text not null,
"added_count" integer default 0 not null,
"modified_count" integer default 0 not null,
"removed_count" integer default 0 not null,
"error_message" text,
"meta" jsonb,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"worker_id" text,
"lease_acquired_at" timestamp with time zone,
"lease_expires_at" timestamp with time zone,
"failure_code" text
);
create table public."bank_transactions" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_item_id" text not null,
"plaid_account_id" text not null,
"plaid_transaction_id" text not null,
"pending" boolean default false not null,
"date" date not null,
"authorized_date" date,
"name" text not null,
"merchant_name" text,
"merchant_entity_id" text,
"payment_channel" text,
"transaction_type" text,
"check_number" text,
"amount" numeric not null,
"iso_currency_code" text,
"unofficial_currency_code" text,
"category_primary" text,
"category_detailed" text,
"category_confidence" text,
"personal_finance_category" jsonb,
"location" jsonb,
"counterparties" jsonb,
"plaid_last_modified_at" timestamp with time zone,
"last_seen_at" timestamp with time zone default now() not null,
"raw" jsonb,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"plaid_amount_raw" numeric,
"direction" text,
"signed_amount" numeric,
"counterparty_name" text,
"counterparty_source" text,
"counterparty_confidence" text,
"qbo_entity_type" text,
"qbo_entity_id" text,
"is_archived" boolean default false not null,
"archived_at" timestamp with time zone,
"pending_transaction_id" text,
"duplicate_fingerprint" text,
"archived_reason" text,
"plaid_env" text,
"physical_account_id" uuid,
"canonical_fingerprint" text,
"canonical_fingerprint_confidence" text,
"canonical_match_reason" text,
"canonical_source" text,
"pending_source_transaction_id" uuid,
"accounting_review_required" boolean default false not null,
"accounting_review_reason" text,
"accounting_review_payload" jsonb,
"canonical_vendor_id" uuid,
"plaid_recovery_batch_id" uuid,
"pending_resolution_state" text,
"pending_resolution_payload" jsonb default '{}'::jsonb not null,
"pending_resolved_at" timestamp with time zone,
"pending_resolved_by" uuid
);
create table public."bizzi_vendors" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"display_name" text not null,
"normalized_display_name" text not null,
"status" text default 'active'::text not null,
"primary_evidence_type" text not null,
"primary_evidence_value" text,
"primary_source" text default 'resolver'::text not null,
"confidence" text default 'medium'::text not null,
"metadata" jsonb default '{}'::jsonb not null,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."bookkeeping_approval_events" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"actor_id" uuid,
"actor_type" text not null,
"resolution" text not null,
"final_qbo_account_id" text,
"post_after" timestamp with time zone,
"idempotency_key" text not null,
"created_at" timestamp with time zone default now() not null,
"metadata" jsonb default '{}'::jsonb not null
);
create table public."bookkeeping_auto_post_backlog_releases" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"release_start_date" date,
"release_end_date" date,
"transaction_ids" uuid[] default '{}'::uuid[] not null,
"status" text default 'active'::text not null,
"requested_by" uuid,
"requested_at" timestamp with time zone default timezone('utc'::text, now()) not null,
"release_metadata" jsonb default '{}'::jsonb not null,
"created_at" timestamp with time zone default timezone('utc'::text, now()) not null,
"preview_total_count" integer default 0 not null,
"released_transaction_count" integer default 0 not null,
"blocked_transaction_count" integer default 0 not null,
"preview_fingerprint" text
);
create table public."bookkeeping_exclusion_events" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"connected_account_id" text,
"event_type" text not null,
"actor" text,
"prior_lifecycle" text,
"resulting_lifecycle" text,
"reason" text,
"correlation_id" text,
"details" jsonb default '{}'::jsonb not null,
"created_at" timestamp with time zone default now() not null
);
create table public."bookkeeping_lifecycle_events" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"previous_review_status" text,
"new_review_status" text not null,
"previous_posting_status" text,
"new_posting_status" text not null,
"previous_legacy_status" text,
"new_legacy_status" text not null,
"actor" text,
"reason" text,
"posting_attempt_id" text,
"plaid_pending_transaction_id" text,
"created_at" timestamp with time zone default now() not null
);
create table public."bookkeeping_post_attempts" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"attempted_at" timestamp with time zone default now() not null,
"status" text not null,
"qbo_txn_id" text,
"qbo_txn_type" text,
"error_message" text,
"retry_count" integer,
"post_after" timestamp with time zone,
"payload_summary" jsonb,
"response_summary" jsonb,
"created_at" timestamp with time zone default now() not null
);
create table public."bookkeeping_posting_jobs" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"queue_name" text default 'books_qbo_posting'::text not null,
"state" text not null,
"scheduled_at" timestamp with time zone,
"next_attempt_at" timestamp with time zone,
"attempt_count" integer default 0 not null,
"lease_owner" text,
"lease_expires_at" timestamp with time zone,
"blocking_code" text,
"blocking_detail" text,
"last_error_code" text,
"last_error_message" text,
"qbo_intent_id" uuid,
"qbo_request_id" text,
"qbo_txn_id" text,
"qbo_txn_type" text,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."bookkeeping_processing_requests" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid,
"scope" text default 'transaction'::text not null,
"status" text default 'pending'::text not null,
"priority" integer default 0 not null,
"attempt_count" integer default 0 not null,
"max_attempts" integer default 5 not null,
"process_after" timestamp with time zone default now() not null,
"locked_at" timestamp with time zone,
"locked_by" text,
"processed_at" timestamp with time zone,
"error_code" text,
"error_message" text,
"metadata" jsonb default '{}'::jsonb not null,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"blocked_reason" text,
"evidence_fingerprint" text,
"blocked_until" timestamp with time zone
);
create table public."business_billing" (
"business_id" uuid not null,
"stripe_customer_id" text,
"stripe_subscription_id" text,
"subscription_status" text default 'free'::text not null,
"plan_price_id" text,
"current_period_end" timestamp with time zone,
"trial_end" timestamp with time zone,
"cancel_at_period_end" boolean default false not null,
"updated_at" timestamp with time zone default now() not null,
"plan_type" text,
"last_invoice_status" text,
"canceled_at" timestamp with time zone,
"last_invoice_id" text,
"last_payment_failed_at" timestamp with time zone,
"stripe_customer_id_live" text,
"stripe_customer_id_test" text,
"stripe_subscription_id_live" text,
"stripe_subscription_id_test" text,
"subscription_status_live" text,
"subscription_status_test" text,
"plan_price_id_live" text,
"plan_price_id_test" text,
"current_period_end_live" timestamp with time zone,
"current_period_end_test" timestamp with time zone,
"trial_end_live" timestamp with time zone,
"trial_end_test" timestamp with time zone,
"cancel_at_period_end_live" boolean,
"cancel_at_period_end_test" boolean,
"last_invoice_status_live" text,
"last_invoice_status_test" text,
"canceled_at_live" timestamp with time zone,
"canceled_at_test" timestamp with time zone,
"last_invoice_id_live" text,
"last_invoice_id_test" text,
"last_payment_failed_at_live" timestamp with time zone,
"last_payment_failed_at_test" timestamp with time zone,
"plan_type_live" text,
"plan_type_test" text,
"business_name" text,
"customer_user_id" uuid,
"customer_email" text,
"customer_full_name" text,
"billing_display_status" text,
"billing_display_plan_type" text,
"stripe_event_created_at_live" timestamp with time zone,
"stripe_event_created_at_test" timestamp with time zone,
"stripe_event_id_live" text,
"stripe_event_id_test" text
);
create table public."business_financial_reporting_config" (
"business_id" uuid not null,
"qbo_realm_id" text,
"reporting_timezone" text,
"home_currency" text,
"provider_schema_version" text,
"status" text default 'unconfigured'::text not null,
"realm_verified_at" timestamp with time zone,
"currency_verified_at" timestamp with time zone,
"timezone_confirmed_at" timestamp with time zone,
"verified_at" timestamp with time zone,
"verification_source" text,
"invalidated_at" timestamp with time zone,
"invalidation_reason" text,
"created_at" timestamp with time zone default clock_timestamp() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."business_financial_reporting_config_audit" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"request_id" uuid not null,
"action" text not null,
"previous_status" text,
"resulting_status" text not null,
"verification_source" text not null,
"actor_user_id" uuid,
"details" jsonb default '{}'::jsonb not null,
"created_at" timestamp with time zone default now() not null
);
create table public."business_profiles" (
"id" uuid default uuid_generate_v4() not null,
"user_id" uuid,
"business_name" text not null,
"industry" text not null,
"team_size" integer not null,
"annual_revenue" text,
"fixture_dropped_7" text,
"state" text not null,
"fixture_dropped_9" text,
"fixture_dropped_10" text,
"fixture_dropped_11" text,
"fixture_dropped_12" text,
"fixture_dropped_13" text,
"fixture_dropped_14" text,
"fixture_dropped_15" text,
"services_offered" text,
"fixture_dropped_17" text,
"billing_model" text,
"fixture_dropped_19" text,
"fixture_dropped_20" text,
"fixture_dropped_21" text,
"fixture_dropped_22" text,
"fixture_dropped_23" text,
"fixture_dropped_24" text,
"fixture_dropped_25" text,
"fixture_dropped_26" text,
"fixture_dropped_27" text,
"founded_year" integer,
"fixture_dropped_29" text,
"fixture_dropped_30" text,
"fixture_dropped_31" text,
"fixture_dropped_32" text,
"fixture_dropped_33" text,
"fixture_dropped_34" text,
"top_challenge" text,
"onboarding_integrations_viewed_at" timestamp with time zone,
"onboarding_completed_at" timestamp with time zone,
"onboarding_status" text default 'in_progress'::text not null,
"onboarding_status_updated_at" timestamp with time zone default now() not null,
"quickbooks_connected" boolean default false not null,
"quickbooks_connected_at" timestamp with time zone,
"plaid_connected" boolean default false not null,
"plaid_connected_at" timestamp with time zone,
"bookkeeping_start_date" date,
"auto_post_to_quickbooks" boolean default false not null,
"auto_post_enabled_at" timestamp with time zone,
"auto_post_effective_date" date,
"auto_post_scope_mode" text default 'new_activity_only'::text not null,
"historical_backlog_status" text default 'none'::text not null,
"backlog_reviewed_at" timestamp with time zone,
"backlog_reviewed_by" uuid,
"backlog_released_at" timestamp with time zone,
"backlog_released_by" uuid
);
alter table public."business_profiles" drop column "fixture_dropped_7";
alter table public."business_profiles" drop column "fixture_dropped_9";
alter table public."business_profiles" drop column "fixture_dropped_10";
alter table public."business_profiles" drop column "fixture_dropped_11";
alter table public."business_profiles" drop column "fixture_dropped_12";
alter table public."business_profiles" drop column "fixture_dropped_13";
alter table public."business_profiles" drop column "fixture_dropped_14";
alter table public."business_profiles" drop column "fixture_dropped_15";
alter table public."business_profiles" drop column "fixture_dropped_17";
alter table public."business_profiles" drop column "fixture_dropped_19";
alter table public."business_profiles" drop column "fixture_dropped_20";
alter table public."business_profiles" drop column "fixture_dropped_21";
alter table public."business_profiles" drop column "fixture_dropped_22";
alter table public."business_profiles" drop column "fixture_dropped_23";
alter table public."business_profiles" drop column "fixture_dropped_24";
alter table public."business_profiles" drop column "fixture_dropped_25";
alter table public."business_profiles" drop column "fixture_dropped_26";
alter table public."business_profiles" drop column "fixture_dropped_27";
alter table public."business_profiles" drop column "fixture_dropped_29";
alter table public."business_profiles" drop column "fixture_dropped_30";
alter table public."business_profiles" drop column "fixture_dropped_31";
alter table public."business_profiles" drop column "fixture_dropped_32";
alter table public."business_profiles" drop column "fixture_dropped_33";
alter table public."business_profiles" drop column "fixture_dropped_34";
create table public."clarification_requests" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"status" text default 'pending'::text not null,
"reason_code" text default 'other'::text not null,
"prompt_text" text default 'What was this for?'::text not null,
"answer_text" text,
"answered_at" timestamp with time zone,
"answered_by" text,
"last_notified_at" timestamp with time zone,
"dismissed_until" timestamp with time zone,
"meta" jsonb,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"answered_by_user_id" uuid,
"selected_intent" text,
"resolved_at" timestamp with time zone,
"resolved_by_user_id" uuid,
"resolved_reason" text,
"resolved_transaction_status" text,
"resolved_final_qbo_account_id" text,
"resolved_final_qbo_account_name" text
);
create table public."credit_card_payment_pair_events" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"pair_id" uuid not null,
"transaction_id" uuid not null,
"event_type" text not null,
"actor" text,
"metadata" jsonb default '{}'::jsonb not null,
"created_at" timestamp with time zone default now() not null
);
create table public."credit_card_payment_pairs" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"checking_transaction_id" uuid not null,
"credit_card_transaction_id" uuid,
"checking_plaid_account_id" text not null,
"credit_card_plaid_account_id" text,
"checking_qbo_account_id" text not null,
"checking_qbo_account_name" text,
"credit_card_qbo_account_id" text not null,
"credit_card_qbo_account_name" text,
"amount" numeric(14,2) not null,
"payment_date" date,
"matched_date" date,
"status" text default 'needs_review'::text not null,
"match_confidence" text default 'manual'::text not null,
"match_evidence" jsonb default '{}'::jsonb not null,
"request_id" text,
"idempotency_key" text,
"posting_started_at" timestamp with time zone,
"lease_expires_at" timestamp with time zone,
"last_post_attempt_at" timestamp with time zone,
"post_error" text,
"qbo_txn_id" text,
"qbo_txn_type" text,
"qbo_sync_token" text,
"posted_at" timestamp with time zone,
"created_by" text default 'bizzi'::text not null,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."financial_monthly_review_stamps" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"review_month" date not null,
"status" text default 'finalized'::text not null,
"reviewed_by" text,
"reviewer_user_id" uuid,
"completed_at" timestamp with time zone default now() not null,
"notes" text,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."internal_admin_view_sessions" (
"id" uuid default gen_random_uuid() not null,
"staff_user_id" uuid not null,
"staff_role" text not null,
"business_id" uuid not null,
"source" text default 'monthly_review'::text not null,
"read_only" boolean default true not null,
"handoff_token_hash" text,
"handoff_expires_at" timestamp with time zone,
"handoff_used_at" timestamp with time zone,
"session_token_hash" text,
"started_at" timestamp with time zone,
"last_seen_at" timestamp with time zone,
"expires_at" timestamp with time zone,
"ended_at" timestamp with time zone,
"revoked_at" timestamp with time zone,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"created_ip" text,
"created_user_agent" text,
"redeemed_ip" text,
"redeemed_user_agent" text,
"return_url" text,
"metadata" jsonb default '{}'::jsonb not null,
"capabilities" text[] default '{}'::text[] not null
);
create table public."internal_staff_users" (
"user_id" uuid not null,
"role" text not null,
"active" boolean default true not null,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."monthly_review_qbo_pnl_snapshots" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"review_year" integer not null,
"review_month" integer not null,
"snapshot_version" integer default 1 not null,
"is_current" boolean default true not null,
"qbo_realm_id" text,
"qbo_environment" text,
"accounting_method" text not null,
"source_start_date" date not null,
"source_end_date" date not null,
"pulled_at" timestamp with time zone default now() not null,
"revenue" numeric(14,2) default 0 not null,
"cogs" numeric(14,2) default 0 not null,
"expenses" numeric(14,2) default 0 not null,
"net_profit" numeric(14,2) default 0 not null,
"raw_hash" text,
"status" text default 'current'::text not null,
"metadata" jsonb default '{}'::jsonb not null,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."monthly_review_runs" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"review_month" date not null,
"status" text default 'in_progress'::text not null,
"reviewed_by" uuid,
"finalized_by" uuid,
"finalized_at" timestamp with time zone,
"notes" text,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"active_editor_user_id" uuid,
"active_editor_email" text,
"active_editor_started_at" timestamp with time zone,
"active_editor_expires_at" timestamp with time zone,
"assigned_reviewer_id" uuid,
"assigned_reviewer_email" text,
"assignment_notes" text,
"evidence_snapshot" jsonb default '{}'::jsonb not null,
"evidence_hash" text,
"readiness_score" numeric default 0 not null,
"last_reminder_at" timestamp with time zone
);
create table public."operator_request_summaries" (
"business_id" uuid not null,
"accounting_needs_review_count" integer default 0 not null,
"outstanding_count" integer default 0 not null,
"answered_awaiting_review_count" integer default 0 not null,
"reconciliation_status" text default 'ok'::text not null,
"last_error" text,
"last_reconciled_at" timestamp with time zone,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."pending_transaction_resolution_events" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"action" text not null,
"prior_state" text,
"resulting_state" text not null,
"actor_user_id" uuid,
"actor_label" text,
"reason" text,
"evidence" jsonb default '{}'::jsonb not null,
"idempotency_key" text not null,
"created_at" timestamp with time zone default now() not null
);
create table public."plaid_account_connection_audit" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_account_id" text not null,
"plaid_item_id" text,
"plaid_env" text not null,
"previous_state" jsonb not null,
"next_state" text not null,
"actor_user_id" uuid,
"action_type" text not null,
"source" text not null,
"request_id" text not null,
"created_at" timestamp with time zone default now() not null
);
create table public."plaid_account_lineage_decisions" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_env" text not null,
"physical_account_id" uuid not null,
"prior_plaid_account_id" text not null,
"replacement_plaid_account_id" text not null,
"qbo_account_id" text not null,
"status" text default 'confirmed'::text not null,
"source" text not null,
"actor_user_id" uuid,
"metadata" jsonb default '{}'::jsonb not null,
"created_at" timestamp with time zone default now() not null,
"reversed_at" timestamp with time zone,
"reversed_by" uuid
);
create table public."plaid_accounts" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_item_id" text not null,
"plaid_account_id" text not null,
"name" text not null,
"official_name" text,
"mask" text,
"type" text,
"subtype" text,
"iso_currency_code" text,
"unofficial_currency_code" text,
"current_balance" numeric,
"available_balance" numeric,
"limit_balance" numeric,
"is_active" boolean default true not null,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"connected_at" timestamp with time zone default now() not null,
"last_sync_at" timestamp with time zone,
"disconnected_at" timestamp with time zone,
"plaid_env" text not null,
"physical_account_id" uuid,
"relink_status" text,
"relink_confidence" text,
"relink_candidate_ids" uuid[] default '{}'::uuid[] not null,
"connection_state" text default 'connected'::text not null,
"connection_state_version" bigint default 0 not null,
"disconnected_by" uuid,
"disconnect_metadata" jsonb default '{}'::jsonb not null,
"sync_gap_started_at" timestamp with time zone,
"sync_gap_last_event_at" timestamp with time zone,
"sync_gap_event_count" bigint default 0 not null,
"reconnected_at" timestamp with time zone,
"reconnected_by" uuid
);
create table public."plaid_items" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"user_id" uuid,
"plaid_item_id" text not null,
"plaid_access_token" text not null,
"institution_id" text,
"institution_name" text,
"status" text default 'active'::text not null,
"cursor" text,
"last_sync_at" timestamp with time zone,
"last_success_at" timestamp with time zone,
"error_code" text,
"error_message" text,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"metadata" jsonb,
"sync_in_progress" boolean default false not null,
"sync_started_at" timestamp with time zone,
"is_active" boolean default true not null,
"disconnected_at" timestamp with time zone,
"plaid_env" text not null,
"sync_lease_owner" text,
"sync_lease_acquired_at" timestamp with time zone,
"sync_lease_expires_at" timestamp with time zone,
"replacement_recovery_status" text,
"replacement_recovery_account_id" text,
"replacement_recovery_cutoff_date" date,
"replacement_repair_completed_at" timestamp with time zone,
"replacement_recovery_bootstrapped_at" timestamp with time zone,
"replacement_recovery_bootstrapped_by" uuid,
"replacement_recovery_selected_at" timestamp with time zone,
"replacement_recovery_selected_by" uuid,
"reconnect_state" jsonb default '{}'::jsonb not null
);
create table public."plaid_physical_accounts" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_env" text default 'production'::text not null,
"institution_id" text,
"institution_name" text,
"account_mask" text,
"account_type" text,
"account_subtype" text,
"normalized_account_name" text,
"current_plaid_item_id" text,
"current_plaid_account_id" text,
"previous_plaid_item_ids" text[] default '{}'::text[] not null,
"previous_plaid_account_ids" text[] default '{}'::text[] not null,
"confidence" text default 'probable'::text not null,
"status" text default 'active'::text not null,
"needs_confirmation" boolean default false not null,
"duplicate_candidate_ids" uuid[] default '{}'::uuid[] not null,
"metadata" jsonb default '{}'::jsonb not null,
"first_seen_at" timestamp with time zone default now() not null,
"last_seen_at" timestamp with time zone default now() not null,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."plaid_qbo_account_mappings" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_account_id" text not null,
"qbo_account_id" text not null,
"qbo_account_name" text not null,
"qbo_account_type" text not null,
"source" text default 'manual'::text not null,
"confidence" text,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."plaid_recovery_batch_rows" (
"id" uuid default gen_random_uuid() not null,
"batch_id" uuid not null,
"business_id" uuid not null,
"plaid_transaction_id" text,
"pending_transaction_id" text,
"plaid_account_id" text,
"physical_account_id" uuid,
"change_type" text not null,
"disposition" text not null,
"transaction_date" date,
"authorized_date" date,
"payload" jsonb default '{}'::jsonb not null,
"admitted_transaction_id" uuid,
"created_at" timestamp with time zone default now() not null,
"amount" numeric,
"signed_amount" numeric,
"pending" boolean default false not null
);
create table public."plaid_recovery_batches" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_env" text not null,
"plaid_item_id" text not null,
"original_cursor" text,
"staged_next_cursor" text,
"cutoff_date" date not null,
"status" text default 'staging'::text not null,
"posting_hold" boolean default true not null,
"summary" jsonb default '{}'::jsonb not null,
"failure_code" text,
"failure_detail" text,
"created_by" uuid,
"released_by" uuid,
"released_at" timestamp with time zone,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"rebuild_source_batch_id" uuid,
"rebuild_idempotency_key" text,
"abandoned_at" timestamp with time zone,
"abandoned_by" uuid
);
create table public."plaid_replacement_account_candidates" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"plaid_env" text not null,
"plaid_item_id" text not null,
"plaid_account_id" text not null,
"account_snapshot" jsonb not null,
"status" text default 'pending'::text not null,
"created_at" timestamp with time zone default now() not null,
"decided_at" timestamp with time zone,
"decided_by" uuid
);
create table public."qbo_accounts_cache" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"realm_id" text not null,
"qbo_env" text default 'production'::text not null,
"qbo_account_id" text not null,
"name" text not null,
"fully_qualified_name" text,
"account_type" text,
"account_subtype" text,
"active" boolean default true not null,
"sync_token" text,
"raw" jsonb default '{}'::jsonb not null,
"last_synced_at" timestamp with time zone default now() not null,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null
);
create table public."qbo_posted_transactions" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"qbo_env" text default 'production'::text not null,
"realm_id" text,
"qbo_txn_type" text not null,
"qbo_txn_id" text,
"qbo_sync_token" text,
"status" text default 'posted'::text not null,
"posted_at" timestamp with time zone default now(),
"error" text,
"payload" jsonb,
"response" jsonb,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"request_id" text,
"idempotency_key" text,
"attempt_count" integer default 0 not null,
"processing_started_at" timestamp with time zone,
"lease_expires_at" timestamp with time zone,
"last_attempt_at" timestamp with time zone,
"last_error" jsonb,
"payload_summary" jsonb,
"response_summary" jsonb,
"created_by" text default 'bizzi'::text not null
);
create table public."quickbooks_tokens" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid,
"access_token" text not null,
"refresh_token" text not null,
"realm_id" text not null,
"token_type" text default 'Bearer'::text,
"expires_in" integer,
"x_refresh_token_expires_in" integer,
"scope" text,
"created_at" timestamp with time zone default now(),
"company_name" text,
"access_token_expires_at" timestamp with time zone,
"refresh_token_expires_at" timestamp with time zone,
"connected_company_name" text,
"connected_legal_name" text,
"connected_at" timestamp with time zone,
"qbo_env" text default 'production'::text not null,
"is_active" boolean default true not null,
"disconnected_at" timestamp with time zone,
"status" text default 'active'::text not null,
"last_connected_at" timestamp with time zone,
"company_id" text,
"display_name" text
);
create table public."subscriptions" (
"id" uuid default gen_random_uuid() not null,
"user_id" uuid not null,
"business_id" uuid not null,
"stripe_customer_id" text,
"stripe_subscription_id" text,
"status" text,
"current_period_end" timestamp with time zone,
"created_at" timestamp with time zone default now(),
"updated_at" timestamp with time zone default now(),
"business_name" text,
"customer_email" text,
"customer_full_name" text,
"plan_type" text,
"plan_price_id" text,
"cancel_at_period_end" boolean,
"trial_end" timestamp with time zone,
"last_invoice_status" text
);
create table public."transaction_categorizations" (
"id" uuid default gen_random_uuid() not null,
"business_id" uuid not null,
"transaction_id" uuid not null,
"status" text default 'needs_review'::text not null,
"suggested_qbo_account_id" text,
"suggested_qbo_account_name" text,
"confidence" text,
"reason" text,
"final_qbo_account_id" text,
"final_qbo_account_name" text,
"decided_by" text default 'bizzi'::text not null,
"decided_at" timestamp with time zone,
"model" text,
"prompt_version" text,
"meta" jsonb default '{}'::jsonb,
"created_at" timestamp with time zone default now() not null,
"updated_at" timestamp with time zone default now() not null,
"post_after" timestamp with time zone,
"qbo_txn_id" text,
"qbo_txn_type" text,
"posted_at" timestamp with time zone,
"last_post_attempt_at" timestamp with time zone,
"post_error" text,
"reconciled_at" timestamp with time zone,
"txn_date" date,
"txn_name" text,
"signed_amount" numeric,
"is_archived" boolean default false not null,
"archived_at" timestamp with time zone,
"pending_blocked_at" timestamp with time zone,
"accounting_review_required" boolean default false not null,
"accounting_review_reason" text,
"suggested_canonical_account_key" text,
"final_canonical_account_key" text,
"review_status" text default 'needs_review'::text not null,
"reviewed_at" timestamp with time zone,
"review_reopened_at" timestamp with time zone,
"review_reopen_reason" text,
"posting_status" text default 'not_scheduled'::text not null,
"excluded_at" timestamp with time zone,
"excluded_by" text,
"exclusion_reason" text,
"exclusion_source" text,
"pre_exclusion_lifecycle" text,
"exclusion_version" integer default 0 not null,
"exclusion_snapshot" jsonb,
"posting_hold_batch_id" uuid
);
create table public."user_business_link" (
"id" uuid default uuid_generate_v4() not null,
"user_id" uuid,
"business_id" uuid,
"role" text default 'owner'::text,
"created_at" timestamp with time zone default timezone('utc'::text, now())
);
create table public."user_profiles" (
"id" uuid not null,
"email" text not null,
"role" text default 'owner'::text,
"created_at" timestamp with time zone default timezone('utc'::text, now()),
"first_name" text,
"last_name" text,
"full_name" text,
"billing_business_id" uuid,
"billing_business_name" text,
"billing_stripe_customer_id" text,
"billing_stripe_subscription_id" text,
"billing_subscription_status" text,
"billing_plan_type" text,
"billing_current_period_end" timestamp with time zone,
"billing_updated_at" timestamp with time zone
);
CREATE OR REPLACE FUNCTION public.tax_user_owns_business(p_business_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select exists (
    select 1
    from public.business_profiles bp
    where bp.id = p_business_id
      and bp.user_id = auth.uid()
  );
$function$
;
CREATE OR REPLACE FUNCTION public.refresh_billing_identity_summary_from_billing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  perform public.refresh_billing_identity_summary(new.business_id);
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.enforce_business_profile_onboarding_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_quickbooks_connected boolean;
  v_plaid_connected boolean;
  v_requirements_met boolean;
BEGIN
  v_quickbooks_connected := public.business_profile_has_active_qbo_connection(NEW.id);
  v_plaid_connected := public.business_profile_has_active_plaid_connection(NEW.id);

  NEW.quickbooks_connected := v_quickbooks_connected;
  NEW.plaid_connected := v_plaid_connected;

  IF v_quickbooks_connected THEN
    NEW.quickbooks_connected_at := COALESCE(NEW.quickbooks_connected_at, now());
  ELSE
    NEW.quickbooks_connected_at := NULL;
  END IF;

  IF v_plaid_connected THEN
    NEW.plaid_connected_at := COALESCE(NEW.plaid_connected_at, now());
  ELSE
    NEW.plaid_connected_at := NULL;
  END IF;

  v_requirements_met :=
    NULLIF(btrim(NEW.business_name), '') IS NOT NULL
    AND NULLIF(btrim(NEW.industry), '') IS NOT NULL
    AND NULLIF(btrim(NEW.state), '') IS NOT NULL
    AND v_quickbooks_connected
    AND v_plaid_connected;

  IF v_requirements_met THEN
    NEW.onboarding_status := 'complete';
    IF NEW.onboarding_completed_at IS NULL THEN
      NEW.onboarding_completed_at := now();
    END IF;
  ELSE
    NEW.onboarding_status := 'in_progress';
    IF TG_OP = 'INSERT' THEN
      NEW.onboarding_completed_at := NULL;
    ELSIF OLD.onboarding_completed_at IS NULL THEN
      NEW.onboarding_completed_at := NULL;
    ELSE
      NEW.onboarding_completed_at := OLD.onboarding_completed_at;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.onboarding_status_updated_at := now();
  ELSIF NEW.onboarding_status IS DISTINCT FROM OLD.onboarding_status
    OR NEW.onboarding_completed_at IS DISTINCT FROM OLD.onboarding_completed_at
    OR NEW.quickbooks_connected IS DISTINCT FROM OLD.quickbooks_connected
    OR NEW.plaid_connected IS DISTINCT FROM OLD.plaid_connected THEN
    NEW.onboarding_status_updated_at := now();
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.claim_bookkeeping_processing_requests(p_worker_id text, p_batch_size integer, p_now timestamp with time zone)
 RETURNS SETOF bookkeeping_processing_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  with candidates as (
    select id
    from public.bookkeeping_processing_requests
    where (
        status in ('pending', 'failed')
        or (
          status = 'processing'
          and locked_at is not null
          and locked_at < p_now - interval '10 minutes'
        )
      )
      and process_after <= p_now
      and attempt_count < max_attempts
    order by priority desc, process_after asc, created_at asc
    limit greatest(1, least(coalesce(p_batch_size, 25), 250))
    for update skip locked
  )
  update public.bookkeeping_processing_requests r
     set status = 'processing',
         locked_at = p_now,
         locked_by = p_worker_id,
         attempt_count = coalesce(r.attempt_count, 0) + 1,
         error_code = null,
         error_message = null,
         updated_at = p_now
    from candidates
   where r.id = candidates.id
  returning r.*;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.get_operator_request_counts_bounded(p_business_id uuid)
 RETURNS TABLE(outstanding_count bigint, answered_awaiting_review_count bigint, accounting_needs_review_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with needs_review as (
    select bt.id
    from public.bank_transactions bt
    left join public.business_profiles bp
      on bp.id = bt.business_id
    left join public.transaction_categorizations tc
      on tc.business_id = bt.business_id
     and tc.transaction_id = bt.id
    where bt.business_id = p_business_id
      and bt.is_archived is false
      and bt.pending is not true
      and (bp.bookkeeping_start_date is null or bt.date >= bp.bookkeeping_start_date)
      and public.bookkeeping_transaction_matches_status('needs_review', tc.status, tc.meta, tc.qbo_txn_id)
  ),
  answered as (
    select distinct cr.transaction_id
    from public.clarification_requests cr
    join needs_review nr
      on nr.id = cr.transaction_id
    where cr.business_id = p_business_id
      and cr.status = 'answered'
      and cr.resolved_at is null
  )
  select
    (select count(*) from needs_review nr where not exists (select 1 from answered a where a.transaction_id = nr.id)) as outstanding_count,
    (select count(*) from answered) as answered_awaiting_review_count,
    (select count(*) from needs_review) as accounting_needs_review_count;
$function$
;
CREATE OR REPLACE FUNCTION public.enforce_bookkeeping_review_posting_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_explicit_undo boolean := false;
  v_documented_reopen boolean :=
    coalesce((new.meta ->> 'review_reopen_authorized')::boolean, false)
    and nullif(new.meta ->> 'review_reopen_reason', '') is not null;
begin
  -- A reviewed hold-only release must not recalculate review/posting decisions.
  -- This non-login owner is reachable only through the private vetted helper.
  if current_user = 'plaid_residual_hold_executor' and tg_op = 'UPDATE'
     and old.posting_hold_batch_id is not null and new.posting_hold_batch_id is null
     and (to_jsonb(new)-'posting_hold_batch_id'-'updated_at') = (to_jsonb(old)-'posting_hold_batch_id'-'updated_at') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    v_explicit_undo :=
      new.decided_by = 'user'
      and new.final_qbo_account_id is null
      and new.final_qbo_account_name is null
      and new.post_error is null
      and new.decided_at is distinct from old.decided_at;
  end if;

  if tg_op = 'UPDATE'
     and (old.status = 'posted' or old.qbo_txn_id is not null or old.posted_at is not null)
     and new.status in ('needs_review', 'uncategorized') then
    -- Undo never voids a QBO entity. A posted row cannot become reviewable or
    -- post-eligible again while durable posting evidence remains.
    new.status := old.status;
    new.review_status := 'handled';
    new.reviewed_at := old.reviewed_at;
    new.final_qbo_account_id := old.final_qbo_account_id;
    new.final_qbo_account_name := old.final_qbo_account_name;
    new.final_canonical_account_key := old.final_canonical_account_key;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  elsif tg_op = 'UPDATE'
     and old.review_status = 'handled'
     and new.status in ('needs_review', 'uncategorized')
     and not v_explicit_undo
     and not v_documented_reopen then
    -- Stale suggestion/sync/worker writes may update operational metadata, but
    -- they may not erase a completed human review decision.
    new.status := old.status;
    new.review_status := 'handled';
    new.reviewed_at := old.reviewed_at;
    new.final_qbo_account_id := old.final_qbo_account_id;
    new.final_qbo_account_name := old.final_qbo_account_name;
    new.final_canonical_account_key := old.final_canonical_account_key;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  elsif new.status in ('approved', 'auto_approved', 'handled', 'failed', 'posted', 'matched', 'matched_existing_qbo', 'ignored') then
    new.review_status := 'handled';
    new.reviewed_at := coalesce(old.reviewed_at, new.decided_at, new.posted_at, now());
  else
    new.review_status := 'needs_review';
    if tg_op = 'UPDATE' and old.review_status = 'handled' then
      new.review_reopened_at := now();
      new.review_reopen_reason := coalesce(new.meta ->> 'review_reopen_reason', 'user_undo');
    end if;
  end if;

  new.posting_status := case
    when new.status = 'posted' or new.qbo_txn_id is not null then 'posted'
    when new.status in ('matched', 'matched_existing_qbo') then 'not_scheduled'
    when new.status = 'failed' or new.post_error is not null then 'posting_failed'
    when coalesce((new.meta ->> 'posting_in_progress')::boolean, false) then 'posting'
    when new.post_after is not null then 'scheduled'
    else 'not_scheduled'
  end;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.plaid_residual_reconciliation_snapshot(p_business_id uuid, p_plaid_env text, p_account_id text, p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  with rows as (select * from public.plaid_residual_reconciliation_rows(p_business_id,p_batch_id)),
  scope as (select b.*,bp.auto_post_to_quickbooks,to_jsonb(a) account_json,
      jsonb_build_object('status',i.status,'is_active',i.is_active,'sync_lease_owner',i.sync_lease_owner,
        'sync_in_progress',i.sync_in_progress,'sync_lease_expires_at',i.sync_lease_expires_at,'last_success_at',i.last_success_at,
        'cursor_sha256',encode(sha256(convert_to(coalesce(i.cursor,''),'UTF8')),'hex')) item_json
    from public.plaid_recovery_batches b join public.business_profiles bp on bp.id=b.business_id
    join public.plaid_accounts a on a.business_id=b.business_id and a.plaid_env=b.plaid_env and a.plaid_account_id=p_account_id and a.plaid_item_id=b.plaid_item_id
    join public.plaid_items i on i.business_id=b.business_id and i.plaid_env=b.plaid_env and i.plaid_item_id=b.plaid_item_id
    where b.id=p_batch_id and b.business_id=p_business_id and b.plaid_env=p_plaid_env)
  select jsonb_build_object('observed_at',now(),'batch_id',p_batch_id,'account_id',p_account_id,
    'auto_post_disabled',not s.auto_post_to_quickbooks,'row_count',(select count(*) from rows),
    'held_count',(select count(*) from rows where held),'releasable_count',(select count(*) from rows where releasable),
    'classifications',coalesce((select jsonb_object_agg(classification,n) from (select classification,count(*) n from rows where held group by classification) counts),'{}'),
    'rows',coalesce((select jsonb_agg(to_jsonb(r) order by transaction_id) from rows r),'[]'),
    'fingerprint',encode(sha256(convert_to(jsonb_build_array(s.business_id,s.plaid_env,s.plaid_item_id,s.status,s.posting_hold,
      s.created_by,s.created_at,s.summary-'residual_reconciliations',s.auto_post_to_quickbooks,s.account_json,s.item_json,
      (select string_agg(evidence_fingerprint,',' order by transaction_id) from rows))::text,'UTF8')),'hex'))
  from scope s;
$function$
;
CREATE OR REPLACE FUNCTION public.assert_plaid_residual_operator_scope(p_business_id uuid, p_plaid_env text, p_account_id text, p_batch_id uuid, p_actor_id uuid)
 RETURNS plaid_recovery_batches
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare b public.plaid_recovery_batches%rowtype;
begin
  if not exists(select 1 from public.internal_staff_users where user_id=p_actor_id and active
    and role in ('operator','accountant','owner_admin')) then
    raise exception using errcode='42501',message='plaid_reconciliation_operator_required';
  end if;
  select * into b from public.plaid_recovery_batches where id=p_batch_id and business_id=p_business_id
    and plaid_env=p_plaid_env and summary->>'workflow_kind' in ('residual_orphan','reviewed_recovery')
    and summary->'before'->>'account_id'=p_account_id and status='imported_held'
    and posting_hold and summary ? 'applied_at' and summary ? 'applied_count';
  if not found or not exists(select 1 from public.plaid_accounts where business_id=p_business_id
    and plaid_env=p_plaid_env and plaid_account_id=p_account_id and plaid_item_id=b.plaid_item_id) then
    raise exception using errcode='22023',message='plaid_reconciliation_scope_or_admission_invalid';
  end if;
  if (b.summary->>'applied_count')::integer<>(select count(*) from public.plaid_recovery_batch_rows
      where business_id=p_business_id and batch_id=b.id
        and (b.summary->>'workflow_kind'='residual_orphan' or admitted_transaction_id is not null)) then
    raise exception using errcode='40001',message='plaid_reconciliation_cohort_invalid';
  end if;
  return b;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.assert_plaid_recovery_operator(p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if not exists(select 1 from public.internal_staff_users where user_id=p_actor_id and active
    and role in ('operator','accountant','owner_admin')) then
    raise exception using errcode='42501',message='plaid_recovery_operator_required';
  end if;
end $function$
;
CREATE OR REPLACE FUNCTION public.touch_internal_admin_view_sessions_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.bizzi_current_user_is_business_member(p_business_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT
    p_business_id IS NOT NULL
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.business_profiles AS bp
        WHERE bp.id = p_business_id
          AND bp.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.user_business_link AS ubl
        WHERE ubl.business_id = p_business_id
          AND ubl.user_id = auth.uid()
      )
    );
$function$
;
CREATE OR REPLACE FUNCTION public.business_profile_has_active_qbo_connection(p_business_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT
    p_business_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.quickbooks_tokens AS qt
      WHERE qt.business_id = p_business_id
        AND qt.is_active IS TRUE
        AND qt.status = 'active'
        AND qt.realm_id IS NOT NULL
    );
$function$
;
CREATE OR REPLACE FUNCTION public.prevent_business_profile_identity_reassignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_ID_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_OWNER_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.business_profile_has_active_plaid_connection(p_business_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT
    p_business_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.plaid_items AS pi
        WHERE pi.business_id = p_business_id
          AND pi.is_active IS TRUE
          AND pi.status IN ('connected', 'active')
      )
      OR EXISTS (
        SELECT 1
        FROM public.plaid_accounts AS pa
        WHERE pa.business_id = p_business_id
          AND pa.is_active IS TRUE
          AND pa.disconnected_at IS NULL
      )
    );
$function$
;
CREATE OR REPLACE FUNCTION public.refresh_business_profile_onboarding_status_from_integration()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_business_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_business_id := OLD.business_id;
  ELSE
    v_business_id := NEW.business_id;
  END IF;

  PERFORM public.refresh_business_profile_onboarding_status(v_business_id);
  RETURN COALESCE(NEW, OLD);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.audit_bookkeeping_lifecycle_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.review_status is distinct from new.review_status
     or old.posting_status is distinct from new.posting_status
     or old.status is distinct from new.status then
    insert into public.bookkeeping_lifecycle_events (
      business_id,
      transaction_id,
      previous_review_status,
      new_review_status,
      previous_posting_status,
      new_posting_status,
      previous_legacy_status,
      new_legacy_status,
      actor,
      reason,
      posting_attempt_id,
      plaid_pending_transaction_id
    ) values (
      new.business_id,
      new.transaction_id,
      old.review_status,
      new.review_status,
      old.posting_status,
      new.posting_status,
      old.status,
      new.status,
      coalesce(new.decided_by, new.meta ->> 'lifecycle_actor', 'system'),
      coalesce(new.meta ->> 'review_reopen_reason', new.post_error, new.reason, 'state_transition'),
      coalesce(new.meta ->> 'post_intent_id', new.meta ->> 'post_idempotency_key'),
      new.meta ->> 'pending_transaction_id'
    );
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.refresh_billing_identity_summary_from_business_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  perform public.refresh_billing_identity_summary(new.id);
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.refresh_billing_identity_summary_from_user_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  business_row record;
begin
  for business_row in
    select id from public.business_profiles where user_id = new.id
  loop
    perform public.refresh_billing_identity_summary(business_row.id);
  end loop;

  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.prevent_user_business_link_identity_reassignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'USER_BUSINESS_LINK_ID_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'USER_BUSINESS_LINK_USER_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'USER_BUSINESS_LINK_BUSINESS_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'USER_BUSINESS_LINK_ROLE_IMMUTABLE'
      USING ERRCODE = '23000';
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.set_user_profiles_full_name()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.full_name :=
    nullif(trim(coalesce(new.first_name,'') || ' ' || coalesce(new.last_name,'')), '');
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.tc_sync_txn_fields_from_bank_transactions()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.business_id is not null
     and new.transaction_id is not null
  then
    select
      bt.date,
      bt.name,
      bt.signed_amount
    into
      new.txn_date,
      new.txn_name,
      new.signed_amount
    from public.bank_transactions bt
    where bt.business_id = new.business_id
      and bt.id = new.transaction_id
    limit 1;
  end if;

  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.billing_effective_bool(p_legacy_value boolean, p_live_value boolean, p_test_value boolean)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(p_live_value, p_test_value, p_legacy_value, false);
$function$
;
CREATE OR REPLACE FUNCTION public.count_bookkeeping_transactions_bounded(p_business_id uuid, p_status_filter text DEFAULT 'needs_review'::text, p_account_id text DEFAULT NULL::text, p_range_start date DEFAULT NULL::date, p_range_end date DEFAULT NULL::date)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with candidate_rows as (
    select
      bt.id,
      bt.business_id,
      bt.plaid_transaction_id,
      bt.pending,
      tc.status as cat_status,
      tc.meta as cat_meta,
      tc.qbo_txn_id
    from public.bank_transactions bt
    left join public.business_profiles bp
      on bp.id = bt.business_id
    left join public.transaction_categorizations tc
      on tc.business_id = bt.business_id
     and tc.transaction_id = bt.id
    where bt.business_id = p_business_id
      and bt.is_archived is false
      and (p_account_id is null or bt.plaid_account_id = p_account_id)
      and (p_range_start is null or bt.date >= p_range_start)
      and (p_range_end is null or bt.date < p_range_end)
      and (bp.bookkeeping_start_date is null or bt.date >= bp.bookkeeping_start_date)
  )
  select count(*)
  from candidate_rows cr
  where (
    lower(coalesce(p_status_filter, 'needs_review')) = 'pending'
    and cr.pending is true and coalesce(cr.cat_status, '') <> 'excluded' and cr.cat_meta ->> 'excluded_at' is null and coalesce(cr.cat_status, '') <> 'excluded' and cr.cat_meta ->> 'excluded_at' is null and coalesce(cr.cat_status, '') <> 'excluded' and cr.cat_meta ->> 'excluded_at' is null
    and not exists (
      select 1
      from public.bank_transactions settled
      where settled.business_id = cr.business_id
        and settled.is_archived is false
        and settled.pending is not true
        and settled.pending_transaction_id is not null
        and cr.plaid_transaction_id is not null
        and settled.pending_transaction_id = cr.plaid_transaction_id
    )
  )
  or (
    lower(coalesce(p_status_filter, 'needs_review')) <> 'pending'
    and (cr.pending is not true or lower(coalesce(p_status_filter, '')) = 'excluded')
    and public.bookkeeping_transaction_matches_status(p_status_filter, cr.cat_status, cr.cat_meta, cr.qbo_txn_id)
  );
$function$
;
CREATE OR REPLACE FUNCTION public.get_bookkeeping_transactions_bounded(p_business_id uuid, p_status_filter text DEFAULT 'needs_review'::text, p_account_id text DEFAULT NULL::text, p_range_start date DEFAULT NULL::date, p_range_end date DEFAULT NULL::date, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, plaid_account_id text, plaid_transaction_id text, date date, name text, merchant_name text, merchant_entity_id text, counterparties jsonb, counterparty_name text, counterparty_source text, counterparty_confidence text, canonical_vendor_id uuid, qbo_entity_type text, qbo_entity_id text, amount numeric, signed_amount numeric, direction text, pending boolean, category_primary text, category_detailed text, personal_finance_category jsonb, account_name text, account_official_name text, cat_status text, suggested_qbo_account_id text, suggested_qbo_account_name text, suggested_canonical_account_key text, confidence text, reason text, final_qbo_account_id text, final_qbo_account_name text, final_canonical_account_key text, post_after timestamp with time zone, qbo_txn_id text, qbo_txn_type text, posted_at timestamp with time zone, reconciled_at timestamp with time zone, post_error text, last_post_attempt_at timestamp with time zone, cat_meta jsonb, operator_request_id uuid, operator_request_status text, operator_prompt_text text, operator_answer_text text, operator_selected_intent text, operator_answered_at timestamp with time zone, operator_resolved_at timestamp with time zone, operator_meta jsonb, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with candidate_rows as (
    select
      bt.*,
      pa.name as account_name,
      pa.official_name as account_official_name,
      tc.status as cat_status,
      tc.suggested_qbo_account_id,
      tc.suggested_qbo_account_name,
      tc.suggested_canonical_account_key,
      tc.confidence,
      tc.reason,
      tc.final_qbo_account_id,
      tc.final_qbo_account_name,
      tc.final_canonical_account_key,
      tc.post_after,
      tc.qbo_txn_id,
      tc.qbo_txn_type,
      tc.posted_at,
      tc.reconciled_at,
      tc.post_error,
      tc.last_post_attempt_at,
      tc.meta as cat_meta,
      cr.id as operator_request_id,
      cr.status as operator_request_status,
      cr.prompt_text as operator_prompt_text,
      cr.answer_text as operator_answer_text,
      cr.selected_intent as operator_selected_intent,
      cr.answered_at as operator_answered_at,
      cr.resolved_at as operator_resolved_at,
      cr.meta as operator_meta
    from public.bank_transactions bt
    left join public.business_profiles bp
      on bp.id = bt.business_id
    left join public.transaction_categorizations tc
      on tc.business_id = bt.business_id
     and tc.transaction_id = bt.id
    left join public.plaid_accounts pa
      on pa.business_id = bt.business_id
     and pa.plaid_account_id = bt.plaid_account_id
    left join public.clarification_requests cr
      on cr.business_id = bt.business_id
     and cr.transaction_id = bt.id
     and cr.status = 'answered'
     and cr.resolved_at is null
    where bt.business_id = p_business_id
      and bt.is_archived is false
      and (p_account_id is null or bt.plaid_account_id = p_account_id)
      and (p_range_start is null or bt.date >= p_range_start)
      and (p_range_end is null or bt.date < p_range_end)
      and (bp.bookkeeping_start_date is null or bt.date >= bp.bookkeeping_start_date)
  ),
  scoped as (
    select *
    from candidate_rows cr
    where (
      lower(coalesce(p_status_filter, 'needs_review')) = 'pending'
      and cr.pending is true and coalesce(cr.cat_status, '') <> 'excluded' and cr.cat_meta ->> 'excluded_at' is null and coalesce(cr.cat_status, '') <> 'excluded' and cr.cat_meta ->> 'excluded_at' is null and coalesce(cr.cat_status, '') <> 'excluded' and cr.cat_meta ->> 'excluded_at' is null
      and not exists (
        select 1
        from public.bank_transactions settled
        where settled.business_id = cr.business_id
          and settled.is_archived is false
          and settled.pending is not true
          and settled.pending_transaction_id is not null
          and cr.plaid_transaction_id is not null
          and settled.pending_transaction_id = cr.plaid_transaction_id
      )
    )
    or (
      lower(coalesce(p_status_filter, 'needs_review')) <> 'pending'
      and (cr.pending is not true or lower(coalesce(p_status_filter, '')) = 'excluded')
      and public.bookkeeping_transaction_matches_status(p_status_filter, cr.cat_status, cr.cat_meta, cr.qbo_txn_id)
    )
  )
  select
    scoped.id,
    scoped.plaid_account_id,
    scoped.plaid_transaction_id,
    scoped.date,
    scoped.name,
    scoped.merchant_name,
    scoped.merchant_entity_id,
    to_jsonb(scoped.counterparties) as counterparties,
    scoped.counterparty_name,
    scoped.counterparty_source,
    scoped.counterparty_confidence::text,
    scoped.canonical_vendor_id,
    scoped.qbo_entity_type,
    scoped.qbo_entity_id,
    scoped.amount,
    scoped.signed_amount,
    scoped.direction,
    scoped.pending,
    scoped.category_primary,
    scoped.category_detailed,
    to_jsonb(scoped.personal_finance_category) as personal_finance_category,
    scoped.account_name,
    scoped.account_official_name,
    scoped.cat_status,
    scoped.suggested_qbo_account_id,
    scoped.suggested_qbo_account_name,
    scoped.suggested_canonical_account_key,
    scoped.confidence::text,
    scoped.reason,
    scoped.final_qbo_account_id,
    scoped.final_qbo_account_name,
    scoped.final_canonical_account_key,
    scoped.post_after,
    scoped.qbo_txn_id,
    scoped.qbo_txn_type,
    scoped.posted_at,
    scoped.reconciled_at,
    scoped.post_error,
    scoped.last_post_attempt_at,
    scoped.cat_meta,
    scoped.operator_request_id,
    scoped.operator_request_status,
    scoped.operator_prompt_text,
    scoped.operator_answer_text,
    scoped.operator_selected_intent,
    scoped.operator_answered_at,
    scoped.operator_resolved_at,
    scoped.operator_meta,
    count(*) over () as total_count
  from scoped
  order by scoped.date desc nulls last, scoped.id desc
  limit greatest(least(coalesce(p_limit, 25), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$function$
;
CREATE OR REPLACE FUNCTION public.billing_effective_status(p_legacy_status text, p_live_status text, p_test_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(
    case
      when nullif(p_live_status, '') is not null and p_live_status <> 'free' then p_live_status
      when nullif(p_test_status, '') is not null and p_test_status <> 'free' then p_test_status
      when nullif(p_legacy_status, '') is not null then p_legacy_status
      when nullif(p_live_status, '') is not null then p_live_status
      when nullif(p_test_status, '') is not null then p_test_status
      else null
    end,
    'free'
  );
$function$
;
CREATE OR REPLACE FUNCTION public.billing_effective_text(p_legacy_value text, p_live_value text, p_test_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(
    nullif(p_live_value, ''),
    nullif(p_test_value, ''),
    nullif(p_legacy_value, '')
  );
$function$
;
CREATE OR REPLACE FUNCTION public.billing_effective_timestamptz(p_legacy_value timestamp with time zone, p_live_value timestamp with time zone, p_test_value timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(p_live_value, p_test_value, p_legacy_value);
$function$
;
CREATE OR REPLACE FUNCTION public.bizzi_current_user_can_manage_business(p_business_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT
    p_business_id IS NOT NULL
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.business_profiles AS bp
        WHERE bp.id = p_business_id
          AND bp.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.user_business_link AS ubl
        WHERE ubl.business_id = p_business_id
          AND ubl.user_id = auth.uid()
          AND ubl.role IN ('owner', 'admin')
      )
    );
$function$
;
CREATE OR REPLACE FUNCTION public.refresh_business_profile_onboarding_status(p_business_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_quickbooks_connected boolean;
  v_plaid_connected boolean;
  v_requirements_met boolean;
BEGIN
  IF p_business_id IS NULL THEN
    RETURN;
  END IF;

  v_quickbooks_connected := public.business_profile_has_active_qbo_connection(p_business_id);
  v_plaid_connected := public.business_profile_has_active_plaid_connection(p_business_id);

  SELECT
    NULLIF(btrim(bp.business_name), '') IS NOT NULL
    AND NULLIF(btrim(bp.industry), '') IS NOT NULL
    AND NULLIF(btrim(bp.state), '') IS NOT NULL
    AND NULLIF(btrim(bp.services_offered), '') IS NOT NULL
    AND v_quickbooks_connected
    AND v_plaid_connected
  INTO v_requirements_met
  FROM public.business_profiles AS bp
  WHERE bp.id = p_business_id;

  UPDATE public.business_profiles AS bp
  SET
    quickbooks_connected = v_quickbooks_connected,
    quickbooks_connected_at = CASE
      WHEN v_quickbooks_connected THEN COALESCE(bp.quickbooks_connected_at, now())
      ELSE NULL
    END,
    plaid_connected = v_plaid_connected,
    plaid_connected_at = CASE
      WHEN v_plaid_connected THEN COALESCE(bp.plaid_connected_at, now())
      ELSE NULL
    END,
    onboarding_status = CASE
      WHEN COALESCE(v_requirements_met, false) THEN 'complete'
      ELSE 'in_progress'
    END,
    onboarding_completed_at = CASE
      WHEN COALESCE(v_requirements_met, false) THEN COALESCE(bp.onboarding_completed_at, now())
      ELSE bp.onboarding_completed_at
    END,
    onboarding_status_updated_at = now()
  WHERE bp.id = p_business_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.acquire_posting_lock(p_business_id uuid, p_transaction_id uuid, p_now_iso timestamp with time zone, p_lock_stale_seconds integer, p_idempotency_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_meta jsonb;
  v_started_at timestamptz;
  v_in_progress boolean;
  v_qbo_txn_id text;
  v_status text;
  v_existing_key text;
BEGIN
  SELECT status, qbo_txn_id, meta
    INTO v_status, v_qbo_txn_id, v_meta
  FROM public.transaction_categorizations
  WHERE business_id = p_business_id
    AND transaction_id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_status = 'posted' OR v_qbo_txn_id IS NOT NULL THEN
    RETURN false;
  END IF;

  v_in_progress := COALESCE((v_meta->>'posting_in_progress')::boolean, false);
  v_started_at := NULLIF(v_meta->>'posting_started_at','')::timestamptz;

  IF v_in_progress AND v_started_at IS NOT NULL THEN
    IF EXTRACT(EPOCH FROM (p_now_iso - v_started_at)) < p_lock_stale_seconds THEN
      RETURN false;
    END IF;
  END IF;

  v_existing_key := NULLIF(v_meta->>'post_idempotency_key','');
  IF v_existing_key IS NULL THEN
    v_existing_key := p_idempotency_key;
  END IF;

  UPDATE public.transaction_categorizations
  SET
    last_post_attempt_at = p_now_iso,
    meta = jsonb_set(
            jsonb_set(
              jsonb_set(
                COALESCE(meta, '{}'::jsonb),
                '{posting_in_progress}',
                'true'::jsonb,
                true
              ),
              '{posting_started_at}',
              to_jsonb(p_now_iso),
              true
            ),
            '{post_idempotency_key}',
            to_jsonb(v_existing_key),
            true
          )
  WHERE business_id = p_business_id
    AND transaction_id = p_transaction_id;

  RETURN true;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.enforce_active_credit_card_payment_pair_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_left uuid;
  v_right uuid;
begin
  if new.status = 'voided' or new.credit_card_transaction_id is null then
    return new;
  end if;
  v_left := least(new.checking_transaction_id, new.credit_card_transaction_id);
  v_right := greatest(new.checking_transaction_id, new.credit_card_transaction_id);
  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':' || v_left::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':' || v_right::text, 0));
  if exists (
    select 1 from public.credit_card_payment_pairs p
    where p.business_id = new.business_id and p.status <> 'voided'
      and p.id is distinct from new.id
      and (
        p.checking_transaction_id in (new.checking_transaction_id, new.credit_card_transaction_id)
        or p.credit_card_transaction_id in (new.checking_transaction_id, new.credit_card_transaction_id)
      )
  ) then
    raise exception 'credit_card_payment_pair_leg_already_consumed';
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.approve_bookkeeping_transactions_atomic(p_business_id uuid, p_actor_id uuid, p_actor_type text, p_approvals jsonb, p_require_needs_review boolean DEFAULT true)
 RETURNS SETOF transaction_categorizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  approval jsonb;
  current_row public.transaction_categorizations%ROWTYPE;
  bank_row public.bank_transactions%ROWTYPE;
  event_key text;
  inflow_decision jsonb;
  is_credit_card_inflow boolean;
BEGIN
  IF p_actor_type NOT IN ('user','admin','system','automation') THEN RAISE EXCEPTION 'invalid_approval_actor_type' USING ERRCODE='22023'; END IF;
  IF p_actor_type IN ('user','admin') AND p_actor_id IS NULL THEN RAISE EXCEPTION 'missing_approval_actor_id' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_approvals) <> 'array' OR jsonb_array_length(p_approvals)=0 THEN RAISE EXCEPTION 'missing_approvals' USING ERRCODE='22023'; END IF;

  FOR approval IN SELECT value FROM jsonb_array_elements(p_approvals) LOOP
    SELECT * INTO bank_row FROM public.bank_transactions bt
      WHERE bt.business_id=p_business_id AND bt.id=(approval->>'transaction_id')::uuid AND bt.is_archived=false FOR UPDATE;
    IF bank_row.id IS NULL THEN RAISE EXCEPTION 'approval_transaction_not_found' USING ERRCODE='P0002'; END IF;

    SELECT * INTO current_row FROM public.transaction_categorizations tc
      WHERE tc.business_id=p_business_id AND tc.transaction_id=(approval->>'transaction_id')::uuid FOR UPDATE;
    event_key := approval->>'approval_idempotency_key';
    IF coalesce(event_key,'')='' THEN RAISE EXCEPTION 'missing_approval_idempotency_key' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.bookkeeping_approval_events e WHERE e.business_id=p_business_id AND e.idempotency_key=event_key) THEN CONTINUE; END IF;
    IF p_require_needs_review AND current_row.id IS NOT NULL AND lower(coalesce(current_row.status,'needs_review')) NOT IN ('needs_review','uncategorized') THEN
      RAISE EXCEPTION 'transaction_not_needs_review' USING ERRCODE='40001';
    END IF;

    inflow_decision := approval#>'{meta,credit_card_inflow_resolution}';
    SELECT (
      (upper(coalesce(bank_row.direction,''))='INFLOW' OR coalesce(bank_row.amount,0)>0)
      AND EXISTS (
        SELECT 1 FROM public.plaid_qbo_account_mappings pam
        WHERE pam.business_id=p_business_id
          AND pam.plaid_account_id=bank_row.plaid_account_id
          AND regexp_replace(lower(coalesce(pam.qbo_account_type,'')),'[^a-z]','','g')='creditcard'
      )
    ) INTO is_credit_card_inflow;
    IF bank_row.accounting_review_required IS TRUE THEN
      IF bank_row.accounting_review_reason <> 'operator_confirmed_settlement'
         OR bank_row.pending IS TRUE
         OR bank_row.pending_resolution_state <> 'promoted_to_settled'
         OR bank_row.pending_resolution_payload->>'confirmed_at' IS NULL
         OR (is_credit_card_inflow AND (
           coalesce(inflow_decision->>'resolution_type','') NOT IN ('merchant_refund','credit_card_statement_credit')
           OR inflow_decision->>'destination_qbo_account_id' IS NULL
           OR inflow_decision->>'decided_by' IS NULL
           OR inflow_decision->>'decided_at' IS NULL
         )) THEN
        RAISE EXCEPTION 'credit_card_inflow_type_required' USING ERRCODE='22023';
      END IF;
      UPDATE public.bank_transactions SET
        accounting_review_required=false,
        accounting_review_reason=null,
        accounting_review_payload=null,
        updated_at=coalesce(nullif(approval->>'updated_at','')::timestamptz,now())
      WHERE business_id=p_business_id AND id=bank_row.id;
    END IF;

    INSERT INTO public.transaction_categorizations (
      business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,
      final_canonical_account_key,confidence,reason,decided_by,decided_at,updated_at,
      post_after,post_error,meta
    ) VALUES (
      p_business_id,(approval->>'transaction_id')::uuid,coalesce(approval->>'status','approved'),
      approval->>'final_qbo_account_id',approval->>'final_qbo_account_name',approval->>'final_canonical_account_key',
      approval->>'confidence',approval->>'reason',p_actor_type,(approval->>'decided_at')::timestamptz,
      (approval->>'updated_at')::timestamptz,nullif(approval->>'post_after','')::timestamptz,
      approval->>'post_error',coalesce(approval->'meta','{}'::jsonb)
    ) ON CONFLICT (business_id,transaction_id) DO UPDATE SET
      status=EXCLUDED.status,final_qbo_account_id=EXCLUDED.final_qbo_account_id,
      final_qbo_account_name=EXCLUDED.final_qbo_account_name,final_canonical_account_key=EXCLUDED.final_canonical_account_key,
      confidence=EXCLUDED.confidence,reason=EXCLUDED.reason,decided_by=EXCLUDED.decided_by,
      decided_at=EXCLUDED.decided_at,updated_at=EXCLUDED.updated_at,post_after=EXCLUDED.post_after,
      post_error=EXCLUDED.post_error,meta=EXCLUDED.meta;

    INSERT INTO public.bookkeeping_approval_events (
      business_id,transaction_id,actor_id,actor_type,resolution,final_qbo_account_id,post_after,idempotency_key,metadata
    ) VALUES (
      p_business_id,(approval->>'transaction_id')::uuid,p_actor_id,p_actor_type,
      coalesce(inflow_decision->>'resolution_type',approval#>>'{meta,user_selected_resolution}','categorize_new'),
      approval->>'final_qbo_account_id',nullif(approval->>'post_after','')::timestamptz,event_key,
      jsonb_build_object('source',coalesce(inflow_decision->>'operator_source','books_review'),
        'posting_generation',approval#>>'{meta,posting_generation}',
        'credit_card_inflow_resolution',inflow_decision,
        'statement_settlement_authority',approval#>'{meta,accounting_review_completed,statement_settlement_authority}')
    ) ON CONFLICT (business_id,idempotency_key) DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT tc.* FROM public.transaction_categorizations tc
    WHERE tc.business_id=p_business_id AND tc.transaction_id IN
      (SELECT (value->>'transaction_id')::uuid FROM jsonb_array_elements(p_approvals));
END; $function$
;
CREATE OR REPLACE FUNCTION public.validate_credit_card_payment_pair_business()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_checking_business_id uuid;
  v_card_business_id uuid;
begin
  select business_id
    into v_checking_business_id
  from public.bank_transactions
  where id = new.checking_transaction_id;

  if v_checking_business_id is distinct from new.business_id then
    raise exception 'credit_card_payment_pair_checking_business_mismatch';
  end if;

  if new.credit_card_transaction_id is not null then
    select business_id
      into v_card_business_id
    from public.bank_transactions
    where id = new.credit_card_transaction_id;

    if v_card_business_id is distinct from new.business_id then
      raise exception 'credit_card_payment_pair_card_business_mismatch';
    end if;
  end if;

  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.refresh_operator_request_summary_after_business_scope_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.refresh_operator_request_summary(new.id);
  return new;
exception
  when others then
    return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.refresh_operator_request_summary(p_business_id uuid)
 RETURNS TABLE(business_id uuid, accounting_needs_review_count integer, outstanding_count integer, answered_awaiting_review_count integer, reconciliation_status text, last_error text, last_reconciled_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_counts record;
begin
  if p_business_id is null then
    raise exception 'missing_business_id';
  end if;

  select *
  into v_counts
  from public.get_operator_request_counts_bounded(p_business_id);

  insert into public.operator_request_summaries as ors (
    business_id,
    accounting_needs_review_count,
    outstanding_count,
    answered_awaiting_review_count,
    reconciliation_status,
    last_error,
    last_reconciled_at,
    updated_at
  )
  values (
    p_business_id,
    greatest(coalesce(v_counts.accounting_needs_review_count, 0), 0)::integer,
    greatest(coalesce(v_counts.outstanding_count, 0), 0)::integer,
    greatest(coalesce(v_counts.answered_awaiting_review_count, 0), 0)::integer,
    'ok',
    null,
    now(),
    now()
  )
  on conflict on constraint operator_request_summaries_pkey do update
    set accounting_needs_review_count = excluded.accounting_needs_review_count,
        outstanding_count = excluded.outstanding_count,
        answered_awaiting_review_count = excluded.answered_awaiting_review_count,
        reconciliation_status = 'ok',
        last_error = null,
        last_reconciled_at = excluded.last_reconciled_at,
        updated_at = excluded.updated_at;

  return query
  select
    ors.business_id,
    ors.accounting_needs_review_count,
    ors.outstanding_count,
    ors.answered_awaiting_review_count,
    ors.reconciliation_status,
    ors.last_error,
    ors.last_reconciled_at,
    ors.created_at,
    ors.updated_at
  from public.operator_request_summaries ors
  where ors.business_id = p_business_id;
exception
  when others then
    insert into public.operator_request_summaries as ors (
      business_id,
      reconciliation_status,
      last_error,
      updated_at
    )
    values (
      p_business_id,
      'error',
      left(sqlerrm, 1000),
      now()
    )
    on conflict on constraint operator_request_summaries_pkey do update
      set reconciliation_status = 'error',
          last_error = left(sqlerrm, 1000),
          updated_at = now();
    raise;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.claim_qbo_posting_intent(p_business_id uuid, p_transaction_id uuid, p_realm_id text, p_qbo_env text, p_qbo_txn_type text, p_request_id text, p_idempotency_key text, p_payload_summary jsonb DEFAULT NULL::jsonb, p_now timestamp with time zone DEFAULT now(), p_lease_seconds integer DEFAULT 600)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.qbo_posted_transactions;
  v_inserted integer := 0;
begin
  if p_business_id is null or p_transaction_id is null then
    raise exception 'missing_posting_identity';
  end if;
  if p_realm_id is null or length(trim(p_realm_id)) = 0 then
    raise exception 'missing_qbo_realm_id';
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 or length(p_request_id) > 50 then
    raise exception 'invalid_qbo_request_id';
  end if;

  insert into public.qbo_posted_transactions (
    business_id,
    transaction_id,
    qbo_env,
    realm_id,
    qbo_txn_type,
    request_id,
    idempotency_key,
    status,
    attempt_count,
    processing_started_at,
    lease_expires_at,
    last_attempt_at,
    payload_summary,
    created_at,
    updated_at
  )
  values (
    p_business_id,
    p_transaction_id,
    coalesce(p_qbo_env, 'production'),
    p_realm_id,
    p_qbo_txn_type,
    p_request_id,
    p_idempotency_key,
    'processing',
    1,
    p_now,
    p_now + make_interval(secs => p_lease_seconds),
    p_now,
    p_payload_summary,
    p_now,
    p_now
  )
  on conflict (business_id, transaction_id) do nothing;
  get diagnostics v_inserted = row_count;

  select *
    into v_row
  from public.qbo_posted_transactions
  where business_id = p_business_id
    and transaction_id = p_transaction_id
  for update;

  if not found then
    raise exception 'posting_intent_claim_failed';
  end if;

  if v_row.status = 'posted' and v_row.qbo_txn_id is not null then
    return jsonb_build_object('claimed', false, 'already_posted', true, 'intent', to_jsonb(v_row));
  end if;

  if v_inserted > 0 then
    return jsonb_build_object('claimed', true, 'already_posted', false, 'intent', to_jsonb(v_row));
  end if;

  if v_row.status = 'processing'
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > p_now
     and coalesce(v_row.request_id, p_request_id) = p_request_id
     and v_row.last_attempt_at is not null
     and v_row.last_attempt_at <> p_now then
    return jsonb_build_object('claimed', false, 'already_posted', false, 'intent', to_jsonb(v_row));
  end if;

  update public.qbo_posted_transactions
     set status = 'processing',
         realm_id = coalesce(realm_id, p_realm_id),
         qbo_env = coalesce(qbo_env, p_qbo_env, 'production'),
         qbo_txn_type = coalesce(qbo_txn_type, p_qbo_txn_type),
         request_id = coalesce(request_id, p_request_id),
         idempotency_key = coalesce(idempotency_key, p_idempotency_key),
         attempt_count = coalesce(attempt_count, 0) + 1,
         processing_started_at = p_now,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         last_attempt_at = p_now,
         payload_summary = coalesce(payload_summary, p_payload_summary),
         updated_at = p_now
   where business_id = p_business_id
     and transaction_id = p_transaction_id
     and (request_id is null or request_id = p_request_id)
  returning * into v_row;

  if not found then
    raise exception 'posting_request_id_mismatch';
  end if;

  return jsonb_build_object('claimed', true, 'already_posted', false, 'intent', to_jsonb(v_row));
end;
$function$
;
CREATE OR REPLACE FUNCTION public.set_internal_staff_users_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.claim_credit_card_payment_pair_posting(p_business_id uuid, p_pair_id uuid, p_request_id text, p_idempotency_key text, p_now timestamp with time zone DEFAULT now(), p_lease_seconds integer DEFAULT 600)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.credit_card_payment_pairs;
begin
  if p_business_id is null or p_pair_id is null then
    raise exception 'missing_cc_payment_pair_identity';
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 or length(p_request_id) > 50 then
    raise exception 'invalid_cc_payment_pair_request_id';
  end if;

  select *
    into v_row
  from public.credit_card_payment_pairs
  where business_id = p_business_id
    and id = p_pair_id
  for update;

  if not found then
    raise exception 'cc_payment_pair_not_found';
  end if;

  if v_row.status = 'posted' and v_row.qbo_txn_id is not null then
    return jsonb_build_object('claimed', false, 'already_posted', true, 'pair', to_jsonb(v_row));
  end if;

  if v_row.status = 'posting'
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > p_now
     and coalesce(v_row.request_id, p_request_id) = p_request_id then
    return jsonb_build_object('claimed', false, 'already_posted', false, 'pair', to_jsonb(v_row));
  end if;

  update public.credit_card_payment_pairs
     set status = 'posting',
         request_id = coalesce(request_id, p_request_id),
         idempotency_key = coalesce(idempotency_key, p_idempotency_key),
         posting_started_at = p_now,
         lease_expires_at = p_now + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 1)),
         last_post_attempt_at = p_now,
         updated_at = p_now
   where business_id = p_business_id
     and id = p_pair_id
     and (request_id is null or request_id = p_request_id)
  returning * into v_row;

  if not found then
    raise exception 'cc_payment_pair_request_id_mismatch';
  end if;

  return jsonb_build_object('claimed', true, 'already_posted', false, 'pair', to_jsonb(v_row));
end;
$function$
;
CREATE OR REPLACE FUNCTION public.confirm_pending_transaction_settled(p_business_id uuid, p_transaction_id uuid, p_actor_user_id uuid, p_actor_label text, p_statement_date date, p_statement_amount numeric, p_reason text, p_idempotency_key text, p_decision_version integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_bank public.bank_transactions%rowtype; v_cat public.transaction_categorizations%rowtype; v_now timestamptz:=now(); v_existing jsonb; v_before jsonb; v_replacement jsonb; v_candidates jsonb; v_provenance text;
begin
  select * into v_bank from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
  if not found then raise exception 'transaction_not_found'; end if;
  select * into v_cat from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id for update;
  if v_bank.pending is not true and v_bank.pending_resolution_state <> 'promoted_to_settled' then raise exception 'transaction_not_pending'; end if;
  if v_cat.qbo_txn_id is not null or v_cat.posted_at is not null or v_cat.reconciled_at is not null or v_cat.status in ('posted','matched','matched_existing_qbo') then raise exception 'transaction_already_accounted'; end if;
  if v_cat.posting_status='posting' or coalesce((v_cat.meta->>'posting_in_progress')::boolean,false) then raise exception 'posting_in_progress'; end if;
  if p_actor_user_id is null then raise exception 'operator_authorization_required'; end if;
  if p_statement_date is null then raise exception 'invalid_statement_date'; end if;
  if p_statement_amount is null or p_statement_amount=0 then raise exception 'invalid_statement_amount'; end if;
  if round(abs(p_statement_amount)::numeric,2) <> round(abs(v_bank.amount)::numeric,2) then raise exception 'statement_amount_mismatch'; end if;
  if exists (select 1 from public.bank_transactions r where r.business_id=p_business_id and r.is_archived=false and r.pending is not true and r.pending_transaction_id=v_bank.plaid_transaction_id and r.id<>v_bank.id) then raise exception 'posted_replacement_exists'; end if;
  select jsonb_build_object('state',resulting_state,'created_at',created_at) into v_existing from public.pending_transaction_resolution_events where business_id=p_business_id and idempotency_key=p_idempotency_key;
  if v_existing is not null then return v_existing || jsonb_build_object('idempotent',true); end if;
  v_before:=jsonb_build_object('pending',v_bank.pending,'pending_resolution_state',v_bank.pending_resolution_state,'accounting_review_required',v_bank.accounting_review_required,'accounting_review_reason',v_bank.accounting_review_reason);
  v_provenance:=case when coalesce((v_bank.raw->>'recovery_imported')::boolean,false) or v_bank.raw->>'plaid_recovery_batch_id' is not null then 'replacement_card_recovery' else coalesce(v_bank.raw->>'canonical_source','normal_sync') end;
  select to_jsonb(r) into v_replacement from public.bank_transactions r where r.business_id=p_business_id and r.is_archived=false and r.pending is not true and r.pending_transaction_id=v_bank.plaid_transaction_id and r.id<>v_bank.id limit 1;
  v_candidates:=coalesce(v_cat.meta->'qbo_duplicate_candidates','[]'::jsonb);
  update public.bank_transactions set pending=false, pending_resolution_state='promoted_to_settled', pending_resolved_at=v_now,
    pending_resolved_by=p_actor_user_id, pending_resolution_payload=jsonb_build_object(
      'original_pending',true,'original_plaid_transaction_id',v_bank.plaid_transaction_id,'original_pending_transaction_id',v_bank.pending_transaction_id,
      'statement_confirmed_date',p_statement_date,'statement_confirmed_amount',p_statement_amount,'operator_note',nullif(trim(p_reason),''),
      'decision_version',p_decision_version,'confirmed_at',v_now,'confirmed_by',p_actor_user_id,'confirmed_by_email',p_actor_label,
      'request_id',p_idempotency_key,'provider_provenance',v_provenance,'provider_last_update',coalesce(v_bank.last_seen_at,v_bank.updated_at),
      'posted_replacement_search',jsonb_build_object('found',v_replacement is not null,'result',v_replacement),
      'qbo_candidate_search',jsonb_build_object('found',jsonb_array_length(v_candidates)>0,'result',v_candidates)
    ), accounting_review_required=true, accounting_review_reason='operator_confirmed_settlement'
    where business_id=p_business_id and id=p_transaction_id;
  insert into public.transaction_categorizations (business_id,transaction_id,status,review_status,posting_status,meta,post_after,updated_at)
    values (p_business_id,p_transaction_id,'needs_review','needs_review','not_scheduled',jsonb_build_object('pending_resolution_state','promoted_to_settled','operator_settlement_confirmation',jsonb_build_object('actor_user_id',p_actor_user_id,'actor_email',p_actor_label,'statement_date',p_statement_date,'statement_amount',p_statement_amount,'operator_note',nullif(trim(p_reason),''),'request_id',p_idempotency_key,'decision_version',p_decision_version,'confirmed_at',v_now)),null,v_now)
    on conflict (business_id,transaction_id) do update set status='needs_review',review_status='needs_review',posting_status='not_scheduled',post_after=null,
      meta=coalesce(public.transaction_categorizations.meta,'{}'::jsonb)||excluded.meta,updated_at=v_now;
  insert into public.pending_transaction_resolution_events (business_id,transaction_id,action,prior_state,resulting_state,actor_user_id,actor_label,reason,evidence,idempotency_key)
    values (p_business_id,p_transaction_id,'confirm_settled_from_statement',coalesce(v_bank.pending_resolution_state,'stale_pending_check_required'),'promoted_to_settled',p_actor_user_id,p_actor_label,p_reason,
      jsonb_build_object('actor_user_id',p_actor_user_id,'actor_email',p_actor_label,'decision_timestamp',v_now,'action_type','confirm_settled_from_statement',
        'statement_date',p_statement_date,'statement_amount',p_statement_amount,'operator_note',nullif(trim(p_reason),''),
        'before_state',v_before,'after_state',jsonb_build_object('pending',false,'pending_resolution_state','promoted_to_settled','accounting_review_required',true,'accounting_review_reason','operator_confirmed_settlement','categorization_status','needs_review','posting_status','not_scheduled'),
        'provider_provenance',v_provenance,'provider_last_update',coalesce(v_bank.last_seen_at,v_bank.updated_at),
        'posted_replacement_search',jsonb_build_object('found',v_replacement is not null,'result',v_replacement),
        'qbo_candidate_search',jsonb_build_object('found',jsonb_array_length(v_candidates)>0,'result',v_candidates),
        'business_id',p_business_id,'transaction_id',p_transaction_id,'request_id',p_idempotency_key,'idempotency_key',p_idempotency_key,
        'provider_write',false,'qbo_write',false,'decision_version',p_decision_version),p_idempotency_key);
  return jsonb_build_object('idempotent',false,'state','promoted_to_settled','transaction_id',p_transaction_id);
end $function$
;
CREATE OR REPLACE FUNCTION public.confirm_auto_post_effective_date_scope(p_business_id uuid, p_scope_mode text, p_effective_date date, p_requested_by uuid, p_transaction_ids uuid[], p_preview_total_count integer, p_released_transaction_count integer, p_blocked_transaction_count integer, p_preview_fingerprint text, p_enabled_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_release_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(business_id uuid, auto_post_scope_mode text, auto_post_effective_date date, historical_backlog_status text, release_id uuid, release_status text, preview_total_count integer, released_transaction_count integer, blocked_transaction_count integer, preview_fingerprint text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_business public.business_profiles%rowtype;
  v_release_id uuid;
  v_now timestamptz := timezone('utc'::text, now());
  v_scope_mode text := lower(coalesce(p_scope_mode, ''));
  v_transaction_ids uuid[] := coalesce(p_transaction_ids, '{}'::uuid[]);
begin
  if p_business_id is null then
    raise exception 'missing_business_id' using errcode = '22023';
  end if;

  if v_scope_mode <> 'effective_date' then
    raise exception 'invalid_scope_mode' using errcode = '22023';
  end if;

  if p_effective_date is null then
    raise exception 'invalid_effective_date' using errcode = '22023';
  end if;

  if nullif(trim(coalesce(p_preview_fingerprint, '')), '') is null then
    raise exception 'preview_required' using errcode = '22023';
  end if;

  if coalesce(p_preview_total_count, -1) < 0
     or coalesce(p_released_transaction_count, -1) < 0
     or coalesce(p_blocked_transaction_count, -1) < 0 then
    raise exception 'invalid_preview_counts' using errcode = '22023';
  end if;

  if cardinality(v_transaction_ids) <> coalesce(p_released_transaction_count, 0) then
    raise exception 'released_transaction_count_mismatch' using errcode = '22023';
  end if;

  select *
    into v_business
  from public.business_profiles
  where id = p_business_id
  for update;

  if not found then
    raise exception 'business_not_found' using errcode = '22023';
  end if;

  select id
    into v_release_id
  from public.bookkeeping_auto_post_backlog_releases r
  where r.business_id = p_business_id
    and r.status = 'active'
    and r.preview_fingerprint = p_preview_fingerprint
  limit 1;

  if v_release_id is null then
    insert into public.bookkeeping_auto_post_backlog_releases (
      business_id,
      release_start_date,
      release_end_date,
      transaction_ids,
      status,
      requested_by,
      requested_at,
      release_metadata,
      preview_total_count,
      released_transaction_count,
      blocked_transaction_count,
      preview_fingerprint
    )
    values (
      p_business_id,
      p_effective_date,
      null,
      v_transaction_ids,
      'active',
      p_requested_by,
      v_now,
      coalesce(p_release_metadata, '{}'::jsonb) || jsonb_build_object(
        'preview_fingerprint', p_preview_fingerprint,
        'scope_mode', 'effective_date'
      ),
      coalesce(p_preview_total_count, 0),
      coalesce(p_released_transaction_count, 0),
      coalesce(p_blocked_transaction_count, 0),
      p_preview_fingerprint
    )
    returning id into v_release_id;
  end if;

  update public.business_profiles
  set auto_post_to_quickbooks = true,
      auto_post_enabled_at = coalesce(auto_post_enabled_at, p_enabled_at, v_now),
      auto_post_scope_mode = 'effective_date',
      auto_post_effective_date = p_effective_date,
      historical_backlog_status = 'released',
      backlog_reviewed_at = v_now,
      backlog_reviewed_by = p_requested_by,
      backlog_released_at = v_now,
      backlog_released_by = p_requested_by
  where id = p_business_id;

  return query
  select
    p_business_id,
    'effective_date'::text,
    p_effective_date,
    'released'::text,
    r.id,
    r.status,
    r.preview_total_count,
    r.released_transaction_count,
    r.blocked_transaction_count,
    r.preview_fingerprint
  from public.bookkeeping_auto_post_backlog_releases r
  where r.id = v_release_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.touch_bookkeeping_processing_requests_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.bookkeeping_transaction_matches_status(p_status_filter text, p_status text, p_meta jsonb, p_qbo_txn_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case lower(coalesce(p_status_filter, 'needs_review'))
    when 'approved' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'handled'
    when 'handled' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'handled'
    when 'reconciled' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'matched'
    when 'matched' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'matched'
    when 'posted' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'posted'
    when 'excluded' then public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'excluded'
    when 'pending' then false
    else public.classify_bookkeeping_primary_feed(false,p_status,null,null,p_meta,p_qbo_txn_id,null,null) = 'needs_review'
  end;
$function$
;
CREATE OR REPLACE FUNCTION public.classify_bookkeeping_posting_outcome(p_status text, p_posting_status text, p_post_error text, p_last_post_attempt_at timestamp with time zone, p_post_after timestamp with time zone, p_meta jsonb, p_qbo_txn_id text, p_posted_at timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_qbo_txn_id is not null or p_posted_at is not null or p_posting_status = 'posted' then 'succeeded'
    when p_posting_status = 'posting' or coalesce((p_meta ->> 'posting_in_progress')::boolean, false) then 'processing'
    when p_posting_status = 'scheduled' or p_post_after is not null then 'queued'
    when p_posting_status = 'posting_failed' or lower(coalesce(p_status, '')) in ('failed', 'failed_post', 'post_failed') then 'failed'
    when p_post_error is not null and p_last_post_attempt_at is not null then 'failed'
    when p_post_error is not null or p_meta ->> 'post_block_reason' is not null then 'blocked'
    else 'not_requested'
  end;
$function$
;
CREATE OR REPLACE FUNCTION public.exclude_bookkeeping_transaction(p_business_id uuid, p_transaction_id uuid, p_actor text, p_reason text DEFAULT NULL::text, p_source text DEFAULT 'books_review'::text, p_correlation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bank public.bank_transactions%rowtype;
  v_cat public.transaction_categorizations%rowtype;
  v_prior text;
  v_now timestamptz := now();
  v_meta jsonb;
begin
  select * into v_bank from public.bank_transactions
   where business_id = p_business_id and id = p_transaction_id and is_archived is false
   for update;
  if not found then raise exception 'transaction_not_found'; end if;

  insert into public.bookkeeping_exclusion_events (
    business_id, transaction_id, connected_account_id, event_type, actor, reason, correlation_id
  ) values (p_business_id, p_transaction_id, v_bank.plaid_account_id, 'exclusion_requested', p_actor, p_reason, p_correlation_id);

  select * into v_cat from public.transaction_categorizations
   where business_id = p_business_id and transaction_id = p_transaction_id
   for update;

  if v_cat.status = 'excluded' and v_cat.excluded_at is not null then
    return jsonb_build_object('idempotent', true, 'primary_feed', 'excluded', 'excluded_at', v_cat.excluded_at);
  end if;

  if v_cat.qbo_txn_id is not null or v_cat.posted_at is not null or v_cat.status = 'posted' then
    insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)
    values (p_business_id,p_transaction_id,v_bank.plaid_account_id,'exclusion_rejected_concurrent_processing',p_actor,'posted','posted','authoritative_qbo_receipt',p_correlation_id);
    raise exception 'transaction_already_posted';
  end if;
  if coalesce((v_cat.meta ->> 'posting_in_progress')::boolean, false) or v_cat.posting_status = 'posting' then
    insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)
    values (p_business_id,p_transaction_id,v_bank.plaid_account_id,'exclusion_rejected_concurrent_processing',p_actor,v_cat.status,v_cat.status,'posting_in_progress',p_correlation_id);
    raise exception 'posting_in_progress';
  end if;
  if v_cat.status in ('matched','matched_existing_qbo')
     or v_cat.meta ->> 'incoming_deposit_match_status' = 'confirmed'
     or (v_cat.meta ->> 'cc_payment_pair_id' is not null and v_cat.meta ->> 'cc_payment_pair_status' in ('confirmed','matched','posted')) then
    raise exception 'transaction_already_matched';
  end if;

  v_prior := case when v_bank.pending then 'pending' else coalesce(v_cat.status, 'needs_review') end;
  v_meta := coalesce(v_cat.meta, '{}'::jsonb) || jsonb_build_object(
    'excluded_at', v_now, 'excluded_by', p_actor, 'exclusion_reason', p_reason,
    'exclusion_source', p_source, 'pre_exclusion_lifecycle', v_prior,
    'exclusion_correlation_id', p_correlation_id,
    'exclusion_snapshot', jsonb_build_object('pending',v_bank.pending,'amount',v_bank.amount,'date',v_bank.date,'memo',v_bank.name,'provider_transaction_id',v_bank.plaid_transaction_id,'prior_status',v_cat.status,'prior_posting_status',v_cat.posting_status)
  );

  insert into public.transaction_categorizations (
    business_id, transaction_id, status, review_status, posting_status, meta,
    excluded_at, excluded_by, exclusion_reason, exclusion_source,
    pre_exclusion_lifecycle, exclusion_version, exclusion_snapshot,
    post_after, updated_at
  ) values (
    p_business_id, p_transaction_id, 'excluded', 'handled', 'not_scheduled', v_meta,
    v_now, p_actor, p_reason, p_source, v_prior, 1,
    jsonb_build_object('pending',v_bank.pending,'amount',v_bank.amount,'date',v_bank.date,'memo',v_bank.name,'provider_transaction_id',v_bank.plaid_transaction_id,'prior_status',v_cat.status,'prior_posting_status',v_cat.posting_status),
    null, v_now
  ) on conflict (business_id, transaction_id) do update set
    status='excluded', review_status='handled', posting_status='not_scheduled', meta=excluded.meta,
    excluded_at=excluded.excluded_at, excluded_by=excluded.excluded_by,
    exclusion_reason=excluded.exclusion_reason, exclusion_source=excluded.exclusion_source,
    pre_exclusion_lifecycle=excluded.pre_exclusion_lifecycle,
    exclusion_version=public.transaction_categorizations.exclusion_version + 1,
    exclusion_snapshot=excluded.exclusion_snapshot, post_after=null, updated_at=v_now;

  insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)
  values (p_business_id,p_transaction_id,v_bank.plaid_account_id,'exclusion_completed',p_actor,v_prior,'excluded',p_reason,p_correlation_id);
  return jsonb_build_object('idempotent',false,'primary_feed','excluded','excluded_at',v_now,'previous_feed',v_prior);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.prevent_stale_stripe_entitlement_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if new.stripe_event_created_at_live is not null
     and old.stripe_event_created_at_live is not null
     and new.stripe_event_created_at_live < old.stripe_event_created_at_live then
    new.stripe_customer_id_live := old.stripe_customer_id_live;
    new.stripe_subscription_id_live := old.stripe_subscription_id_live;
    new.subscription_status_live := old.subscription_status_live;
    new.plan_price_id_live := old.plan_price_id_live;
    new.current_period_end_live := old.current_period_end_live;
    new.trial_end_live := old.trial_end_live;
    new.cancel_at_period_end_live := old.cancel_at_period_end_live;
    new.last_invoice_status_live := old.last_invoice_status_live;
    new.canceled_at_live := old.canceled_at_live;
    new.last_invoice_id_live := old.last_invoice_id_live;
    new.last_payment_failed_at_live := old.last_payment_failed_at_live;
    new.plan_type_live := old.plan_type_live;
    new.stripe_event_created_at_live := old.stripe_event_created_at_live;
    new.stripe_event_id_live := old.stripe_event_id_live;
  end if;
  if new.stripe_event_created_at_test is not null
     and old.stripe_event_created_at_test is not null
     and new.stripe_event_created_at_test < old.stripe_event_created_at_test then
    new.stripe_customer_id_test := old.stripe_customer_id_test;
    new.stripe_subscription_id_test := old.stripe_subscription_id_test;
    new.subscription_status_test := old.subscription_status_test;
    new.plan_price_id_test := old.plan_price_id_test;
    new.current_period_end_test := old.current_period_end_test;
    new.trial_end_test := old.trial_end_test;
    new.cancel_at_period_end_test := old.cancel_at_period_end_test;
    new.last_invoice_status_test := old.last_invoice_status_test;
    new.canceled_at_test := old.canceled_at_test;
    new.last_invoice_id_test := old.last_invoice_id_test;
    new.last_payment_failed_at_test := old.last_payment_failed_at_test;
    new.plan_type_test := old.plan_type_test;
    new.stripe_event_created_at_test := old.stripe_event_created_at_test;
    new.stripe_event_id_test := old.stripe_event_id_test;
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.restore_bookkeeping_transaction(p_business_id uuid, p_transaction_id uuid, p_actor text, p_source text DEFAULT 'books_review'::text, p_correlation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bank public.bank_transactions%rowtype;
  v_cat public.transaction_categorizations%rowtype;
  v_destination text;
  v_status text;
  v_meta jsonb;
begin
  select * into v_bank from public.bank_transactions where business_id=p_business_id and id=p_transaction_id and is_archived is false for update;
  if not found then raise exception 'transaction_not_found'; end if;
  select * into v_cat from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id for update;
  if not found or v_cat.excluded_at is null then
    return jsonb_build_object('idempotent',true,'primary_feed',case when v_bank.pending then 'pending' else 'needs_review' end);
  end if;

  v_destination := case
    when v_bank.pending then 'pending'
    when v_cat.qbo_txn_id is not null or v_cat.posted_at is not null then 'posted'
    when v_cat.meta ->> 'incoming_deposit_match_status'='confirmed' then 'matched'
    when v_cat.pre_exclusion_lifecycle in ('approved','auto_approved','handled','failed') and v_cat.final_qbo_account_id is not null then 'handled'
    else 'needs_review' end;
  v_status := case v_destination when 'posted' then 'posted' when 'matched' then 'matched_existing_qbo' when 'handled' then coalesce(nullif(v_cat.exclusion_snapshot->>'prior_status',''),'approved') else 'needs_review' end;
  v_meta := coalesce(v_cat.meta,'{}'::jsonb) - 'excluded_at' - 'excluded_by' - 'exclusion_reason' - 'exclusion_source' - 'pre_exclusion_lifecycle' - 'exclusion_correlation_id';

  update public.transaction_categorizations set status=v_status,
    review_status=case when v_destination in ('handled','posted','matched') then 'handled' else 'needs_review' end,
    posting_status=case when v_destination='posted' then 'posted' else 'not_scheduled' end,
    meta=v_meta, excluded_at=null, excluded_by=null, exclusion_reason=null,
    exclusion_source=null, pre_exclusion_lifecycle=null, post_after=null, updated_at=now()
  where business_id=p_business_id and transaction_id=p_transaction_id;

  insert into public.bookkeeping_exclusion_events (business_id,transaction_id,connected_account_id,event_type,actor,prior_lifecycle,resulting_lifecycle,reason,correlation_id)
  values (p_business_id,p_transaction_id,v_bank.plaid_account_id,'restored',p_actor,'excluded',v_destination,p_source,p_correlation_id);
  return jsonb_build_object('idempotent',false,'primary_feed',v_destination);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.classify_bookkeeping_primary_feed(p_pending boolean, p_status text, p_review_status text, p_posting_status text, p_meta jsonb, p_qbo_txn_id text, p_posted_at timestamp with time zone, p_reconciled_at timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when lower(coalesce(p_status,''))='excluded' or p_meta->>'excluded_at' is not null then 'excluded'
    when coalesce(p_pending,false) then 'pending'
    when (
      lower(coalesce(p_status,''))='matched_existing_qbo'
      or coalesce((p_meta->>'matched_existing_qbo')::boolean,false)
      or p_meta->>'incoming_deposit_match_status'='confirmed'
      or (
        p_meta->>'cc_payment_pair_id' is not null
        and p_meta->>'cc_payment_pair_status' in ('confirmed','matched','posted','auto_approved')
      )
    ) then 'matched'
    when p_posted_at is not null
      or lower(coalesce(p_status,''))='posted'
      or lower(coalesce(p_posting_status,''))='posted'
      or (
        p_qbo_txn_id is not null and (
          p_meta->>'qbo_posting_receipt_id' is not null
          or p_meta->>'merchant_group_operation_id' is not null
          or p_meta->>'post_intent_id' is not null
          or p_meta->'manual_approval'->>'operation_id' is not null
        )
      ) then 'posted'
    when (
      p_meta->>'taxonomy_type'='cc_payment'
      or p_meta->>'cc_payment_pair_id' is not null
      or p_meta->>'cc_payment_bank_qbo_account_id' is not null
      or p_meta->>'cc_payment_cc_qbo_account_id' is not null
    ) then 'needs_review'
    when lower(coalesce(p_review_status,''))='handled'
      or lower(coalesce(p_status,'')) in ('approved','auto_approved','handled','failed','failed_post','post_failed','ignored')
      then 'handled'
    else 'needs_review'
  end;
$function$
;
CREATE OR REPLACE FUNCTION public.prevent_uncontrolled_qbo_realm_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if old.realm_id is not null and new.realm_id is distinct from old.realm_id then
    raise exception 'QBO_COMPANY_REPLACEMENT_REQUIRES_CONTROLLED_SUPPORT_WORKFLOW'
      using errcode = '23000';
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.reject_immutable_financial_evidence_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  raise exception 'immutable_financial_evidence' using errcode = '55000';
end;
$function$
;
CREATE OR REPLACE FUNCTION public.refresh_billing_identity_summary(p_business_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  owner_id uuid;
begin
  if p_business_id is null then
    return;
  end if;

  select bp.user_id
    into owner_id
  from public.business_profiles bp
  where bp.id = p_business_id;

  update public.business_billing bb
  set
    business_name = bp.business_name,
    customer_user_id = bp.user_id,
    customer_email = up.email,
    customer_full_name = coalesce(
      nullif(trim(up.full_name), ''),
      nullif(trim(concat_ws(' ', up.first_name, up.last_name)), '')
    ),
    billing_display_status = public.billing_effective_status(
      bb.subscription_status,
      bb.subscription_status_live,
      bb.subscription_status_test
    ),
    billing_display_plan_type = public.billing_effective_text(
      bb.plan_type,
      bb.plan_type_live,
      bb.plan_type_test
    )
  from public.business_profiles bp
  left join public.user_profiles up on up.id = bp.user_id
  where bb.business_id = p_business_id
    and bp.id = bb.business_id;

  if owner_id is not null then
    with ranked_billing as (
      select
        bb.business_id,
        bp.business_name,
        public.billing_effective_text(
          bb.stripe_customer_id,
          bb.stripe_customer_id_live,
          bb.stripe_customer_id_test
        ) as stripe_customer_id,
        public.billing_effective_text(
          bb.stripe_subscription_id,
          bb.stripe_subscription_id_live,
          bb.stripe_subscription_id_test
        ) as stripe_subscription_id,
        public.billing_effective_status(
          bb.subscription_status,
          bb.subscription_status_live,
          bb.subscription_status_test
        ) as subscription_status,
        public.billing_effective_text(
          bb.plan_type,
          bb.plan_type_live,
          bb.plan_type_test
        ) as plan_type,
        public.billing_effective_timestamptz(
          bb.current_period_end,
          bb.current_period_end_live,
          bb.current_period_end_test
        ) as current_period_end,
        bb.updated_at,
        row_number() over (
          order by
            case public.billing_effective_status(
              bb.subscription_status,
              bb.subscription_status_live,
              bb.subscription_status_test
            )
              when 'active' then 1
              when 'trialing' then 2
              when 'past_due' then 3
              when 'unpaid' then 4
              when 'incomplete' then 5
              when 'incomplete_expired' then 6
              when 'canceled' then 7
              else 8
            end,
            bb.updated_at desc nulls last
        ) as row_rank
      from public.business_billing bb
      join public.business_profiles bp on bp.id = bb.business_id
      where bp.user_id = owner_id
    )
    update public.user_profiles up
    set
      billing_business_id = rb.business_id,
      billing_business_name = rb.business_name,
      billing_stripe_customer_id = rb.stripe_customer_id,
      billing_stripe_subscription_id = rb.stripe_subscription_id,
      billing_subscription_status = rb.subscription_status,
      billing_plan_type = rb.plan_type,
      billing_current_period_end = rb.current_period_end,
      billing_updated_at = rb.updated_at
    from ranked_billing rb
    where up.id = owner_id
      and rb.row_rank = 1;

    insert into public.subscriptions (
      user_id,
      business_id,
      business_name,
      customer_email,
      customer_full_name,
      stripe_customer_id,
      stripe_subscription_id,
      status,
      current_period_end,
      plan_type,
      plan_price_id,
      cancel_at_period_end,
      trial_end,
      last_invoice_status,
      updated_at
    )
    select
      bp.user_id,
      bb.business_id,
      bp.business_name,
      up.email,
      coalesce(
        nullif(trim(up.full_name), ''),
        nullif(trim(concat_ws(' ', up.first_name, up.last_name)), '')
      ),
      public.billing_effective_text(
        bb.stripe_customer_id,
        bb.stripe_customer_id_live,
        bb.stripe_customer_id_test
      ),
      public.billing_effective_text(
        bb.stripe_subscription_id,
        bb.stripe_subscription_id_live,
        bb.stripe_subscription_id_test
      ),
      public.billing_effective_status(
        bb.subscription_status,
        bb.subscription_status_live,
        bb.subscription_status_test
      ),
      public.billing_effective_timestamptz(
        bb.current_period_end,
        bb.current_period_end_live,
        bb.current_period_end_test
      ),
      public.billing_effective_text(
        bb.plan_type,
        bb.plan_type_live,
        bb.plan_type_test
      ),
      public.billing_effective_text(
        bb.plan_price_id,
        bb.plan_price_id_live,
        bb.plan_price_id_test
      ),
      public.billing_effective_bool(
        bb.cancel_at_period_end,
        bb.cancel_at_period_end_live,
        bb.cancel_at_period_end_test
      ),
      public.billing_effective_timestamptz(
        bb.trial_end,
        bb.trial_end_live,
        bb.trial_end_test
      ),
      public.billing_effective_text(
        bb.last_invoice_status,
        bb.last_invoice_status_live,
        bb.last_invoice_status_test
      ),
      coalesce(bb.updated_at, now())
    from public.business_billing bb
    join public.business_profiles bp on bp.id = bb.business_id
    left join public.user_profiles up on up.id = bp.user_id
    where bb.business_id = p_business_id
      and bp.user_id is not null
    on conflict (business_id) do update
    set
      user_id = excluded.user_id,
      business_name = excluded.business_name,
      customer_email = excluded.customer_email,
      customer_full_name = excluded.customer_full_name,
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      plan_type = excluded.plan_type,
      plan_price_id = excluded.plan_price_id,
      cancel_at_period_end = excluded.cancel_at_period_end,
      trial_end = excluded.trial_end,
      last_invoice_status = excluded.last_invoice_status,
      updated_at = excluded.updated_at;
  end if;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.audit_handled_posting_job_invariants(p_business_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(transaction_id uuid, business_id uuid, violation_codes text[])
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select tc.transaction_id, tc.business_id,
    array_remove(array[
      case when j.id is null then 'handled_missing_posting_job' end,
      case when j.state = 'posted' and (j.qbo_txn_id is null or tc.qbo_txn_id is null) then 'posted_without_qbo_reference' end,
      case when j.state in ('scheduled','retry_scheduled') and coalesce(j.next_attempt_at,j.scheduled_at) is null then 'active_job_without_due_time' end,
      case when j.state in ('blocked','failed') and j.blocking_code is null then 'blocked_without_reason' end,
      case when j.state = 'processing' and j.lease_expires_at is null then 'processing_without_lease' end
    ]::text[], null) violation_codes
  from public.transaction_categorizations tc
  left join public.bookkeeping_posting_jobs j
    on j.business_id = tc.business_id and j.transaction_id = tc.transaction_id
  where (p_business_id is null or tc.business_id = p_business_id)
    and public.classify_bookkeeping_primary_feed(
      false, tc.status, tc.review_status, tc.posting_status, tc.meta,
      tc.qbo_txn_id, tc.posted_at, tc.reconciled_at
    ) = 'handled'
    and cardinality(array_remove(array[
      case when j.id is null then 'handled_missing_posting_job' end,
      case when j.state = 'posted' and (j.qbo_txn_id is null or tc.qbo_txn_id is null) then 'posted_without_qbo_reference' end,
      case when j.state in ('scheduled','retry_scheduled') and coalesce(j.next_attempt_at,j.scheduled_at) is null then 'active_job_without_due_time' end,
      case when j.state in ('blocked','failed') and j.blocking_code is null then 'blocked_without_reason' end,
      case when j.state = 'processing' and j.lease_expires_at is null then 'processing_without_lease' end
    ]::text[], null)) > 0;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_bookkeeping_posting_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_feed text;
  v_intent public.qbo_posted_transactions;
  v_state text;
  v_block_code text;
  v_retry_at timestamptz;
  v_attempt_count integer := 0;
begin
  select * into v_intent
  from public.qbo_posted_transactions
  where business_id = new.business_id and transaction_id = new.transaction_id;

  v_feed := public.classify_bookkeeping_primary_feed(
    false, new.status, new.review_status, new.posting_status, new.meta,
    new.qbo_txn_id, new.posted_at, new.reconciled_at
  );

  if new.qbo_txn_id is not null and new.posted_at is not null then
    v_state := 'posted';
  elsif new.excluded_at is not null or coalesce(new.is_archived, false) then
    v_state := 'cancelled';
  elsif v_feed <> 'handled' then
    v_state := 'cancelled';
  elsif v_intent.status = 'posted' and v_intent.qbo_txn_id is not null then
    v_state := 'reconciling';
  elsif v_intent.status = 'processing' and v_intent.lease_expires_at > now() then
    v_state := 'processing';
  elsif lower(coalesce(new.meta->>'posting_in_progress','false')) = 'true'
    and new.last_post_attempt_at > now() - interval '15 minutes' then
    v_state := 'processing';
  elsif new.post_after is not null then
    v_state := case when coalesce(new.meta->>'post_retry_count','') ~ '^[0-9]+$'
      and (new.meta->>'post_retry_count')::integer > 0
      then 'retry_scheduled' else 'scheduled' end;
  elsif new.post_error is not null then
    v_state := 'failed';
  else
    v_state := 'blocked';
  end if;

  v_block_code := coalesce(
    nullif(new.meta->>'post_block_reason',''),
    nullif(new.meta->>'auto_post_block_reason',''),
    nullif(new.post_error,''),
    case
      when new.final_qbo_account_id is null then 'missing_destination_qbo_account'
      when new.post_after is null then 'missing_posting_schedule'
      else null
    end
  );
  begin
    v_retry_at := nullif(new.meta->>'next_post_attempt_at','')::timestamptz;
  exception when others then
    v_retry_at := null;
    v_block_code := coalesce(v_block_code, 'invalid_retry_timestamp');
  end;
  begin
    v_attempt_count := greatest(
      coalesce(nullif(new.meta->>'post_retry_count','')::integer, 0),
      coalesce(v_intent.attempt_count, 0)
    );
  exception when others then
    v_attempt_count := coalesce(v_intent.attempt_count, 0);
    v_block_code := coalesce(v_block_code, 'invalid_retry_count');
    if v_state not in ('posted','cancelled') then v_state := 'blocked'; end if;
  end;

  insert into public.bookkeeping_posting_jobs (
    business_id, transaction_id, state, scheduled_at, next_attempt_at,
    attempt_count, lease_expires_at, blocking_code, blocking_detail,
    last_error_code, last_error_message, qbo_intent_id, qbo_request_id,
    qbo_txn_id, qbo_txn_type, updated_at
  ) values (
    new.business_id, new.transaction_id, v_state, new.post_after, v_retry_at,
    v_attempt_count, v_intent.lease_expires_at,
    case when v_state in ('blocked','failed') then v_block_code else null end,
    case when v_state in ('blocked','failed') then new.post_error else null end,
    case when new.post_error is not null then coalesce(v_block_code, 'qbo_post_failed') else null end,
    new.post_error, v_intent.id, v_intent.request_id,
    coalesce(new.qbo_txn_id, v_intent.qbo_txn_id),
    coalesce(new.qbo_txn_type, v_intent.qbo_txn_type), now()
  )
  on conflict (business_id, transaction_id) do update set
    state = excluded.state,
    scheduled_at = excluded.scheduled_at,
    next_attempt_at = excluded.next_attempt_at,
    attempt_count = excluded.attempt_count,
    lease_expires_at = excluded.lease_expires_at,
    blocking_code = excluded.blocking_code,
    blocking_detail = excluded.blocking_detail,
    last_error_code = excluded.last_error_code,
    last_error_message = excluded.last_error_message,
    qbo_intent_id = excluded.qbo_intent_id,
    qbo_request_id = excluded.qbo_request_id,
    qbo_txn_id = excluded.qbo_txn_id,
    qbo_txn_type = excluded.qbo_txn_type,
    updated_at = now();
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.release_plaid_sync_lease(p_business_id uuid, p_item_id uuid, p_owner text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare affected_rows integer;
begin
  update public.plaid_items
     set sync_in_progress = false, sync_started_at = null,
         sync_lease_owner = null, sync_lease_acquired_at = null, sync_lease_expires_at = null
   where id = p_item_id and business_id = p_business_id and sync_lease_owner = p_owner;
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end $function$
;
CREATE OR REPLACE FUNCTION public.claim_plaid_sync_lease(p_business_id uuid, p_item_id uuid, p_owner text, p_ttl_seconds integer DEFAULT 300)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare affected_rows integer;
begin
  update public.plaid_items
     set sync_in_progress = true,
         sync_started_at = now(),
         sync_lease_owner = p_owner,
         sync_lease_acquired_at = now(),
         sync_lease_expires_at = now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 1800)))
   where id = p_item_id and business_id = p_business_id
     and (
       (sync_lease_owner is null and (coalesce(sync_in_progress, false) = false or sync_started_at is null or sync_started_at + make_interval(secs => greatest(30, least(p_ttl_seconds, 1800))) <= now()))
       or sync_lease_expires_at <= now()
       or sync_lease_owner = p_owner
     );
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end $function$
;
CREATE OR REPLACE FUNCTION public.confirm_plaid_replacement_account_lineage(p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_candidate_id uuid, p_prior_plaid_account_id text, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_candidate public.plaid_replacement_account_candidates%rowtype;
  v_prior public.plaid_accounts%rowtype;
  v_mapping public.plaid_qbo_account_mappings%rowtype;
  v_now timestamptz := now();
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  select * into v_candidate from public.plaid_replacement_account_candidates
   where id = p_candidate_id and business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_item_id = p_plaid_item_id for update;
  if not found then raise exception 'replacement_candidate_not_found'; end if;

  select * into v_prior from public.plaid_accounts
   where business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_account_id = p_prior_plaid_account_id and is_active is true;
  if not found or v_prior.physical_account_id is null then raise exception 'prior_account_not_found'; end if;

  select * into v_mapping from public.plaid_qbo_account_mappings
   where business_id = p_business_id and plaid_account_id = p_prior_plaid_account_id;
  if not found or v_mapping.qbo_account_id is null then raise exception 'prior_account_qbo_mapping_required'; end if;

  if exists(select 1 from public.plaid_accounts where business_id=p_business_id and plaid_account_id=v_candidate.plaid_account_id
      and (plaid_env is distinct from p_plaid_env or (physical_account_id is not null and physical_account_id<>v_prior.physical_account_id)))
    or exists(select 1 from public.plaid_qbo_account_mappings where business_id=p_business_id and plaid_account_id=v_candidate.plaid_account_id
      and qbo_account_id is distinct from v_mapping.qbo_account_id) then
    raise exception 'plaid_recovery_existing_ledger_identity_conflict'; end if;

  insert into public.plaid_accounts (
    business_id, plaid_item_id, plaid_env, plaid_account_id, physical_account_id,
    name, official_name, mask, type, subtype, is_active, connected_at, updated_at,
    relink_status, relink_confidence, relink_candidate_ids
  ) values (
    p_business_id, p_plaid_item_id, p_plaid_env, v_candidate.plaid_account_id, v_prior.physical_account_id,
    coalesce(v_candidate.account_snapshot->>'name', v_candidate.account_snapshot->>'official_name', 'Replacement account'),
    v_candidate.account_snapshot->>'official_name', v_candidate.account_snapshot->>'mask',
    v_candidate.account_snapshot->>'type', v_candidate.account_snapshot->>'subtype', true, v_now, v_now,
    'linked_existing', 'confirmed', '{}'::uuid[]
  ) on conflict (business_id, plaid_account_id) do update set
    physical_account_id = excluded.physical_account_id, plaid_item_id = excluded.plaid_item_id,
    plaid_env = excluded.plaid_env, is_active = true, relink_status = 'linked_existing',
    relink_confidence = 'confirmed', updated_at = v_now;

  insert into public.plaid_qbo_account_mappings (
    business_id, plaid_account_id, qbo_account_id, qbo_account_name, qbo_account_type, source, confidence
  ) values (
    p_business_id, v_candidate.plaid_account_id, v_mapping.qbo_account_id,
    v_mapping.qbo_account_name, v_mapping.qbo_account_type, 'manual', 'high'
  ) on conflict (business_id, plaid_account_id) do update set
    qbo_account_id = excluded.qbo_account_id, qbo_account_name = excluded.qbo_account_name,
    qbo_account_type = excluded.qbo_account_type, source = excluded.source, confidence = excluded.confidence;

  insert into public.plaid_account_lineage_decisions (
    business_id, plaid_env, physical_account_id, prior_plaid_account_id,
    replacement_plaid_account_id, qbo_account_id, status, source, actor_user_id, metadata
  ) values (
    p_business_id, p_plaid_env, v_prior.physical_account_id, p_prior_plaid_account_id,
    v_candidate.plaid_account_id, v_mapping.qbo_account_id, 'confirmed', 'settings_replacement_recovery',
    p_actor_user_id, jsonb_build_object('candidate_id', p_candidate_id, 'plaid_item_id', p_plaid_item_id)
  ) on conflict (business_id, plaid_env, replacement_plaid_account_id) do nothing;

  update public.plaid_replacement_account_candidates set status = 'confirmed', decided_at = v_now, decided_by = p_actor_user_id
   where id = p_candidate_id and business_id = p_business_id;

  return jsonb_build_object('status','confirmed','candidate_id',p_candidate_id,
    'replacement_plaid_account_id',v_candidate.plaid_account_id,'prior_plaid_account_id',p_prior_plaid_account_id,
    'qbo_account_id',v_mapping.qbo_account_id);
end $function$
;
CREATE OR REPLACE FUNCTION public.bootstrap_plaid_replacement_recovery(p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_item public.plaid_items%rowtype;
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  select * into v_item from public.plaid_items where business_id = p_business_id and plaid_env = p_plaid_env
    and plaid_item_id = p_plaid_item_id and is_active is true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  if v_item.replacement_recovery_status is null then
    update public.plaid_items set replacement_recovery_status = 'awaiting_account_selection',
      replacement_recovery_bootstrapped_at = now(),
      replacement_recovery_bootstrapped_by = p_actor_user_id, updated_at = now() where id = v_item.id;
    return jsonb_build_object('status','awaiting_account_selection','cutoff_date',v_item.replacement_recovery_cutoff_date,'reused',false);
  end if;
  return jsonb_build_object('status',v_item.replacement_recovery_status,
    'cutoff_date',v_item.replacement_recovery_cutoff_date,'reused',true);
end $function$
;
CREATE OR REPLACE FUNCTION public.select_plaid_replacement_recovery_account(p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_plaid_account_id text, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_item public.plaid_items%rowtype; v_account public.plaid_accounts%rowtype;
  v_mapping public.plaid_qbo_account_mappings%rowtype; v_candidate_id uuid;
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  select * into v_item from public.plaid_items where business_id = p_business_id and plaid_env = p_plaid_env
    and plaid_item_id = p_plaid_item_id and is_active is true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  select * into v_account from public.plaid_accounts where business_id = p_business_id and plaid_env = p_plaid_env
    and plaid_item_id = p_plaid_item_id and plaid_account_id = p_plaid_account_id and is_active is true;
  if not found then raise exception 'replacement_account_not_found'; end if;
  select * into v_mapping from public.plaid_qbo_account_mappings where business_id = p_business_id
    and plaid_account_id = p_plaid_account_id;
  if not found or v_mapping.qbo_account_id is null then raise exception 'replacement_account_qbo_mapping_required'; end if;
  insert into public.plaid_replacement_account_candidates
    (business_id,plaid_env,plaid_item_id,plaid_account_id,account_snapshot,status,decided_at,decided_by)
  values (p_business_id,p_plaid_env,p_plaid_item_id,p_plaid_account_id,
    jsonb_build_object('name',v_account.name,'official_name',v_account.official_name,'mask',v_account.mask,
      'type',v_account.type,'subtype',v_account.subtype,'qbo_account_id',v_mapping.qbo_account_id,
      'qbo_account_name',v_mapping.qbo_account_name,'qbo_account_type',v_mapping.qbo_account_type),
    'pending',null,null)
  on conflict (business_id,plaid_env,plaid_item_id,plaid_account_id) do update set
    account_snapshot = excluded.account_snapshot, status = 'pending', decided_at = null, decided_by = null
  returning id into v_candidate_id;
  update public.plaid_items set replacement_recovery_status = 'lineage_confirmation_required',
    replacement_recovery_account_id = p_plaid_account_id,
    replacement_recovery_selected_at = now(), replacement_recovery_selected_by = p_actor_user_id, updated_at = now()
    where id = v_item.id;
  return jsonb_build_object('status','lineage_confirmation_required','candidate_id',v_candidate_id,
    'plaid_account_id',p_plaid_account_id,'qbo_account_id',v_mapping.qbo_account_id);
end $function$
;
CREATE OR REPLACE FUNCTION public.begin_plaid_recovery_preview_rebuild(p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_batch_id uuid, p_actor_user_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item public.plaid_items%rowtype;
  v_old public.plaid_recovery_batches%rowtype;
  v_existing public.plaid_recovery_batches%rowtype;
  v_expected integer;
  v_staged integer;
  v_admitted integer;
  v_imported integer;
  v_attempts integer;
  v_candidate public.plaid_replacement_account_candidates%rowtype;
  v_lineage public.plaid_account_lineage_decisions%rowtype;
  v_mapping public.plaid_qbo_account_mappings%rowtype;
  v_new_id uuid := gen_random_uuid();
begin
  if nullif(trim(p_idempotency_key), '') is null then raise exception 'recovery_rebuild_idempotency_required'; end if;
  if p_batch_id <> 'b551bd2e-8921-4440-a151-cc70721beb31'::uuid then
    raise exception 'recovery_rebuild_unrelated_batch';
  end if;
  select * into v_item from public.plaid_items
   where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id and is_active=true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  if p_business_id <> 'cffc2183-e77c-4148-a206-d5192e090925'::uuid
     or p_plaid_item_id <> '4KNZYd1xn4fZeBMob4RYTwZvwO9ezVSAEwrXe' then
    raise exception 'recovery_rebuild_scope_mismatch';
  end if;
  if v_item.replacement_recovery_status <> 'ready_for_preview'
     or v_item.replacement_recovery_account_id is null
     or v_item.replacement_recovery_cutoff_date <> date '2026-08-27' then
    raise exception 'recovery_rebuild_lineage_not_ready';
  end if;
  select * into v_candidate from public.plaid_replacement_account_candidates
   where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id
     and plaid_account_id=v_item.replacement_recovery_account_id and status='confirmed';
  if not found then raise exception 'recovery_rebuild_lineage_not_confirmed'; end if;
  select * into v_lineage from public.plaid_account_lineage_decisions
   where business_id=p_business_id and plaid_env=p_plaid_env
     and replacement_plaid_account_id=v_item.replacement_recovery_account_id and status='confirmed';
  if not found then raise exception 'recovery_rebuild_lineage_not_confirmed'; end if;
  select * into v_mapping from public.plaid_qbo_account_mappings
   where business_id=p_business_id and plaid_account_id=v_item.replacement_recovery_account_id;
  if not found or v_mapping.qbo_account_id <> v_lineage.qbo_account_id then
    raise exception 'recovery_rebuild_mapping_changed';
  end if;

  select * into v_existing from public.plaid_recovery_batches
   where business_id=p_business_id and rebuild_idempotency_key=p_idempotency_key limit 1;
  if found then return jsonb_build_object('batch_id',v_existing.id,'status',v_existing.status,'created',false,'source_batch_id',v_existing.rebuild_source_batch_id); end if;

  select * into v_old from public.plaid_recovery_batches
   where id=p_batch_id and business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id for update;
  if not found then raise exception 'recovery_rebuild_batch_not_found'; end if;
  if v_old.status not in ('preview_ready','failed','abandoned') then raise exception 'recovery_rebuild_batch_not_incomplete'; end if;
  v_expected := coalesce((v_old.summary->>'new_after_cutoff')::integer,(v_old.summary->>'genuinely_new')::integer,0);
  if v_expected <> 113 then raise exception 'recovery_rebuild_expected_count_changed'; end if;
  select count(*) into v_staged from public.plaid_recovery_batch_rows where batch_id=v_old.id and disposition='new_after_cutoff';
  select count(*) into v_admitted from public.plaid_recovery_batch_rows where batch_id=v_old.id and admitted_transaction_id is not null;
  select count(*) into v_imported from public.bank_transactions where business_id=p_business_id and plaid_recovery_batch_id=v_old.id;
  if v_staged <> 0 or v_admitted <> 0 or v_imported <> 0 then raise exception 'recovery_rebuild_batch_has_admission'; end if;
  if v_item.cursor is distinct from v_old.original_cursor then raise exception 'recovery_rebuild_cursor_committed'; end if;
  if exists (select 1 from public.plaid_recovery_batches b where b.business_id=p_business_id and b.plaid_env=p_plaid_env
    and b.plaid_item_id=p_plaid_item_id and b.created_at>v_old.created_at and b.status in ('preview_ready','lineage_confirmation_required','imported_held','released'))
  then raise exception 'recovery_rebuild_newer_batch_exists'; end if;

  if v_old.status <> 'abandoned' then
    update public.plaid_recovery_batches set status='abandoned', abandoned_at=now(), abandoned_by=p_actor_user_id,
      failure_code='eligible_rows_not_staged', failure_detail='Preview summary had 113 eligible rows but no durable transaction details.', updated_at=now()
    where id=v_old.id and status in ('preview_ready','failed');
    if not found then raise exception 'recovery_rebuild_compare_and_swap_failed'; end if;
  end if;

  select * into v_existing from public.plaid_recovery_batches where business_id=p_business_id and rebuild_source_batch_id=v_old.id
    and status in ('staging','preview_ready','lineage_confirmation_required','imported_held') order by created_at desc limit 1;
  if found then return jsonb_build_object('batch_id',v_existing.id,'status',v_existing.status,'created',false,'source_batch_id',v_old.id); end if;

  select count(*) into v_attempts from public.plaid_recovery_batches
   where business_id=p_business_id and rebuild_source_batch_id=v_old.id;
  if v_attempts >= 3 then raise exception 'recovery_rebuild_retry_limit_reached'; end if;

  insert into public.plaid_recovery_batches(id,business_id,plaid_env,plaid_item_id,original_cursor,cutoff_date,status,posting_hold,summary,created_by,rebuild_source_batch_id,rebuild_idempotency_key)
  values(v_new_id,p_business_id,p_plaid_env,p_plaid_item_id,v_old.original_cursor,v_old.cutoff_date,'staging',true,
    jsonb_build_object('rebuild_previous_expected_count',v_expected),p_actor_user_id,v_old.id,p_idempotency_key);
  return jsonb_build_object('batch_id',v_new_id,'status','staging','created',true,'source_batch_id',v_old.id,'previous_expected_count',v_expected);
end $function$
;
CREATE OR REPLACE FUNCTION public.confirm_plaid_replacement_lineage_and_advance(p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_candidate_id uuid, p_prior_plaid_account_id text, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_result jsonb; affected integer; v_replacement_account_id text;
  v_item public.plaid_items%rowtype;
  v_candidate public.plaid_replacement_account_candidates%rowtype;
  v_prior public.plaid_accounts%rowtype;
  v_physical_account_id uuid;
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  select * into v_item from public.plaid_items
   where business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_item_id = p_plaid_item_id and is_active is true for update;
  if not found then raise exception 'plaid_item_not_found'; end if;
  select * into v_candidate from public.plaid_replacement_account_candidates
   where id = p_candidate_id and business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_item_id = p_plaid_item_id for update;
  if not found then raise exception 'replacement_candidate_not_found'; end if;
  select * into v_prior from public.plaid_accounts
   where business_id = p_business_id and plaid_env = p_plaid_env
     and plaid_account_id = p_prior_plaid_account_id and is_active is true for update;
  if not found then raise exception 'prior_account_not_found'; end if;

  -- A retained Plaid account ID can legitimately predate canonical physical-account
  -- backfill. Establish that identity only after the operator explicitly confirms
  -- that the selected account represents itself; never infer it from the mask.
  if v_prior.physical_account_id is null
     and v_candidate.plaid_account_id = p_prior_plaid_account_id then
    insert into public.plaid_physical_accounts (
      business_id, plaid_env, institution_name, account_mask, account_type,
      account_subtype, normalized_account_name, current_plaid_item_id,
      current_plaid_account_id, confidence, status, needs_confirmation, metadata
    ) values (
      p_business_id, p_plaid_env, v_item.institution_name, v_prior.mask,
      v_prior.type, v_prior.subtype, lower(trim(coalesce(v_prior.official_name,v_prior.name,'account'))),
      p_plaid_item_id, v_prior.plaid_account_id, 'manual', 'active', false,
      jsonb_build_object('source','settings_replacement_recovery_explicit_retained_identity',
        'candidate_id',p_candidate_id,'confirmed_by',p_actor_user_id)
    ) returning id into v_physical_account_id;
    update public.plaid_accounts set physical_account_id = v_physical_account_id,
      relink_status = 'linked_existing', relink_confidence = 'confirmed', updated_at = now()
     where business_id = p_business_id and plaid_env = p_plaid_env
       and plaid_account_id = p_prior_plaid_account_id;
  end if;

  v_result := public.confirm_plaid_replacement_account_lineage(
    p_business_id, p_plaid_env, p_plaid_item_id, p_candidate_id,
    p_prior_plaid_account_id, p_actor_user_id
  );
  v_replacement_account_id := v_result->>'replacement_plaid_account_id';
  update public.plaid_items set replacement_recovery_status = 'ready_for_preview', replacement_recovery_account_id=v_replacement_account_id, updated_at = now()
   where business_id = p_business_id and plaid_env = p_plaid_env and plaid_item_id = p_plaid_item_id
     and is_active is true;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'lineage_state_persistence_failed'; end if;
  update public.plaid_items set reconnect_state=reconnect_state||jsonb_build_object('state','identity_confirmed',
    'confirmed_by',p_actor_user_id,'confirmed_at',now()) where id=v_item.id;
  return v_result || jsonb_build_object('orchestration_status','ready_for_preview');
end $function$
;
CREATE OR REPLACE FUNCTION public.link_pending_transaction_replacement(p_business_id uuid, p_transaction_id uuid, p_replacement_transaction_id uuid, p_actor_user_id uuid, p_actor_label text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_pending public.bank_transactions%rowtype; v_replacement public.bank_transactions%rowtype; v_existing jsonb;
begin
  select * into v_pending from public.bank_transactions where business_id=p_business_id and id=p_transaction_id for update;
  select * into v_replacement from public.bank_transactions where business_id=p_business_id and id=p_replacement_transaction_id for update;
  if v_pending.id is null or v_replacement.id is null then raise exception 'transaction_not_found'; end if;
  if v_pending.pending is not true or v_replacement.pending is true or v_replacement.pending_transaction_id is distinct from v_pending.plaid_transaction_id then raise exception 'replacement_not_verified'; end if;
  select jsonb_build_object('state',resulting_state,'created_at',created_at) into v_existing from public.pending_transaction_resolution_events where business_id=p_business_id and idempotency_key=p_idempotency_key;
  if v_existing is not null then return v_existing || jsonb_build_object('idempotent',true); end if;
  update public.bank_transactions set is_archived=true,archived_at=now(),archived_reason='linked_to_posted_replacement',pending_resolution_state='linked_to_posted_replacement',pending_resolved_at=now(),pending_resolved_by=p_actor_user_id,
    pending_resolution_payload=coalesce(pending_resolution_payload,'{}'::jsonb)||jsonb_build_object('replacement_transaction_id',v_replacement.id,'replacement_plaid_transaction_id',v_replacement.plaid_transaction_id)
    where id=v_pending.id and business_id=p_business_id;
  insert into public.pending_transaction_resolution_events (business_id,transaction_id,action,prior_state,resulting_state,actor_user_id,actor_label,evidence,idempotency_key)
    values (p_business_id,v_pending.id,'use_posted_replacement',coalesce(v_pending.pending_resolution_state,'posted_replacement_found'),'linked_to_posted_replacement',p_actor_user_id,p_actor_label,jsonb_build_object('replacement_transaction_id',v_replacement.id),p_idempotency_key);
  return jsonb_build_object('idempotent',false,'state','linked_to_posted_replacement','replacement_transaction_id',v_replacement.id);
end $function$
;
CREATE OR REPLACE FUNCTION public.invalidate_reporting_config_on_qbo_realm_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if new.is_active is true and new.status = 'active' and new.realm_id is not null then
    update public.business_financial_reporting_config
      set status='invalidated', verified_at=null, invalidated_at=now(),
          invalidation_reason='active_qbo_realm_changed', updated_at=now()
      where business_id=new.business_id and status='verified' and qbo_realm_id is distinct from new.realm_id;
    if found then
      insert into public.business_financial_reporting_config_audit(
        business_id,request_id,action,previous_status,resulting_status,verification_source,details
      ) values (
        new.business_id,gen_random_uuid(),'invalidate','verified','invalidated','qbo_realm_change_trigger',
        jsonb_build_object('new_realm_id',new.realm_id)
      );
    end if;
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.set_plaid_account_connection_state(p_business_id uuid, p_plaid_account_id text, p_next_state text, p_actor_user_id uuid, p_request_id text, p_source text, p_expected_version bigint DEFAULT NULL::bigint)
 RETURNS TABLE(plaid_account_id text, plaid_item_id text, connection_state text, connection_state_version bigint, disconnected_at timestamp with time zone, reconnected_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_account public.plaid_accounts%rowtype;
  v_item public.plaid_items%rowtype;
  v_now timestamptz := now();
begin
  if p_next_state not in ('connected', 'disconnected') then
    raise exception 'unsupported_account_connection_state';
  end if;
  if p_actor_user_id is null or coalesce(trim(p_request_id), '') = '' then
    raise exception 'account_connection_actor_and_request_required';
  end if;

  select * into v_account from public.plaid_accounts
   where business_id = p_business_id and plaid_account_id = p_plaid_account_id
   for update;
  if not found then raise exception 'plaid_account_not_found'; end if;
  if exists (
    select 1 from public.plaid_account_connection_audit audit
    where audit.business_id = p_business_id
      and audit.plaid_account_id = p_plaid_account_id
      and audit.request_id = p_request_id
  ) then
    return query select pa.plaid_account_id, pa.plaid_item_id, pa.connection_state,
      pa.connection_state_version, pa.disconnected_at, pa.reconnected_at
    from public.plaid_accounts pa
    where pa.business_id = p_business_id and pa.plaid_account_id = p_plaid_account_id;
    return;
  end if;
  if p_expected_version is not null and v_account.connection_state_version <> p_expected_version then
    raise exception 'account_connection_state_version_conflict';
  end if;

  select * into v_item from public.plaid_items
   where business_id = p_business_id and plaid_env = v_account.plaid_env
     and plaid_item_id = v_account.plaid_item_id;
  if not found then raise exception 'plaid_item_not_found'; end if;
  if p_next_state = 'connected' and
     (v_item.is_active is false or v_item.status = 'disconnected' or v_item.plaid_access_token is null) then
    raise exception 'plaid_item_relink_required';
  end if;

  insert into public.plaid_account_connection_audit (
    business_id, plaid_account_id, plaid_item_id, plaid_env, previous_state,
    next_state, actor_user_id, action_type, source, request_id
  ) values (
    p_business_id, v_account.plaid_account_id, v_account.plaid_item_id, v_account.plaid_env,
    jsonb_build_object('connection_state', v_account.connection_state, 'is_active', v_account.is_active,
      'disconnected_at', v_account.disconnected_at, 'connection_state_version', v_account.connection_state_version),
    p_next_state, p_actor_user_id,
    case when p_next_state = 'connected' then 'account_reconnected' else 'account_disconnected' end,
    coalesce(nullif(trim(p_source), ''), 'settings_integrations'), p_request_id
  ) on conflict (business_id, plaid_account_id, request_id) do nothing;

  if p_next_state = 'connected' then
    update public.plaid_accounts set connection_state = 'connected', is_active = true,
      disconnected_at = null, disconnected_by = null, reconnected_at = v_now,
      reconnected_by = p_actor_user_id, connection_state_version = connection_state_version + 1,
      updated_at = v_now
     where business_id = p_business_id and plaid_account_id = p_plaid_account_id
       and (connection_state <> 'connected' or is_active is false or disconnected_at is not null);
  else
    update public.plaid_accounts set connection_state = 'disconnected', is_active = false,
      disconnected_at = coalesce(disconnected_at, v_now), disconnected_by = p_actor_user_id,
      disconnect_metadata = jsonb_build_object('source', coalesce(nullif(trim(p_source), ''), 'settings_integrations'),
        'request_id', p_request_id, 'previous_state', v_account.connection_state),
      sync_gap_started_at = coalesce(sync_gap_started_at, v_now),
      connection_state_version = connection_state_version + 1, updated_at = v_now
     where business_id = p_business_id and plaid_account_id = p_plaid_account_id
       and (connection_state <> 'disconnected' or is_active is true or disconnected_at is null);
  end if;

  return query select pa.plaid_account_id, pa.plaid_item_id, pa.connection_state,
    pa.connection_state_version, pa.disconnected_at, pa.reconnected_at
  from public.plaid_accounts pa
  where pa.business_id = p_business_id and pa.plaid_account_id = p_plaid_account_id;
end $function$
;
CREATE OR REPLACE FUNCTION public.tax_vehicle_serialize_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare b uuid;
begin
 if tg_op='DELETE' then b:=old.business_id; else b:=new.business_id;end if;
 if tg_op='UPDATE' and old.business_id is distinct from new.business_id then raise exception 'business_scope_immutable' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(b::text||':vehicle-election',0));
 if tg_op='DELETE' then return old;end if;return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.ensure_plaid_transaction_categorizations(p_business_id uuid, p_transaction_ids uuid[])
 RETURNS TABLE(expected_count integer, categorization_count integer, inserted_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_expected integer;
  v_before integer;
  v_after integer;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'plaid_categorization_business_required';
  end if;

  select count(*) into v_expected
  from (select distinct unnest(coalesce(p_transaction_ids, '{}'::uuid[])) id) requested;

  if v_expected = 0 then
    return query select 0, 0, 0;
    return;
  end if;

  if (select count(*) from public.bank_transactions bt
      where bt.business_id = p_business_id and bt.id = any(p_transaction_ids)) <> v_expected then
    raise exception using errcode = '23503', message = 'plaid_categorization_transaction_scope_mismatch';
  end if;

  select count(*) into v_before
  from public.transaction_categorizations tc
  where tc.business_id = p_business_id and tc.transaction_id = any(p_transaction_ids);

  insert into public.transaction_categorizations (
    business_id, transaction_id, status, post_after, post_error,
    accounting_review_required, accounting_review_reason, meta
  )
  select
    bt.business_id,
    bt.id,
    'needs_review',
    null,
    case when bt.accounting_review_required then coalesce(bt.accounting_review_reason, 'plaid_accounting_review_required') else null end,
    coalesce(bt.accounting_review_required, false),
    bt.accounting_review_reason,
    case when bt.accounting_review_required then jsonb_build_object(
      'post_block_reason', coalesce(bt.accounting_review_reason, 'plaid_accounting_review_required'),
      'plaid_duplicate_review_required', true,
      'plaid_duplicate_review_payload', bt.accounting_review_payload
    ) else '{}'::jsonb end
  from public.bank_transactions bt
  where bt.business_id = p_business_id and bt.id = any(p_transaction_ids)
  on conflict (business_id, transaction_id) do nothing;

  -- Existing decisions, exclusions, matches, receipts and recovery holds are
  -- authoritative. Review annotations are written separately by sync; admission
  -- must not reset lifecycle state or resurrect removed transactions.

  select count(*) into v_after
  from public.transaction_categorizations tc
  where tc.business_id = p_business_id and tc.transaction_id = any(p_transaction_ids);

  if v_after <> v_expected then
    raise exception using errcode = 'P0001', message = 'plaid_categorization_persistence_incomplete';
  end if;

  return query select v_expected, v_after, v_after - v_before;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.complete_plaid_sync_admission(p_business_id uuid, p_item_id uuid, p_run_id uuid, p_worker_id text, p_original_cursor text, p_next_cursor text, p_transaction_ids uuid[], p_completed_at timestamp with time zone, p_added_count integer, p_modified_count integer, p_removed_count integer, p_mutation_restarts integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_item public.plaid_items%rowtype;
  v_ids uuid[];
  v_admitted integer;
  v_table text; v_column text; v_constraint text; v_message text;
  v_stage text := 'checkpoint_scope';
begin
  select * into v_item from public.plaid_items
   where id = p_item_id and business_id = p_business_id for update;
  if not found or v_item.is_active is false
     or v_item.sync_lease_owner is distinct from p_worker_id
     or v_item.sync_lease_expires_at is null
     or v_item.sync_lease_expires_at <= clock_timestamp()
     or v_item.cursor is distinct from p_original_cursor then
    raise exception using errcode = '40001', message = 'plaid_checkpoint_scope_or_lease_conflict';
  end if;
  perform 1 from public.bank_sync_runs where id = p_run_id
    and business_id = p_business_id and plaid_item_id = v_item.plaid_item_id
    and worker_id = p_worker_id and status = 'running' for update;
  if not found then
    raise exception using errcode = '40001', message = 'plaid_running_attempt_required';
  end if;
  select coalesce(array_agg(distinct id), '{}'::uuid[]) into v_ids
    from unnest(coalesce(p_transaction_ids, '{}'::uuid[])) id;
  if exists (select 1 from unnest(v_ids) requested(id)
    left join public.bank_transactions bt on bt.id = requested.id
      and bt.business_id = p_business_id and bt.plaid_item_id = v_item.plaid_item_id
      and bt.plaid_env = v_item.plaid_env
    where bt.id is null) then
    raise exception using errcode = '23503', message = 'plaid_admission_transaction_scope_mismatch';
  end if;

  v_stage := 'categorization_persistence';
  perform public.ensure_plaid_transaction_categorizations(p_business_id, v_ids);
  v_stage := 'processing_admission';
  -- A worker may already have read an older generation. Merely finding its
  -- request is not admission of the new evidence. Retain the cursor for replay
  -- after that lease completes; never steal/reset its request or lose the wake.
  if exists (select 1 from public.bookkeeping_processing_requests r
    join public.transaction_categorizations tc
      on tc.business_id = r.business_id and tc.transaction_id = r.transaction_id
    where r.business_id = p_business_id and r.transaction_id = any(v_ids)
      and (r.status = 'dead_letter' or (r.status = 'processing'
        and r.metadata->>'plaid_sync_input_cursor_sha256' is distinct from
          encode(sha256(convert_to(coalesce(p_original_cursor, ''), 'UTF8')), 'hex')))
      and tc.status not in ('posted', 'matched', 'matched_existing_qbo', 'excluded', 'ignored')
      and tc.qbo_txn_id is null) then
    raise exception using errcode = '40001', message = 'plaid_processing_request_requires_replay';
  end if;
  insert into public.bookkeeping_processing_requests as existing
    (business_id, transaction_id, scope, status, priority, metadata)
  select p_business_id, bt.id, 'transaction', 'pending', 10,
    jsonb_build_object('source', 'plaid_sync', 'plaid_sync_run_id', p_run_id,
      'plaid_sync_input_cursor_sha256', encode(sha256(convert_to(coalesce(p_original_cursor, ''), 'UTF8')), 'hex'))
    from public.bank_transactions bt where bt.business_id = p_business_id
      and bt.id = any(v_ids) and not bt.is_archived
  on conflict (business_id, transaction_id) do update
    set status = 'pending', process_after = now(), updated_at = now(),
        metadata = coalesce(existing.metadata, '{}'::jsonb) || excluded.metadata
    -- Preserve request identity and historical error evidence. Do not steal
    -- an active lease or reset exhausted retries during duplicate replay.
    where existing.status in ('completed', 'skipped')
      and existing.metadata->>'plaid_sync_input_cursor_sha256'
        is distinct from excluded.metadata->>'plaid_sync_input_cursor_sha256';

  select count(*) into v_admitted from public.bookkeeping_processing_requests r
    join public.bank_transactions bt on bt.id = r.transaction_id and bt.business_id = r.business_id
    where r.business_id = p_business_id and bt.id = any(v_ids) and not bt.is_archived;
  if v_admitted <> (select count(*) from public.bank_transactions where business_id = p_business_id
      and id = any(v_ids) and not is_archived) then
    raise exception using errcode = 'P0001', message = 'plaid_processing_admission_incomplete';
  end if;

  v_stage := 'cursor_commit';
  update public.plaid_accounts set last_sync_at = p_completed_at, updated_at = p_completed_at
    where business_id = p_business_id and plaid_env = v_item.plaid_env
      and plaid_item_id = v_item.plaid_item_id and is_active is true
      and connection_state = 'connected' and disconnected_at is null;
  update public.plaid_items set cursor = p_next_cursor, last_sync_at = p_completed_at,
    last_success_at = p_completed_at, status = 'connected', error_code = null,
    error_message = null, updated_at = p_completed_at
    where id = p_item_id and business_id = p_business_id;
  update public.bank_sync_runs set status = 'completed', finished_at = p_completed_at,
    added_count = p_added_count, modified_count = p_modified_count, removed_count = p_removed_count,
    failure_code = null, error_message = null,
    meta = jsonb_build_object('admitted_count', v_admitted, 'mutation_restarts', p_mutation_restarts,
      'cursor_input_sha256', encode(sha256(convert_to(coalesce(p_original_cursor, ''), 'UTF8')), 'hex'),
      'next_cursor_sha256', encode(sha256(convert_to(coalesce(p_next_cursor, ''), 'UTF8')), 'hex'))
    where id = p_run_id and business_id = p_business_id and worker_id = p_worker_id;
  return jsonb_build_object('admitted_count', v_admitted);
exception when others then
  get stacked diagnostics v_table = table_name, v_column = column_name, v_constraint = constraint_name, v_message = message_text;
  -- Never propagate row values, descriptions or provider payloads in DETAIL.
  raise exception using errcode = sqlstate, message = 'plaid_admission_database_failure',
    detail = jsonb_build_object('table', v_table, 'column', v_column, 'constraint', v_constraint, 'stage', v_stage,
      'reason', case when v_message ~ '^plaid_[a-z_]+$' then v_message else null end)::text;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.classify_plaid_account_recovery_rows(p_business_id uuid, p_plaid_env text, p_plaid_account_id text)
 RETURNS TABLE(transaction_id uuid, initial_target boolean, classification text, evidence_version text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select bt.id,
    not bt.is_archived and tc.id is null and r.id is null,
    case
      when bt.is_archived or bt.archived_reason is not null then 'protected_removed_transaction'
      when r.status = 'processing' and r.locked_at>now()-interval '10 minutes' then 'active_processing_lease'
      when r.status = 'processing' then 'stale_processing_lease'
      when r.status = 'dead_letter' then 'unresolved_dead_letter'
      when tc.status in ('matched','matched_existing_qbo') or tc.reconciled_at is not null then 'existing_match'
      when q.id is not null or tc.qbo_txn_id is not null or tc.posted_at is not null then 'existing_posting_intent_or_receipt'
      when tc.status in ('excluded','ignored','approved','auto_approved','handled','posted') then 'completed_decision'
      when bt.pending then 'pending_transaction'
      when bt.accounting_review_reason ilike '%duplicate%'
        or tc.meta->>'possible_qbo_duplicate' = 'true'
        or bt.raw->>'possible_qbo_duplicate' = 'true' then 'possible_qbo_duplicate'
      when bt.accounting_review_required or tc.accounting_review_required then 'manual_review_required'
      when bt.direction is distinct from 'OUTFLOW' or bt.check_number is not null
        or coalesce(bt.transaction_type,'') ~* '(transfer|refund|payroll|tax|loan|payment)'
        or coalesce(bt.name,'') ~* '(\m(transfer|payroll|loan|refund|autopay)\M|DEPOSIT INTUIT|TRAN FEE INTUIT)'
        or coalesce(bt.raw->>'source','plaid') ~* '(csv|manual)'
        or bt.plaid_transaction_id is null then 'protected_workflow'
      when tc.id is not null then 'existing_categorization'
      when r.id is not null then 'existing_processing_admission'
      else 'eligible_residual_orphan'
    end,
    encode(sha256(convert_to(jsonb_build_array(to_jsonb(bt), to_jsonb(tc), to_jsonb(r), to_jsonb(q))::text, 'UTF8')), 'hex')
  from public.bank_transactions bt
  join public.plaid_accounts a on a.business_id = bt.business_id and a.plaid_env = bt.plaid_env
    and a.plaid_account_id = bt.plaid_account_id
  left join public.transaction_categorizations tc on tc.business_id = bt.business_id and tc.transaction_id = bt.id
  left join public.bookkeeping_processing_requests r on r.business_id = bt.business_id and r.transaction_id = bt.id
  left join public.qbo_posted_transactions q on q.business_id = bt.business_id and q.transaction_id = bt.id
  where bt.business_id = p_business_id and bt.plaid_env = p_plaid_env and bt.plaid_account_id = p_plaid_account_id;
$function$
;
CREATE OR REPLACE FUNCTION public.plaid_residual_recovery_snapshot(p_business_id uuid, p_plaid_env text, p_plaid_account_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  a public.plaid_accounts%rowtype; i public.plaid_items%rowtype;
  replay_id uuid; checkpoint_id uuid; attempt_id uuid; checkpoint_at timestamptz; newest_target_at timestamptz;
  classifications jsonb; target_rows jsonb; target_count bigint; eligible_count bigint; fingerprint text;
begin
  select * into a from public.plaid_accounts where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_account_id=p_plaid_account_id;
  if not found then raise exception using errcode='22023', message='plaid_residual_account_not_found'; end if;
  select * into i from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=a.plaid_item_id;
  if not found then raise exception using errcode='22023', message='plaid_residual_item_not_found'; end if;
  select id into attempt_id from public.bank_sync_runs where business_id=p_business_id and plaid_item_id=a.plaid_item_id
    order by started_at desc,id desc limit 1;
  select id into checkpoint_id from public.bank_sync_runs where business_id=p_business_id and plaid_item_id=a.plaid_item_id
    and status='completed' order by started_at desc,id desc limit 1;
  select finished_at into checkpoint_at from public.bank_sync_runs where id=checkpoint_id;
  select max(bt.created_at) into newest_target_at from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id) r
    join public.bank_transactions bt on bt.business_id=p_business_id and bt.id=r.transaction_id where r.initial_target;
  select s.id into replay_id from public.bank_sync_runs s where s.business_id=p_business_id and s.plaid_item_id=a.plaid_item_id
    and s.status='completed' and s.finished_at>=a.connected_at and s.meta ? 'admitted_count' and s.meta->>'cursor_input_sha256' is not null
    and exists(select 1 from public.bank_sync_runs f where f.business_id=s.business_id and f.plaid_item_id=s.plaid_item_id
      and f.status='failed' and f.started_at<s.started_at
      and f.meta->>'failure_stage' in ('transaction_persistence','downstream_admission')
      and f.meta->>'cursor_input_sha256'=s.meta->>'cursor_input_sha256')
    order by s.started_at desc,s.id desc limit 1;
  select coalesce(jsonb_object_agg(classification,n),'{}') into classifications from (
    select classification,count(*) n from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id)
      group by classification) grouped;
  select coalesce(jsonb_agg(jsonb_build_object('transaction_id',transaction_id,'classification',classification)
      order by transaction_id),'[]'::jsonb) into target_rows
    from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id) where initial_target;
  select count(*) filter(where initial_target),count(*) filter(where initial_target and classification='eligible_residual_orphan'),
    encode(sha256(convert_to(coalesce(string_agg(transaction_id::text || evidence_version || classification,',' order by transaction_id),'')
      || coalesce(replay_id::text,'') || coalesce(checkpoint_id::text,'') || to_jsonb(a)::text || coalesce(i.status,''),'UTF8')),'hex')
    into target_count,eligible_count,fingerprint
    from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id);
  return jsonb_build_object('account_id',p_plaid_account_id,'plaid_item_id',a.plaid_item_id,
    'replay_run_id',replay_id,'checkpoint_run_id',checkpoint_id,'latest_attempt_id',attempt_id,
    'replay_completed',replay_id is not null and attempt_id=checkpoint_id and coalesce(newest_target_at<=checkpoint_at,true),
    'connection_eligible',a.is_active and a.connection_state='connected' and a.disconnected_at is null
      and i.is_active and i.status in ('connected','active') and i.error_code is null,
    'initial_target_count',target_count,'eligible_count',eligible_count,'classifications',classifications,
    'initial_targets',target_rows,'fingerprint',fingerprint);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.get_plaid_account_recovery_facts(p_business_id uuid, p_plaid_env text, p_qbo_env text DEFAULT 'production'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  a record; i public.plaid_items%rowtype; latest jsonb; successful jsonb;
  metrics jsonb; accounts jsonb := '[]';
  token_status text; token_at timestamptz; token_active boolean; token_connected_at timestamptz; policy boolean;
begin
  select auto_post_to_quickbooks into policy from public.business_profiles where id = p_business_id;
  select status, disconnected_at,is_active,coalesce(last_connected_at,created_at) into token_status, token_at,token_active,token_connected_at
    from public.quickbooks_tokens where business_id = p_business_id and qbo_env = p_qbo_env
    order by created_at desc limit 1;
  for a in select * from public.plaid_accounts where business_id = p_business_id and plaid_env = p_plaid_env order by id loop
    select * into i from public.plaid_items where business_id = p_business_id and plaid_env = p_plaid_env
      and plaid_item_id = a.plaid_item_id;
    select jsonb_build_object('id',id,'status',status,'started_at',started_at,'finished_at',finished_at,
      'failure_code',failure_code,'stage',meta->>'failure_stage','database_stage',meta->>'database_stage',
      'source_error_code',meta->>'source_error_code','reason',meta->>'reason') into latest
      from public.bank_sync_runs where business_id = p_business_id and plaid_item_id = a.plaid_item_id
      order by started_at desc, id desc limit 1;
    select jsonb_build_object('id',id,'started_at',started_at,'finished_at',finished_at) into successful
      from public.bank_sync_runs where business_id = p_business_id and plaid_item_id = a.plaid_item_id
        and status = 'completed' order by finished_at desc, id desc limit 1;
    select jsonb_build_object(
      'active_count', count(*), 'first_transaction_date', min(bt.date), 'latest_transaction_date', max(bt.date),
      'last_persisted_at', max(bt.created_at), 'last_mutation_at',max(bt.updated_at), 'last_observed_at',max(bt.last_seen_at),
      'missing_categorization',count(*) filter(where tc.id is null),
      'missing_processing_admission',count(*) filter(where r.id is null),
      'missing_both',count(*) filter(where tc.id is null and r.id is null),
      'required_processing_admission_missing',count(*) filter(where r.id is null and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'processing_count',count(*) filter(where r.status in ('pending','processing','failed') and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'active_lease_count',count(*) filter(where r.status = 'processing' and r.locked_at>now()-interval '10 minutes' and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'stale_lease_count',count(*) filter(where r.status='processing' and (r.locked_at is null or r.locked_at<=now()-interval '10 minutes') and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'dead_letter_count',count(*) filter(where r.status = 'dead_letter' and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'automation_failed_count',count(*) filter(where r.status in ('failed','dead_letter') and (tc.id is null or tc.status in ('needs_review','uncategorized','failed'))),
      'automation_due_count',count(*) filter(where r.status in ('pending','failed') and r.attempt_count<r.max_attempts and greatest(r.process_after,coalesce(r.blocked_until,r.process_after))<=now()),
      'review_count',count(*) filter(where (tc.status in ('needs_review','uncategorized') or (bt.accounting_review_required and coalesce(tc.status,'') not in ('excluded','ignored'))) and not bt.pending),
      'automation_last_attempt_at',max(coalesce(r.locked_at,r.processed_at,case when r.attempt_count>0 then r.updated_at end)),
      'automation_last_success_at',max(r.processed_at) filter(where r.status in ('completed','skipped')),
      'automation_error_at',max(r.updated_at) filter(where r.status in ('failed','dead_letter')),
      'automation_retry_candidate_at',min(greatest(r.process_after,coalesce(r.blocked_until,r.process_after)))
        filter(where r.status='failed' and r.attempt_count>0 and r.attempt_count < r.max_attempts
          and greatest(r.process_after,coalesce(r.blocked_until,r.process_after)) > now()),
      'posting_hold_count',count(*) filter(where tc.posting_hold_batch_id is not null and coalesce(b.posting_hold,true)),
      'receipt_reconciliation_count',count(*) filter(where q.status in ('pending','unknown','processing')),
      'posting_failed_count',count(*) filter(where q.status = 'failed' or tc.posting_status = 'posting_failed'),
      'posting_last_attempt_at',max(coalesce(q.last_attempt_at,tc.last_post_attempt_at)),
      'posting_last_success_at',max(q.posted_at) filter(where q.status = 'posted'),
      'posting_error_at',max(coalesce(q.last_attempt_at,q.updated_at,tc.updated_at))
        filter(where q.status = 'failed' or tc.posting_status = 'posting_failed'),
      'qbo_auth_error_at',max(coalesce(q.last_attempt_at,q.updated_at,tc.updated_at)) filter(where
        coalesce(q.last_error->>'code',tc.post_error,'') in
          ('invalid_grant','qbo_reconnect_required','qbo_auth_required','vendor_qbo_auth_required','AuthenticationFailed')
        and coalesce(q.status,'')<>'posted' and coalesce(tc.status,'')<>'posted')
    ) into metrics
    from public.bank_transactions bt
    left join public.transaction_categorizations tc on tc.business_id = bt.business_id and tc.transaction_id = bt.id
    left join public.bookkeeping_processing_requests r on r.business_id = bt.business_id and r.transaction_id = bt.id
    left join public.qbo_posted_transactions q on q.business_id = bt.business_id and q.transaction_id = bt.id and q.qbo_env = p_qbo_env
    left join public.plaid_recovery_batches b on b.id = tc.posting_hold_batch_id and b.business_id = bt.business_id
    where bt.business_id = p_business_id and bt.plaid_env = p_plaid_env
      and bt.plaid_account_id = a.plaid_account_id and not bt.is_archived;
    -- Ledger reconciliation and held cohorts remain relevant after a bank row
    -- is archived. Imported date/count metrics above remain active-only.
    metrics := metrics || jsonb_build_object(
      'recovery_gap_review_count',(select count(*) from public.plaid_recovery_batches g where g.business_id=p_business_id
        and g.plaid_env=p_plaid_env and g.plaid_item_id=a.plaid_item_id and g.summary->>'workflow_kind'='reviewed_recovery'
        and g.summary->'before'->>'account_id'=a.plaid_account_id and g.status='preview_ready'),
      'posting_hold_count',(select count(*) from public.transaction_categorizations tc
        join public.bank_transactions bt on bt.id=tc.transaction_id and bt.business_id=tc.business_id
        join public.plaid_recovery_batches rb on rb.id=tc.posting_hold_batch_id and rb.business_id=tc.business_id
        where tc.business_id=p_business_id and bt.plaid_env=p_plaid_env and bt.plaid_account_id=a.plaid_account_id and rb.posting_hold),
      'receipt_reconciliation_count',(select count(*) from public.qbo_posted_transactions q
        join public.bank_transactions bt on bt.id=q.transaction_id and bt.business_id=q.business_id
        where q.business_id=p_business_id and bt.plaid_env=p_plaid_env and bt.plaid_account_id=a.plaid_account_id
          and q.qbo_env=p_qbo_env and q.status in ('pending','unknown','processing'))
    );
    accounts := accounts || jsonb_build_array(jsonb_build_object(
      'account',jsonb_build_object('id',a.plaid_account_id,'plaid_item_id',a.plaid_item_id,'name',a.name,'mask',a.mask,
        'connection_state',a.connection_state,'is_active',a.is_active,'disconnected_at',a.disconnected_at,'updated_at',a.updated_at,
        'plaid_env',a.plaid_env,'plaid_account_id',a.plaid_account_id,'official_name',a.official_name,'type',a.type,'subtype',a.subtype,
        'current_balance',a.current_balance,'available_balance',a.available_balance,'iso_currency_code',a.iso_currency_code,
        'connected_at',a.connected_at,'created_at',a.created_at,'last_sync_at',a.last_sync_at,'connection_state_version',a.connection_state_version,
        'reconnected_at',a.reconnected_at,'sync_gap_started_at',a.sync_gap_started_at,'sync_gap_last_event_at',a.sync_gap_last_event_at,'sync_gap_event_count',a.sync_gap_event_count),
      'item',jsonb_build_object('institution_id',i.institution_id,'institution_name',i.institution_name,'reconnect_state',i.reconnect_state,'status',i.status,
        'is_active',i.is_active,'disconnected_at',i.disconnected_at,'error_code',i.error_code,'updated_at',i.updated_at,
        'last_success_at',i.last_success_at),
      'latest_run',latest,'last_checkpoint',successful,'metrics',metrics,
      'mapped_to_qbo',exists(select 1 from public.plaid_qbo_account_mappings where business_id=p_business_id and plaid_account_id=a.plaid_account_id),
      'auto_post_enabled',coalesce(policy,false),'qbo_token_status',token_status,'qbo_token_active',token_active,'qbo_token_status_at',token_at,'qbo_token_connected_at',token_connected_at));
  end loop;
  return jsonb_build_object('observed_at',now(),'accounts',accounts);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.preview_plaid_residual_orphan_recovery(p_business_id uuid, p_plaid_env text, p_plaid_account_id text, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare snapshot jsonb; batch_id uuid;
begin
  if p_actor_user_id is null then raise exception using errcode='22023',message='plaid_residual_actor_required'; end if;
  snapshot := public.plaid_residual_recovery_snapshot(p_business_id,p_plaid_env,p_plaid_account_id);
  -- An ineligible dry-run is read-only and still reports current classifications.
  if not (snapshot->>'replay_completed')::boolean or not (snapshot->>'connection_eligible')::boolean then
    return jsonb_build_object('dry_run',true,'ready',false,'reason_code','successful_replay_required','before',snapshot);
  end if;
  insert into public.plaid_recovery_batches(business_id,plaid_env,plaid_item_id,cutoff_date,status,posting_hold,created_by,summary)
    values(p_business_id,p_plaid_env,snapshot->>'plaid_item_id',current_date,'preview_ready',true,p_actor_user_id,
      jsonb_build_object('workflow_kind','residual_orphan','preview_at',clock_timestamp(),'before',snapshot)) returning id into batch_id;
  insert into public.plaid_recovery_batch_rows(batch_id,business_id,change_type,disposition,plaid_transaction_id,plaid_account_id,payload)
    select batch_id,p_business_id,'modified','new_after_cutoff',bt.plaid_transaction_id,bt.plaid_account_id,
      jsonb_build_object('transaction_id',r.transaction_id,'evidence_version',r.evidence_version,'classification',r.classification)
    from public.classify_plaid_account_recovery_rows(p_business_id,p_plaid_env,p_plaid_account_id) r
    join public.bank_transactions bt on bt.business_id=p_business_id and bt.id=r.transaction_id
    where r.initial_target and r.classification='eligible_residual_orphan';
  return jsonb_build_object('dry_run',true,'ready',true,'batch_id',batch_id,'expires_at',clock_timestamp()+interval '5 minutes',
    'posting_protection','recovery_batch_hold','before',snapshot);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.apply_plaid_residual_orphan_recovery(p_business_id uuid, p_plaid_env text, p_plaid_account_id text, p_actor_user_id uuid, p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  batch public.plaid_recovery_batches%rowtype; current_snapshot jsonb; after_snapshot jsonb;
  ids uuid[]; posting_enabled boolean; n integer;
begin
  select * into batch from public.plaid_recovery_batches where id=p_batch_id and business_id=p_business_id
    and plaid_env=p_plaid_env and summary->>'workflow_kind'='residual_orphan' for update;
  if not found or batch.created_by is distinct from p_actor_user_id
    or batch.summary->'before'->>'account_id' is distinct from p_plaid_account_id then
    raise exception using errcode='22023',message='plaid_residual_preview_scope_mismatch';
  end if;
  if batch.status='imported_held' then
    return jsonb_build_object('dry_run',false,'idempotent',true,'newly_applied_count',0,'batch_id',batch.id,
      'before',batch.summary->'before','after',public.plaid_residual_recovery_snapshot(p_business_id,p_plaid_env,p_plaid_account_id));
  end if;
  if batch.status<>'preview_ready' or batch.posting_hold is not true
    or (batch.summary->>'preview_at')::timestamptz<clock_timestamp()-interval '5 minutes' then
    raise exception using errcode='40001',message='plaid_residual_fresh_preview_required';
  end if;
  select auto_post_to_quickbooks into posting_enabled from public.business_profiles where id=p_business_id for update;
  if posting_enabled is distinct from false then
    raise exception using errcode='42501',message='plaid_residual_disable_posting_required';
  end if;
  -- Coordinate with ordinary sync's Item lease; repair never advances its cursor.
  perform 1 from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=batch.plaid_item_id and not coalesce(sync_in_progress,false)
    and sync_lease_owner is null for update;
  if not found then raise exception using errcode='40001',message='plaid_residual_sync_lease_active'; end if;
  perform 1 from public.plaid_accounts where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_account_id=p_plaid_account_id for update;
  -- Lock the exact preview cohort; worker/receipt/categorization ownership FKs
  -- cannot admit conflicting work on these bank rows during this transaction.
  select coalesce(array_agg((payload->>'transaction_id')::uuid),'{}'::uuid[]) into ids
    from public.plaid_recovery_batch_rows where batch_id=batch.id and business_id=p_business_id;
  perform 1 from public.bank_transactions where business_id=p_business_id and id=any(ids) order by id for update;
  current_snapshot := public.plaid_residual_recovery_snapshot(p_business_id,p_plaid_env,p_plaid_account_id);
  if not coalesce((current_snapshot->>'replay_completed')::boolean,false)
    or not coalesce((current_snapshot->>'connection_eligible')::boolean,false)
    or current_snapshot->>'fingerprint' is distinct from batch.summary->'before'->>'fingerprint' then
    raise exception using errcode='40001',message='plaid_residual_preview_stale';
  end if;
  if cardinality(ids)<>(current_snapshot->>'eligible_count')::integer then
    raise exception using errcode='40001',message='plaid_residual_preview_manifest_incomplete';
  end if;
  insert into public.transaction_categorizations(business_id,transaction_id,status,posting_hold_batch_id,post_after,meta)
    select p_business_id,id,'needs_review',batch.id,null,
      jsonb_build_object('residual_recovery_batch_id',batch.id,'safe_to_auto_post',false,'post_block_reason','residual_recovery_hold')
    from unnest(ids) id;
  insert into public.bookkeeping_processing_requests(business_id,transaction_id,scope,status,priority,metadata)
    select p_business_id,id,'transaction','pending',10,
      jsonb_build_object('source','plaid_residual_recovery','residual_recovery_batch_id',batch.id) from unnest(ids) id;
  get diagnostics n=row_count;
  after_snapshot := public.plaid_residual_recovery_snapshot(p_business_id,p_plaid_env,p_plaid_account_id);
  update public.plaid_recovery_batches set status='imported_held',updated_at=now(),
    summary=summary || jsonb_build_object('applied_count',n,'applied_at',clock_timestamp(),'after',after_snapshot)
    where id=batch.id and business_id=p_business_id;
  return jsonb_build_object('dry_run',false,'idempotent',false,'newly_applied_count',n,'batch_id',batch.id,
    'posting_protection','recovery_batch_hold','before',batch.summary->'before','after',after_snapshot);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.auto_post_technical_block(c transaction_categorizations, p_env text DEFAULT 'production'::text, p_context jsonb DEFAULT NULL::jsonb, p_effective_date date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare b public.bank_transactions; p public.business_profiles; q public.quickbooks_tokens; m public.plaid_qbo_account_mappings;
  x jsonb := coalesce(c.meta,'{}'::jsonb); stale text[] := array['missing_posting_schedule','pending_transaction_not_postable','weak_memo_evidence','probable_requires_review','low_classifier_confidence','merchant_ambiguous','no_matching_vendor_rule','automatic_posting_safety_not_established','unsafe_auto_post','auto_post_admission_pending','auto_post_admission_retry'];
begin
  select * into b from public.bank_transactions where business_id=c.business_id and id=c.transaction_id;
  select * into p from public.business_profiles where id=c.business_id;
  if p_context is not null and coalesce(p_context->>'manual','false')<>'true' and not coalesce(p.auto_post_to_quickbooks,false) then return 'auto_post_disabled'; end if;
  if b.id is null then return 'bank_transaction_missing'; end if;
  if c.qbo_txn_id is not null or to_jsonb(c)->>'source_qbo_txn_id' is not null or x->>'source_qbo_txn_id' is not null or c.posted_at is not null or c.posting_status='posted' or c.status='posted' then return 'already_posted'; end if;
  if c.excluded_at is not null or c.status='excluded' or coalesce(c.is_archived,false) or coalesce(b.is_archived,false) then return 'excluded_or_archived'; end if;
  if exists(select 1 from public.bank_qbo_matches r where r.business_id=c.business_id and r.bank_transaction_id=c.transaction_id and r.status='confirmed') then return 'matched_transaction'; end if;
  if c.status='matched_existing_qbo' or x->>'matched_existing_qbo'='true' or x->>'incoming_deposit_match_status'='confirmed' or (x->>'cc_payment_pair_id' is not null and x->>'cc_payment_pair_id' is distinct from p_context->>'pair_id') then return 'matched_transaction'; end if;
  -- Failed decisions belong exclusively to the existing posting retry lifecycle.
  -- Caller-writable history, meta and decided_at never authorize admission.
  if p_context is null and c.status='failed' then return 'failed_requires_existing_retry_workflow'; end if;
  if c.status not in ('approved','auto_approved','handled','failed') then return 'not_handled'; end if;
  if b.pending then return 'pending_transaction_not_postable'; end if;
  if b.accounting_review_required then return 'plaid_accounting_review_required'; end if;
  if b.date is null or b.amount is null or b.amount=0 or b.amount::text in ('NaN','Infinity','-Infinity') then return 'required_financial_data_missing'; end if;
  if (p_context is null and (b.direction is distinct from 'OUTFLOW' or coalesce(x->>'taxonomy_type','')<>'' or x->>'is_check'='true'))
    or (p_context is not null and (b.direction not in ('OUTFLOW','INFLOW') or coalesce(x->>'taxonomy_type','') not in ('','loan_payment','split_transaction','statement_credit','cc_payment'))) then return 'unsupported_transaction_type'; end if;
  if x->>'existing_qbo_match_confirmed'='true' or x->>'qbo_duplicate_detection_confidence'='DETERMINISTIC_EXISTING'
     or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(x->'qbo_duplicate_candidates')='array' then x->'qbo_duplicate_candidates' else '[]'::jsonb end) d where d->>'deterministic'='true') then return 'confirmed_duplicate'; end if;
  if x->>'ambiguous_provider_outcome'='true' then return 'provider_outcome_ambiguous'; end if;
  if p_context is null then
    if exists(select 1 from public.qbo_posted_transactions r where r.business_id=c.business_id and r.transaction_id=c.transaction_id) then return 'existing_provider_intent_or_receipt'; end if;
    if c.last_post_attempt_at is not null or x->>'post_intent_id' is not null or x->>'posting_in_progress'='true'
      or exists(select 1 from public.bookkeeping_post_attempts a where a.business_id=c.business_id and a.transaction_id=c.transaction_id) then return 'prior_posting_evidence'; end if;
  else
    if p_context->>'business_id' is distinct from c.business_id::text
      or p_context->>'transaction_id' is distinct from c.transaction_id::text
      or p_context->>'env' is distinct from p_env then return 'posting_execution_identity_changed'; end if;
    if x->>'posting_generation' is distinct from p_context->>'generation'
      or nullif(x->>'posting_cancelled_at','') is not null
      or x->>'posting_cancelled_at' is distinct from p_context->>'cancelled_at'
      or x->>'posting_in_progress' is distinct from 'true'
      or nullif(p_context->>'lock_started_at','') is null
      or (x->>'posting_started_at')::timestamptz is distinct from (p_context->>'lock_started_at')::timestamptz
      or (x->>'posting_started_at')::timestamptz <= statement_timestamp()-interval '10 minutes'
      or x->>'post_idempotency_key' is distinct from p_context->>'lock_key'
      then return 'posting_execution_cancelled_or_replaced'; end if;
    if coalesce(p_context->>'pair_id','')='' and (not exists(select 1 from public.qbo_posted_transactions r where r.business_id=c.business_id and r.transaction_id=c.transaction_id
      and r.status='processing' and r.qbo_txn_id is null and r.request_id=p_context->>'request_id' and r.idempotency_key=p_context->>'idempotency_key'
      and r.realm_id=p_context->>'realm_id' and r.qbo_env=p_env and r.processing_started_at=(p_context->>'claimed_at')::timestamptz
      and r.lease_expires_at=(p_context->>'lease_expires_at')::timestamptz and r.lease_expires_at>statement_timestamp())
      or nullif(p_context->>'owner','') is null or x->>'posting_execution_owner' is distinct from p_context->>'owner'
      or x->>'posting_execution_request_id' is distinct from p_context->>'request_id' ) then return 'foreign_or_stale_posting_lease'; end if;
    if exists(select 1 from public.qbo_posted_transactions r where r.business_id=c.business_id and r.transaction_id=c.transaction_id and (r.request_id is distinct from p_context->>'request_id' or r.idempotency_key is distinct from p_context->>'idempotency_key' or r.qbo_env is distinct from p_env or r.qbo_txn_id is not null or r.status is distinct from 'processing')) then return 'foreign_or_stale_posting_lease'; end if;
    if exists(select 1 from public.bookkeeping_post_attempts a where a.business_id=c.business_id and a.transaction_id=c.transaction_id
      and a.status='attempted' and (
        a.payload_summary->>'posting_execution_owner' is distinct from p_context->>'owner'
        or a.payload_summary->>'posting_request_id' is distinct from p_context->>'request_id'
        or a.payload_summary->>'posting_claimed_at' is distinct from p_context->>'claimed_at'
        or a.payload_summary->>'posting_generation' is distinct from p_context->>'generation'
        or a.attempted_at<(p_context->>'claimed_at')::timestamptz)
      -- A conclusively rejected old attempt belongs to the existing retry
      -- workflow. An unknown outcome or an unresolved older attempt never does.
      and not (a.attempted_at<(p_context->>'claimed_at')::timestamptz
        and exists(select 1 from public.qbo_posted_transactions r where r.business_id=c.business_id and r.transaction_id=c.transaction_id
          and r.request_id=p_context->>'request_id' and r.response_summary->>'qbo_write_may_have_occurred'='false'
          and r.response_summary->>'posting_claimed_at'=a.payload_summary->>'posting_claimed_at'
          and r.response_summary->>'posting_execution_owner'=a.payload_summary->>'posting_execution_owner'
          and r.response_summary->>'posting_request_id'=a.payload_summary->>'posting_request_id'
          and (r.response_summary->>'rejected_at')::timestamptz>=a.attempted_at)
        and exists(select 1 from public.bookkeeping_post_attempts f where f.business_id=c.business_id and f.transaction_id=c.transaction_id
          and f.status='failed' and f.attempted_at>=a.attempted_at and f.attempted_at<(p_context->>'claimed_at')::timestamptz))) then return 'ambiguous_prior_attempt'; end if;
    if c.final_qbo_account_id is distinct from p_context->>'final_account_id' or b.plaid_account_id is distinct from p_context->>'plaid_account_id'
      or b.date::text is distinct from p_context->>'date' or b.amount is distinct from (p_context->>'amount')::numeric
      or c.post_error is distinct from p_context->>'post_error' then return 'posting_payload_changed'; end if;
    if coalesce(p_context->>'manual','false')<>'true' and c.post_after<=p.auto_post_enabled_at then return 'expired_schedule_requires_review'; end if;
  end if;
  if c.posting_hold_batch_id is not null and not exists(select 1 from public.plaid_recovery_batches r where r.business_id=c.business_id and r.id=c.posting_hold_batch_id and r.posting_hold=false)
    or exists(select 1 from public.plaid_recovery_batch_rows r join public.plaid_recovery_batches h on h.id=r.batch_id and h.business_id=r.business_id where r.business_id=c.business_id and r.admitted_transaction_id=c.transaction_id and h.posting_hold) then return 'recovery_posting_hold'; end if;
  if exists(select 1 from public.monthly_review_runs r where r.business_id=c.business_id and r.review_month=date_trunc('month',b.date)::date and r.status='finalized')
    or exists(select 1 from public.financial_monthly_review_stamps r where r.business_id=c.business_id and r.review_month=date_trunc('month',b.date)::date and r.status in ('completed','closed','finalized'))
    or exists(select 1 from public.accounting_period_closes r where r.business_id=c.business_id and r.period_month=date_trunc('month',b.date)::date and r.is_active and r.status in ('approved','close_requested','refreshing_snapshot','ready_for_approval','reopen_required')) then return 'accounting_period_locked'; end if;
  if b.date<greatest(p.bookkeeping_start_date,coalesce(p_effective_date,p.auto_post_effective_date)) then return 'before_active_books_cutoff'; end if;
  select * into q from public.quickbooks_tokens where business_id=c.business_id and qbo_env=p_env and status='active' and is_active order by created_at desc limit 1;
  if q.id is null then return 'qbo_connection_inactive'; end if;
  if p_context is not null and (q.realm_id is distinct from p_context->>'realm_id' or q.qbo_env is distinct from p_env) then return 'qbo_connection_identity_changed'; end if;
  select * into m from public.plaid_qbo_account_mappings where business_id=c.business_id and plaid_account_id=b.plaid_account_id limit 1;
  if p_context is not null and m.qbo_account_id is distinct from p_context->>'source_account_id' then return 'posting_source_changed'; end if;
  if m.qbo_account_id is null then return 'missing_source_qbo_account'; end if;
  if not exists(select 1 from public.qbo_accounts_cache a where a.business_id=c.business_id and a.qbo_env=p_env and a.realm_id=q.realm_id and a.qbo_account_id=m.qbo_account_id and a.active and a.account_type in ('Bank','Credit Card','CreditCard')) then return 'inactive_source_qbo_account'; end if;
  if c.final_qbo_account_id is null or not exists(select 1 from public.qbo_accounts_cache a where a.business_id=c.business_id and a.qbo_env=p_env and a.realm_id=q.realm_id and a.qbo_account_id=c.final_qbo_account_id and a.active and (p_context is not null or regexp_replace(lower(a.account_type),'[^a-z]','','g') in ('expense','otherexpense','costofgoodssold','othercurrentasset','fixedasset','otherasset'))) then return 'invalid_final_qbo_account'; end if;
  if p_context is null and c.post_error is not null and not(c.post_error=any(stale)) then return case when c.post_error ~ '^[a-z0-9_]{1,80}$' then c.post_error else 'retained_posting_error' end; end if;
  if nullif(x->>'post_block_reason','') is not null and not(x->>'post_block_reason'=any(stale)) then return 'retained_posting_blocker'; end if;
  if nullif(x->>'auto_post_block_reason','') is not null and not(x->>'auto_post_block_reason'=any(stale)) then return 'retained_posting_blocker'; end if;
  return null;
end $function$
;
CREATE OR REPLACE FUNCTION public.plaid_residual_reconciliation_rows(p_business_id uuid, p_batch_id uuid)
 RETURNS TABLE(transaction_id uuid, classification text, held boolean, releasable boolean, requires_live_qbo_attestation boolean, evidence_fingerprint text, non_hold_fingerprint text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  with evidence as (
    select coalesce(br.admitted_transaction_id,(br.payload->>'transaction_id')::uuid) tid, tc.posting_hold_batch_id=p_batch_id is_held,
      to_jsonb(br) br_json,to_jsonb(bt) bt_json,to_jsonb(tc) tc_json,to_jsonb(r) r_json,to_jsonb(q) q_json,
      to_jsonb(j) j_json, attempts.all_rows attempt_json, matches.all_rows match_json, pairs.all_rows pair_json,
      case
        when bt.id is null or tc.id is null or r.id is null
          or bt.plaid_account_id is distinct from b.summary->'before'->>'account_id'
          or bt.plaid_env is distinct from b.plaid_env
          or (tc.posting_hold_batch_id is not null and tc.posting_hold_batch_id<>p_batch_id) then 'evidence_changed'
        when r.status='processing' and r.locked_at>now()-interval '10 minutes' then 'categorization_lease_active'
        when r.status='processing' then 'categorization_lease_stale'
        when r.status='dead_letter' then 'unresolved_dead_letter'
        when r.status in ('pending','failed') then 'categorization_processing'
        when q.status in ('pending','processing') then 'pending_qbo_receipt'
        when q.status='unknown' then 'unknown_qbo_receipt'
        when q.status='failed' or tc.posting_status='posting_failed' or j.state in ('failed','processing','reconciling')
          or (attempts.latest_status='failed' and coalesce(q.status,'')<>'posted') then 'failed_qbo_attempt'
        when bt.accounting_review_reason ilike '%duplicate%' or tc.meta->>'possible_qbo_duplicate'='true'
          or tc.meta->>'duplicate_risk'='true' or bt.raw->>'possible_qbo_duplicate'='true'
          or matches.ambiguous then 'possible_qbo_duplicate'
        when bt.is_archived or bt.pending or tc.is_archived or bt.accounting_review_required
          or tc.accounting_review_required or tc.post_after is not null
          or coalesce(tc.meta->>'posting_in_progress','false')='true' then 'protected_workflow'
        when q.status='posted' and q.qbo_txn_id is not null then 'existing_posted_receipt'
        when tc.status='posted' and tc.qbo_txn_id is not null and tc.posted_at is not null then 'existing_posted_receipt'
        when tc.status in ('matched','matched_existing_qbo') or tc.reconciled_at is not null
          or matches.confirmed then 'matched_existing_qbo'
        when tc.status in ('excluded','ignored') or (tc.meta->>'is_personal'='true'
          and tc.decided_by='user' and tc.decided_at is not null and tc.review_status='handled') then 'excluded_or_personal'
        when bt.direction is distinct from 'OUTFLOW' or bt.check_number is not null
          or coalesce(bt.transaction_type,'') ~* '(transfer|refund|payroll|tax|loan|payment)'
          or coalesce(bt.name,'') ~* '(\m(transfer|payroll|loan|refund|autopay)\M|DEPOSIT INTUIT|TRAN FEE INTUIT)'
          or coalesce(tc.meta->>'taxonomy_type','') ~* '(transfer|refund|payroll|tax|loan|cc_payment|check)'
          or tc.meta ? 'protected_workflow' or pairs.present then 'protected_workflow'
        when tc.status in ('needs_review','uncategorized') and not (tc.decided_by='user'
          and tc.decided_at is not null and tc.review_status='handled'
          and coalesce(tc.review_reopened_at,'-infinity'::timestamptz)<=tc.decided_at) then 'needs_user_review'
        when nullif(tc.final_qbo_account_id,'') is null then 'needs_user_review'
        when tc.status='handled' and tc.review_status='handled' then 'handled_without_posting'
        when tc.status in ('approved','auto_approved','handled','needs_review') and tc.review_status='handled'
          then 'safe_for_reviewed_release'
        else 'needs_user_review'
      end c
    from public.plaid_recovery_batch_rows br
    join public.plaid_recovery_batches b on b.id=br.batch_id and b.business_id=br.business_id
    left join public.bank_transactions bt on bt.id=coalesce(br.admitted_transaction_id,(br.payload->>'transaction_id')::uuid) and bt.business_id=br.business_id
    left join public.transaction_categorizations tc on tc.transaction_id=bt.id and tc.business_id=bt.business_id
    left join public.bookkeeping_processing_requests r on r.transaction_id=bt.id and r.business_id=bt.business_id
    left join public.qbo_posted_transactions q on q.transaction_id=bt.id and q.business_id=bt.business_id
    left join public.bookkeeping_posting_jobs j on j.transaction_id=bt.id and j.business_id=bt.business_id
    left join lateral (
      select jsonb_agg(to_jsonb(pa) order by pa.id) all_rows,
        (array_agg(pa.status order by pa.attempted_at desc,pa.id desc))[1] latest_status
      from public.bookkeeping_post_attempts pa where pa.business_id=br.business_id and pa.transaction_id=bt.id
    ) attempts on true
    left join lateral (
      select jsonb_agg(jsonb_build_array(to_jsonb(m),
        (select jsonb_agg(to_jsonb(mi) order by mi.id) from public.bank_qbo_match_items mi where mi.business_id=m.business_id and mi.match_id=m.id),
        (select jsonb_agg(to_jsonb(mh) order by mh.id) from public.bank_qbo_match_history mh where mh.business_id=m.business_id and mh.match_id=m.id)) order by m.id) all_rows,
        coalesce(bool_or(m.status='confirmed'),false) confirmed,
        coalesce(bool_or(m.status in ('ambiguous','needs_confirmation','candidate','match_check_unavailable')),false) ambiguous
      from public.bank_qbo_matches m where m.business_id=br.business_id and m.bank_transaction_id=bt.id
    ) matches on true
    left join lateral (
      select jsonb_agg(jsonb_build_array(to_jsonb(p),
        (select jsonb_agg(to_jsonb(pe) order by pe.id) from public.credit_card_payment_pair_events pe where pe.business_id=p.business_id and pe.pair_id=p.id)) order by p.id) all_rows,
        count(*)>0 present
      from public.credit_card_payment_pairs p where p.business_id=br.business_id
        and (p.checking_transaction_id=bt.id or p.credit_card_transaction_id=bt.id)
    ) pairs on true
    where br.business_id=p_business_id and br.batch_id=p_batch_id
      and (b.summary->>'workflow_kind'='residual_orphan' or br.admitted_transaction_id is not null)
  )
  select tid,c,coalesce(is_held,false),coalesce(is_held,false) and c in
    ('existing_posted_receipt','matched_existing_qbo','excluded_or_personal','handled_without_posting','safe_for_reviewed_release'),
    c in ('handled_without_posting','safe_for_reviewed_release'),
    encode(sha256(convert_to(jsonb_build_array(br_json,bt_json,tc_json,r_json,q_json,j_json,attempt_json,match_json,pair_json,c)::text,'UTF8')),'hex'),
    encode(sha256(convert_to(jsonb_build_array(br_json,bt_json,tc_json-'posting_hold_batch_id'-'updated_at',r_json,q_json,j_json,attempt_json,match_json,pair_json)::text,'UTF8')),'hex')
  from evidence order by tid;
$function$
;
CREATE OR REPLACE FUNCTION public.protect_plaid_residual_recovery_hold()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare authorized boolean;
begin
  if tg_table_name='transaction_categorizations' then
    if old.posting_hold_batch_id is not null and new.posting_hold_batch_id is distinct from old.posting_hold_batch_id
      and exists(select 1 from public.plaid_recovery_batches where business_id=old.business_id and id=old.posting_hold_batch_id
        and summary->>'workflow_kind' in ('residual_orphan','reviewed_recovery') and posting_hold) then
      select exists(select 1 from public.plaid_recovery_batches b cross join lateral jsonb_each(b.summary->'residual_reconciliations') m
        where b.id=old.posting_hold_batch_id and b.business_id=old.business_id
          and m.value->>'release_txid'=txid_current()::text
          and m.value->'approved_ids' @> jsonb_build_array(old.transaction_id)
          and not(m.value ? 'result')) into authorized;
      if current_user<>'plaid_residual_hold_executor' or not authorized or new.posting_hold_batch_id is not null
        or (to_jsonb(new)-'posting_hold_batch_id'-'updated_at') is distinct from (to_jsonb(old)-'posting_hold_batch_id'-'updated_at') then
        raise exception using errcode='42501',message='plaid_residual_hold_requires_reconciliation';
      end if;
    end if;
  elsif old.summary->>'workflow_kind' in ('residual_orphan','reviewed_recovery') then
    if new.posting_hold is not true or (new.status not in ('preview_ready','imported_held')
      and not(old.summary->>'workflow_kind'='reviewed_recovery' and old.status='preview_ready' and new.status='abandoned' and not(old.summary ? 'applied_at')))
      or new.summary->>'workflow_kind' is distinct from old.summary->>'workflow_kind'
      or new.business_id is distinct from old.business_id or new.plaid_env is distinct from old.plaid_env
      or new.plaid_item_id is distinct from old.plaid_item_id then
      raise exception using errcode='42501',message='plaid_residual_hold_requires_reconciliation';
    end if;
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.clear_approved_plaid_residual_holds(p_business_id uuid, p_batch_id uuid, p_manifest_id uuid, p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare n integer;
begin
  update public.transaction_categorizations set posting_hold_batch_id=null
    where business_id=p_business_id and posting_hold_batch_id=p_batch_id and transaction_id=any(p_ids)
      and exists(select 1 from public.plaid_recovery_batches b where b.id=p_batch_id and b.business_id=p_business_id
        and b.summary->'residual_reconciliations'->p_manifest_id::text->>'release_txid'=txid_current()::text
        and b.summary->'residual_reconciliations'->p_manifest_id::text->'approved_ids' @> to_jsonb(p_ids));
  get diagnostics n=row_count;
  return n;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.preview_plaid_residual_reconciliation(p_business_id uuid, p_plaid_env text, p_account_id text, p_batch_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare b public.plaid_recovery_batches%rowtype; snapshot jsonb; manifests jsonb; m jsonb; manifest_id uuid;
begin
  b:=public.assert_plaid_residual_operator_scope(p_business_id,p_plaid_env,p_account_id,p_batch_id,p_actor_id);
  select * into b from public.plaid_recovery_batches where id=b.id and business_id=p_business_id for update;
  snapshot:=public.plaid_residual_reconciliation_snapshot(p_business_id,p_plaid_env,p_account_id,p_batch_id);
  manifests:=coalesce(b.summary->'residual_reconciliations','{}');
  select value into m from jsonb_each(manifests) where value->>'actor_id'=p_actor_id::text
    and value->'before'->>'fingerprint'=snapshot->>'fingerprint' and not(value ? 'result')
    and (value->>'expires_at')::timestamptz>clock_timestamp() order by value->>'created_at' desc limit 1;
  if m is not null then return m||jsonb_build_object('dry_run',true,'idempotent',true); end if;
  manifest_id:=gen_random_uuid();
  m:=jsonb_build_object('manifest_id',manifest_id,'batch_id',p_batch_id,'business_id',p_business_id,
    'plaid_env',p_plaid_env,'account_id',p_account_id,'actor_id',p_actor_id,'created_at',clock_timestamp(),
    'expires_at',clock_timestamp()+interval '5 minutes','before',snapshot);
  update public.plaid_recovery_batches set summary=summary||jsonb_build_object('residual_reconciliations',
    manifests||jsonb_build_object(manifest_id::text,m)) where id=p_batch_id and business_id=p_business_id;
  return m||jsonb_build_object('dry_run',true,'idempotent',false);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.release_plaid_residual_reconciliation(p_business_id uuid, p_plaid_env text, p_account_id text, p_batch_id uuid, p_actor_id uuid, p_manifest_id uuid, p_reviewed_ids uuid[], p_attestation jsonb DEFAULT NULL::jsonb, p_execute boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  b public.plaid_recovery_batches%rowtype; m jsonb; current_snapshot jsonb; after_snapshot jsonb;
  ids uuid[]; all_ids uuid[]; request_hash text; changed_ids jsonb; result jsonb; n integer; needs_attestation boolean;
begin
  b:=public.assert_plaid_residual_operator_scope(p_business_id,p_plaid_env,p_account_id,p_batch_id,p_actor_id);
  if p_execute is distinct from true then
    return public.preview_plaid_residual_reconciliation(p_business_id,p_plaid_env,p_account_id,p_batch_id,p_actor_id);
  end if;
  select coalesce(array_agg(distinct id order by id),'{}'::uuid[]) into ids from unnest(p_reviewed_ids) id;
  if cardinality(ids)=0 or array_position(ids,null) is not null then
    raise exception using errcode='22023',message='plaid_reconciliation_explicit_rows_required';
  end if;
  if p_attestation is not null and (jsonb_typeof(p_attestation)<>'object'
    or p_attestation - array['performed','ledger','outcome','reviewed_at'] <> '{}'::jsonb
    or p_attestation->'performed' is distinct from 'true'::jsonb or p_attestation->>'ledger' is distinct from 'quickbooks_live'
    or p_attestation->>'outcome' is distinct from 'no_unrepresented_duplicate'
    or nullif(p_attestation->>'reviewed_at','') is null) then
    raise exception using errcode='22023',message='plaid_reconciliation_safe_attestation_required';
  end if;
  request_hash:=encode(sha256(convert_to(jsonb_build_array(ids,p_attestation)::text,'UTF8')),'hex');
  -- Fixed lock order; the Item lock coordinates with sync's owner-scoped lease.
  perform 1 from public.business_profiles where id=p_business_id for update;
  perform 1 from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=b.plaid_item_id for update;
  perform 1 from public.plaid_accounts where business_id=p_business_id and plaid_env=p_plaid_env and plaid_account_id=p_account_id for update;
  select * into b from public.plaid_recovery_batches where id=p_batch_id and business_id=p_business_id for update;
  m:=b.summary->'residual_reconciliations'->p_manifest_id::text;
  if m is null or m->>'actor_id' is distinct from p_actor_id::text or m->>'account_id' is distinct from p_account_id
    or m->>'batch_id' is distinct from p_batch_id::text or m->>'business_id' is distinct from p_business_id::text
    or m->>'plaid_env' is distinct from p_plaid_env or m->>'manifest_id' is distinct from p_manifest_id::text
    or m->>'created_at' is null or m->>'expires_at' is null then
    raise exception using errcode='22023',message='plaid_reconciliation_manifest_scope_invalid';
  end if;
  if m ? 'result' then
    if m->>'request_hash' is distinct from request_hash then raise exception using errcode='40001',message='plaid_reconciliation_confirmation_reused'; end if;
    return (m->'result')||jsonb_build_object('idempotent',true,'newly_released_count',0);
  end if;
  if (m->>'expires_at')::timestamptz<=clock_timestamp() or (m->>'created_at')::timestamptz+interval '5 minutes'<=clock_timestamp() then
    raise exception using errcode='40001',message='plaid_reconciliation_manifest_expired';
  end if;
  if exists(select 1 from public.business_profiles where id=p_business_id and auto_post_to_quickbooks is distinct from false) then
    raise exception using errcode='42501',message='plaid_reconciliation_disable_posting_required';
  end if;
  if exists(select 1 from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=b.plaid_item_id
    and (coalesce(sync_in_progress,false) or sync_lease_owner is not null)) then
    raise exception using errcode='40001',message='plaid_reconciliation_sync_lease_conflict';
  end if;
  perform 1 from public.plaid_recovery_batch_rows where business_id=p_business_id and batch_id=p_batch_id order by id for update;
  select array_agg(coalesce(admitted_transaction_id,(payload->>'transaction_id')::uuid)) into all_ids from public.plaid_recovery_batch_rows where business_id=p_business_id and batch_id=p_batch_id;
  perform 1 from public.bank_transactions where business_id=p_business_id and id=any(all_ids) order by id for update;
  perform 1 from public.transaction_categorizations where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bookkeeping_processing_requests where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.qbo_posted_transactions where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bookkeeping_posting_jobs where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bookkeeping_post_attempts where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=any(all_ids) order by id for update;
  perform 1 from public.bank_qbo_match_items where business_id=p_business_id and match_id in
    (select id from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=any(all_ids)) order by id for update;
  perform 1 from public.bank_qbo_match_history where business_id=p_business_id and match_id in
    (select id from public.bank_qbo_matches where business_id=p_business_id and bank_transaction_id=any(all_ids)) order by id for update;
  perform 1 from public.credit_card_payment_pairs where business_id=p_business_id and (checking_transaction_id=any(all_ids) or credit_card_transaction_id=any(all_ids)) order by id for update;
  perform 1 from public.credit_card_payment_pair_events where business_id=p_business_id and transaction_id=any(all_ids) order by id for update;
  current_snapshot:=public.plaid_residual_reconciliation_snapshot(p_business_id,p_plaid_env,p_account_id,p_batch_id);
  if current_snapshot->>'fingerprint' is distinct from m->'before'->>'fingerprint' then
    select coalesce(jsonb_agg(c->'transaction_id'),'[]') into changed_ids from jsonb_array_elements(current_snapshot->'rows') c
      where not exists(select 1 from jsonb_array_elements(m->'before'->'rows') old_row
        where old_row->>'transaction_id'=c->>'transaction_id' and old_row->>'evidence_fingerprint'=c->>'evidence_fingerprint');
    raise exception using errcode='40001',message='plaid_reconciliation_evidence_changed',
      detail=jsonb_build_object('classification','evidence_changed','changed_transaction_ids',changed_ids)::text;
  end if;
  if exists(select 1 from unnest(ids) id where not exists(select 1 from jsonb_array_elements(current_snapshot->'rows') row
    where row->>'transaction_id'=id::text and (row->>'releasable')::boolean)) then
    raise exception using errcode='40001',message='plaid_reconciliation_selected_row_blocked';
  end if;
  select coalesce(bool_or((row->>'requires_live_qbo_attestation')::boolean),false) into needs_attestation
    from jsonb_array_elements(current_snapshot->'rows') row where (row->>'transaction_id')::uuid=any(ids);
  if needs_attestation and p_attestation is null then
    raise exception using errcode='42501',message='plaid_reconciliation_live_qbo_attestation_required';
  end if;
  if p_attestation is not null and ((p_attestation->>'reviewed_at')::timestamptz < (m->>'created_at')::timestamptz
    or (p_attestation->>'reviewed_at')::timestamptz>clock_timestamp()) then
    raise exception using errcode='22023',message='plaid_reconciliation_attestation_time_invalid';
  end if;
  m:=m||jsonb_build_object('approved_ids',ids,'release_txid',txid_current()::text,'request_hash',request_hash,
    'attestation',p_attestation,'confirmed_by',p_actor_id,'confirmed_at',clock_timestamp());
  update public.plaid_recovery_batches set summary=jsonb_set(summary,array['residual_reconciliations',p_manifest_id::text],m) where id=p_batch_id;
  n:=public.clear_approved_plaid_residual_holds(p_business_id,p_batch_id,p_manifest_id,ids);
  if n<>cardinality(ids) then raise exception using errcode='40001',message='plaid_reconciliation_exact_hold_required'; end if;
  after_snapshot:=public.plaid_residual_reconciliation_snapshot(p_business_id,p_plaid_env,p_account_id,p_batch_id);
  if (after_snapshot->>'auto_post_disabled')::boolean is distinct from true then raise exception using errcode='40001',message='plaid_reconciliation_unexpected_side_effect'; end if;
  if exists(select 1 from jsonb_array_elements(current_snapshot->'rows') old_row
    join jsonb_array_elements(after_snapshot->'rows') new_row on old_row->>'transaction_id'=new_row->>'transaction_id'
    where old_row->>'non_hold_fingerprint' is distinct from new_row->>'non_hold_fingerprint') then
    raise exception using errcode='40001',message='plaid_reconciliation_unexpected_side_effect';
  end if;
  result:=jsonb_build_object('dry_run',false,'idempotent',false,'newly_released_count',n,'released_transaction_ids',ids,
    'batch_id',p_batch_id,'manifest_id',p_manifest_id,'business_id',p_business_id,'account_id',p_account_id,'actor_id',p_actor_id,
    'released_at',clock_timestamp(),'before',current_snapshot,'after',after_snapshot);
  m:=m||jsonb_build_object('result',result);
  update public.plaid_recovery_batches set summary=jsonb_set(summary,array['residual_reconciliations',p_manifest_id::text],m) where id=p_batch_id;
  return result;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.record_plaid_reconnect_verification(p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_actor_id uuid, p_expected_cursor text, p_accounts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare i public.plaid_items%rowtype; actual_ids text[]; known_ids text[]; new_accounts jsonb; s jsonb;
begin
  select * into i from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=p_plaid_item_id and is_active for update;
  if not found or p_actor_id is null then raise exception 'plaid_reconnect_scope_invalid'; end if;
  if i.cursor is distinct from p_expected_cursor or i.sync_lease_owner is not null or coalesce(i.sync_in_progress,false) then
    raise exception using errcode='40001',message='plaid_reconnect_sync_conflict'; end if;
  if jsonb_typeof(p_accounts)<>'array' or jsonb_array_length(p_accounts)=0 then raise exception 'plaid_reconnect_accounts_required'; end if;
  select array_agg(a->>'plaid_account_id' order by a->>'plaid_account_id') into actual_ids from jsonb_array_elements(p_accounts) a;
  select array_agg(pa.plaid_account_id order by pa.plaid_account_id) into known_ids from public.plaid_accounts pa
    where pa.business_id=p_business_id and pa.plaid_env=p_plaid_env and pa.plaid_item_id=p_plaid_item_id
      and pa.is_active and pa.disconnected_at is null and pa.connection_state not in ('disconnected','closed_historical')
      -- Retained prior IDs do not reopen an explicitly confirmed lineage review.
      -- Keep their history/mappings/state; never infer replacement from a mask.
      and not exists(select 1 from public.plaid_account_lineage_decisions l where l.business_id=p_business_id
        and l.plaid_env=p_plaid_env and l.status='confirmed' and l.prior_plaid_account_id=pa.plaid_account_id
        and l.replacement_plaid_account_id<>pa.plaid_account_id and l.physical_account_id=pa.physical_account_id
        and l.replacement_plaid_account_id=any(actual_ids) and not(pa.plaid_account_id=any(actual_ids)));
  select coalesce(jsonb_agg(a),'[]'::jsonb) into new_accounts from jsonb_array_elements(p_accounts) a
    where not exists(select 1 from public.plaid_accounts pa where pa.business_id=p_business_id and pa.plaid_env=p_plaid_env
      and pa.plaid_item_id=p_plaid_item_id and pa.plaid_account_id=a->>'plaid_account_id');
  if actual_ids is distinct from known_ids then
    -- Candidate discovery never resets prior operator decisions or maps accounts.
    insert into public.plaid_replacement_account_candidates(business_id,plaid_env,plaid_item_id,plaid_account_id,account_snapshot)
      select p_business_id,p_plaid_env,p_plaid_item_id,a->>'plaid_account_id',a from jsonb_array_elements(new_accounts) a
      on conflict(business_id,plaid_env,plaid_item_id,plaid_account_id) do nothing;
    s:=jsonb_build_object('state','identity_review_required','reason','replacement_card','verified_at',clock_timestamp(),
      'actor_id',p_actor_id,'provider_account_ids',actual_ids,'new_accounts',new_accounts);
  elsif i.reconnect_state->>'state'='completed' and i.error_code is null and i.status='connected' then
    return i.reconnect_state;
  elsif i.reconnect_state->>'state'='waiting_for_replay'
    and i.reconnect_state->>'cursor_input_sha256'=encode(sha256(convert_to(coalesce(i.cursor,''),'UTF8')),'hex') then
    return i.reconnect_state;
  else
    s:=jsonb_build_object('state','waiting_for_replay','verified_at',clock_timestamp(),'actor_id',p_actor_id,
      'provider_account_ids',actual_ids,'prior_error_code',i.error_code,
      'cursor_input_sha256',encode(sha256(convert_to(coalesce(i.cursor,''),'UTF8')),'hex'));
  end if;
  update public.plaid_items set reconnect_state=s where id=i.id;
  return s;
end $function$
;
CREATE OR REPLACE FUNCTION public.guard_plaid_reconnect_sync_lease()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if new.sync_lease_owner is not null and new.sync_lease_owner is distinct from old.sync_lease_owner
    and old.reconnect_state->>'state' in ('identity_review_required','new_item_identity_required') then return null; end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.finish_plaid_reconnect_checkpoint()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare i public.plaid_items%rowtype;
begin
  if new.status<>'completed' or old.status='completed' or not(new.meta ? 'admitted_count') then return new; end if;
  select * into i from public.plaid_items where business_id=new.business_id and plaid_item_id=new.plaid_item_id for update;
  if i.reconnect_state->>'state'<>'waiting_for_replay' or i.reconnect_state->>'state' is null then return new; end if;
  if new.started_at<(i.reconnect_state->>'verified_at')::timestamptz
    or new.meta->>'cursor_input_sha256' is distinct from i.reconnect_state->>'cursor_input_sha256'
    or new.meta->>'next_cursor_sha256' is distinct from encode(sha256(convert_to(coalesce(i.cursor,''),'UTF8')),'hex') then
    raise exception using errcode='40001',message='plaid_reconnect_checkpoint_evidence_conflict'; end if;
  update public.plaid_accounts set connection_state='connected',connection_state_version=connection_state_version+1,
    last_sync_at=new.finished_at,updated_at=new.finished_at
    where business_id=i.business_id and plaid_env=i.plaid_env and plaid_item_id=i.plaid_item_id
      and is_active and disconnected_at is null and connection_state='attention_required'
      and i.reconnect_state->'provider_account_ids' ? plaid_account_id;
  update public.plaid_items set reconnect_state=reconnect_state||jsonb_build_object('state','completed',
    'checkpoint_run_id',new.id,'checkpoint_at',new.finished_at,'continuity','replay_completed_no_proven_gap') where id=i.id;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.plaid_bounded_recovery_fingerprint(p_business_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select encode(sha256(convert_to(jsonb_build_array(
    (select jsonb_agg(to_jsonb(t) order by id) from public.bank_transactions t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.transaction_categorizations t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.qbo_posted_transactions t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.plaid_accounts t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.plaid_account_lineage_decisions t where business_id=p_business_id),
    (select jsonb_agg(to_jsonb(t) order by id) from public.plaid_qbo_account_mappings t where business_id=p_business_id)
  )::text,'UTF8')),'hex');
$function$
;
CREATE OR REPLACE FUNCTION public.admit_handled_auto_post(p_business_id uuid, p_enabled boolean DEFAULT NULL::boolean, p_grace_hours numeric DEFAULT 24, p_limit integer DEFAULT 2000, p_preview boolean DEFAULT false, p_ids uuid[] DEFAULT NULL::uuid[], p_preview_hash text DEFAULT NULL::text, p_repair_anchor timestamp with time zone DEFAULT NULL::timestamp with time zone, p_env text DEFAULT 'production'::text, p_preview_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_actor uuid DEFAULT NULL::uuid, p_effective_date date DEFAULT NULL::date, p_source text DEFAULT 'enable'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare p public.business_profiles; plan jsonb; anchor timestamptz; due timestamptz; fingerprint text; n integer; eligible integer; blocked integer; existing integer; changed integer; expected integer; reasons jsonb; corrected integer;
begin
 if p_business_id is null or p_limit is null or p_limit not between 1 and 2000 or p_grace_hours is null or p_grace_hours<=0 or p_grace_hours>168
   or p_env is null or p_env not in ('production','sandbox') or p_source is null or p_source not in ('enable','handled','settled','repair') or p_preview is null then raise exception 'invalid_admission_parameters'; end if;
 if p_preview then select * into strict p from public.business_profiles where id=p_business_id;
 else select * into strict p from public.business_profiles where id=p_business_id for update; end if;
 if p_ids is not null and (cardinality(p_ids)=0 or cardinality(p_ids)>p_limit or cardinality(p_ids)<>(select count(distinct id) from unnest(p_ids) id)) then raise exception 'invalid_admission_ids'; end if;
 if p_ids is not null and (select count(*) from public.transaction_categorizations where business_id=p_business_id and transaction_id=any(p_ids))<>cardinality(p_ids) then raise exception 'cross_business_or_unknown_ids'; end if;
 if not p_preview and p_enabled=false then
  update public.business_profiles set auto_post_to_quickbooks=false where id=p_business_id returning * into p;
  return jsonb_build_object('ok',true,'enabled',false,'auto_post_to_quickbooks',false,'auto_post_effective_date',p.auto_post_effective_date,'auto_post_scope_mode',p.auto_post_scope_mode,'auto_post_enabled_at',p.auto_post_enabled_at,'state','complete','scheduled',0,'evaluated',0,'already_scheduled',0,'technically_blocked',0,'retryable_failure_count',0);
 end if;
 if p_source in ('handled','settled','repair') and p_ids is null then raise exception 'bounded_ids_required'; end if;
 if p_source='repair' and (p_actor is null or p_repair_anchor is null) then raise exception 'approved_repair_anchor_required'; end if;
 if p_source<>'enable' and not coalesce(p.auto_post_to_quickbooks,false) then
  return jsonb_build_object('ok',true,'enabled',false,'auto_post_to_quickbooks',false,'state','paused','scheduled',0,'evaluated',0,'retryable_failure_count',0);
 end if;
 if p_repair_anchor is not null and (p_repair_anchor<statement_timestamp()-interval '5 minutes' or p_repair_anchor>statement_timestamp()) then raise exception 'repair_anchor_requires_fresh_approval'; end if;
 anchor:=case when p_source='repair' then p_repair_anchor when p_source in ('handled','settled') then statement_timestamp()
   when not coalesce(p.auto_post_to_quickbooks,false) then statement_timestamp() else p.auto_post_enabled_at end;
 due:=anchor+p_grace_hours*interval '1 hour';
 -- Materialize the entire bounded plan against ONE statement snapshot. Later
 -- mapping/hold/period changes are allowed; execution validation is mandatory.
 with candidates as materialized (
  select c.*,public.auto_post_technical_block(c,p_env,null,p_effective_date) as gate_reason,
   encode(sha256(convert_to(to_jsonb(c)::text||coalesce(to_jsonb(b)::text,''),'UTF8')),'hex') as row_hash
  from public.transaction_categorizations c join public.bank_transactions b on b.business_id=c.business_id and b.id=c.transaction_id
  where c.business_id=p_business_id and (p_ids is null or c.transaction_id=any(p_ids))
   and (p_ids is not null or (c.status in ('approved','auto_approved','handled') and c.qbo_txn_id is null and c.posted_at is null))
  order by c.transaction_id limit p_limit+1
 ) select coalesce(jsonb_agg(jsonb_build_object('transaction_id',transaction_id,'updated_at',updated_at,'status',status,'row_hash',row_hash,
   'reason',case when status='failed' then 'failed_requires_existing_retry_workflow' when post_after is not null then 'already_scheduled' else gate_reason end,'post_after',post_after,'previous_safe',meta->'safe_to_auto_post','previous_error',post_error) order by transaction_id),'[]') into plan from candidates;
 n:=jsonb_array_length(plan);
 if n>p_limit then return jsonb_build_object('ok',false,'enabled',p.auto_post_to_quickbooks,'auto_post_to_quickbooks',p.auto_post_to_quickbooks,'state','terminal','error','backlog_limit_exceeded','evaluated',0,'scheduled',0,'retryable_failure_count',0,'limit',p_limit); end if;
 select count(*) filter(where r->>'reason' is null),count(*) filter(where r->>'reason'='already_scheduled'),count(*) filter(where r->>'reason' is not null and r->>'reason'<>'already_scheduled'),
 count(*) filter(where r->>'reason' is null and (r->>'previous_safe' is distinct from 'true' or r->>'previous_error' is not null))
 into eligible,existing,blocked,corrected from jsonb_array_elements(plan) r;
 select coalesce(jsonb_object_agg(reason,count),'{}') into reasons from (select r->>'reason' reason,count(*) from jsonb_array_elements(plan) r where r->>'reason' is not null and r->>'reason'<>'already_scheduled' group by 1) a;
 if p_preview then p_preview_at:=statement_timestamp(); end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('business',p_business_id,'rows',plan,'source',p_source,'anchor',case when p_source='repair' then anchor end,'grace',p_grace_hours,'effective_date',p_effective_date,'env',p_env,'at',p_preview_at,'actor',p_actor)::text,'UTF8')),'hex');
 if p_preview then return jsonb_build_object('ok',true,'state','preview','rows',plan,'preview_hash',fingerprint,'preview_at',p_preview_at,'evaluated',n,'eligible',eligible,'already_scheduled',existing,'technically_blocked',blocked,'reason_counts',reasons,'post_after',due); end if;
 -- Idempotent replay must be the SAME approved manifest, not arbitrary IDs that
 -- happen to have schedules. It never changes an existing deadline.
 if p_source='repair' and existing=n and n>0 and not exists(select 1 from public.transaction_categorizations c where c.business_id=p_business_id and c.transaction_id=any(p_ids) and c.meta#>>'{auto_post_admission,manifest}' is distinct from p_preview_hash) then
  return jsonb_build_object('ok',true,'enabled',true,'auto_post_to_quickbooks',true,'state','complete','evaluated',n,'scheduled',0,'already_scheduled',existing,'technically_blocked',0,'retryable_failure_count',0);
 end if;
 if p_source='repair' or p_effective_date is not null then
  if p_preview_hash is null or p_preview_at is null or p_preview_at<statement_timestamp()-interval '5 minutes' or p_preview_at>statement_timestamp()
    or p_preview_hash is distinct from fingerprint then raise exception 'stale_or_changed_admission_preview'; end if;
 end if;
 if eligible>0 and (anchor is null or due<=statement_timestamp()) then return jsonb_build_object('ok',false,'enabled',p.auto_post_to_quickbooks,'auto_post_to_quickbooks',p.auto_post_to_quickbooks,'state','terminal','error','approved_fresh_repair_anchor_required','scheduled',0,'evaluated',n,'retryable_failure_count',0); end if;
 -- Policy and every evaluated row commit or roll back together. A concurrent
 -- categorization edit causes 40001; only this narrow caller retries the RPC.
 if p_source='enable' then
  update public.business_profiles set auto_post_to_quickbooks=true,auto_post_enabled_at=anchor,
   auto_post_effective_date=coalesce(p_effective_date,case when p.auto_post_to_quickbooks then p.auto_post_effective_date end),auto_post_scope_mode=case when coalesce(p_effective_date,case when p.auto_post_to_quickbooks then p.auto_post_effective_date end) is null then 'new_activity_only' else 'effective_date' end,
   historical_backlog_status='none' where id=p_business_id returning * into p;
 end if;
 select count(*) into expected from jsonb_array_elements(plan) r where r->>'post_after' is null and r->>'status' in ('approved','auto_approved','handled');
 with updates as (
  update public.transaction_categorizations c set
   post_after=case when r->>'reason' is null then due else c.post_after end,
   post_error=case when r->>'reason' is null then null else c.post_error end,
   status=case when r->>'reason' is null and c.status='handled' then 'approved' else c.status end,
   meta=public.auto_post_admission_meta(
    case when r->>'reason' is null then (coalesce(c.meta,'{}')-'post_block_reason'-'auto_post_block_reason'-'pending')||'{"safe_to_auto_post":true}'::jsonb else c.meta end,
    jsonb_build_object('state',case when r->>'reason' is null then 'scheduled' else 'blocked' end,'source',p_source,'at',statement_timestamp(),'anchor',anchor,
      'reason',r->>'reason','previous_safe',c.meta->'safe_to_auto_post','previous_status',c.status,'previous_error',c.post_error,'actor',p_actor,'manifest',p_preview_hash)),
   updated_at=statement_timestamp()
  from jsonb_array_elements(plan) r where c.business_id=p_business_id and c.transaction_id=(r->>'transaction_id')::uuid
   and c.updated_at=(r->>'updated_at')::timestamptz and c.status=r->>'status' and c.post_after is null and c.status in ('approved','auto_approved','handled')
  returning c.transaction_id
 ) select count(*) into changed from updates;
 if changed<>expected then raise exception using errcode='40001',message='admission_snapshot_changed'; end if;
 if exists(select 1 from jsonb_array_elements(plan) r where r->>'reason' is null and not exists(select 1 from public.bookkeeping_posting_jobs j where j.business_id=p_business_id and j.transaction_id=(r->>'transaction_id')::uuid and j.state='scheduled' and j.scheduled_at=due)) then raise exception 'durable_posting_job_missing'; end if;
 return jsonb_build_object('ok',true,'enabled',true,'auto_post_to_quickbooks',true,'auto_post_effective_date',p.auto_post_effective_date,'auto_post_scope_mode',p.auto_post_scope_mode,'auto_post_enabled_at',p.auto_post_enabled_at,'state','complete','event_at',anchor,'post_after',case when eligible>0 then due end,'posting_grace_hours',p_grace_hours,
  'evaluated',n,'scheduled',eligible,'scheduled_backlog_count',eligible,'handled_backlog_count',n,'already_scheduled',existing,'technically_blocked',blocked,'reason_counts',reasons,'stale_state_corrected',corrected,'retryable_failure_count',0);
end $function$
;
CREATE OR REPLACE FUNCTION public.validate_plaid_bounded_recovery(p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_actor_id uuid, p_context jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare i public.plaid_items%rowtype; a public.plaid_accounts%rowtype; cp public.bank_sync_runs%rowtype;
  start_date date; end_date date;
begin
  perform public.assert_plaid_recovery_operator(p_actor_id);
  if jsonb_typeof(p_context)<>'object' or p_context - array['reason','account_id','start_date','end_date','checkpoint_run_id','gap_evidence'] <> '{}'::jsonb then
    raise exception 'plaid_recovery_safe_context_required'; end if;
  perform 1 from public.business_profiles where id=p_business_id and auto_post_to_quickbooks is false for update;
  if not found then raise exception 'plaid_recovery_disable_posting_required'; end if;
  select * into i from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=p_plaid_item_id and is_active for update;
  if not found or i.sync_lease_owner is not null or coalesce(i.sync_in_progress,false) then raise exception 'plaid_recovery_sync_conflict'; end if;
  select * into a from public.plaid_accounts where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=p_plaid_item_id and plaid_account_id=p_context->>'account_id' and is_active
    and disconnected_at is null and connection_state='connected';
  if not found or a.physical_account_id is null then raise exception 'plaid_recovery_confirmed_account_required'; end if;
  if not exists(select 1 from public.plaid_qbo_account_mappings where business_id=p_business_id
    and plaid_account_id=a.plaid_account_id and qbo_account_id is not null) then raise exception 'plaid_recovery_mapping_required'; end if;
  start_date:=(p_context->>'start_date')::date; end_date:=(p_context->>'end_date')::date;
  if start_date is null or end_date is null or end_date<start_date or end_date-start_date>366 or end_date>current_date then
    raise exception 'plaid_recovery_exact_range_required'; end if;
  -- Evidence is an operator assertion of an authoritative document/history;
  -- the range is explicit. A maximum local transaction date proves nothing.
  if p_context->>'reason' not in ('replacement_card','institution_migration','reconnect_gap') or p_context->>'reason' is null
    or p_context->'gap_evidence'->>'kind' not in ('statement','provider_history','operator_verified_document')
    or p_context->'gap_evidence'->>'kind' is null
    or coalesce(p_context->'gap_evidence'->>'reference_sha256','') !~ '^[a-f0-9]{64}$'
    or (p_context->'gap_evidence') - array['kind','reference_sha256'] <> '{}'::jsonb then
    raise exception 'plaid_recovery_authoritative_evidence_required'; end if;
  if p_context->>'reason'='reconnect_gap' then
    select * into cp from public.bank_sync_runs where business_id=p_business_id and plaid_item_id=p_plaid_item_id
      order by started_at desc,id desc limit 1;
    if i.reconnect_state->>'state' is distinct from 'completed' or cp.status is distinct from 'completed'
      or cp.id::text is distinct from p_context->>'checkpoint_run_id' or not(cp.meta ? 'admitted_count')
      or cp.finished_at<(i.reconnect_state->>'checkpoint_at')::timestamptz then
      raise exception 'plaid_recovery_successful_replay_required'; end if;
  elsif coalesce(i.reconnect_state->>'state','') not in ('identity_confirmed','completed') or not exists(
    select 1 from public.plaid_account_lineage_decisions where business_id=p_business_id and plaid_env=p_plaid_env
      and replacement_plaid_account_id=a.plaid_account_id and physical_account_id=a.physical_account_id and status='confirmed') then
    raise exception 'plaid_recovery_lineage_required';
  end if;
  return jsonb_build_object('physical_account_id',a.physical_account_id,'evidence_fingerprint',public.plaid_bounded_recovery_fingerprint(p_business_id));
end $function$
;
CREATE OR REPLACE FUNCTION public.stage_plaid_bounded_recovery(p_business_id uuid, p_plaid_env text, p_plaid_item_id text, p_actor_id uuid, p_context jsonb, p_fingerprint text, p_rows jsonb, p_summary jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare evidence jsonb; b public.plaid_recovery_batches%rowtype; i public.plaid_items%rowtype; context_hash text;
begin
  evidence:=public.validate_plaid_bounded_recovery(p_business_id,p_plaid_env,p_plaid_item_id,p_actor_id,p_context);
  if evidence->>'evidence_fingerprint' is distinct from p_fingerprint then raise exception 'plaid_recovery_evidence_changed'; end if;
  select * into i from public.plaid_items where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id;
  context_hash:=encode(sha256(convert_to(p_context::text,'UTF8')),'hex');
  select * into b from public.plaid_recovery_batches where business_id=p_business_id and plaid_env=p_plaid_env and plaid_item_id=p_plaid_item_id
    and summary->>'workflow_kind'='reviewed_recovery' and summary->>'context_hash'=context_hash
    and status in ('preview_ready','imported_held') order by created_at desc limit 1;
  if found then
    if b.status='imported_held' or (b.summary->>'evidence_fingerprint'=p_fingerprint
      and (b.summary->>'preview_at')::timestamptz+interval '5 minutes'>clock_timestamp()) then
      return jsonb_build_object('batch_id',b.id,'status',b.status,'summary',b.summary,'posting_hold',true,'reused',true);
    end if;
    update public.plaid_recovery_batches set status='abandoned' where id=b.id;
  end if;
  if exists(select 1 from public.plaid_recovery_batches where business_id=p_business_id and plaid_env=p_plaid_env
    and plaid_item_id=p_plaid_item_id and status in ('preview_ready','imported_held')
    and summary->>'workflow_kind' is distinct from 'residual_orphan' and posting_hold) then
    raise exception 'plaid_recovery_existing_cohort_requires_review'; end if;
  insert into public.plaid_recovery_batches(business_id,plaid_env,plaid_item_id,original_cursor,staged_next_cursor,cutoff_date,status,posting_hold,created_by,summary)
    values(p_business_id,p_plaid_env,p_plaid_item_id,i.cursor,i.cursor,(p_context->>'start_date')::date-1,'preview_ready',true,p_actor_id,
      p_summary||jsonb_build_object('workflow_kind','reviewed_recovery','recovery_reason',p_context->>'reason','context',p_context,
        'context_hash',context_hash,'preview_at',clock_timestamp(),'evidence_fingerprint',p_fingerprint,
        'before',jsonb_build_object('account_id',p_context->>'account_id'))) returning * into b;
  insert into public.plaid_recovery_batch_rows(batch_id,business_id,change_type,disposition,plaid_transaction_id,pending_transaction_id,
    plaid_account_id,physical_account_id,transaction_date,authorized_date,amount,signed_amount,pending,payload)
    select b.id,p_business_id,'added',r->>'disposition',r->>'plaid_transaction_id',r->>'pending_transaction_id',
      p_context->>'account_id',(evidence->>'physical_account_id')::uuid,(r->>'transaction_date')::date,(r->>'authorized_date')::date,
      (r->>'amount')::numeric,(r->>'signed_amount')::numeric,(r->>'pending')::boolean,r->'payload'
    from jsonb_array_elements(p_rows) r;
  update public.plaid_items set replacement_recovery_status='preview_ready',replacement_recovery_account_id=p_context->>'account_id',
    replacement_recovery_cutoff_date=b.cutoff_date where id=i.id;
  return jsonb_build_object('batch_id',b.id,'status',b.status,'summary',b.summary,'posting_hold',true,'reused',false);
end $function$
;
CREATE OR REPLACE FUNCTION public.admit_plaid_recovery_batch(p_business_id uuid, p_batch_id uuid, p_plaid_item_id text, p_selected_row_ids uuid[], p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch public.plaid_recovery_batches%rowtype;
  v_item public.plaid_items%rowtype;
  v_admitted integer := 0;
  v_blocked integer := 0;
  v_selected integer := 0;
begin
  perform public.assert_plaid_recovery_operator(p_actor_user_id);
  if coalesce(cardinality(p_selected_row_ids),0) = 0 then raise exception 'recovery_selection_required'; end if;
  select count(distinct x) into v_selected from unnest(p_selected_row_ids) x;
  if v_selected <> cardinality(p_selected_row_ids) then raise exception 'duplicate_recovery_row_selection'; end if;

  select * into v_batch from public.plaid_recovery_batches
   where id=p_batch_id and business_id=p_business_id and plaid_item_id=p_plaid_item_id for update;
  if not found then raise exception 'recovery_batch_not_found'; end if;
  if v_batch.status='imported_held' then
    if v_batch.summary->>'workflow_kind'='reviewed_recovery' and not(
      v_batch.summary->'selected_row_ids' @> to_jsonb(p_selected_row_ids)
      and to_jsonb(p_selected_row_ids) @> (v_batch.summary->'selected_row_ids')) then
      raise exception 'plaid_recovery_admission_selection_reused'; end if;
    return jsonb_build_object('batch_id',p_batch_id,'status','imported_held','posting_hold',true,
      'admitted',coalesce((v_batch.summary->>'admitted')::integer,0),'reused',true);
  end if;
  if v_batch.status<>'preview_ready' then raise exception 'recovery_batch_not_ready'; end if;

  select * into v_item from public.plaid_items where business_id=p_business_id and plaid_env=v_batch.plaid_env
    and plaid_item_id=p_plaid_item_id and is_active is true for update;
  if not found or v_item.replacement_recovery_status not in ('ready_for_preview','preview_ready')
    or v_item.replacement_recovery_account_id is null then raise exception 'recovery_workflow_not_active'; end if;

  select count(*) into v_blocked from public.plaid_recovery_batch_rows
   where batch_id=p_batch_id and business_id=p_business_id and disposition in ('probable_duplicate','ambiguous');
  if v_blocked>0 then raise exception 'recovery_batch_requires_review'; end if;
  select count(*) into v_blocked from public.plaid_recovery_batch_rows
   where id=any(p_selected_row_ids) and batch_id=p_batch_id and business_id=p_business_id
     and plaid_account_id=v_item.replacement_recovery_account_id and disposition='new_after_cutoff';
  if v_blocked<>v_selected then raise exception 'invalid_recovery_row_selection'; end if;
  select count(*) into v_blocked from public.plaid_recovery_batch_rows r
  join public.bank_transactions bt on bt.business_id=p_business_id
    and bt.plaid_env=v_batch.plaid_env and bt.plaid_transaction_id=r.plaid_transaction_id
  where r.id=any(p_selected_row_ids) and r.batch_id=p_batch_id and r.business_id=p_business_id;
  if v_blocked>0 then raise exception 'recovery_selection_no_longer_eligible'; end if;

  if v_batch.summary->>'workflow_kind'='residual_orphan' then raise exception 'recovery_batch_not_ready'; end if;
  if v_batch.summary->>'workflow_kind'='reviewed_recovery' then
    perform public.validate_plaid_bounded_recovery(p_business_id,v_batch.plaid_env,p_plaid_item_id,p_actor_user_id,v_batch.summary->'context');
    if (v_batch.summary->>'preview_at')::timestamptz+interval '5 minutes'<=clock_timestamp()
      or v_item.cursor is distinct from v_batch.original_cursor
      or public.plaid_bounded_recovery_fingerprint(p_business_id) is distinct from v_batch.summary->>'evidence_fingerprint' then
      raise exception 'plaid_recovery_preview_evidence_changed'; end if;
  end if;

  insert into public.bank_transactions (
    business_id,plaid_item_id,plaid_env,plaid_account_id,physical_account_id,plaid_transaction_id,
    pending_transaction_id,name,merchant_name,plaid_amount_raw,amount,signed_amount,direction,
    iso_currency_code,unofficial_currency_code,date,authorized_date,pending,payment_channel,
    transaction_type,check_number,category_primary,category_detailed,category_confidence,
    personal_finance_category,location,counterparties,plaid_last_modified_at,last_seen_at,
    is_archived,raw,updated_at,plaid_recovery_batch_id,canonical_source
  )
  select r.business_id,v_batch.plaid_item_id,v_batch.plaid_env,r.plaid_account_id,pa.physical_account_id,
    r.plaid_transaction_id,r.pending_transaction_id,
    coalesce(r.payload->'transaction'->>'name',r.payload->'transaction'->>'merchant_name','Transaction'),
    r.payload->'transaction'->>'merchant_name',coalesce((r.payload->'transaction'->>'amount')::numeric,0),
    r.amount,r.signed_amount,case when r.signed_amount>0 then 'INFLOW' when r.signed_amount<0 then 'OUTFLOW' else 'UNKNOWN' end,
    r.payload->'transaction'->>'iso_currency_code',r.payload->'transaction'->>'unofficial_currency_code',r.transaction_date,r.authorized_date,r.pending,
    r.payload->'transaction'->>'payment_channel',r.payload->'transaction'->>'transaction_type',r.payload->'transaction'->>'check_number',
    r.payload->'transaction'->'personal_finance_category'->>'primary',r.payload->'transaction'->'personal_finance_category'->>'detailed',
    r.payload->'transaction'->'personal_finance_category'->>'confidence_level',r.payload->'transaction'->'personal_finance_category',
    r.payload->'transaction'->'location',r.payload->'transaction'->'counterparties',
    nullif(coalesce(r.payload->'transaction'->>'timestamp',r.payload->'transaction'->>'datetime'),'')::timestamptz,
    now(),false,r.payload->'transaction',now(),p_batch_id,'plaid_replacement_recovery'
  from public.plaid_recovery_batch_rows r join public.plaid_accounts pa on pa.business_id=r.business_id
    and pa.plaid_env=v_batch.plaid_env and pa.plaid_account_id=r.plaid_account_id and pa.is_active is true
  where r.id=any(p_selected_row_ids) and r.batch_id=p_batch_id and r.business_id=p_business_id
    and r.plaid_account_id=v_item.replacement_recovery_account_id and r.disposition='new_after_cutoff'
    and not exists (select 1 from public.bank_transactions bt where bt.business_id=p_business_id
      and bt.plaid_env=v_batch.plaid_env and bt.plaid_transaction_id=r.plaid_transaction_id);
  get diagnostics v_admitted=row_count;
  if v_admitted<>v_selected then raise exception 'recovery_admission_count_mismatch'; end if;

  update public.plaid_recovery_batch_rows r set admitted_transaction_id=bt.id from public.bank_transactions bt
   where r.id=any(p_selected_row_ids) and r.batch_id=p_batch_id and r.business_id=p_business_id
    and bt.business_id=p_business_id and bt.plaid_env=v_batch.plaid_env and bt.plaid_transaction_id=r.plaid_transaction_id;
  insert into public.transaction_categorizations (business_id,transaction_id,status,posting_hold_batch_id,meta,updated_at)
  select p_business_id,r.admitted_transaction_id,'needs_review',p_batch_id,
    jsonb_build_object('plaid_recovery_batch_id',p_batch_id,'recovery_admitted_by',p_actor_user_id),now()
  from public.plaid_recovery_batch_rows r where r.id=any(p_selected_row_ids) and r.batch_id=p_batch_id
    and r.business_id=p_business_id and r.admitted_transaction_id is not null
  on conflict (business_id,transaction_id) do update set posting_hold_batch_id=p_batch_id,updated_at=now();

  if v_batch.summary->>'workflow_kind'='reviewed_recovery' then
    perform public.ensure_plaid_transaction_categorizations(p_business_id,
      array(select admitted_transaction_id from public.plaid_recovery_batch_rows where batch_id=p_batch_id and id=any(p_selected_row_ids)));
    insert into public.bookkeeping_processing_requests(business_id,transaction_id,scope,status,priority,metadata)
      select p_business_id,admitted_transaction_id,'transaction','pending',10,
        jsonb_build_object('source','plaid_reviewed_recovery','recovery_batch_id',p_batch_id)
      from public.plaid_recovery_batch_rows where batch_id=p_batch_id and id=any(p_selected_row_ids);
    update public.plaid_recovery_batches set summary=summary||jsonb_build_object('applied_at',now(),'applied_count',v_admitted)
      where id=p_batch_id and business_id=p_business_id;
  end if;
  update public.plaid_items set cursor=case when v_batch.summary->>'workflow_kind'='reviewed_recovery' then cursor else v_batch.staged_next_cursor end,replacement_recovery_status='imported_held',updated_at=now()
   where business_id=p_business_id and plaid_env=v_batch.plaid_env and plaid_item_id=p_plaid_item_id;
  update public.plaid_recovery_batches set status='imported_held',posting_hold=true,
    summary=summary||jsonb_build_object('admitted',v_admitted,'selected',v_selected,'quarantined',
      greatest(coalesce((summary->>'new_after_cutoff')::integer,0)-v_selected,0),'selected_row_ids',to_jsonb(p_selected_row_ids),
      'admitted_at',now(),'admitted_by',p_actor_user_id),updated_at=now()
   where id=p_batch_id and business_id=p_business_id;
  return jsonb_build_object('batch_id',p_batch_id,'status','imported_held','posting_hold',true,
    'admitted',v_admitted,'selected',v_selected,'quarantined',greatest(coalesce((v_batch.summary->>'new_after_cutoff')::integer,0)-v_selected,0));
end $function$
;
CREATE OR REPLACE FUNCTION public.approve_bookkeeping_with_admission(p_business_id uuid, p_actor_id uuid, p_actor_type text, p_approvals jsonb, p_require_needs_review boolean DEFAULT true)
 RETURNS SETOF transaction_categorizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare a jsonb; approvals jsonb:='[]'; current_row public.transaction_categorizations;
begin
 if jsonb_typeof(p_approvals) is distinct from 'array' or jsonb_array_length(p_approvals) not between 1 and 2000 then raise exception 'bounded_approvals_required'; end if;
 for a in select value from jsonb_array_elements(p_approvals) order by value->>'transaction_id' loop
  perform 1 from public.bank_transactions where business_id=p_business_id and id=(a->>'transaction_id')::uuid for update;
  if not found then raise exception 'approval_transaction_not_found'; end if;
  select * into current_row from public.transaction_categorizations where business_id=p_business_id and transaction_id=(a->>'transaction_id')::uuid for update;
  if a->>'status'='failed' then
   a:=jsonb_set(a,'{post_after}',coalesce(to_jsonb(current_row.post_after),'null'::jsonb));
   a:=jsonb_set(a,'{meta}',(coalesce(a->'meta','{}')-'auto_post_admission')||case when current_row.meta ? 'auto_post_admission' then jsonb_build_object('auto_post_admission',current_row.meta->'auto_post_admission') else '{}'::jsonb end);
  end if;
  if current_row.post_after is not null then
   a:=jsonb_set(a,'{post_after}',to_jsonb(current_row.post_after));
   a:=jsonb_set(a,'{meta}',(coalesce(a->'meta','{}')-'auto_post_admission')||case when current_row.meta ? 'auto_post_admission' then jsonb_build_object('auto_post_admission',current_row.meta->'auto_post_admission') else '{}'::jsonb end);
  end if;
  approvals:=approvals||jsonb_build_array(a);
 end loop;
 return query select * from public.approve_bookkeeping_transactions_atomic(p_business_id,p_actor_id,p_actor_type,approvals,p_require_needs_review);
end $function$
;
CREATE OR REPLACE FUNCTION public.auto_post_admission_meta(p_meta jsonb, p_entry jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare m jsonb:=coalesce(p_meta,'{}'); old jsonb:=coalesce(p_meta->'auto_post_admission','{}'); recent jsonb; e jsonb; n bigint;
begin
  e:=jsonb_build_object('state',case when p_entry->>'state' in ('pending','retry','blocked','scheduled') then p_entry->>'state' else 'blocked' end,
    'source',left(coalesce(p_entry->>'source','handled'),24),'at',left(p_entry->>'at',40),'anchor',left(p_entry->>'anchor',40),
    'reason',case when p_entry->>'reason' ~ '^[a-z0-9_]{1,80}$' then p_entry->>'reason' else null end,
    'previous_safe',case when jsonb_typeof(p_entry->'previous_safe')='boolean' then p_entry->'previous_safe' else 'null'::jsonb end,
    'previous_status',left(p_entry->>'previous_status',24),'previous_error',case when p_entry->>'previous_error' ~ '^[a-z0-9_]{1,80}$' then p_entry->>'previous_error' else null end,
    'actor',left(p_entry->>'actor',36),'manifest',left(p_entry->>'manifest',64));
  -- Re-whitelist even retained entries; malformed/oversize old data cannot grow
  -- this owned namespace. Summaries are counts, never arbitrary reason maps.
  select coalesce(jsonb_agg(v order by ord),'[]') into recent from (
    select v,ord from jsonb_array_elements(case when jsonb_typeof(old->'recent')='array' then old->'recent' else '[]'::jsonb end || jsonb_build_array(e)) with ordinality a(v,ord)
    where octet_length(v::text)<=768 order by ord desc limit 4
  ) r;
  n:=case when old->>'total' ~ '^[0-9]{1,10}$' then least((old->>'total')::bigint,2147483646) else 0 end + 1;
  old:=e||jsonb_build_object('version',2,'recent',recent,'total',n,'older_compacted',greatest(0,n-jsonb_array_length(recent)));
  if octet_length(old::text)>4096 then old:=e||jsonb_build_object('version',2,'recent',jsonb_build_array(e),'total',n,'older_compacted',n-1); end if;
  if octet_length(old::text)>4096 then raise exception 'admission_evidence_budget_exceeded'; end if;
  return jsonb_set(m,'{auto_post_admission}',old,true);
end $function$
;
CREATE OR REPLACE FUNCTION public.check_auto_post_technical_integrity(p_business_id uuid, p_transaction_id uuid, p_env text DEFAULT 'production'::text, p_context jsonb DEFAULT NULL::jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare c public.transaction_categorizations; pair public.credit_card_payment_pairs; leg uuid; b public.bank_transactions; ctx jsonb; reason text;
begin
 if p_context is null then return 'posting_execution_identity_required'; end if;
 if p_context->>'business_id' is distinct from p_business_id::text
   or p_context->>'transaction_id' is distinct from p_transaction_id::text
   or p_context->>'env' is distinct from p_env then return 'posting_execution_identity_changed'; end if;
 if nullif(p_context->>'pair_id','') is not null then
  select * into pair from public.credit_card_payment_pairs where business_id=p_business_id and id=(p_context->>'pair_id')::uuid;
  if pair.id is null or pair.status<>'posting' or pair.qbo_txn_id is not null or pair.request_id is distinct from p_context->>'request_id'
   or pair.idempotency_key is distinct from p_context->>'idempotency_key' or pair.posting_started_at is distinct from (p_context->>'claimed_at')::timestamptz
   or pair.lease_expires_at is distinct from (p_context->>'lease_expires_at')::timestamptz or not(pair.lease_expires_at>statement_timestamp())
   or p_transaction_id not in (pair.checking_transaction_id,pair.credit_card_transaction_id) then return 'foreign_or_stale_posting_lease'; end if;
  if pair.checking_qbo_account_id is distinct from p_context->>'from_account_id' or pair.credit_card_qbo_account_id is distinct from p_context->>'to_account_id'
   or pair.amount is distinct from (p_context->>'pair_amount')::numeric or pair.payment_date::text is distinct from p_context->>'pair_date' then return 'posting_payload_changed'; end if;
  foreach leg in array array[pair.checking_transaction_id,pair.credit_card_transaction_id] loop
   select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=leg;
   select * into b from public.bank_transactions where business_id=p_business_id and id=leg;
   if c.transaction_id is null or b.id is null then return 'bank_transaction_missing'; end if;
   if abs(b.amount) is distinct from pair.amount or (leg=pair.checking_transaction_id and b.date is distinct from pair.payment_date) then return 'posting_payload_changed'; end if;
   if c.meta->>'posting_execution_owner' is distinct from p_context->>'owner' or c.meta->>'posting_execution_request_id' is distinct from p_context->>'request_id' or nullif(p_context->>'owner','') is null then return 'foreign_or_stale_posting_lease'; end if;
   if exists(select 1 from public.qbo_posted_transactions r where r.business_id=p_business_id and r.transaction_id=leg) then return 'existing_provider_intent_or_receipt'; end if;
   select p_context||v||jsonb_build_object('business_id',p_business_id,'transaction_id',leg,'final_account_id',c.final_qbo_account_id,'source_account_id',case when leg=pair.checking_transaction_id then pair.checking_qbo_account_id else pair.credit_card_qbo_account_id end) into ctx from jsonb_array_elements(p_context->'legs') v where v->>'id'=leg::text;
   if ctx is null then return 'posting_payload_changed'; end if;
   reason:=public.auto_post_technical_block(c,p_env,ctx,null);
   if reason is not null then return reason; end if;
  end loop;
  return null;
 end if;
 select * into c from public.transaction_categorizations where business_id=p_business_id and transaction_id=p_transaction_id;
 if c.transaction_id is null then return 'bank_transaction_missing'; end if;
 return public.auto_post_technical_block(c,p_env,p_context,null);
end $function$
;
alter table public."user_profiles" add constraint "users_pkey" PRIMARY KEY (id);
alter table public."business_profiles" add constraint "business_profiles_pkey" PRIMARY KEY (id);
alter table public."user_business_link" add constraint "user_business_link_pkey" PRIMARY KEY (id);
alter table public."quickbooks_tokens" add constraint "quickbooks_tokens_pkey" PRIMARY KEY (id);
alter table public."subscriptions" add constraint "subscriptions_pkey" PRIMARY KEY (id);
alter table public."business_billing" add constraint "business_billing_pkey" PRIMARY KEY (business_id);
alter table public."plaid_items" add constraint "plaid_items_pkey" PRIMARY KEY (id);
alter table public."plaid_accounts" add constraint "plaid_accounts_pkey" PRIMARY KEY (id);
alter table public."bank_transactions" add constraint "bank_transactions_pkey" PRIMARY KEY (id);
alter table public."transaction_categorizations" add constraint "transaction_categorizations_pkey" PRIMARY KEY (id);
alter table public."qbo_posted_transactions" add constraint "qbo_posted_transactions_pkey" PRIMARY KEY (id);
alter table public."bank_sync_runs" add constraint "bank_sync_runs_pkey" PRIMARY KEY (id);
alter table public."plaid_qbo_account_mappings" add constraint "plaid_qbo_account_mappings_pkey" PRIMARY KEY (id);
alter table public."clarification_requests" add constraint "clarification_requests_pkey" PRIMARY KEY (id);
alter table public."bookkeeping_post_attempts" add constraint "bookkeeping_post_attempts_pkey" PRIMARY KEY (id);
alter table public."financial_monthly_review_stamps" add constraint "financial_monthly_review_stamps_pkey" PRIMARY KEY (id);
alter table public."monthly_review_runs" add constraint "monthly_review_runs_pkey" PRIMARY KEY (id);
alter table public."plaid_physical_accounts" add constraint "plaid_physical_accounts_pkey" PRIMARY KEY (id);
alter table public."qbo_accounts_cache" add constraint "qbo_accounts_cache_pkey" PRIMARY KEY (id);
alter table public."bizzi_vendors" add constraint "bizzi_vendors_pkey" PRIMARY KEY (id);
alter table public."bookkeeping_processing_requests" add constraint "bookkeeping_processing_requests_pkey" PRIMARY KEY (id);
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_pkey" PRIMARY KEY (id);
alter table public."operator_request_summaries" add constraint "operator_request_summaries_pkey" PRIMARY KEY (business_id);
alter table public."internal_staff_users" add constraint "internal_staff_users_pkey" PRIMARY KEY (user_id);
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_pkey" PRIMARY KEY (id);
alter table public."internal_admin_view_sessions" add constraint "internal_admin_view_sessions_pkey" PRIMARY KEY (id);
alter table public."accounting_period_closes" add constraint "accounting_period_closes_pkey" PRIMARY KEY (id);
alter table public."bookkeeping_auto_post_backlog_releases" add constraint "bookkeeping_auto_post_backlog_releases_pkey" PRIMARY KEY (id);
alter table public."bank_qbo_matches" add constraint "bank_qbo_matches_pkey" PRIMARY KEY (id);
alter table public."bank_qbo_match_items" add constraint "bank_qbo_match_items_pkey" PRIMARY KEY (id);
alter table public."bank_qbo_match_history" add constraint "bank_qbo_match_history_pkey" PRIMARY KEY (id);
alter table public."bookkeeping_lifecycle_events" add constraint "bookkeeping_lifecycle_events_pkey" PRIMARY KEY (id);
alter table public."credit_card_payment_pair_events" add constraint "credit_card_payment_pair_events_pkey" PRIMARY KEY (id);
alter table public."bookkeeping_exclusion_events" add constraint "bookkeeping_exclusion_events_pkey" PRIMARY KEY (id);
alter table public."bookkeeping_approval_events" add constraint "bookkeeping_approval_events_pkey" PRIMARY KEY (id);
alter table public."bookkeeping_posting_jobs" add constraint "bookkeeping_posting_jobs_pkey" PRIMARY KEY (id);
alter table public."plaid_recovery_batches" add constraint "plaid_recovery_batches_pkey" PRIMARY KEY (id);
alter table public."plaid_recovery_batch_rows" add constraint "plaid_recovery_batch_rows_pkey" PRIMARY KEY (id);
alter table public."plaid_account_lineage_decisions" add constraint "plaid_account_lineage_decisions_pkey" PRIMARY KEY (id);
alter table public."plaid_replacement_account_candidates" add constraint "plaid_replacement_account_candidates_pkey" PRIMARY KEY (id);
alter table public."pending_transaction_resolution_events" add constraint "pending_transaction_resolution_events_pkey" PRIMARY KEY (id);
alter table public."plaid_account_connection_audit" add constraint "plaid_account_connection_audit_pkey" PRIMARY KEY (id);
alter table public."business_financial_reporting_config" add constraint "business_financial_reporting_config_pkey" PRIMARY KEY (business_id);
alter table public."business_financial_reporting_config_audit" add constraint "business_financial_reporting_config_audit_pkey" PRIMARY KEY (id);
alter table public."plaid_physical_accounts" add constraint "plaid_physical_accounts_business_id_id_uq" UNIQUE (business_id, id);
alter table public."quickbooks_tokens" add constraint "quickbooks_tokens_business_id_key" UNIQUE (business_id);
alter table public."financial_monthly_review_stamps" add constraint "financial_monthly_review_stamps_unique_month" UNIQUE (business_id, review_month);
alter table public."monthly_review_runs" add constraint "monthly_review_runs_unique_month" UNIQUE (business_id, review_month);
alter table public."bizzi_vendors" add constraint "bizzi_vendors_business_id_id_uq" UNIQUE (business_id, id);
alter table public."qbo_accounts_cache" add constraint "qbo_accounts_cache_business_id_qbo_env_realm_id_qbo_account_key" UNIQUE (business_id, qbo_env, realm_id, qbo_account_id);
alter table public."bank_transactions" add constraint "bank_transactions_business_id_id_key" UNIQUE (business_id, id);
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_month_version_unique" UNIQUE (business_id, review_year, review_month, snapshot_version);
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_business_id_id_unique" UNIQUE (business_id, id);
alter table public."bookkeeping_approval_events" add constraint "bookkeeping_approval_events_idempotency_unique" UNIQUE (business_id, idempotency_key);
alter table public."bookkeeping_posting_jobs" add constraint "bookkeeping_posting_jobs_business_transaction_uq" UNIQUE (business_id, transaction_id);
alter table public."plaid_recovery_batches" add constraint "plaid_recovery_batches_business_id_plaid_env_plaid_item_id__key" UNIQUE (business_id, plaid_env, plaid_item_id, id);
alter table public."plaid_recovery_batch_rows" add constraint "plaid_recovery_batch_rows_batch_id_change_type_plaid_transa_key" UNIQUE (batch_id, change_type, plaid_transaction_id);
alter table public."plaid_account_lineage_decisions" add constraint "plaid_account_lineage_decisio_business_id_plaid_env_replace_key" UNIQUE (business_id, plaid_env, replacement_plaid_account_id);
alter table public."plaid_replacement_account_candidates" add constraint "plaid_replacement_account_can_business_id_plaid_env_plaid_i_key" UNIQUE (business_id, plaid_env, plaid_item_id, plaid_account_id);
alter table public."pending_transaction_resolution_events" add constraint "pending_transaction_resolution__business_id_idempotency_key_key" UNIQUE (business_id, idempotency_key);
alter table public."plaid_account_connection_audit" add constraint "plaid_account_connection_audi_business_id_plaid_account_id__key" UNIQUE (business_id, plaid_account_id, request_id);
alter table public."business_financial_reporting_config_audit" add constraint "business_financial_reporting_config__business_id_request_id_key" UNIQUE (business_id, request_id);
alter table public."quickbooks_tokens" add constraint "quickbooks_tokens_qbo_env_check" CHECK (qbo_env = ANY (ARRAY['sandbox'::text, 'production'::text]));
alter table public."plaid_items" add constraint "plaid_items_status_check" CHECK (status = ANY (ARRAY['connected'::text, 'error'::text, 'reauth_required'::text, 'disconnected'::text]));
alter table public."transaction_categorizations" add constraint "transaction_categorizations_conf_check" CHECK (confidence IS NULL OR (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])));
alter table public."qbo_posted_transactions" add constraint "qbo_posted_transactions_env_check" CHECK (qbo_env = ANY (ARRAY['sandbox'::text, 'production'::text]));
alter table public."bank_transactions" add constraint "bank_transactions_direction_check" CHECK (direction IS NULL OR (direction = ANY (ARRAY['INFLOW'::text, 'OUTFLOW'::text, 'UNKNOWN'::text])));
alter table public."bank_transactions" add constraint "bank_transactions_counterparty_conf_check" CHECK (counterparty_confidence IS NULL OR (counterparty_confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])));
alter table public."bank_transactions" add constraint "bank_transactions_qbo_entity_type_check" CHECK (qbo_entity_type IS NULL OR (qbo_entity_type = ANY (ARRAY['vendor'::text, 'customer'::text])));
alter table public."bank_transactions" add constraint "bank_transactions_counterparty_source_check" CHECK (counterparty_source IS NULL OR (counterparty_source = ANY (ARRAY['plaid_merchant'::text, 'plaid_counterparty'::text, 'memo_parse'::text, 'qbo_match'::text, 'user_override'::text])));
alter table public."plaid_qbo_account_mappings" add constraint "plaid_qbo_account_mappings_type_check" CHECK (qbo_account_type = ANY (ARRAY['Bank'::text, 'CreditCard'::text, 'Other'::text]));
alter table public."clarification_requests" add constraint "clarification_requests_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'answered'::text, 'expired'::text, 'dismissed'::text]));
alter table public."clarification_requests" add constraint "clarification_requests_reason_code_check" CHECK (reason_code = ANY (ARRAY['low_confidence'::text, 'missing_vendor'::text, 'check'::text, 'suspense'::text, 'no_safe_default'::text, 'other'::text]));
alter table public."clarification_requests" add constraint "clarification_requests_answered_by_check" CHECK (answered_by IS NULL OR (answered_by = ANY (ARRAY['user'::text, 'bizzi'::text])));
alter table public."financial_monthly_review_stamps" add constraint "financial_monthly_review_stamps_status_check" CHECK (status = ANY (ARRAY['completed'::text, 'closed'::text, 'finalized'::text]));
alter table public."financial_monthly_review_stamps" add constraint "financial_monthly_review_stamps_month_start" CHECK (review_month = date_trunc('month'::text, review_month::timestamp with time zone)::date);
alter table public."monthly_review_runs" add constraint "monthly_review_runs_status_check" CHECK (status = ANY (ARRAY['in_progress'::text, 'ready_to_finalize'::text, 'finalized'::text, 'reopened'::text]));
alter table public."monthly_review_runs" add constraint "monthly_review_runs_month_start" CHECK (review_month = date_trunc('month'::text, review_month::timestamp with time zone)::date);
alter table public."business_profiles" add constraint "business_profiles_onboarding_status_check" CHECK (onboarding_status = ANY (ARRAY['in_progress'::text, 'complete'::text]));
alter table public."plaid_physical_accounts" add constraint "plaid_physical_accounts_confidence_check" CHECK (confidence = ANY (ARRAY['high'::text, 'probable'::text, 'manual'::text]));
alter table public."plaid_physical_accounts" add constraint "plaid_physical_accounts_status_check" CHECK (status = ANY (ARRAY['active'::text, 'disconnected'::text, 'merged'::text, 'needs_confirmation'::text]));
alter table public."bizzi_vendors" add constraint "bizzi_vendors_status_check" CHECK (status = ANY (ARRAY['active'::text, 'needs_review'::text, 'merged'::text, 'disabled'::text]));
alter table public."bizzi_vendors" add constraint "bizzi_vendors_confidence_check" CHECK (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]));
alter table public."bizzi_vendors" add constraint "bizzi_vendors_evidence_type_check" CHECK (primary_evidence_type = ANY (ARRAY['qbo_vendor_id'::text, 'qbo_display_name'::text, 'plaid_merchant_entity_id'::text, 'plaid_merchant_name'::text, 'plaid_counterparty_name'::text, 'approved_alias'::text, 'memo_prefix'::text, 'manual'::text]));
alter table public."qbo_posted_transactions" add constraint "qbo_posted_transactions_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'unknown'::text, 'posted'::text, 'failed'::text, 'voided'::text]));
alter table public."bookkeeping_processing_requests" add constraint "bookkeeping_processing_requests_scope_check" CHECK (scope = ANY (ARRAY['transaction'::text, 'backlog'::text]));
alter table public."bookkeeping_processing_requests" add constraint "bookkeeping_processing_requests_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'dead_letter'::text, 'skipped'::text]));
alter table public."bookkeeping_processing_requests" add constraint "bookkeeping_processing_requests_transaction_scope_check" CHECK (scope = 'transaction'::text AND transaction_id IS NOT NULL OR scope = 'backlog'::text AND transaction_id IS NULL);
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_amount_check" CHECK (amount > 0::numeric);
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_status_check" CHECK (status = ANY (ARRAY['needs_review'::text, 'confirmed'::text, 'posting'::text, 'posted'::text, 'failed'::text, 'voided'::text]));
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_match_confidence_check" CHECK (match_confidence = ANY (ARRAY['manual'::text, 'high'::text, 'ambiguous'::text, 'low'::text]));
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_distinct_legs" CHECK (credit_card_transaction_id IS NULL OR checking_transaction_id <> credit_card_transaction_id);
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_qbo_type" CHECK (qbo_txn_type IS NULL OR qbo_txn_type = 'Transfer'::text);
alter table public."operator_request_summaries" add constraint "operator_request_summaries_accounting_needs_review_count_check" CHECK (accounting_needs_review_count >= 0);
alter table public."operator_request_summaries" add constraint "operator_request_summaries_outstanding_count_check" CHECK (outstanding_count >= 0);
alter table public."operator_request_summaries" add constraint "operator_request_summaries_answered_awaiting_review_count_check" CHECK (answered_awaiting_review_count >= 0);
alter table public."operator_request_summaries" add constraint "operator_request_summaries_reconciliation_status_check" CHECK (reconciliation_status = ANY (ARRAY['ok'::text, 'error'::text]));
alter table public."internal_staff_users" add constraint "internal_staff_users_role_check" CHECK (role = ANY (ARRAY['owner_admin'::text, 'accountant'::text, 'operator'::text]));
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_review_year_check" CHECK (review_year >= 2000 AND review_year <= 2100);
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_review_month_check" CHECK (review_month >= 1 AND review_month <= 12);
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_snapshot_version_check" CHECK (snapshot_version >= 1);
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_source_range_check" CHECK (source_end_date >= source_start_date);
alter table public."internal_admin_view_sessions" add constraint "internal_admin_view_sessions_staff_role_check" CHECK (staff_role = ANY (ARRAY['owner_admin'::text, 'accountant'::text, 'operator'::text]));
alter table public."internal_admin_view_sessions" add constraint "internal_admin_view_sessions_read_only_check" CHECK (read_only IS TRUE);
alter table public."internal_admin_view_sessions" add constraint "internal_admin_view_sessions_source_check" CHECK (length(TRIM(BOTH FROM source)) > 0);
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_status_check" CHECK (status = ANY (ARRAY['building'::text, 'validated'::text, 'current'::text, 'superseded'::text, 'invalidated'::text, 'failed'::text]));
alter table public."accounting_period_closes" add constraint "accounting_period_closes_approved_requires_snapshot" CHECK (status <> 'approved'::text OR authority_type IS NOT NULL AND approved_snapshot_id IS NOT NULL);
alter table public."accounting_period_closes" add constraint "accounting_period_closes_month_start" CHECK (period_month = date_trunc('month'::text, period_month::timestamp with time zone)::date);
alter table public."accounting_period_closes" add constraint "accounting_period_closes_status_check" CHECK (status = ANY (ARRAY['open'::text, 'close_requested'::text, 'refreshing_snapshot'::text, 'review_required'::text, 'ready_for_approval'::text, 'approved'::text, 'reopen_required'::text, 'failed'::text]));
alter table public."accounting_period_closes" add constraint "accounting_period_closes_authority_type_check" CHECK (authority_type IS NULL OR (authority_type = ANY (ARRAY['historical_import'::text, 'admin_approved'::text])));
alter table public."accounting_period_closes" add constraint "accounting_period_closes_admin_approval_fields" CHECK (authority_type <> 'admin_approved'::text OR approved_by IS NOT NULL AND approved_at IS NOT NULL);
alter table public."accounting_period_closes" add constraint "accounting_period_closes_historical_not_admin_approved" CHECK (authority_type <> 'historical_import'::text OR approved_by IS NULL AND source IS NOT NULL);
alter table public."accounting_period_closes" add constraint "accounting_period_closes_pending_count_nonnegative" CHECK (pending_transaction_count_at_close IS NULL OR pending_transaction_count_at_close >= 0);
alter table public."accounting_period_closes" add constraint "accounting_period_closes_version_positive" CHECK (close_version > 0);
alter table public."business_profiles" add constraint "business_profiles_historical_backlog_status_check" CHECK (historical_backlog_status = ANY (ARRAY['none'::text, 'review_required'::text, 'released'::text, 'paused'::text]));
alter table public."bookkeeping_auto_post_backlog_releases" add constraint "bookkeeping_auto_post_backlog_releases_status_check" CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text]));
alter table public."bookkeeping_auto_post_backlog_releases" add constraint "bookkeeping_auto_post_backlog_releases_scope_check" CHECK (release_start_date IS NOT NULL OR release_end_date IS NOT NULL OR cardinality(transaction_ids) > 0);
alter table public."business_profiles" add constraint "business_profiles_auto_post_scope_mode_check" CHECK (auto_post_scope_mode = ANY (ARRAY['new_activity_only'::text, 'effective_date'::text]));
alter table public."bank_qbo_matches" add constraint "bank_qbo_matches_status_check" CHECK (status = ANY (ARRAY['candidate'::text, 'needs_confirmation'::text, 'ambiguous'::text, 'confirmed'::text, 'rejected'::text, 'superseded'::text, 'reversed'::text, 'match_check_unavailable'::text]));
alter table public."bank_qbo_matches" add constraint "bank_qbo_matches_confidence_tier_check" CHECK (confidence_tier = ANY (ARRAY['tier_1'::text, 'tier_2'::text, 'tier_3'::text, 'tier_4'::text, 'unavailable'::text]));
alter table public."bank_qbo_matches" add constraint "bank_qbo_matches_bank_account_match_check" CHECK (bank_account_match = ANY (ARRAY['verified_same_account'::text, 'unverified_mapping'::text, 'candidate_account_mismatch'::text, 'unavailable'::text]));
alter table public."bank_qbo_match_items" add constraint "bank_qbo_match_items_evidence_role_check" CHECK (evidence_role = ANY (ARRAY['primary'::text, 'linked_context'::text, 'supporting'::text]));
alter table public."bank_qbo_matches" add constraint "bank_qbo_matches_match_type_check" CHECK (match_type = ANY (ARRAY['qbo_deposit'::text, 'qbo_payment_direct'::text, 'qbo_sales_receipt_direct'::text, 'qbo_payment_with_invoice_context'::text, 'qbo_invoice_only_context'::text, 'qbo_processing_fee_expense'::text, 'processor_net_settlement'::text, 'unavailable'::text]));
alter table public."bank_qbo_match_items" add constraint "bank_qbo_match_items_qbo_entity_type_check" CHECK (qbo_entity_type = ANY (ARRAY['Deposit'::text, 'Payment'::text, 'SalesReceipt'::text, 'Invoice'::text, 'Purchase'::text, 'Expense'::text, 'Check'::text, 'CreditCardCharge'::text, 'Bill'::text]));
alter table public."credit_card_payment_pair_events" add constraint "credit_card_payment_pair_events_event_type_check" CHECK (event_type = ANY (ARRAY['confirmed'::text, 'undone'::text]));
alter table public."transaction_categorizations" add constraint "transaction_categorizations_posting_status_check" CHECK (posting_status = ANY (ARRAY['not_scheduled'::text, 'scheduled'::text, 'posting'::text, 'posting_failed'::text, 'posted'::text]));
alter table public."transaction_categorizations" add constraint "transaction_categorizations_review_status_check" CHECK (review_status = ANY (ARRAY['needs_review'::text, 'handled'::text, 'matched'::text]));
alter table public."bookkeeping_exclusion_events" add constraint "bookkeeping_exclusion_events_event_type_check" CHECK (event_type = ANY (ARRAY['exclusion_requested'::text, 'exclusion_completed'::text, 'exclusion_rejected_concurrent_processing'::text, 'restored'::text, 'pending_transaction_replaced'::text, 'finalized_replacement_reopened'::text]));
alter table public."transaction_categorizations" add constraint "transaction_categorizations_status_check" CHECK (status = ANY (ARRAY['uncategorized'::text, 'needs_review'::text, 'approved'::text, 'auto_approved'::text, 'posted'::text, 'failed'::text, 'ignored'::text, 'handled'::text, 'matched'::text, 'matched_existing_qbo'::text, 'excluded'::text]));
alter table public."bookkeeping_approval_events" add constraint "bookkeeping_approval_events_actor_type_check" CHECK (actor_type = ANY (ARRAY['user'::text, 'admin'::text, 'system'::text, 'automation'::text]));
alter table public."bookkeeping_posting_jobs" add constraint "bookkeeping_posting_jobs_state_check" CHECK (state = ANY (ARRAY['scheduled'::text, 'retry_scheduled'::text, 'processing'::text, 'reconciling'::text, 'blocked'::text, 'failed'::text, 'posted'::text, 'cancelled'::text]));
alter table public."plaid_items" add constraint "plaid_items_plaid_env_check" CHECK (plaid_env = ANY (ARRAY['sandbox'::text, 'development'::text, 'production'::text]));
alter table public."plaid_accounts" add constraint "plaid_accounts_plaid_env_check" CHECK (plaid_env = ANY (ARRAY['sandbox'::text, 'development'::text, 'production'::text]));
alter table public."internal_admin_view_sessions" add constraint "internal_admin_view_sessions_capabilities_check" CHECK (capabilities <@ ARRAY['admin_bookkeeping_write'::text]);
alter table public."bank_sync_runs" add constraint "bank_sync_runs_status_check" CHECK (status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'abandoned'::text, 'ok'::text, 'error'::text]));
alter table public."plaid_recovery_batches" add constraint "plaid_recovery_batches_status_check" CHECK (status = ANY (ARRAY['staging'::text, 'preview_ready'::text, 'lineage_confirmation_required'::text, 'imported_held'::text, 'released'::text, 'failed'::text, 'abandoned'::text]));
alter table public."plaid_recovery_batch_rows" add constraint "plaid_recovery_batch_rows_change_type_check" CHECK (change_type = ANY (ARRAY['added'::text, 'modified'::text, 'removed'::text]));
alter table public."plaid_recovery_batch_rows" add constraint "plaid_recovery_batch_rows_disposition_check" CHECK (disposition = ANY (ARRAY['exact_existing'::text, 'pending_replacement'::text, 'represented'::text, 'historical_discrepancy'::text, 'new_after_cutoff'::text, 'probable_duplicate'::text, 'ambiguous'::text, 'removed_existing'::text]));
alter table public."plaid_account_lineage_decisions" add constraint "plaid_account_lineage_decisions_status_check" CHECK (status = ANY (ARRAY['confirmed'::text, 'reversed'::text]));
alter table public."plaid_replacement_account_candidates" add constraint "plaid_replacement_account_candidates_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text]));
alter table public."plaid_items" add constraint "plaid_items_replacement_recovery_status_check" CHECK (replacement_recovery_status IS NULL OR (replacement_recovery_status = ANY (ARRAY['awaiting_account_selection'::text, 'lineage_confirmation_required'::text, 'ready_for_preview'::text, 'preview_ready'::text, 'imported_held'::text, 'released'::text, 'failed'::text])));
alter table public."bank_transactions" add constraint "bank_transactions_pending_resolution_state_check" CHECK (pending_resolution_state IS NULL OR (pending_resolution_state = ANY (ARRAY['recent_pending'::text, 'stale_pending_check_required'::text, 'posted_replacement_found'::text, 'authorization_expired_or_removed'::text, 'operator_settlement_confirmation_required'::text, 'promoted_to_settled'::text, 'excluded_pending_authorization'::text, 'linked_to_posted_replacement'::text])));
alter table public."plaid_account_connection_audit" add constraint "plaid_account_connection_audit_next_state_check" CHECK (next_state = ANY (ARRAY['connected'::text, 'disconnected'::text]));
alter table public."plaid_accounts" add constraint "plaid_accounts_connection_state_check" CHECK (connection_state = ANY (ARRAY['connected'::text, 'attention_required'::text, 'disconnected'::text, 'closed_historical'::text]));
alter table public."business_financial_reporting_config" add constraint "business_financial_reporting_config_status_check" CHECK (status = ANY (ARRAY['unconfigured'::text, 'verified'::text, 'invalidated'::text]));
alter table public."business_financial_reporting_config" add constraint "business_reporting_config_verified_fields" CHECK (status <> 'verified'::text OR qbo_realm_id IS NOT NULL AND btrim(qbo_realm_id) <> ''::text AND reporting_timezone IS NOT NULL AND btrim(reporting_timezone) <> ''::text AND home_currency IS NOT NULL AND home_currency ~ '^[A-Z]{3}$'::text AND provider_schema_version IS NOT NULL AND btrim(provider_schema_version) <> ''::text AND realm_verified_at IS NOT NULL AND currency_verified_at IS NOT NULL AND timezone_confirmed_at IS NOT NULL AND verified_at IS NOT NULL AND verification_source IS NOT NULL AND btrim(verification_source) <> ''::text);
alter table public."business_financial_reporting_config_audit" add constraint "business_financial_reporting_config_a_verification_source_check" CHECK (btrim(verification_source) <> ''::text);
alter table public."business_financial_reporting_config_audit" add constraint "business_financial_reporting_config_audit_action_check" CHECK (action = ANY (ARRAY['verify_qbo_identity'::text, 'verify_currency'::text, 'confirm_timezone'::text, 'activate'::text, 'invalidate'::text, 'auto_initialize'::text]));
CREATE INDEX bank_txn_business_pending_txn_idx ON public.bank_transactions USING btree (business_id, pending_transaction_id);
CREATE INDEX bank_txn_business_fingerprint_active_idx ON public.bank_transactions USING btree (business_id, duplicate_fingerprint) WHERE (is_archived = false);
CREATE UNIQUE INDEX plaid_accounts_business_account_uq ON public.plaid_accounts USING btree (business_id, plaid_account_id);
CREATE INDEX plaid_accounts_business_item_idx ON public.plaid_accounts USING btree (business_id, plaid_item_id);
CREATE UNIQUE INDEX bank_transactions_business_plaid_txn_uq ON public.bank_transactions USING btree (business_id, plaid_transaction_id);
CREATE INDEX bank_transactions_business_account_date_idx ON public.bank_transactions USING btree (business_id, plaid_account_id, date DESC);
CREATE INDEX bank_transactions_business_pending_idx ON public.bank_transactions USING btree (business_id, pending);
CREATE INDEX bank_txn_business_pending_txn_active_idx ON public.bank_transactions USING btree (business_id, pending_transaction_id) WHERE ((is_archived = false) AND (pending_transaction_id IS NOT NULL));
CREATE INDEX business_billing_status_idx ON public.business_billing USING btree (subscription_status);
CREATE INDEX business_billing_customer_idx ON public.business_billing USING btree (stripe_customer_id);
CREATE INDEX business_billing_subscription_idx ON public.business_billing USING btree (stripe_subscription_id);
CREATE UNIQUE INDEX txn_categ_business_txn_uq ON public.transaction_categorizations USING btree (business_id, transaction_id);
CREATE INDEX txn_categ_business_status_idx ON public.transaction_categorizations USING btree (business_id, status);
CREATE INDEX txn_categ_meta_gin_idx ON public.transaction_categorizations USING gin (meta);
CREATE UNIQUE INDEX qbo_posted_transactions_business_txn_uq ON public.qbo_posted_transactions USING btree (business_id, transaction_id);
CREATE INDEX qbo_posted_transactions_business_status_idx ON public.qbo_posted_transactions USING btree (business_id, status);
CREATE INDEX qbo_posted_transactions_business_posted_at_idx ON public.qbo_posted_transactions USING btree (business_id, posted_at DESC);
CREATE INDEX bank_txn_business_date_amount_idx ON public.bank_transactions USING btree (business_id, date DESC, amount);
CREATE INDEX monthly_review_runs_business_month_idx ON public.monthly_review_runs USING btree (business_id, review_month DESC);
CREATE UNIQUE INDEX plaid_items_business_item_uq ON public.plaid_items USING btree (business_id, plaid_item_id);
CREATE INDEX plaid_items_business_idx ON public.plaid_items USING btree (business_id);
CREATE INDEX bank_sync_runs_business_item_started_idx ON public.bank_sync_runs USING btree (business_id, plaid_item_id, started_at DESC);
CREATE INDEX txn_categ_business_post_after_idx ON public.transaction_categorizations USING btree (business_id, post_after);
CREATE INDEX txn_categ_status_post_after_idx ON public.transaction_categorizations USING btree (status, post_after);
CREATE INDEX txn_categ_qbo_txn_id_idx ON public.transaction_categorizations USING btree (qbo_txn_id);
CREATE INDEX bank_txn_business_counterparty_idx ON public.bank_transactions USING btree (business_id, counterparty_name);
CREATE INDEX bank_txn_business_qbo_entity_idx ON public.bank_transactions USING btree (business_id, qbo_entity_type, qbo_entity_id);
CREATE INDEX bank_txn_business_merchant_entity_idx ON public.bank_transactions USING btree (business_id, merchant_entity_id);
CREATE INDEX plaid_items_sync_in_progress_idx ON public.plaid_items USING btree (sync_in_progress);
CREATE INDEX user_profiles_full_name_idx ON public.user_profiles USING btree (full_name);
CREATE INDEX idx_quickbooks_tokens_company_name ON public.quickbooks_tokens USING btree (company_name);
CREATE INDEX idx_quickbooks_tokens_business_id ON public.quickbooks_tokens USING btree (business_id);
CREATE UNIQUE INDEX quickbooks_tokens_business_id_unique ON public.quickbooks_tokens USING btree (business_id);
CREATE UNIQUE INDEX quickbooks_tokens_business_id_uidx ON public.quickbooks_tokens USING btree (business_id);
CREATE UNIQUE INDEX quickbooks_tokens_business_env_uq ON public.quickbooks_tokens USING btree (business_id, qbo_env);
CREATE UNIQUE INDEX plaid_qbo_account_mappings_business_plaid_uq ON public.plaid_qbo_account_mappings USING btree (business_id, plaid_account_id);
CREATE INDEX plaid_qbo_account_mappings_business_idx ON public.plaid_qbo_account_mappings USING btree (business_id);
CREATE INDEX transaction_categorizations_business_reconciled_at_idx ON public.transaction_categorizations USING btree (business_id, reconciled_at DESC);
CREATE INDEX bookkeeping_post_attempts_business_transaction_idx ON public.bookkeeping_post_attempts USING btree (business_id, transaction_id);
CREATE INDEX bookkeeping_post_attempts_business_attempted_at_idx ON public.bookkeeping_post_attempts USING btree (business_id, attempted_at DESC);
CREATE INDEX bookkeeping_post_attempts_business_status_idx ON public.bookkeeping_post_attempts USING btree (business_id, status);
CREATE INDEX txn_categ_business_txn_date_idx ON public.transaction_categorizations USING btree (business_id, txn_date DESC);
CREATE INDEX txn_categ_business_txn_name_idx ON public.transaction_categorizations USING btree (business_id, txn_name);
CREATE INDEX txn_categ_business_signed_amount_idx ON public.transaction_categorizations USING btree (business_id, signed_amount);
CREATE INDEX plaid_accounts_business_connected_at_idx ON public.plaid_accounts USING btree (business_id, connected_at DESC);
CREATE INDEX plaid_accounts_business_last_sync_at_idx ON public.plaid_accounts USING btree (business_id, last_sync_at DESC);
CREATE UNIQUE INDEX clarification_requests_business_txn_uq ON public.clarification_requests USING btree (business_id, transaction_id);
CREATE INDEX clarification_requests_business_status_idx ON public.clarification_requests USING btree (business_id, status);
CREATE INDEX clarification_requests_business_created_at_idx ON public.clarification_requests USING btree (business_id, created_at DESC);
CREATE INDEX clarification_requests_business_reason_code_idx ON public.clarification_requests USING btree (business_id, reason_code);
CREATE INDEX clarification_requests_business_txn_idx ON public.clarification_requests USING btree (business_id, transaction_id);
CREATE INDEX idx_plaid_items_business_active ON public.plaid_items USING btree (business_id, is_active);
CREATE INDEX idx_plaid_accounts_business_active ON public.plaid_accounts USING btree (business_id, is_active);
CREATE INDEX idx_bank_transactions_business_archived ON public.bank_transactions USING btree (business_id, is_archived);
CREATE INDEX idx_transaction_categorizations_business_archived ON public.transaction_categorizations USING btree (business_id, is_archived);
CREATE INDEX monthly_review_runs_active_editor_idx ON public.monthly_review_runs USING btree (active_editor_expires_at) WHERE (active_editor_expires_at IS NOT NULL);
CREATE INDEX financial_monthly_review_stamps_business_month_idx ON public.financial_monthly_review_stamps USING btree (business_id, review_month DESC);
CREATE INDEX bank_transactions_business_date_id_idx ON public.bank_transactions USING btree (business_id, date DESC, id);
CREATE INDEX business_billing_business_name_idx ON public.business_billing USING btree (business_name);
CREATE INDEX business_billing_customer_user_idx ON public.business_billing USING btree (customer_user_id);
CREATE INDEX business_billing_customer_email_idx ON public.business_billing USING btree (customer_email);
CREATE INDEX business_billing_display_status_idx ON public.business_billing USING btree (billing_display_status);
CREATE INDEX user_profiles_billing_business_idx ON public.user_profiles USING btree (billing_business_id);
CREATE INDEX user_profiles_billing_customer_idx ON public.user_profiles USING btree (billing_stripe_customer_id);
CREATE INDEX user_profiles_billing_status_idx ON public.user_profiles USING btree (billing_subscription_status);
CREATE UNIQUE INDEX subscriptions_business_id_key ON public.subscriptions USING btree (business_id);
CREATE INDEX subscriptions_status_idx ON public.subscriptions USING btree (status);
CREATE INDEX quickbooks_tokens_realm_env_idx ON public.quickbooks_tokens USING btree (realm_id, qbo_env) WHERE ((is_active = true) AND (status = 'active'::text) AND (realm_id IS NOT NULL));
CREATE UNIQUE INDEX quickbooks_tokens_active_realm_env_uidx ON public.quickbooks_tokens USING btree (realm_id, qbo_env) WHERE ((is_active = true) AND (status = 'active'::text) AND (realm_id IS NOT NULL));
CREATE INDEX business_profiles_onboarding_status_idx ON public.business_profiles USING btree (onboarding_status);
CREATE INDEX business_profiles_onboarding_completed_at_idx ON public.business_profiles USING btree (onboarding_completed_at) WHERE (onboarding_completed_at IS NOT NULL);
CREATE INDEX bank_transactions_business_plaid_env_idx ON public.bank_transactions USING btree (business_id, plaid_env);
CREATE INDEX business_profiles_bookkeeping_start_date_idx ON public.business_profiles USING btree (bookkeeping_start_date) WHERE (bookkeeping_start_date IS NOT NULL);
CREATE INDEX plaid_physical_accounts_business_idx ON public.plaid_physical_accounts USING btree (business_id);
CREATE INDEX plaid_physical_accounts_lookup_idx ON public.plaid_physical_accounts USING btree (business_id, plaid_env, institution_id, account_mask, account_type, account_subtype) WHERE ((institution_id IS NOT NULL) AND (account_mask IS NOT NULL));
CREATE INDEX plaid_physical_accounts_current_plaid_idx ON public.plaid_physical_accounts USING btree (business_id, current_plaid_account_id) WHERE (current_plaid_account_id IS NOT NULL);
CREATE INDEX plaid_accounts_physical_account_idx ON public.plaid_accounts USING btree (business_id, physical_account_id) WHERE (physical_account_id IS NOT NULL);
CREATE INDEX bank_txn_business_physical_account_idx ON public.bank_transactions USING btree (business_id, physical_account_id, date DESC) WHERE (physical_account_id IS NOT NULL);
CREATE INDEX bank_txn_business_canonical_fingerprint_idx ON public.bank_transactions USING btree (business_id, canonical_fingerprint) WHERE (canonical_fingerprint IS NOT NULL);
CREATE UNIQUE INDEX bank_txn_business_canonical_deterministic_uq ON public.bank_transactions USING btree (business_id, canonical_fingerprint) WHERE ((canonical_fingerprint IS NOT NULL) AND (canonical_fingerprint_confidence = 'deterministic'::text) AND (is_archived = false));
CREATE INDEX bank_txn_accounting_review_idx ON public.bank_transactions USING btree (business_id, accounting_review_required) WHERE (accounting_review_required = true);
CREATE INDEX txn_categ_accounting_review_idx ON public.transaction_categorizations USING btree (business_id, accounting_review_required) WHERE (accounting_review_required = true);
CREATE UNIQUE INDEX qbo_posted_transactions_request_uq ON public.qbo_posted_transactions USING btree (business_id, qbo_env, realm_id, request_id) WHERE (request_id IS NOT NULL);
CREATE INDEX qbo_posted_transactions_processing_idx ON public.qbo_posted_transactions USING btree (business_id, status, lease_expires_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text, 'unknown'::text, 'failed'::text]));
CREATE INDEX txn_categ_suggested_canonical_idx ON public.transaction_categorizations USING btree (business_id, suggested_canonical_account_key);
CREATE INDEX txn_categ_final_canonical_idx ON public.transaction_categorizations USING btree (business_id, final_canonical_account_key);
CREATE UNIQUE INDEX bizzi_vendors_business_normalized_active_uq ON public.bizzi_vendors USING btree (business_id, normalized_display_name) WHERE (status = 'active'::text);
CREATE INDEX bizzi_vendors_business_status_idx ON public.bizzi_vendors USING btree (business_id, status, created_at DESC);
CREATE INDEX clarification_requests_business_resolved_idx ON public.clarification_requests USING btree (business_id, resolved_at DESC) WHERE (resolved_at IS NOT NULL);
CREATE INDEX operator_request_summaries_updated_idx ON public.operator_request_summaries USING btree (updated_at DESC);
CREATE INDEX bank_transactions_canonical_vendor_idx ON public.bank_transactions USING btree (business_id, canonical_vendor_id) WHERE (canonical_vendor_id IS NOT NULL);
CREATE UNIQUE INDEX bookkeeping_processing_requests_txn_uq ON public.bookkeeping_processing_requests USING btree (business_id, transaction_id);
CREATE INDEX bookkeeping_processing_requests_due_idx ON public.bookkeeping_processing_requests USING btree (status, process_after, priority DESC, created_at);
CREATE INDEX bookkeeping_processing_requests_business_status_idx ON public.bookkeeping_processing_requests USING btree (business_id, status, process_after);
CREATE UNIQUE INDEX credit_card_payment_pairs_active_checking_uq ON public.credit_card_payment_pairs USING btree (business_id, checking_transaction_id) WHERE (status <> 'voided'::text);
CREATE UNIQUE INDEX credit_card_payment_pairs_active_card_uq ON public.credit_card_payment_pairs USING btree (business_id, credit_card_transaction_id) WHERE ((credit_card_transaction_id IS NOT NULL) AND (status <> 'voided'::text));
CREATE UNIQUE INDEX credit_card_payment_pairs_request_uq ON public.credit_card_payment_pairs USING btree (business_id, request_id) WHERE (request_id IS NOT NULL);
CREATE INDEX credit_card_payment_pairs_business_status_idx ON public.credit_card_payment_pairs USING btree (business_id, status, updated_at);
CREATE INDEX clarification_requests_business_answered_unresolved_idx ON public.clarification_requests USING btree (business_id, status, resolved_at, answered_at DESC) WHERE ((status = 'answered'::text) AND (resolved_at IS NULL));
CREATE INDEX internal_staff_users_active_role_idx ON public.internal_staff_users USING btree (active, role);
CREATE INDEX monthly_review_qbo_pnl_snapshots_business_month_idx ON public.monthly_review_qbo_pnl_snapshots USING btree (business_id, review_year DESC, review_month DESC, pulled_at DESC);
CREATE INDEX monthly_review_qbo_pnl_snapshots_status_idx ON public.monthly_review_qbo_pnl_snapshots USING btree (business_id, status, pulled_at DESC);
CREATE UNIQUE INDEX internal_admin_view_sessions_handoff_hash_unique ON public.internal_admin_view_sessions USING btree (handoff_token_hash) WHERE (handoff_token_hash IS NOT NULL);
CREATE UNIQUE INDEX internal_admin_view_sessions_session_hash_unique ON public.internal_admin_view_sessions USING btree (session_token_hash) WHERE (session_token_hash IS NOT NULL);
CREATE INDEX internal_admin_view_sessions_staff_active_idx ON public.internal_admin_view_sessions USING btree (staff_user_id, expires_at DESC) WHERE ((session_token_hash IS NOT NULL) AND (ended_at IS NULL) AND (revoked_at IS NULL));
CREATE INDEX internal_admin_view_sessions_business_idx ON public.internal_admin_view_sessions USING btree (business_id, created_at DESC);
CREATE INDEX internal_admin_view_sessions_handoff_expiry_idx ON public.internal_admin_view_sessions USING btree (handoff_expires_at) WHERE ((handoff_used_at IS NULL) AND (revoked_at IS NULL));
CREATE INDEX internal_admin_view_sessions_session_expiry_idx ON public.internal_admin_view_sessions USING btree (expires_at) WHERE ((session_token_hash IS NOT NULL) AND (ended_at IS NULL) AND (revoked_at IS NULL));
CREATE UNIQUE INDEX accounting_period_closes_active_unique ON public.accounting_period_closes USING btree (business_id, period_month) WHERE (is_active IS TRUE);
CREATE INDEX accounting_period_closes_business_month_idx ON public.accounting_period_closes USING btree (business_id, period_month DESC);
CREATE INDEX accounting_period_closes_snapshot_idx ON public.accounting_period_closes USING btree (approved_snapshot_id) WHERE (approved_snapshot_id IS NOT NULL);
CREATE INDEX accounting_period_closes_status_idx ON public.accounting_period_closes USING btree (status, period_month DESC);
CREATE INDEX bookkeeping_auto_post_backlog_releases_business_idx ON public.bookkeeping_auto_post_backlog_releases USING btree (business_id, requested_at DESC);
CREATE UNIQUE INDEX bookkeeping_auto_post_backlog_releases_fingerprint_idx ON public.bookkeeping_auto_post_backlog_releases USING btree (business_id, preview_fingerprint) WHERE ((status = 'active'::text) AND (preview_fingerprint IS NOT NULL));
CREATE UNIQUE INDEX monthly_review_qbo_pnl_snapshots_current_basis_unique ON public.monthly_review_qbo_pnl_snapshots USING btree (business_id, review_year, review_month, accounting_method) WHERE (is_current IS TRUE);
CREATE UNIQUE INDEX bank_qbo_matches_one_active_confirmed_bank_txn ON public.bank_qbo_matches USING btree (business_id, bank_transaction_id) WHERE ((status = 'confirmed'::text) AND (superseded_at IS NULL));
CREATE UNIQUE INDEX bank_qbo_matches_request_idempotency ON public.bank_qbo_matches USING btree (business_id, request_idempotency_key) WHERE (request_idempotency_key IS NOT NULL);
CREATE INDEX bank_qbo_matches_business_bank_idx ON public.bank_qbo_matches USING btree (business_id, bank_transaction_id, status, created_at DESC);
CREATE INDEX bank_qbo_match_items_entity_idx ON public.bank_qbo_match_items USING btree (business_id, qbo_entity_type, qbo_entity_id);
CREATE INDEX transaction_categorizations_review_posting_idx ON public.transaction_categorizations USING btree (business_id, review_status, posting_status);
CREATE INDEX bookkeeping_lifecycle_events_transaction_idx ON public.bookkeeping_lifecycle_events USING btree (business_id, transaction_id, created_at DESC);
CREATE UNIQUE INDEX bank_qbo_match_items_one_active_one_to_one_target ON public.bank_qbo_match_items USING btree (business_id, qbo_realm_id, qbo_entity_type, qbo_entity_id) WHERE ((evidence_role = 'primary'::text) AND (active_confirmed = true) AND (qbo_realm_id IS NOT NULL) AND (qbo_entity_type = ANY (ARRAY['Deposit'::text, 'Payment'::text, 'SalesReceipt'::text, 'Purchase'::text, 'Expense'::text, 'Check'::text, 'CreditCardCharge'::text, 'Bill'::text])));
CREATE INDEX credit_card_payment_pair_events_pair_idx ON public.credit_card_payment_pair_events USING btree (business_id, pair_id, created_at);
CREATE INDEX bookkeeping_exclusion_events_transaction_idx ON public.bookkeeping_exclusion_events USING btree (business_id, transaction_id, created_at DESC);
CREATE UNIQUE INDEX credit_card_payment_pairs_active_normalized_pair_uq ON public.credit_card_payment_pairs USING btree (business_id, LEAST(checking_transaction_id, credit_card_transaction_id), GREATEST(checking_transaction_id, credit_card_transaction_id)) WHERE ((credit_card_transaction_id IS NOT NULL) AND (status <> 'voided'::text));
CREATE UNIQUE INDEX credit_card_payment_pairs_idempotency_uq ON public.credit_card_payment_pairs USING btree (business_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE INDEX bookkeeping_posting_jobs_due_idx ON public.bookkeeping_posting_jobs USING btree (COALESCE(next_attempt_at, scheduled_at), business_id) WHERE (state = ANY (ARRAY['scheduled'::text, 'retry_scheduled'::text]));
CREATE INDEX bookkeeping_posting_jobs_stale_lease_idx ON public.bookkeeping_posting_jobs USING btree (lease_expires_at) WHERE (state = ANY (ARRAY['processing'::text, 'reconciling'::text]));
CREATE UNIQUE INDEX business_billing_live_subscription_uidx ON public.business_billing USING btree (stripe_subscription_id_live) WHERE (stripe_subscription_id_live IS NOT NULL);
CREATE UNIQUE INDEX business_billing_test_subscription_uidx ON public.business_billing USING btree (stripe_subscription_id_test) WHERE (stripe_subscription_id_test IS NOT NULL);
CREATE UNIQUE INDEX business_billing_legacy_subscription_uidx ON public.business_billing USING btree (stripe_subscription_id) WHERE (stripe_subscription_id IS NOT NULL);
CREATE INDEX business_billing_live_customer_idx ON public.business_billing USING btree (stripe_customer_id_live) WHERE (stripe_customer_id_live IS NOT NULL);
CREATE INDEX business_billing_test_customer_idx ON public.business_billing USING btree (stripe_customer_id_test) WHERE (stripe_customer_id_test IS NOT NULL);
CREATE UNIQUE INDEX user_business_link_user_business_uidx ON public.user_business_link USING btree (user_id, business_id) WHERE ((user_id IS NOT NULL) AND (business_id IS NOT NULL));
CREATE UNIQUE INDEX plaid_items_active_env_item_uidx ON public.plaid_items USING btree (plaid_env, plaid_item_id) WHERE ((is_active IS TRUE) AND (plaid_item_id IS NOT NULL));
CREATE UNIQUE INDEX plaid_items_business_env_item_uidx ON public.plaid_items USING btree (business_id, plaid_env, plaid_item_id);
CREATE INDEX plaid_recovery_batches_item_idx ON public.plaid_recovery_batches USING btree (business_id, plaid_env, plaid_item_id, created_at DESC);
CREATE INDEX plaid_recovery_rows_disposition_idx ON public.plaid_recovery_batch_rows USING btree (business_id, batch_id, disposition);
CREATE INDEX transaction_categorizations_posting_hold_idx ON public.transaction_categorizations USING btree (business_id, posting_hold_batch_id) WHERE (posting_hold_batch_id IS NOT NULL);
CREATE UNIQUE INDEX plaid_recovery_rebuild_idempotency_idx ON public.plaid_recovery_batches USING btree (business_id, rebuild_idempotency_key) WHERE (rebuild_idempotency_key IS NOT NULL);
CREATE UNIQUE INDEX plaid_recovery_one_active_rebuild_idx ON public.plaid_recovery_batches USING btree (business_id, rebuild_source_batch_id) WHERE ((rebuild_source_batch_id IS NOT NULL) AND (status = ANY (ARRAY['staging'::text, 'preview_ready'::text, 'lineage_confirmation_required'::text, 'imported_held'::text])));
CREATE INDEX pending_resolution_events_transaction_idx ON public.pending_transaction_resolution_events USING btree (business_id, transaction_id, created_at DESC);
alter table public."user_business_link" add constraint "user_business_link_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."business_profiles" add constraint "business_profiles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE;
alter table public."user_business_link" add constraint "user_business_link_user_id_fkey" FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE;
alter table public."quickbooks_tokens" add constraint "quickbooks_tokens_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_items" add constraint "plaid_items_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_items" add constraint "plaid_items_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public."plaid_accounts" add constraint "plaid_accounts_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bank_transactions" add constraint "bank_transactions_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."transaction_categorizations" add constraint "transaction_categorizations_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."transaction_categorizations" add constraint "transaction_categorizations_txn_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."qbo_posted_transactions" add constraint "qbo_posted_transactions_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."qbo_posted_transactions" add constraint "qbo_posted_transactions_txn_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."bank_sync_runs" add constraint "bank_sync_runs_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_qbo_account_mappings" add constraint "plaid_qbo_account_mappings_business_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."clarification_requests" add constraint "clarification_requests_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."clarification_requests" add constraint "clarification_requests_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."financial_monthly_review_stamps" add constraint "financial_monthly_review_stamps_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."monthly_review_runs" add constraint "monthly_review_runs_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_physical_accounts" add constraint "plaid_physical_accounts_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_accounts" add constraint "plaid_accounts_physical_account_id_fkey" FOREIGN KEY (physical_account_id) REFERENCES plaid_physical_accounts(id) ON DELETE SET NULL;
alter table public."bank_transactions" add constraint "bank_transactions_physical_account_id_fkey" FOREIGN KEY (physical_account_id) REFERENCES plaid_physical_accounts(id) ON DELETE SET NULL;
alter table public."bank_transactions" add constraint "bank_transactions_pending_source_transaction_id_fkey" FOREIGN KEY (pending_source_transaction_id) REFERENCES bank_transactions(id) ON DELETE SET NULL;
alter table public."plaid_accounts" add constraint "plaid_accounts_business_physical_account_fkey" FOREIGN KEY (business_id, physical_account_id) REFERENCES plaid_physical_accounts(business_id, id);
alter table public."bank_transactions" add constraint "bank_transactions_business_physical_account_fkey" FOREIGN KEY (business_id, physical_account_id) REFERENCES plaid_physical_accounts(business_id, id);
alter table public."qbo_accounts_cache" add constraint "qbo_accounts_cache_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bizzi_vendors" add constraint "bizzi_vendors_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bank_transactions" add constraint "bank_transactions_business_canonical_vendor_fk" FOREIGN KEY (business_id, canonical_vendor_id) REFERENCES bizzi_vendors(business_id, id) ON DELETE SET NULL (canonical_vendor_id);
alter table public."bank_transactions" add constraint "bank_transactions_canonical_vendor_id_fkey" FOREIGN KEY (canonical_vendor_id) REFERENCES bizzi_vendors(id) ON DELETE SET NULL;
alter table public."bookkeeping_processing_requests" add constraint "bookkeeping_processing_requests_business_transaction_fk" FOREIGN KEY (business_id, transaction_id) REFERENCES bank_transactions(business_id, id) ON DELETE CASCADE;
alter table public."bookkeeping_processing_requests" add constraint "bookkeeping_processing_requests_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bookkeeping_processing_requests" add constraint "bookkeeping_processing_requests_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_checking_transaction_id_fkey" FOREIGN KEY (checking_transaction_id) REFERENCES bank_transactions(id) ON DELETE RESTRICT;
alter table public."credit_card_payment_pairs" add constraint "credit_card_payment_pairs_credit_card_transaction_id_fkey" FOREIGN KEY (credit_card_transaction_id) REFERENCES bank_transactions(id) ON DELETE RESTRICT;
alter table public."clarification_requests" add constraint "clarification_requests_answered_by_user_id_fkey" FOREIGN KEY (answered_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public."clarification_requests" add constraint "clarification_requests_resolved_by_user_id_fkey" FOREIGN KEY (resolved_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public."operator_request_summaries" add constraint "operator_request_summaries_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."internal_staff_users" add constraint "internal_staff_users_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public."monthly_review_qbo_pnl_snapshots" add constraint "monthly_review_qbo_pnl_snapshots_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."internal_admin_view_sessions" add constraint "internal_admin_view_sessions_staff_user_id_fkey" FOREIGN KEY (staff_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public."internal_admin_view_sessions" add constraint "internal_admin_view_sessions_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."accounting_period_closes" add constraint "accounting_period_closes_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."accounting_period_closes" add constraint "accounting_period_closes_snapshot_fkey" FOREIGN KEY (approved_snapshot_id) REFERENCES monthly_review_qbo_pnl_snapshots(id) ON DELETE RESTRICT;
alter table public."bookkeeping_auto_post_backlog_releases" add constraint "bookkeeping_auto_post_backlog_releases_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bank_qbo_matches" add constraint "bank_qbo_matches_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bank_qbo_matches" add constraint "bank_qbo_matches_bank_transaction_id_fkey" FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."bank_qbo_match_items" add constraint "bank_qbo_match_items_match_id_fkey" FOREIGN KEY (match_id) REFERENCES bank_qbo_matches(id) ON DELETE CASCADE;
alter table public."bank_qbo_match_items" add constraint "bank_qbo_match_items_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bank_qbo_match_history" add constraint "bank_qbo_match_history_match_id_fkey" FOREIGN KEY (match_id) REFERENCES bank_qbo_matches(id) ON DELETE SET NULL;
alter table public."bank_qbo_match_history" add constraint "bank_qbo_match_history_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bank_qbo_match_history" add constraint "bank_qbo_match_history_bank_transaction_id_fkey" FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE SET NULL;
alter table public."bank_qbo_match_history" add constraint "bank_qbo_match_history_supersedes_match_id_fkey" FOREIGN KEY (supersedes_match_id) REFERENCES bank_qbo_matches(id) ON DELETE SET NULL;
alter table public."credit_card_payment_pair_events" add constraint "credit_card_payment_pair_events_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."credit_card_payment_pair_events" add constraint "credit_card_payment_pair_events_pair_id_fkey" FOREIGN KEY (pair_id) REFERENCES credit_card_payment_pairs(id) ON DELETE CASCADE;
alter table public."credit_card_payment_pair_events" add constraint "credit_card_payment_pair_events_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE RESTRICT;
alter table public."bookkeeping_lifecycle_events" add constraint "bookkeeping_lifecycle_events_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bookkeeping_lifecycle_events" add constraint "bookkeeping_lifecycle_events_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."bookkeeping_posting_jobs" add constraint "bookkeeping_posting_jobs_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."bookkeeping_posting_jobs" add constraint "bookkeeping_posting_jobs_qbo_intent_id_fkey" FOREIGN KEY (qbo_intent_id) REFERENCES qbo_posted_transactions(id) ON DELETE SET NULL;
alter table public."bookkeeping_exclusion_events" add constraint "bookkeeping_exclusion_events_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bookkeeping_exclusion_events" add constraint "bookkeeping_exclusion_events_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."bookkeeping_approval_events" add constraint "bookkeeping_approval_events_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bookkeeping_approval_events" add constraint "bookkeeping_approval_events_transaction_fkey" FOREIGN KEY (business_id, transaction_id) REFERENCES bank_transactions(business_id, id) ON DELETE CASCADE;
alter table public."bookkeeping_posting_jobs" add constraint "bookkeeping_posting_jobs_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_accounts" add constraint "plaid_accounts_business_env_item_fkey" FOREIGN KEY (business_id, plaid_env, plaid_item_id) REFERENCES plaid_items(business_id, plaid_env, plaid_item_id);
alter table public."plaid_account_lineage_decisions" add constraint "plaid_account_lineage_decisions_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_recovery_batches" add constraint "plaid_recovery_batches_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_recovery_batch_rows" add constraint "plaid_recovery_batch_rows_batch_id_fkey" FOREIGN KEY (batch_id) REFERENCES plaid_recovery_batches(id) ON DELETE CASCADE;
alter table public."plaid_recovery_batch_rows" add constraint "plaid_recovery_batch_rows_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_replacement_account_candidates" add constraint "plaid_replacement_account_candidates_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."bank_transactions" add constraint "bank_transactions_plaid_recovery_batch_id_fkey" FOREIGN KEY (plaid_recovery_batch_id) REFERENCES plaid_recovery_batches(id);
alter table public."transaction_categorizations" add constraint "transaction_categorizations_posting_hold_batch_id_fkey" FOREIGN KEY (posting_hold_batch_id) REFERENCES plaid_recovery_batches(id);
alter table public."plaid_recovery_batches" add constraint "plaid_recovery_batches_rebuild_source_batch_id_fkey" FOREIGN KEY (rebuild_source_batch_id) REFERENCES plaid_recovery_batches(id);
alter table public."pending_transaction_resolution_events" add constraint "pending_transaction_resolution_events_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."pending_transaction_resolution_events" add constraint "pending_transaction_resolution_events_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
alter table public."plaid_accounts" add constraint "plaid_accounts_disconnected_by_fkey" FOREIGN KEY (disconnected_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public."plaid_accounts" add constraint "plaid_accounts_reconnected_by_fkey" FOREIGN KEY (reconnected_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public."plaid_account_connection_audit" add constraint "plaid_account_connection_audit_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."plaid_account_connection_audit" add constraint "plaid_account_connection_audit_actor_user_id_fkey" FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public."business_financial_reporting_config" add constraint "business_financial_reporting_config_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
alter table public."business_financial_reporting_config_audit" add constraint "business_financial_reporting_config_audit_business_id_fkey" FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
create view public."bookkeeping_transaction_feed_classification" with (security_invoker=true) as  SELECT bt.id AS transaction_id,
    bt.business_id,
    bt.plaid_account_id AS connected_account_id,
    classify_bookkeeping_primary_feed(bt.pending, tc.status, tc.review_status, tc.posting_status, tc.meta, tc.qbo_txn_id, tc.posted_at, tc.reconciled_at) AS primary_feed,
    COALESCE(tc.meta ->> 'taxonomy_type'::text, 'regular'::text) AS transaction_kind,
    COALESCE(tc.meta ->> 'resolution_type'::text, tc.meta ->> 'resolution'::text, 'categorize_new'::text) AS resolution_type,
    COALESCE(tc.review_status,
        CASE
            WHEN tc.status = ANY (ARRAY['approved'::text, 'auto_approved'::text, 'handled'::text, 'failed'::text]) THEN 'handled'::text
            ELSE 'needs_review'::text
        END) AS categorization_state,
    tc.final_qbo_account_id AS selected_qbo_account_id,
    bt.pending AS bank_pending,
    classify_bookkeeping_posting_outcome(tc.status, tc.posting_status, tc.post_error, tc.last_post_attempt_at, tc.post_after, tc.meta, tc.qbo_txn_id, tc.posted_at) AS posting_outcome,
    tc.qbo_txn_id AS qbo_entity_id,
    COALESCE(tc.meta ->> 'cc_payment_pair_id'::text, tc.meta ->> 'incoming_deposit_match_id'::text) AS matched_relationship_id,
    COALESCE(tc.post_error, tc.meta ->> 'post_block_reason'::text) AS failure_review_reason,
    COALESCE(tc.meta ->> 'merchant_group_operation_id'::text, (tc.meta -> 'manual_approval'::text) ->> 'operation_id'::text, tc.meta ->> 'post_intent_id'::text) AS last_operation_id,
    COALESCE(tc.last_post_attempt_at, tc.posted_at, tc.reviewed_at, tc.updated_at, bt.updated_at) AS last_status_at
   FROM bank_transactions bt
     LEFT JOIN transaction_categorizations tc ON tc.business_id = bt.business_id AND tc.transaction_id = bt.id
  WHERE bt.is_archived IS FALSE;;
CREATE TRIGGER trg_plaid_items_updated_at BEFORE UPDATE ON plaid_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
alter table public."plaid_items" enable trigger "trg_plaid_items_updated_at";
CREATE TRIGGER trg_plaid_accounts_updated_at BEFORE UPDATE ON plaid_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
alter table public."plaid_accounts" enable trigger "trg_plaid_accounts_updated_at";
CREATE TRIGGER trg_transaction_categorizations_updated_at BEFORE UPDATE ON transaction_categorizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
alter table public."transaction_categorizations" enable trigger "trg_transaction_categorizations_updated_at";
CREATE TRIGGER trg_qbo_posted_transactions_updated_at BEFORE UPDATE ON qbo_posted_transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
alter table public."qbo_posted_transactions" enable trigger "trg_qbo_posted_transactions_updated_at";
CREATE TRIGGER trg_bank_transactions_updated_at BEFORE UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
alter table public."bank_transactions" enable trigger "trg_bank_transactions_updated_at";
CREATE TRIGGER trg_bank_sync_runs_updated_at BEFORE UPDATE ON bank_sync_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
alter table public."bank_sync_runs" enable trigger "trg_bank_sync_runs_updated_at";
CREATE TRIGGER trg_user_profiles_full_name BEFORE INSERT OR UPDATE OF first_name, last_name ON user_profiles FOR EACH ROW EXECUTE FUNCTION set_user_profiles_full_name();
alter table public."user_profiles" enable trigger "trg_user_profiles_full_name";
CREATE TRIGGER trg_plaid_qbo_account_mappings_updated_at BEFORE UPDATE ON plaid_qbo_account_mappings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
alter table public."plaid_qbo_account_mappings" enable trigger "trg_plaid_qbo_account_mappings_updated_at";
CREATE TRIGGER trg_tc_sync_txn_fields BEFORE INSERT OR UPDATE OF business_id, transaction_id ON transaction_categorizations FOR EACH ROW EXECUTE FUNCTION tc_sync_txn_fields_from_bank_transactions();
alter table public."transaction_categorizations" enable trigger "trg_tc_sync_txn_fields";
CREATE TRIGGER trg_clarification_requests_updated_at BEFORE UPDATE ON clarification_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
alter table public."clarification_requests" enable trigger "trg_clarification_requests_updated_at";
CREATE TRIGGER trg_business_billing_identity_summary AFTER INSERT OR UPDATE ON business_billing FOR EACH ROW EXECUTE FUNCTION refresh_billing_identity_summary_from_billing();
alter table public."business_billing" enable trigger "trg_business_billing_identity_summary";
CREATE TRIGGER trg_business_profiles_billing_identity_summary AFTER INSERT OR UPDATE OF business_name, user_id ON business_profiles FOR EACH ROW EXECUTE FUNCTION refresh_billing_identity_summary_from_business_profile();
alter table public."business_profiles" enable trigger "trg_business_profiles_billing_identity_summary";
CREATE TRIGGER trg_user_profiles_billing_identity_summary AFTER INSERT OR UPDATE OF email, first_name, last_name, full_name ON user_profiles FOR EACH ROW EXECUTE FUNCTION refresh_billing_identity_summary_from_user_profile();
alter table public."user_profiles" enable trigger "trg_user_profiles_billing_identity_summary";
CREATE TRIGGER trg_business_profiles_identity_immutable BEFORE UPDATE OF id, user_id ON business_profiles FOR EACH ROW EXECUTE FUNCTION prevent_business_profile_identity_reassignment();
alter table public."business_profiles" enable trigger "trg_business_profiles_identity_immutable";
CREATE TRIGGER trg_user_business_link_identity_immutable BEFORE UPDATE OF id, user_id, business_id, role ON user_business_link FOR EACH ROW EXECUTE FUNCTION prevent_user_business_link_identity_reassignment();
alter table public."user_business_link" enable trigger "trg_user_business_link_identity_immutable";
CREATE TRIGGER trg_quickbooks_tokens_refresh_business_onboarding_status AFTER INSERT OR DELETE OR UPDATE ON quickbooks_tokens FOR EACH ROW EXECUTE FUNCTION refresh_business_profile_onboarding_status_from_integration();
alter table public."quickbooks_tokens" enable trigger "trg_quickbooks_tokens_refresh_business_onboarding_status";
CREATE TRIGGER trg_plaid_items_refresh_business_onboarding_status AFTER INSERT OR DELETE OR UPDATE ON plaid_items FOR EACH ROW EXECUTE FUNCTION refresh_business_profile_onboarding_status_from_integration();
alter table public."plaid_items" enable trigger "trg_plaid_items_refresh_business_onboarding_status";
CREATE TRIGGER trg_plaid_accounts_refresh_business_onboarding_status AFTER INSERT OR DELETE OR UPDATE ON plaid_accounts FOR EACH ROW EXECUTE FUNCTION refresh_business_profile_onboarding_status_from_integration();
alter table public."plaid_accounts" enable trigger "trg_plaid_accounts_refresh_business_onboarding_status";
CREATE TRIGGER trg_bookkeeping_processing_requests_updated_at BEFORE UPDATE ON bookkeeping_processing_requests FOR EACH ROW EXECUTE FUNCTION touch_bookkeeping_processing_requests_updated_at();
alter table public."bookkeeping_processing_requests" enable trigger "trg_bookkeeping_processing_requests_updated_at";
CREATE TRIGGER trg_operator_request_summary_business_scope AFTER INSERT OR UPDATE OF bookkeeping_start_date ON business_profiles FOR EACH ROW EXECUTE FUNCTION refresh_operator_request_summary_after_business_scope_change();
alter table public."business_profiles" enable trigger "trg_operator_request_summary_business_scope";
CREATE TRIGGER validate_credit_card_payment_pair_business_trg BEFORE INSERT OR UPDATE OF business_id, checking_transaction_id, credit_card_transaction_id ON credit_card_payment_pairs FOR EACH ROW EXECUTE FUNCTION validate_credit_card_payment_pair_business();
alter table public."credit_card_payment_pairs" enable trigger "validate_credit_card_payment_pair_business_trg";
CREATE TRIGGER internal_admin_view_sessions_touch_updated_at BEFORE UPDATE ON internal_admin_view_sessions FOR EACH ROW EXECUTE FUNCTION touch_internal_admin_view_sessions_updated_at();
alter table public."internal_admin_view_sessions" enable trigger "internal_admin_view_sessions_touch_updated_at";
CREATE TRIGGER trg_internal_staff_users_updated_at BEFORE UPDATE ON internal_staff_users FOR EACH ROW EXECUTE FUNCTION set_internal_staff_users_updated_at();
alter table public."internal_staff_users" enable trigger "trg_internal_staff_users_updated_at";
CREATE TRIGGER trg_business_profiles_onboarding_status BEFORE INSERT OR UPDATE OF business_name, industry, state, services_offered, onboarding_completed_at, onboarding_status, quickbooks_connected, quickbooks_connected_at, plaid_connected, plaid_connected_at ON business_profiles FOR EACH ROW EXECUTE FUNCTION enforce_business_profile_onboarding_status();
alter table public."business_profiles" enable trigger "trg_business_profiles_onboarding_status";
CREATE TRIGGER trg_enforce_bookkeeping_review_posting_state BEFORE INSERT OR UPDATE ON transaction_categorizations FOR EACH ROW EXECUTE FUNCTION enforce_bookkeeping_review_posting_state();
alter table public."transaction_categorizations" enable trigger "trg_enforce_bookkeeping_review_posting_state";
CREATE TRIGGER trg_audit_bookkeeping_lifecycle_transition AFTER UPDATE ON transaction_categorizations FOR EACH ROW EXECUTE FUNCTION audit_bookkeeping_lifecycle_transition();
alter table public."transaction_categorizations" enable trigger "trg_audit_bookkeeping_lifecycle_transition";
CREATE TRIGGER enforce_active_credit_card_payment_pair_membership_trg BEFORE INSERT OR UPDATE OF business_id, checking_transaction_id, credit_card_transaction_id, status ON credit_card_payment_pairs FOR EACH ROW EXECUTE FUNCTION enforce_active_credit_card_payment_pair_membership();
alter table public."credit_card_payment_pairs" enable trigger "enforce_active_credit_card_payment_pair_membership_trg";
CREATE TRIGGER trg_business_billing_stale_stripe_event BEFORE UPDATE ON business_billing FOR EACH ROW EXECUTE FUNCTION prevent_stale_stripe_entitlement_update();
alter table public."business_billing" enable trigger "trg_business_billing_stale_stripe_event";
CREATE TRIGGER trg_quickbooks_tokens_realm_immutable BEFORE UPDATE OF realm_id ON quickbooks_tokens FOR EACH ROW EXECUTE FUNCTION prevent_uncontrolled_qbo_realm_change();
alter table public."quickbooks_tokens" enable trigger "trg_quickbooks_tokens_realm_immutable";
CREATE TRIGGER transaction_categorizations_sync_posting_job AFTER INSERT OR UPDATE OF status, review_status, posting_status, post_after, post_error, qbo_txn_id, qbo_txn_type, posted_at, reconciled_at, excluded_at, is_archived, meta ON transaction_categorizations FOR EACH ROW EXECUTE FUNCTION sync_bookkeeping_posting_job();
alter table public."transaction_categorizations" enable trigger "transaction_categorizations_sync_posting_job";
CREATE TRIGGER business_financial_reporting_config_audit_immutable BEFORE DELETE OR UPDATE ON business_financial_reporting_config_audit FOR EACH ROW EXECUTE FUNCTION reject_immutable_financial_evidence_mutation();
alter table public."business_financial_reporting_config_audit" enable trigger "business_financial_reporting_config_audit_immutable";
CREATE TRIGGER quickbooks_tokens_invalidate_reporting_config AFTER INSERT OR UPDATE OF realm_id, status, is_active ON quickbooks_tokens FOR EACH ROW EXECUTE FUNCTION invalidate_reporting_config_on_qbo_realm_change();
alter table public."quickbooks_tokens" enable trigger "quickbooks_tokens_invalidate_reporting_config";
CREATE TRIGGER tax_vehicle_serialize_evidence BEFORE INSERT OR DELETE OR UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION tax_vehicle_serialize_evidence();
alter table public."bank_transactions" enable trigger "tax_vehicle_serialize_evidence";
CREATE TRIGGER protect_residual_category_hold BEFORE UPDATE ON transaction_categorizations FOR EACH ROW EXECUTE FUNCTION protect_plaid_residual_recovery_hold();
alter table public."transaction_categorizations" enable trigger "protect_residual_category_hold";
CREATE TRIGGER protect_residual_batch_hold BEFORE UPDATE ON plaid_recovery_batches FOR EACH ROW EXECUTE FUNCTION protect_plaid_residual_recovery_hold();
alter table public."plaid_recovery_batches" enable trigger "protect_residual_batch_hold";
CREATE TRIGGER guard_plaid_reconnect_sync_lease BEFORE UPDATE OF sync_lease_owner ON plaid_items FOR EACH ROW EXECUTE FUNCTION guard_plaid_reconnect_sync_lease();
alter table public."plaid_items" enable trigger "guard_plaid_reconnect_sync_lease";
CREATE TRIGGER finish_plaid_reconnect_checkpoint AFTER UPDATE OF status ON bank_sync_runs FOR EACH ROW EXECUTE FUNCTION finish_plaid_reconnect_checkpoint();
alter table public."bank_sync_runs" enable trigger "finish_plaid_reconnect_checkpoint";
create policy "residual_executor_read_categories" on public."transaction_categorizations" as PERMISSIVE for SELECT to "plaid_residual_hold_executor" using (true);
create policy "residual_executor_clear_exact_hold" on public."transaction_categorizations" as PERMISSIVE for UPDATE to "plaid_residual_hold_executor" using (true) with check (true);
create policy "residual_executor_read_manifests" on public."plaid_recovery_batches" as PERMISSIVE for SELECT to "plaid_residual_hold_executor" using (true);
create policy "user_profiles_select_own" on public."user_profiles" as PERMISSIVE for SELECT to "authenticated" using ((id = auth.uid()));
create policy "business_profiles_member_select" on public."business_profiles" as PERMISSIVE for SELECT to "authenticated" using (bizzi_current_user_is_business_member(id));
create policy "clarification_requests_select_own_business" on public."clarification_requests" as PERMISSIVE for SELECT to public using ((EXISTS ( SELECT 1
   FROM business_profiles bp
  WHERE ((bp.id = clarification_requests.business_id) AND (bp.user_id = auth.uid())))));
create policy "clarification_requests_insert_own_business" on public."clarification_requests" as PERMISSIVE for INSERT to public with check ((EXISTS ( SELECT 1
   FROM business_profiles bp
  WHERE ((bp.id = clarification_requests.business_id) AND (bp.user_id = auth.uid())))));
create policy "clarification_requests_update_own_business" on public."clarification_requests" as PERMISSIVE for UPDATE to public using ((EXISTS ( SELECT 1
   FROM business_profiles bp
  WHERE ((bp.id = clarification_requests.business_id) AND (bp.user_id = auth.uid()))))) with check ((EXISTS ( SELECT 1
   FROM business_profiles bp
  WHERE ((bp.id = clarification_requests.business_id) AND (bp.user_id = auth.uid())))));
create policy "clarification_requests_delete_own_business" on public."clarification_requests" as PERMISSIVE for DELETE to public using ((EXISTS ( SELECT 1
   FROM business_profiles bp
  WHERE ((bp.id = clarification_requests.business_id) AND (bp.user_id = auth.uid())))));
create policy "Users can read completed monthly review stamps for their busine" on public."financial_monthly_review_stamps" as PERMISSIVE for SELECT to "authenticated" using (((status = ANY (ARRAY['completed'::text, 'closed'::text, 'finalized'::text])) AND (EXISTS ( SELECT 1
   FROM user_business_link ubl
  WHERE ((ubl.business_id = financial_monthly_review_stamps.business_id) AND (ubl.user_id = auth.uid()))))));
create policy "bank_transactions_member_select" on public."bank_transactions" as PERMISSIVE for SELECT to "authenticated" using (bizzi_current_user_is_business_member(business_id));
create policy "user_profiles_update_own" on public."user_profiles" as PERMISSIVE for UPDATE to "authenticated" using ((id = auth.uid())) with check ((id = auth.uid()));
create policy "user_profiles_insert_own" on public."user_profiles" as PERMISSIVE for INSERT to "authenticated" with check ((id = auth.uid()));
create policy "business_profiles_manager_update" on public."business_profiles" as PERMISSIVE for UPDATE to "authenticated" using (bizzi_current_user_can_manage_business(id)) with check (bizzi_current_user_can_manage_business(id));
create policy "user_business_link_self_or_manager_select" on public."user_business_link" as PERMISSIVE for SELECT to "authenticated" using (((user_id = auth.uid()) OR bizzi_current_user_can_manage_business(business_id)));
create policy "bqm_tenant_delete" on public."bank_qbo_match_items" as PERMISSIVE for DELETE to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_select" on public."bank_qbo_matches" as PERMISSIVE for SELECT to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_insert" on public."bank_qbo_matches" as PERMISSIVE for INSERT to "authenticated" with check (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_update" on public."bank_qbo_matches" as PERMISSIVE for UPDATE to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id))) with check (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_delete" on public."bank_qbo_matches" as PERMISSIVE for DELETE to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_select" on public."bank_qbo_match_items" as PERMISSIVE for SELECT to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_insert" on public."bank_qbo_match_items" as PERMISSIVE for INSERT to "authenticated" with check (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_update" on public."bank_qbo_match_items" as PERMISSIVE for UPDATE to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id))) with check (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "business_billing_member_read" on public."business_billing" as PERMISSIVE for SELECT to "authenticated" using (bizzi_current_user_is_business_member(business_id));
create policy "bqm_tenant_select" on public."bank_qbo_match_history" as PERMISSIVE for SELECT to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_insert" on public."bank_qbo_match_history" as PERMISSIVE for INSERT to "authenticated" with check (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_update" on public."bank_qbo_match_history" as PERMISSIVE for UPDATE to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id))) with check (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
create policy "bqm_tenant_delete" on public."bank_qbo_match_history" as PERMISSIVE for DELETE to "authenticated" using (((business_id IS NOT NULL) AND tax_user_owns_business(business_id)));
alter table public."accounting_period_closes" owner to "postgres";
alter table public."accounting_period_closes" enable row level security;
alter table public."accounting_period_closes" no force row level security;
revoke all on table public."accounting_period_closes" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."accounting_period_closes" to "postgres";
grant SELECT on table public."accounting_period_closes" to "postgres";
grant UPDATE on table public."accounting_period_closes" to "postgres";
grant DELETE on table public."accounting_period_closes" to "postgres";
grant TRUNCATE on table public."accounting_period_closes" to "postgres";
grant REFERENCES on table public."accounting_period_closes" to "postgres";
grant TRIGGER on table public."accounting_period_closes" to "postgres";
grant MAINTAIN on table public."accounting_period_closes" to "postgres";
grant INSERT on table public."accounting_period_closes" to "service_role";
grant SELECT on table public."accounting_period_closes" to "service_role";
grant UPDATE on table public."accounting_period_closes" to "service_role";
grant DELETE on table public."accounting_period_closes" to "service_role";
grant TRUNCATE on table public."accounting_period_closes" to "service_role";
grant REFERENCES on table public."accounting_period_closes" to "service_role";
grant TRIGGER on table public."accounting_period_closes" to "service_role";
grant MAINTAIN on table public."accounting_period_closes" to "service_role";
alter table public."bank_qbo_match_history" owner to "postgres";
alter table public."bank_qbo_match_history" enable row level security;
alter table public."bank_qbo_match_history" no force row level security;
revoke all on table public."bank_qbo_match_history" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bank_qbo_match_history" to "postgres";
grant SELECT on table public."bank_qbo_match_history" to "postgres";
grant UPDATE on table public."bank_qbo_match_history" to "postgres";
grant DELETE on table public."bank_qbo_match_history" to "postgres";
grant TRUNCATE on table public."bank_qbo_match_history" to "postgres";
grant REFERENCES on table public."bank_qbo_match_history" to "postgres";
grant TRIGGER on table public."bank_qbo_match_history" to "postgres";
grant MAINTAIN on table public."bank_qbo_match_history" to "postgres";
grant INSERT on table public."bank_qbo_match_history" to "service_role";
grant SELECT on table public."bank_qbo_match_history" to "service_role";
grant UPDATE on table public."bank_qbo_match_history" to "service_role";
grant DELETE on table public."bank_qbo_match_history" to "service_role";
grant TRUNCATE on table public."bank_qbo_match_history" to "service_role";
grant REFERENCES on table public."bank_qbo_match_history" to "service_role";
grant TRIGGER on table public."bank_qbo_match_history" to "service_role";
grant MAINTAIN on table public."bank_qbo_match_history" to "service_role";
alter table public."bank_qbo_match_items" owner to "postgres";
alter table public."bank_qbo_match_items" enable row level security;
alter table public."bank_qbo_match_items" no force row level security;
revoke all on table public."bank_qbo_match_items" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bank_qbo_match_items" to "postgres";
grant SELECT on table public."bank_qbo_match_items" to "postgres";
grant UPDATE on table public."bank_qbo_match_items" to "postgres";
grant DELETE on table public."bank_qbo_match_items" to "postgres";
grant TRUNCATE on table public."bank_qbo_match_items" to "postgres";
grant REFERENCES on table public."bank_qbo_match_items" to "postgres";
grant TRIGGER on table public."bank_qbo_match_items" to "postgres";
grant MAINTAIN on table public."bank_qbo_match_items" to "postgres";
grant INSERT on table public."bank_qbo_match_items" to "service_role";
grant SELECT on table public."bank_qbo_match_items" to "service_role";
grant UPDATE on table public."bank_qbo_match_items" to "service_role";
grant DELETE on table public."bank_qbo_match_items" to "service_role";
grant TRUNCATE on table public."bank_qbo_match_items" to "service_role";
grant REFERENCES on table public."bank_qbo_match_items" to "service_role";
grant TRIGGER on table public."bank_qbo_match_items" to "service_role";
grant MAINTAIN on table public."bank_qbo_match_items" to "service_role";
alter table public."bank_qbo_matches" owner to "postgres";
alter table public."bank_qbo_matches" enable row level security;
alter table public."bank_qbo_matches" no force row level security;
revoke all on table public."bank_qbo_matches" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bank_qbo_matches" to "postgres";
grant SELECT on table public."bank_qbo_matches" to "postgres";
grant UPDATE on table public."bank_qbo_matches" to "postgres";
grant DELETE on table public."bank_qbo_matches" to "postgres";
grant TRUNCATE on table public."bank_qbo_matches" to "postgres";
grant REFERENCES on table public."bank_qbo_matches" to "postgres";
grant TRIGGER on table public."bank_qbo_matches" to "postgres";
grant MAINTAIN on table public."bank_qbo_matches" to "postgres";
grant INSERT on table public."bank_qbo_matches" to "service_role";
grant SELECT on table public."bank_qbo_matches" to "service_role";
grant UPDATE on table public."bank_qbo_matches" to "service_role";
grant DELETE on table public."bank_qbo_matches" to "service_role";
grant TRUNCATE on table public."bank_qbo_matches" to "service_role";
grant REFERENCES on table public."bank_qbo_matches" to "service_role";
grant TRIGGER on table public."bank_qbo_matches" to "service_role";
grant MAINTAIN on table public."bank_qbo_matches" to "service_role";
alter table public."bank_sync_runs" owner to "postgres";
alter table public."bank_sync_runs" enable row level security;
alter table public."bank_sync_runs" no force row level security;
revoke all on table public."bank_sync_runs" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bank_sync_runs" to "postgres";
grant SELECT on table public."bank_sync_runs" to "postgres";
grant UPDATE on table public."bank_sync_runs" to "postgres";
grant DELETE on table public."bank_sync_runs" to "postgres";
grant TRUNCATE on table public."bank_sync_runs" to "postgres";
grant REFERENCES on table public."bank_sync_runs" to "postgres";
grant TRIGGER on table public."bank_sync_runs" to "postgres";
grant MAINTAIN on table public."bank_sync_runs" to "postgres";
grant INSERT on table public."bank_sync_runs" to "service_role";
grant SELECT on table public."bank_sync_runs" to "service_role";
grant UPDATE on table public."bank_sync_runs" to "service_role";
grant DELETE on table public."bank_sync_runs" to "service_role";
grant TRUNCATE on table public."bank_sync_runs" to "service_role";
grant REFERENCES on table public."bank_sync_runs" to "service_role";
grant TRIGGER on table public."bank_sync_runs" to "service_role";
grant MAINTAIN on table public."bank_sync_runs" to "service_role";
alter table public."bank_transactions" owner to "postgres";
alter table public."bank_transactions" enable row level security;
alter table public."bank_transactions" no force row level security;
revoke all on table public."bank_transactions" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bank_transactions" to "postgres";
grant SELECT on table public."bank_transactions" to "postgres";
grant UPDATE on table public."bank_transactions" to "postgres";
grant DELETE on table public."bank_transactions" to "postgres";
grant TRUNCATE on table public."bank_transactions" to "postgres";
grant REFERENCES on table public."bank_transactions" to "postgres";
grant TRIGGER on table public."bank_transactions" to "postgres";
grant MAINTAIN on table public."bank_transactions" to "postgres";
grant INSERT on table public."bank_transactions" to "service_role";
grant SELECT on table public."bank_transactions" to "service_role";
grant UPDATE on table public."bank_transactions" to "service_role";
grant DELETE on table public."bank_transactions" to "service_role";
grant TRUNCATE on table public."bank_transactions" to "service_role";
grant REFERENCES on table public."bank_transactions" to "service_role";
grant TRIGGER on table public."bank_transactions" to "service_role";
grant MAINTAIN on table public."bank_transactions" to "service_role";
grant SELECT on table public."bank_transactions" to "authenticated";
alter table public."bizzi_vendors" owner to "postgres";
alter table public."bizzi_vendors" enable row level security;
alter table public."bizzi_vendors" no force row level security;
revoke all on table public."bizzi_vendors" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bizzi_vendors" to "postgres";
grant SELECT on table public."bizzi_vendors" to "postgres";
grant UPDATE on table public."bizzi_vendors" to "postgres";
grant DELETE on table public."bizzi_vendors" to "postgres";
grant TRUNCATE on table public."bizzi_vendors" to "postgres";
grant REFERENCES on table public."bizzi_vendors" to "postgres";
grant TRIGGER on table public."bizzi_vendors" to "postgres";
grant MAINTAIN on table public."bizzi_vendors" to "postgres";
grant INSERT on table public."bizzi_vendors" to "service_role";
grant SELECT on table public."bizzi_vendors" to "service_role";
grant UPDATE on table public."bizzi_vendors" to "service_role";
grant DELETE on table public."bizzi_vendors" to "service_role";
grant TRUNCATE on table public."bizzi_vendors" to "service_role";
grant REFERENCES on table public."bizzi_vendors" to "service_role";
grant TRIGGER on table public."bizzi_vendors" to "service_role";
grant MAINTAIN on table public."bizzi_vendors" to "service_role";
alter table public."bookkeeping_approval_events" owner to "postgres";
alter table public."bookkeeping_approval_events" enable row level security;
alter table public."bookkeeping_approval_events" no force row level security;
revoke all on table public."bookkeeping_approval_events" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bookkeeping_approval_events" to "postgres";
grant SELECT on table public."bookkeeping_approval_events" to "postgres";
grant UPDATE on table public."bookkeeping_approval_events" to "postgres";
grant DELETE on table public."bookkeeping_approval_events" to "postgres";
grant TRUNCATE on table public."bookkeeping_approval_events" to "postgres";
grant REFERENCES on table public."bookkeeping_approval_events" to "postgres";
grant TRIGGER on table public."bookkeeping_approval_events" to "postgres";
grant MAINTAIN on table public."bookkeeping_approval_events" to "postgres";
grant INSERT on table public."bookkeeping_approval_events" to "service_role";
grant SELECT on table public."bookkeeping_approval_events" to "service_role";
grant UPDATE on table public."bookkeeping_approval_events" to "service_role";
grant DELETE on table public."bookkeeping_approval_events" to "service_role";
grant TRUNCATE on table public."bookkeeping_approval_events" to "service_role";
grant REFERENCES on table public."bookkeeping_approval_events" to "service_role";
grant TRIGGER on table public."bookkeeping_approval_events" to "service_role";
grant MAINTAIN on table public."bookkeeping_approval_events" to "service_role";
alter table public."bookkeeping_auto_post_backlog_releases" owner to "postgres";
alter table public."bookkeeping_auto_post_backlog_releases" enable row level security;
alter table public."bookkeeping_auto_post_backlog_releases" no force row level security;
revoke all on table public."bookkeeping_auto_post_backlog_releases" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bookkeeping_auto_post_backlog_releases" to "postgres";
grant SELECT on table public."bookkeeping_auto_post_backlog_releases" to "postgres";
grant UPDATE on table public."bookkeeping_auto_post_backlog_releases" to "postgres";
grant DELETE on table public."bookkeeping_auto_post_backlog_releases" to "postgres";
grant TRUNCATE on table public."bookkeeping_auto_post_backlog_releases" to "postgres";
grant REFERENCES on table public."bookkeeping_auto_post_backlog_releases" to "postgres";
grant TRIGGER on table public."bookkeeping_auto_post_backlog_releases" to "postgres";
grant MAINTAIN on table public."bookkeeping_auto_post_backlog_releases" to "postgres";
grant INSERT on table public."bookkeeping_auto_post_backlog_releases" to "service_role";
grant SELECT on table public."bookkeeping_auto_post_backlog_releases" to "service_role";
grant UPDATE on table public."bookkeeping_auto_post_backlog_releases" to "service_role";
grant DELETE on table public."bookkeeping_auto_post_backlog_releases" to "service_role";
grant TRUNCATE on table public."bookkeeping_auto_post_backlog_releases" to "service_role";
grant REFERENCES on table public."bookkeeping_auto_post_backlog_releases" to "service_role";
grant TRIGGER on table public."bookkeeping_auto_post_backlog_releases" to "service_role";
grant MAINTAIN on table public."bookkeeping_auto_post_backlog_releases" to "service_role";
alter table public."bookkeeping_exclusion_events" owner to "postgres";
alter table public."bookkeeping_exclusion_events" enable row level security;
alter table public."bookkeeping_exclusion_events" no force row level security;
revoke all on table public."bookkeeping_exclusion_events" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bookkeeping_exclusion_events" to "postgres";
grant SELECT on table public."bookkeeping_exclusion_events" to "postgres";
grant UPDATE on table public."bookkeeping_exclusion_events" to "postgres";
grant DELETE on table public."bookkeeping_exclusion_events" to "postgres";
grant TRUNCATE on table public."bookkeeping_exclusion_events" to "postgres";
grant REFERENCES on table public."bookkeeping_exclusion_events" to "postgres";
grant TRIGGER on table public."bookkeeping_exclusion_events" to "postgres";
grant MAINTAIN on table public."bookkeeping_exclusion_events" to "postgres";
grant INSERT on table public."bookkeeping_exclusion_events" to "service_role";
grant SELECT on table public."bookkeeping_exclusion_events" to "service_role";
grant UPDATE on table public."bookkeeping_exclusion_events" to "service_role";
grant DELETE on table public."bookkeeping_exclusion_events" to "service_role";
grant TRUNCATE on table public."bookkeeping_exclusion_events" to "service_role";
grant REFERENCES on table public."bookkeeping_exclusion_events" to "service_role";
grant TRIGGER on table public."bookkeeping_exclusion_events" to "service_role";
grant MAINTAIN on table public."bookkeeping_exclusion_events" to "service_role";
alter table public."bookkeeping_lifecycle_events" owner to "postgres";
alter table public."bookkeeping_lifecycle_events" enable row level security;
alter table public."bookkeeping_lifecycle_events" no force row level security;
revoke all on table public."bookkeeping_lifecycle_events" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bookkeeping_lifecycle_events" to "postgres";
grant SELECT on table public."bookkeeping_lifecycle_events" to "postgres";
grant UPDATE on table public."bookkeeping_lifecycle_events" to "postgres";
grant DELETE on table public."bookkeeping_lifecycle_events" to "postgres";
grant TRUNCATE on table public."bookkeeping_lifecycle_events" to "postgres";
grant REFERENCES on table public."bookkeeping_lifecycle_events" to "postgres";
grant TRIGGER on table public."bookkeeping_lifecycle_events" to "postgres";
grant MAINTAIN on table public."bookkeeping_lifecycle_events" to "postgres";
grant INSERT on table public."bookkeeping_lifecycle_events" to "service_role";
grant SELECT on table public."bookkeeping_lifecycle_events" to "service_role";
grant UPDATE on table public."bookkeeping_lifecycle_events" to "service_role";
grant DELETE on table public."bookkeeping_lifecycle_events" to "service_role";
grant TRUNCATE on table public."bookkeeping_lifecycle_events" to "service_role";
grant REFERENCES on table public."bookkeeping_lifecycle_events" to "service_role";
grant TRIGGER on table public."bookkeeping_lifecycle_events" to "service_role";
grant MAINTAIN on table public."bookkeeping_lifecycle_events" to "service_role";
alter table public."bookkeeping_post_attempts" owner to "postgres";
alter table public."bookkeeping_post_attempts" enable row level security;
alter table public."bookkeeping_post_attempts" no force row level security;
revoke all on table public."bookkeeping_post_attempts" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bookkeeping_post_attempts" to "postgres";
grant SELECT on table public."bookkeeping_post_attempts" to "postgres";
grant UPDATE on table public."bookkeeping_post_attempts" to "postgres";
grant DELETE on table public."bookkeeping_post_attempts" to "postgres";
grant TRUNCATE on table public."bookkeeping_post_attempts" to "postgres";
grant REFERENCES on table public."bookkeeping_post_attempts" to "postgres";
grant TRIGGER on table public."bookkeeping_post_attempts" to "postgres";
grant MAINTAIN on table public."bookkeeping_post_attempts" to "postgres";
grant INSERT on table public."bookkeeping_post_attempts" to "anon";
grant SELECT on table public."bookkeeping_post_attempts" to "anon";
grant UPDATE on table public."bookkeeping_post_attempts" to "anon";
grant DELETE on table public."bookkeeping_post_attempts" to "anon";
grant TRUNCATE on table public."bookkeeping_post_attempts" to "anon";
grant REFERENCES on table public."bookkeeping_post_attempts" to "anon";
grant TRIGGER on table public."bookkeeping_post_attempts" to "anon";
grant MAINTAIN on table public."bookkeeping_post_attempts" to "anon";
grant INSERT on table public."bookkeeping_post_attempts" to "authenticated";
grant SELECT on table public."bookkeeping_post_attempts" to "authenticated";
grant UPDATE on table public."bookkeeping_post_attempts" to "authenticated";
grant DELETE on table public."bookkeeping_post_attempts" to "authenticated";
grant TRUNCATE on table public."bookkeeping_post_attempts" to "authenticated";
grant REFERENCES on table public."bookkeeping_post_attempts" to "authenticated";
grant TRIGGER on table public."bookkeeping_post_attempts" to "authenticated";
grant MAINTAIN on table public."bookkeeping_post_attempts" to "authenticated";
grant INSERT on table public."bookkeeping_post_attempts" to "service_role";
grant SELECT on table public."bookkeeping_post_attempts" to "service_role";
grant UPDATE on table public."bookkeeping_post_attempts" to "service_role";
grant DELETE on table public."bookkeeping_post_attempts" to "service_role";
grant TRUNCATE on table public."bookkeeping_post_attempts" to "service_role";
grant REFERENCES on table public."bookkeeping_post_attempts" to "service_role";
grant TRIGGER on table public."bookkeeping_post_attempts" to "service_role";
grant MAINTAIN on table public."bookkeeping_post_attempts" to "service_role";
alter table public."bookkeeping_posting_jobs" owner to "postgres";
alter table public."bookkeeping_posting_jobs" enable row level security;
alter table public."bookkeeping_posting_jobs" no force row level security;
revoke all on table public."bookkeeping_posting_jobs" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bookkeeping_posting_jobs" to "postgres";
grant SELECT on table public."bookkeeping_posting_jobs" to "postgres";
grant UPDATE on table public."bookkeeping_posting_jobs" to "postgres";
grant DELETE on table public."bookkeeping_posting_jobs" to "postgres";
grant TRUNCATE on table public."bookkeeping_posting_jobs" to "postgres";
grant REFERENCES on table public."bookkeeping_posting_jobs" to "postgres";
grant TRIGGER on table public."bookkeeping_posting_jobs" to "postgres";
grant MAINTAIN on table public."bookkeeping_posting_jobs" to "postgres";
grant INSERT on table public."bookkeeping_posting_jobs" to "service_role";
grant SELECT on table public."bookkeeping_posting_jobs" to "service_role";
grant UPDATE on table public."bookkeeping_posting_jobs" to "service_role";
grant DELETE on table public."bookkeeping_posting_jobs" to "service_role";
grant TRUNCATE on table public."bookkeeping_posting_jobs" to "service_role";
grant REFERENCES on table public."bookkeeping_posting_jobs" to "service_role";
grant TRIGGER on table public."bookkeeping_posting_jobs" to "service_role";
grant MAINTAIN on table public."bookkeeping_posting_jobs" to "service_role";
alter table public."bookkeeping_processing_requests" owner to "postgres";
alter table public."bookkeeping_processing_requests" enable row level security;
alter table public."bookkeeping_processing_requests" no force row level security;
revoke all on table public."bookkeeping_processing_requests" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bookkeeping_processing_requests" to "postgres";
grant SELECT on table public."bookkeeping_processing_requests" to "postgres";
grant UPDATE on table public."bookkeeping_processing_requests" to "postgres";
grant DELETE on table public."bookkeeping_processing_requests" to "postgres";
grant TRUNCATE on table public."bookkeeping_processing_requests" to "postgres";
grant REFERENCES on table public."bookkeeping_processing_requests" to "postgres";
grant TRIGGER on table public."bookkeeping_processing_requests" to "postgres";
grant MAINTAIN on table public."bookkeeping_processing_requests" to "postgres";
grant INSERT on table public."bookkeeping_processing_requests" to "service_role";
grant SELECT on table public."bookkeeping_processing_requests" to "service_role";
grant UPDATE on table public."bookkeeping_processing_requests" to "service_role";
grant DELETE on table public."bookkeeping_processing_requests" to "service_role";
grant TRUNCATE on table public."bookkeeping_processing_requests" to "service_role";
grant REFERENCES on table public."bookkeeping_processing_requests" to "service_role";
grant TRIGGER on table public."bookkeeping_processing_requests" to "service_role";
grant MAINTAIN on table public."bookkeeping_processing_requests" to "service_role";
alter view public."bookkeeping_transaction_feed_classification" owner to "postgres";
revoke all on table public."bookkeeping_transaction_feed_classification" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."bookkeeping_transaction_feed_classification" to "postgres";
grant SELECT on table public."bookkeeping_transaction_feed_classification" to "postgres";
grant UPDATE on table public."bookkeeping_transaction_feed_classification" to "postgres";
grant DELETE on table public."bookkeeping_transaction_feed_classification" to "postgres";
grant TRUNCATE on table public."bookkeeping_transaction_feed_classification" to "postgres";
grant REFERENCES on table public."bookkeeping_transaction_feed_classification" to "postgres";
grant TRIGGER on table public."bookkeeping_transaction_feed_classification" to "postgres";
grant MAINTAIN on table public."bookkeeping_transaction_feed_classification" to "postgres";
grant INSERT on table public."bookkeeping_transaction_feed_classification" to "service_role";
grant SELECT on table public."bookkeeping_transaction_feed_classification" to "service_role";
grant UPDATE on table public."bookkeeping_transaction_feed_classification" to "service_role";
grant DELETE on table public."bookkeeping_transaction_feed_classification" to "service_role";
grant TRUNCATE on table public."bookkeeping_transaction_feed_classification" to "service_role";
grant REFERENCES on table public."bookkeeping_transaction_feed_classification" to "service_role";
grant TRIGGER on table public."bookkeeping_transaction_feed_classification" to "service_role";
grant MAINTAIN on table public."bookkeeping_transaction_feed_classification" to "service_role";
alter table public."business_billing" owner to "postgres";
alter table public."business_billing" enable row level security;
alter table public."business_billing" no force row level security;
revoke all on table public."business_billing" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."business_billing" to "postgres";
grant SELECT on table public."business_billing" to "postgres";
grant UPDATE on table public."business_billing" to "postgres";
grant DELETE on table public."business_billing" to "postgres";
grant TRUNCATE on table public."business_billing" to "postgres";
grant REFERENCES on table public."business_billing" to "postgres";
grant TRIGGER on table public."business_billing" to "postgres";
grant MAINTAIN on table public."business_billing" to "postgres";
grant SELECT on table public."business_billing" to "authenticated";
grant MAINTAIN on table public."business_billing" to "authenticated";
grant INSERT on table public."business_billing" to "service_role";
grant SELECT on table public."business_billing" to "service_role";
grant UPDATE on table public."business_billing" to "service_role";
grant DELETE on table public."business_billing" to "service_role";
grant TRUNCATE on table public."business_billing" to "service_role";
grant REFERENCES on table public."business_billing" to "service_role";
grant TRIGGER on table public."business_billing" to "service_role";
grant MAINTAIN on table public."business_billing" to "service_role";
alter table public."business_financial_reporting_config" owner to "postgres";
alter table public."business_financial_reporting_config" enable row level security;
alter table public."business_financial_reporting_config" no force row level security;
revoke all on table public."business_financial_reporting_config" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."business_financial_reporting_config" to "postgres";
grant SELECT on table public."business_financial_reporting_config" to "postgres";
grant UPDATE on table public."business_financial_reporting_config" to "postgres";
grant DELETE on table public."business_financial_reporting_config" to "postgres";
grant TRUNCATE on table public."business_financial_reporting_config" to "postgres";
grant REFERENCES on table public."business_financial_reporting_config" to "postgres";
grant TRIGGER on table public."business_financial_reporting_config" to "postgres";
grant MAINTAIN on table public."business_financial_reporting_config" to "postgres";
grant SELECT on table public."business_financial_reporting_config" to "service_role";
alter table public."business_financial_reporting_config_audit" owner to "postgres";
alter table public."business_financial_reporting_config_audit" enable row level security;
alter table public."business_financial_reporting_config_audit" no force row level security;
revoke all on table public."business_financial_reporting_config_audit" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."business_financial_reporting_config_audit" to "postgres";
grant SELECT on table public."business_financial_reporting_config_audit" to "postgres";
grant UPDATE on table public."business_financial_reporting_config_audit" to "postgres";
grant DELETE on table public."business_financial_reporting_config_audit" to "postgres";
grant TRUNCATE on table public."business_financial_reporting_config_audit" to "postgres";
grant REFERENCES on table public."business_financial_reporting_config_audit" to "postgres";
grant TRIGGER on table public."business_financial_reporting_config_audit" to "postgres";
grant MAINTAIN on table public."business_financial_reporting_config_audit" to "postgres";
grant SELECT on table public."business_financial_reporting_config_audit" to "service_role";
alter table public."business_profiles" owner to "postgres";
alter table public."business_profiles" enable row level security;
alter table public."business_profiles" no force row level security;
revoke all on table public."business_profiles" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."business_profiles" to "postgres";
grant SELECT on table public."business_profiles" to "postgres";
grant UPDATE on table public."business_profiles" to "postgres";
grant DELETE on table public."business_profiles" to "postgres";
grant TRUNCATE on table public."business_profiles" to "postgres";
grant REFERENCES on table public."business_profiles" to "postgres";
grant TRIGGER on table public."business_profiles" to "postgres";
grant MAINTAIN on table public."business_profiles" to "postgres";
grant INSERT on table public."business_profiles" to "service_role";
grant SELECT on table public."business_profiles" to "service_role";
grant UPDATE on table public."business_profiles" to "service_role";
grant DELETE on table public."business_profiles" to "service_role";
grant TRUNCATE on table public."business_profiles" to "service_role";
grant REFERENCES on table public."business_profiles" to "service_role";
grant TRIGGER on table public."business_profiles" to "service_role";
grant MAINTAIN on table public."business_profiles" to "service_role";
grant SELECT on table public."business_profiles" to "authenticated";
grant UPDATE on table public."business_profiles" to "authenticated";
alter table public."clarification_requests" owner to "postgres";
alter table public."clarification_requests" enable row level security;
alter table public."clarification_requests" no force row level security;
revoke all on table public."clarification_requests" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."clarification_requests" to "postgres";
grant SELECT on table public."clarification_requests" to "postgres";
grant UPDATE on table public."clarification_requests" to "postgres";
grant DELETE on table public."clarification_requests" to "postgres";
grant TRUNCATE on table public."clarification_requests" to "postgres";
grant REFERENCES on table public."clarification_requests" to "postgres";
grant TRIGGER on table public."clarification_requests" to "postgres";
grant MAINTAIN on table public."clarification_requests" to "postgres";
grant INSERT on table public."clarification_requests" to "anon";
grant SELECT on table public."clarification_requests" to "anon";
grant UPDATE on table public."clarification_requests" to "anon";
grant DELETE on table public."clarification_requests" to "anon";
grant TRUNCATE on table public."clarification_requests" to "anon";
grant REFERENCES on table public."clarification_requests" to "anon";
grant TRIGGER on table public."clarification_requests" to "anon";
grant MAINTAIN on table public."clarification_requests" to "anon";
grant INSERT on table public."clarification_requests" to "authenticated";
grant SELECT on table public."clarification_requests" to "authenticated";
grant UPDATE on table public."clarification_requests" to "authenticated";
grant DELETE on table public."clarification_requests" to "authenticated";
grant TRUNCATE on table public."clarification_requests" to "authenticated";
grant REFERENCES on table public."clarification_requests" to "authenticated";
grant TRIGGER on table public."clarification_requests" to "authenticated";
grant MAINTAIN on table public."clarification_requests" to "authenticated";
grant INSERT on table public."clarification_requests" to "service_role";
grant SELECT on table public."clarification_requests" to "service_role";
grant UPDATE on table public."clarification_requests" to "service_role";
grant DELETE on table public."clarification_requests" to "service_role";
grant TRUNCATE on table public."clarification_requests" to "service_role";
grant REFERENCES on table public."clarification_requests" to "service_role";
grant TRIGGER on table public."clarification_requests" to "service_role";
grant MAINTAIN on table public."clarification_requests" to "service_role";
alter table public."credit_card_payment_pair_events" owner to "postgres";
alter table public."credit_card_payment_pair_events" enable row level security;
alter table public."credit_card_payment_pair_events" no force row level security;
revoke all on table public."credit_card_payment_pair_events" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."credit_card_payment_pair_events" to "postgres";
grant SELECT on table public."credit_card_payment_pair_events" to "postgres";
grant UPDATE on table public."credit_card_payment_pair_events" to "postgres";
grant DELETE on table public."credit_card_payment_pair_events" to "postgres";
grant TRUNCATE on table public."credit_card_payment_pair_events" to "postgres";
grant REFERENCES on table public."credit_card_payment_pair_events" to "postgres";
grant TRIGGER on table public."credit_card_payment_pair_events" to "postgres";
grant MAINTAIN on table public."credit_card_payment_pair_events" to "postgres";
grant INSERT on table public."credit_card_payment_pair_events" to "service_role";
grant SELECT on table public."credit_card_payment_pair_events" to "service_role";
grant UPDATE on table public."credit_card_payment_pair_events" to "service_role";
grant DELETE on table public."credit_card_payment_pair_events" to "service_role";
grant TRUNCATE on table public."credit_card_payment_pair_events" to "service_role";
grant REFERENCES on table public."credit_card_payment_pair_events" to "service_role";
grant TRIGGER on table public."credit_card_payment_pair_events" to "service_role";
grant MAINTAIN on table public."credit_card_payment_pair_events" to "service_role";
alter table public."credit_card_payment_pairs" owner to "postgres";
alter table public."credit_card_payment_pairs" enable row level security;
alter table public."credit_card_payment_pairs" no force row level security;
revoke all on table public."credit_card_payment_pairs" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."credit_card_payment_pairs" to "postgres";
grant SELECT on table public."credit_card_payment_pairs" to "postgres";
grant UPDATE on table public."credit_card_payment_pairs" to "postgres";
grant DELETE on table public."credit_card_payment_pairs" to "postgres";
grant TRUNCATE on table public."credit_card_payment_pairs" to "postgres";
grant REFERENCES on table public."credit_card_payment_pairs" to "postgres";
grant TRIGGER on table public."credit_card_payment_pairs" to "postgres";
grant MAINTAIN on table public."credit_card_payment_pairs" to "postgres";
grant INSERT on table public."credit_card_payment_pairs" to "service_role";
grant SELECT on table public."credit_card_payment_pairs" to "service_role";
grant UPDATE on table public."credit_card_payment_pairs" to "service_role";
grant DELETE on table public."credit_card_payment_pairs" to "service_role";
grant TRUNCATE on table public."credit_card_payment_pairs" to "service_role";
grant REFERENCES on table public."credit_card_payment_pairs" to "service_role";
grant TRIGGER on table public."credit_card_payment_pairs" to "service_role";
grant MAINTAIN on table public."credit_card_payment_pairs" to "service_role";
alter table public."financial_monthly_review_stamps" owner to "postgres";
alter table public."financial_monthly_review_stamps" enable row level security;
alter table public."financial_monthly_review_stamps" no force row level security;
revoke all on table public."financial_monthly_review_stamps" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."financial_monthly_review_stamps" to "postgres";
grant SELECT on table public."financial_monthly_review_stamps" to "postgres";
grant UPDATE on table public."financial_monthly_review_stamps" to "postgres";
grant DELETE on table public."financial_monthly_review_stamps" to "postgres";
grant TRUNCATE on table public."financial_monthly_review_stamps" to "postgres";
grant REFERENCES on table public."financial_monthly_review_stamps" to "postgres";
grant TRIGGER on table public."financial_monthly_review_stamps" to "postgres";
grant MAINTAIN on table public."financial_monthly_review_stamps" to "postgres";
grant INSERT on table public."financial_monthly_review_stamps" to "anon";
grant SELECT on table public."financial_monthly_review_stamps" to "anon";
grant UPDATE on table public."financial_monthly_review_stamps" to "anon";
grant DELETE on table public."financial_monthly_review_stamps" to "anon";
grant TRUNCATE on table public."financial_monthly_review_stamps" to "anon";
grant REFERENCES on table public."financial_monthly_review_stamps" to "anon";
grant TRIGGER on table public."financial_monthly_review_stamps" to "anon";
grant MAINTAIN on table public."financial_monthly_review_stamps" to "anon";
grant INSERT on table public."financial_monthly_review_stamps" to "authenticated";
grant SELECT on table public."financial_monthly_review_stamps" to "authenticated";
grant UPDATE on table public."financial_monthly_review_stamps" to "authenticated";
grant DELETE on table public."financial_monthly_review_stamps" to "authenticated";
grant TRUNCATE on table public."financial_monthly_review_stamps" to "authenticated";
grant REFERENCES on table public."financial_monthly_review_stamps" to "authenticated";
grant TRIGGER on table public."financial_monthly_review_stamps" to "authenticated";
grant MAINTAIN on table public."financial_monthly_review_stamps" to "authenticated";
grant INSERT on table public."financial_monthly_review_stamps" to "service_role";
grant SELECT on table public."financial_monthly_review_stamps" to "service_role";
grant UPDATE on table public."financial_monthly_review_stamps" to "service_role";
grant DELETE on table public."financial_monthly_review_stamps" to "service_role";
grant TRUNCATE on table public."financial_monthly_review_stamps" to "service_role";
grant REFERENCES on table public."financial_monthly_review_stamps" to "service_role";
grant TRIGGER on table public."financial_monthly_review_stamps" to "service_role";
grant MAINTAIN on table public."financial_monthly_review_stamps" to "service_role";
alter table public."internal_admin_view_sessions" owner to "postgres";
alter table public."internal_admin_view_sessions" enable row level security;
alter table public."internal_admin_view_sessions" no force row level security;
revoke all on table public."internal_admin_view_sessions" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."internal_admin_view_sessions" to "postgres";
grant SELECT on table public."internal_admin_view_sessions" to "postgres";
grant UPDATE on table public."internal_admin_view_sessions" to "postgres";
grant DELETE on table public."internal_admin_view_sessions" to "postgres";
grant TRUNCATE on table public."internal_admin_view_sessions" to "postgres";
grant REFERENCES on table public."internal_admin_view_sessions" to "postgres";
grant TRIGGER on table public."internal_admin_view_sessions" to "postgres";
grant MAINTAIN on table public."internal_admin_view_sessions" to "postgres";
grant INSERT on table public."internal_admin_view_sessions" to "service_role";
grant SELECT on table public."internal_admin_view_sessions" to "service_role";
grant UPDATE on table public."internal_admin_view_sessions" to "service_role";
grant DELETE on table public."internal_admin_view_sessions" to "service_role";
grant TRUNCATE on table public."internal_admin_view_sessions" to "service_role";
grant REFERENCES on table public."internal_admin_view_sessions" to "service_role";
grant TRIGGER on table public."internal_admin_view_sessions" to "service_role";
grant MAINTAIN on table public."internal_admin_view_sessions" to "service_role";
alter table public."internal_staff_users" owner to "postgres";
alter table public."internal_staff_users" enable row level security;
alter table public."internal_staff_users" no force row level security;
revoke all on table public."internal_staff_users" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."internal_staff_users" to "postgres";
grant SELECT on table public."internal_staff_users" to "postgres";
grant UPDATE on table public."internal_staff_users" to "postgres";
grant DELETE on table public."internal_staff_users" to "postgres";
grant TRUNCATE on table public."internal_staff_users" to "postgres";
grant REFERENCES on table public."internal_staff_users" to "postgres";
grant TRIGGER on table public."internal_staff_users" to "postgres";
grant MAINTAIN on table public."internal_staff_users" to "postgres";
grant INSERT on table public."internal_staff_users" to "service_role";
grant SELECT on table public."internal_staff_users" to "service_role";
grant UPDATE on table public."internal_staff_users" to "service_role";
grant DELETE on table public."internal_staff_users" to "service_role";
grant TRUNCATE on table public."internal_staff_users" to "service_role";
grant REFERENCES on table public."internal_staff_users" to "service_role";
grant TRIGGER on table public."internal_staff_users" to "service_role";
grant MAINTAIN on table public."internal_staff_users" to "service_role";
alter table public."monthly_review_qbo_pnl_snapshots" owner to "postgres";
alter table public."monthly_review_qbo_pnl_snapshots" enable row level security;
alter table public."monthly_review_qbo_pnl_snapshots" no force row level security;
revoke all on table public."monthly_review_qbo_pnl_snapshots" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."monthly_review_qbo_pnl_snapshots" to "postgres";
grant SELECT on table public."monthly_review_qbo_pnl_snapshots" to "postgres";
grant UPDATE on table public."monthly_review_qbo_pnl_snapshots" to "postgres";
grant DELETE on table public."monthly_review_qbo_pnl_snapshots" to "postgres";
grant TRUNCATE on table public."monthly_review_qbo_pnl_snapshots" to "postgres";
grant REFERENCES on table public."monthly_review_qbo_pnl_snapshots" to "postgres";
grant TRIGGER on table public."monthly_review_qbo_pnl_snapshots" to "postgres";
grant MAINTAIN on table public."monthly_review_qbo_pnl_snapshots" to "postgres";
grant INSERT on table public."monthly_review_qbo_pnl_snapshots" to "service_role";
grant SELECT on table public."monthly_review_qbo_pnl_snapshots" to "service_role";
grant UPDATE on table public."monthly_review_qbo_pnl_snapshots" to "service_role";
grant DELETE on table public."monthly_review_qbo_pnl_snapshots" to "service_role";
grant TRUNCATE on table public."monthly_review_qbo_pnl_snapshots" to "service_role";
grant REFERENCES on table public."monthly_review_qbo_pnl_snapshots" to "service_role";
grant TRIGGER on table public."monthly_review_qbo_pnl_snapshots" to "service_role";
grant MAINTAIN on table public."monthly_review_qbo_pnl_snapshots" to "service_role";
alter table public."monthly_review_runs" owner to "postgres";
alter table public."monthly_review_runs" enable row level security;
alter table public."monthly_review_runs" no force row level security;
revoke all on table public."monthly_review_runs" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."monthly_review_runs" to "postgres";
grant SELECT on table public."monthly_review_runs" to "postgres";
grant UPDATE on table public."monthly_review_runs" to "postgres";
grant DELETE on table public."monthly_review_runs" to "postgres";
grant TRUNCATE on table public."monthly_review_runs" to "postgres";
grant REFERENCES on table public."monthly_review_runs" to "postgres";
grant TRIGGER on table public."monthly_review_runs" to "postgres";
grant MAINTAIN on table public."monthly_review_runs" to "postgres";
grant INSERT on table public."monthly_review_runs" to "anon";
grant SELECT on table public."monthly_review_runs" to "anon";
grant UPDATE on table public."monthly_review_runs" to "anon";
grant DELETE on table public."monthly_review_runs" to "anon";
grant TRUNCATE on table public."monthly_review_runs" to "anon";
grant REFERENCES on table public."monthly_review_runs" to "anon";
grant TRIGGER on table public."monthly_review_runs" to "anon";
grant MAINTAIN on table public."monthly_review_runs" to "anon";
grant INSERT on table public."monthly_review_runs" to "authenticated";
grant SELECT on table public."monthly_review_runs" to "authenticated";
grant UPDATE on table public."monthly_review_runs" to "authenticated";
grant DELETE on table public."monthly_review_runs" to "authenticated";
grant TRUNCATE on table public."monthly_review_runs" to "authenticated";
grant REFERENCES on table public."monthly_review_runs" to "authenticated";
grant TRIGGER on table public."monthly_review_runs" to "authenticated";
grant MAINTAIN on table public."monthly_review_runs" to "authenticated";
grant INSERT on table public."monthly_review_runs" to "service_role";
grant SELECT on table public."monthly_review_runs" to "service_role";
grant UPDATE on table public."monthly_review_runs" to "service_role";
grant DELETE on table public."monthly_review_runs" to "service_role";
grant TRUNCATE on table public."monthly_review_runs" to "service_role";
grant REFERENCES on table public."monthly_review_runs" to "service_role";
grant TRIGGER on table public."monthly_review_runs" to "service_role";
grant MAINTAIN on table public."monthly_review_runs" to "service_role";
alter table public."operator_request_summaries" owner to "postgres";
alter table public."operator_request_summaries" enable row level security;
alter table public."operator_request_summaries" no force row level security;
revoke all on table public."operator_request_summaries" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."operator_request_summaries" to "postgres";
grant SELECT on table public."operator_request_summaries" to "postgres";
grant UPDATE on table public."operator_request_summaries" to "postgres";
grant DELETE on table public."operator_request_summaries" to "postgres";
grant TRUNCATE on table public."operator_request_summaries" to "postgres";
grant REFERENCES on table public."operator_request_summaries" to "postgres";
grant TRIGGER on table public."operator_request_summaries" to "postgres";
grant MAINTAIN on table public."operator_request_summaries" to "postgres";
grant INSERT on table public."operator_request_summaries" to "service_role";
grant SELECT on table public."operator_request_summaries" to "service_role";
grant UPDATE on table public."operator_request_summaries" to "service_role";
grant DELETE on table public."operator_request_summaries" to "service_role";
grant TRUNCATE on table public."operator_request_summaries" to "service_role";
grant REFERENCES on table public."operator_request_summaries" to "service_role";
grant TRIGGER on table public."operator_request_summaries" to "service_role";
grant MAINTAIN on table public."operator_request_summaries" to "service_role";
alter table public."pending_transaction_resolution_events" owner to "postgres";
alter table public."pending_transaction_resolution_events" enable row level security;
alter table public."pending_transaction_resolution_events" no force row level security;
revoke all on table public."pending_transaction_resolution_events" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."pending_transaction_resolution_events" to "postgres";
grant SELECT on table public."pending_transaction_resolution_events" to "postgres";
grant UPDATE on table public."pending_transaction_resolution_events" to "postgres";
grant DELETE on table public."pending_transaction_resolution_events" to "postgres";
grant TRUNCATE on table public."pending_transaction_resolution_events" to "postgres";
grant REFERENCES on table public."pending_transaction_resolution_events" to "postgres";
grant TRIGGER on table public."pending_transaction_resolution_events" to "postgres";
grant MAINTAIN on table public."pending_transaction_resolution_events" to "postgres";
grant INSERT on table public."pending_transaction_resolution_events" to "service_role";
grant SELECT on table public."pending_transaction_resolution_events" to "service_role";
grant UPDATE on table public."pending_transaction_resolution_events" to "service_role";
grant DELETE on table public."pending_transaction_resolution_events" to "service_role";
grant TRUNCATE on table public."pending_transaction_resolution_events" to "service_role";
grant REFERENCES on table public."pending_transaction_resolution_events" to "service_role";
grant TRIGGER on table public."pending_transaction_resolution_events" to "service_role";
grant MAINTAIN on table public."pending_transaction_resolution_events" to "service_role";
alter table public."plaid_account_connection_audit" owner to "postgres";
alter table public."plaid_account_connection_audit" enable row level security;
alter table public."plaid_account_connection_audit" no force row level security;
revoke all on table public."plaid_account_connection_audit" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_account_connection_audit" to "postgres";
grant SELECT on table public."plaid_account_connection_audit" to "postgres";
grant UPDATE on table public."plaid_account_connection_audit" to "postgres";
grant DELETE on table public."plaid_account_connection_audit" to "postgres";
grant TRUNCATE on table public."plaid_account_connection_audit" to "postgres";
grant REFERENCES on table public."plaid_account_connection_audit" to "postgres";
grant TRIGGER on table public."plaid_account_connection_audit" to "postgres";
grant MAINTAIN on table public."plaid_account_connection_audit" to "postgres";
grant INSERT on table public."plaid_account_connection_audit" to "service_role";
grant SELECT on table public."plaid_account_connection_audit" to "service_role";
grant UPDATE on table public."plaid_account_connection_audit" to "service_role";
grant DELETE on table public."plaid_account_connection_audit" to "service_role";
grant TRUNCATE on table public."plaid_account_connection_audit" to "service_role";
grant REFERENCES on table public."plaid_account_connection_audit" to "service_role";
grant TRIGGER on table public."plaid_account_connection_audit" to "service_role";
grant MAINTAIN on table public."plaid_account_connection_audit" to "service_role";
alter table public."plaid_account_lineage_decisions" owner to "postgres";
alter table public."plaid_account_lineage_decisions" enable row level security;
alter table public."plaid_account_lineage_decisions" no force row level security;
revoke all on table public."plaid_account_lineage_decisions" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_account_lineage_decisions" to "postgres";
grant SELECT on table public."plaid_account_lineage_decisions" to "postgres";
grant UPDATE on table public."plaid_account_lineage_decisions" to "postgres";
grant DELETE on table public."plaid_account_lineage_decisions" to "postgres";
grant TRUNCATE on table public."plaid_account_lineage_decisions" to "postgres";
grant REFERENCES on table public."plaid_account_lineage_decisions" to "postgres";
grant TRIGGER on table public."plaid_account_lineage_decisions" to "postgres";
grant MAINTAIN on table public."plaid_account_lineage_decisions" to "postgres";
grant INSERT on table public."plaid_account_lineage_decisions" to "service_role";
grant SELECT on table public."plaid_account_lineage_decisions" to "service_role";
grant UPDATE on table public."plaid_account_lineage_decisions" to "service_role";
grant DELETE on table public."plaid_account_lineage_decisions" to "service_role";
grant TRUNCATE on table public."plaid_account_lineage_decisions" to "service_role";
grant REFERENCES on table public."plaid_account_lineage_decisions" to "service_role";
grant TRIGGER on table public."plaid_account_lineage_decisions" to "service_role";
grant MAINTAIN on table public."plaid_account_lineage_decisions" to "service_role";
alter table public."plaid_accounts" owner to "postgres";
alter table public."plaid_accounts" enable row level security;
alter table public."plaid_accounts" no force row level security;
revoke all on table public."plaid_accounts" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_accounts" to "postgres";
grant SELECT on table public."plaid_accounts" to "postgres";
grant UPDATE on table public."plaid_accounts" to "postgres";
grant DELETE on table public."plaid_accounts" to "postgres";
grant TRUNCATE on table public."plaid_accounts" to "postgres";
grant REFERENCES on table public."plaid_accounts" to "postgres";
grant TRIGGER on table public."plaid_accounts" to "postgres";
grant MAINTAIN on table public."plaid_accounts" to "postgres";
grant INSERT on table public."plaid_accounts" to "service_role";
grant SELECT on table public."plaid_accounts" to "service_role";
grant UPDATE on table public."plaid_accounts" to "service_role";
grant DELETE on table public."plaid_accounts" to "service_role";
grant TRUNCATE on table public."plaid_accounts" to "service_role";
grant REFERENCES on table public."plaid_accounts" to "service_role";
grant TRIGGER on table public."plaid_accounts" to "service_role";
grant MAINTAIN on table public."plaid_accounts" to "service_role";
alter table public."plaid_items" owner to "postgres";
alter table public."plaid_items" enable row level security;
alter table public."plaid_items" no force row level security;
revoke all on table public."plaid_items" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_items" to "postgres";
grant SELECT on table public."plaid_items" to "postgres";
grant UPDATE on table public."plaid_items" to "postgres";
grant DELETE on table public."plaid_items" to "postgres";
grant TRUNCATE on table public."plaid_items" to "postgres";
grant REFERENCES on table public."plaid_items" to "postgres";
grant TRIGGER on table public."plaid_items" to "postgres";
grant MAINTAIN on table public."plaid_items" to "postgres";
grant INSERT on table public."plaid_items" to "service_role";
grant SELECT on table public."plaid_items" to "service_role";
grant UPDATE on table public."plaid_items" to "service_role";
grant DELETE on table public."plaid_items" to "service_role";
grant TRUNCATE on table public."plaid_items" to "service_role";
grant REFERENCES on table public."plaid_items" to "service_role";
grant TRIGGER on table public."plaid_items" to "service_role";
grant MAINTAIN on table public."plaid_items" to "service_role";
alter table public."plaid_physical_accounts" owner to "postgres";
alter table public."plaid_physical_accounts" enable row level security;
alter table public."plaid_physical_accounts" no force row level security;
revoke all on table public."plaid_physical_accounts" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_physical_accounts" to "postgres";
grant SELECT on table public."plaid_physical_accounts" to "postgres";
grant UPDATE on table public."plaid_physical_accounts" to "postgres";
grant DELETE on table public."plaid_physical_accounts" to "postgres";
grant TRUNCATE on table public."plaid_physical_accounts" to "postgres";
grant REFERENCES on table public."plaid_physical_accounts" to "postgres";
grant TRIGGER on table public."plaid_physical_accounts" to "postgres";
grant MAINTAIN on table public."plaid_physical_accounts" to "postgres";
grant INSERT on table public."plaid_physical_accounts" to "service_role";
grant SELECT on table public."plaid_physical_accounts" to "service_role";
grant UPDATE on table public."plaid_physical_accounts" to "service_role";
grant DELETE on table public."plaid_physical_accounts" to "service_role";
grant TRUNCATE on table public."plaid_physical_accounts" to "service_role";
grant REFERENCES on table public."plaid_physical_accounts" to "service_role";
grant TRIGGER on table public."plaid_physical_accounts" to "service_role";
grant MAINTAIN on table public."plaid_physical_accounts" to "service_role";
alter table public."plaid_qbo_account_mappings" owner to "postgres";
alter table public."plaid_qbo_account_mappings" enable row level security;
alter table public."plaid_qbo_account_mappings" no force row level security;
revoke all on table public."plaid_qbo_account_mappings" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_qbo_account_mappings" to "postgres";
grant SELECT on table public."plaid_qbo_account_mappings" to "postgres";
grant UPDATE on table public."plaid_qbo_account_mappings" to "postgres";
grant DELETE on table public."plaid_qbo_account_mappings" to "postgres";
grant TRUNCATE on table public."plaid_qbo_account_mappings" to "postgres";
grant REFERENCES on table public."plaid_qbo_account_mappings" to "postgres";
grant TRIGGER on table public."plaid_qbo_account_mappings" to "postgres";
grant MAINTAIN on table public."plaid_qbo_account_mappings" to "postgres";
grant INSERT on table public."plaid_qbo_account_mappings" to "service_role";
grant SELECT on table public."plaid_qbo_account_mappings" to "service_role";
grant UPDATE on table public."plaid_qbo_account_mappings" to "service_role";
grant DELETE on table public."plaid_qbo_account_mappings" to "service_role";
grant TRUNCATE on table public."plaid_qbo_account_mappings" to "service_role";
grant REFERENCES on table public."plaid_qbo_account_mappings" to "service_role";
grant TRIGGER on table public."plaid_qbo_account_mappings" to "service_role";
grant MAINTAIN on table public."plaid_qbo_account_mappings" to "service_role";
alter table public."plaid_recovery_batch_rows" owner to "postgres";
alter table public."plaid_recovery_batch_rows" enable row level security;
alter table public."plaid_recovery_batch_rows" no force row level security;
revoke all on table public."plaid_recovery_batch_rows" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_recovery_batch_rows" to "postgres";
grant SELECT on table public."plaid_recovery_batch_rows" to "postgres";
grant UPDATE on table public."plaid_recovery_batch_rows" to "postgres";
grant DELETE on table public."plaid_recovery_batch_rows" to "postgres";
grant TRUNCATE on table public."plaid_recovery_batch_rows" to "postgres";
grant REFERENCES on table public."plaid_recovery_batch_rows" to "postgres";
grant TRIGGER on table public."plaid_recovery_batch_rows" to "postgres";
grant MAINTAIN on table public."plaid_recovery_batch_rows" to "postgres";
grant INSERT on table public."plaid_recovery_batch_rows" to "service_role";
grant SELECT on table public."plaid_recovery_batch_rows" to "service_role";
grant UPDATE on table public."plaid_recovery_batch_rows" to "service_role";
grant DELETE on table public."plaid_recovery_batch_rows" to "service_role";
grant TRUNCATE on table public."plaid_recovery_batch_rows" to "service_role";
grant REFERENCES on table public."plaid_recovery_batch_rows" to "service_role";
grant TRIGGER on table public."plaid_recovery_batch_rows" to "service_role";
grant MAINTAIN on table public."plaid_recovery_batch_rows" to "service_role";
alter table public."plaid_recovery_batches" owner to "postgres";
alter table public."plaid_recovery_batches" enable row level security;
alter table public."plaid_recovery_batches" no force row level security;
revoke all on table public."plaid_recovery_batches" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_recovery_batches" to "postgres";
grant SELECT on table public."plaid_recovery_batches" to "postgres";
grant UPDATE on table public."plaid_recovery_batches" to "postgres";
grant DELETE on table public."plaid_recovery_batches" to "postgres";
grant TRUNCATE on table public."plaid_recovery_batches" to "postgres";
grant REFERENCES on table public."plaid_recovery_batches" to "postgres";
grant TRIGGER on table public."plaid_recovery_batches" to "postgres";
grant MAINTAIN on table public."plaid_recovery_batches" to "postgres";
grant INSERT on table public."plaid_recovery_batches" to "service_role";
grant SELECT on table public."plaid_recovery_batches" to "service_role";
grant UPDATE on table public."plaid_recovery_batches" to "service_role";
grant DELETE on table public."plaid_recovery_batches" to "service_role";
grant TRUNCATE on table public."plaid_recovery_batches" to "service_role";
grant REFERENCES on table public."plaid_recovery_batches" to "service_role";
grant TRIGGER on table public."plaid_recovery_batches" to "service_role";
grant MAINTAIN on table public."plaid_recovery_batches" to "service_role";
grant SELECT on table public."plaid_recovery_batches" to "plaid_residual_hold_executor";
alter table public."plaid_replacement_account_candidates" owner to "postgres";
alter table public."plaid_replacement_account_candidates" enable row level security;
alter table public."plaid_replacement_account_candidates" no force row level security;
revoke all on table public."plaid_replacement_account_candidates" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."plaid_replacement_account_candidates" to "postgres";
grant SELECT on table public."plaid_replacement_account_candidates" to "postgres";
grant UPDATE on table public."plaid_replacement_account_candidates" to "postgres";
grant DELETE on table public."plaid_replacement_account_candidates" to "postgres";
grant TRUNCATE on table public."plaid_replacement_account_candidates" to "postgres";
grant REFERENCES on table public."plaid_replacement_account_candidates" to "postgres";
grant TRIGGER on table public."plaid_replacement_account_candidates" to "postgres";
grant MAINTAIN on table public."plaid_replacement_account_candidates" to "postgres";
grant INSERT on table public."plaid_replacement_account_candidates" to "service_role";
grant SELECT on table public."plaid_replacement_account_candidates" to "service_role";
grant UPDATE on table public."plaid_replacement_account_candidates" to "service_role";
grant DELETE on table public."plaid_replacement_account_candidates" to "service_role";
grant TRUNCATE on table public."plaid_replacement_account_candidates" to "service_role";
grant REFERENCES on table public."plaid_replacement_account_candidates" to "service_role";
grant TRIGGER on table public."plaid_replacement_account_candidates" to "service_role";
grant MAINTAIN on table public."plaid_replacement_account_candidates" to "service_role";
alter table public."qbo_accounts_cache" owner to "postgres";
alter table public."qbo_accounts_cache" enable row level security;
alter table public."qbo_accounts_cache" no force row level security;
revoke all on table public."qbo_accounts_cache" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."qbo_accounts_cache" to "postgres";
grant SELECT on table public."qbo_accounts_cache" to "postgres";
grant UPDATE on table public."qbo_accounts_cache" to "postgres";
grant DELETE on table public."qbo_accounts_cache" to "postgres";
grant TRUNCATE on table public."qbo_accounts_cache" to "postgres";
grant REFERENCES on table public."qbo_accounts_cache" to "postgres";
grant TRIGGER on table public."qbo_accounts_cache" to "postgres";
grant MAINTAIN on table public."qbo_accounts_cache" to "postgres";
grant INSERT on table public."qbo_accounts_cache" to "service_role";
grant SELECT on table public."qbo_accounts_cache" to "service_role";
grant UPDATE on table public."qbo_accounts_cache" to "service_role";
grant DELETE on table public."qbo_accounts_cache" to "service_role";
grant TRUNCATE on table public."qbo_accounts_cache" to "service_role";
grant REFERENCES on table public."qbo_accounts_cache" to "service_role";
grant TRIGGER on table public."qbo_accounts_cache" to "service_role";
grant MAINTAIN on table public."qbo_accounts_cache" to "service_role";
alter table public."qbo_posted_transactions" owner to "postgres";
alter table public."qbo_posted_transactions" enable row level security;
alter table public."qbo_posted_transactions" no force row level security;
revoke all on table public."qbo_posted_transactions" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."qbo_posted_transactions" to "postgres";
grant SELECT on table public."qbo_posted_transactions" to "postgres";
grant UPDATE on table public."qbo_posted_transactions" to "postgres";
grant DELETE on table public."qbo_posted_transactions" to "postgres";
grant TRUNCATE on table public."qbo_posted_transactions" to "postgres";
grant REFERENCES on table public."qbo_posted_transactions" to "postgres";
grant TRIGGER on table public."qbo_posted_transactions" to "postgres";
grant MAINTAIN on table public."qbo_posted_transactions" to "postgres";
grant INSERT on table public."qbo_posted_transactions" to "service_role";
grant SELECT on table public."qbo_posted_transactions" to "service_role";
grant UPDATE on table public."qbo_posted_transactions" to "service_role";
grant DELETE on table public."qbo_posted_transactions" to "service_role";
grant TRUNCATE on table public."qbo_posted_transactions" to "service_role";
grant REFERENCES on table public."qbo_posted_transactions" to "service_role";
grant TRIGGER on table public."qbo_posted_transactions" to "service_role";
grant MAINTAIN on table public."qbo_posted_transactions" to "service_role";
alter table public."quickbooks_tokens" owner to "postgres";
alter table public."quickbooks_tokens" enable row level security;
alter table public."quickbooks_tokens" no force row level security;
revoke all on table public."quickbooks_tokens" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."quickbooks_tokens" to "postgres";
grant SELECT on table public."quickbooks_tokens" to "postgres";
grant UPDATE on table public."quickbooks_tokens" to "postgres";
grant DELETE on table public."quickbooks_tokens" to "postgres";
grant TRUNCATE on table public."quickbooks_tokens" to "postgres";
grant REFERENCES on table public."quickbooks_tokens" to "postgres";
grant TRIGGER on table public."quickbooks_tokens" to "postgres";
grant MAINTAIN on table public."quickbooks_tokens" to "postgres";
grant INSERT on table public."quickbooks_tokens" to "service_role";
grant SELECT on table public."quickbooks_tokens" to "service_role";
grant UPDATE on table public."quickbooks_tokens" to "service_role";
grant DELETE on table public."quickbooks_tokens" to "service_role";
grant TRUNCATE on table public."quickbooks_tokens" to "service_role";
grant REFERENCES on table public."quickbooks_tokens" to "service_role";
grant TRIGGER on table public."quickbooks_tokens" to "service_role";
grant MAINTAIN on table public."quickbooks_tokens" to "service_role";
alter table public."subscriptions" owner to "postgres";
alter table public."subscriptions" enable row level security;
alter table public."subscriptions" no force row level security;
revoke all on table public."subscriptions" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."subscriptions" to "postgres";
grant SELECT on table public."subscriptions" to "postgres";
grant UPDATE on table public."subscriptions" to "postgres";
grant DELETE on table public."subscriptions" to "postgres";
grant TRUNCATE on table public."subscriptions" to "postgres";
grant REFERENCES on table public."subscriptions" to "postgres";
grant TRIGGER on table public."subscriptions" to "postgres";
grant MAINTAIN on table public."subscriptions" to "postgres";
grant INSERT on table public."subscriptions" to "service_role";
grant SELECT on table public."subscriptions" to "service_role";
grant UPDATE on table public."subscriptions" to "service_role";
grant DELETE on table public."subscriptions" to "service_role";
grant TRUNCATE on table public."subscriptions" to "service_role";
grant REFERENCES on table public."subscriptions" to "service_role";
grant TRIGGER on table public."subscriptions" to "service_role";
grant MAINTAIN on table public."subscriptions" to "service_role";
alter table public."transaction_categorizations" owner to "postgres";
alter table public."transaction_categorizations" enable row level security;
alter table public."transaction_categorizations" no force row level security;
revoke all on table public."transaction_categorizations" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."transaction_categorizations" to "postgres";
grant SELECT on table public."transaction_categorizations" to "postgres";
grant UPDATE on table public."transaction_categorizations" to "postgres";
grant DELETE on table public."transaction_categorizations" to "postgres";
grant TRUNCATE on table public."transaction_categorizations" to "postgres";
grant REFERENCES on table public."transaction_categorizations" to "postgres";
grant TRIGGER on table public."transaction_categorizations" to "postgres";
grant MAINTAIN on table public."transaction_categorizations" to "postgres";
grant INSERT on table public."transaction_categorizations" to "service_role";
grant SELECT on table public."transaction_categorizations" to "service_role";
grant UPDATE on table public."transaction_categorizations" to "service_role";
grant DELETE on table public."transaction_categorizations" to "service_role";
grant TRUNCATE on table public."transaction_categorizations" to "service_role";
grant REFERENCES on table public."transaction_categorizations" to "service_role";
grant TRIGGER on table public."transaction_categorizations" to "service_role";
grant MAINTAIN on table public."transaction_categorizations" to "service_role";
grant SELECT on table public."transaction_categorizations" to "plaid_residual_hold_executor";
alter table public."user_business_link" owner to "postgres";
alter table public."user_business_link" enable row level security;
alter table public."user_business_link" no force row level security;
revoke all on table public."user_business_link" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."user_business_link" to "postgres";
grant SELECT on table public."user_business_link" to "postgres";
grant UPDATE on table public."user_business_link" to "postgres";
grant DELETE on table public."user_business_link" to "postgres";
grant TRUNCATE on table public."user_business_link" to "postgres";
grant REFERENCES on table public."user_business_link" to "postgres";
grant TRIGGER on table public."user_business_link" to "postgres";
grant MAINTAIN on table public."user_business_link" to "postgres";
grant INSERT on table public."user_business_link" to "service_role";
grant SELECT on table public."user_business_link" to "service_role";
grant UPDATE on table public."user_business_link" to "service_role";
grant DELETE on table public."user_business_link" to "service_role";
grant TRUNCATE on table public."user_business_link" to "service_role";
grant REFERENCES on table public."user_business_link" to "service_role";
grant TRIGGER on table public."user_business_link" to "service_role";
grant MAINTAIN on table public."user_business_link" to "service_role";
grant SELECT on table public."user_business_link" to "authenticated";
alter table public."user_profiles" owner to "postgres";
alter table public."user_profiles" enable row level security;
alter table public."user_profiles" no force row level security;
revoke all on table public."user_profiles" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant INSERT on table public."user_profiles" to "postgres";
grant SELECT on table public."user_profiles" to "postgres";
grant UPDATE on table public."user_profiles" to "postgres";
grant DELETE on table public."user_profiles" to "postgres";
grant TRUNCATE on table public."user_profiles" to "postgres";
grant REFERENCES on table public."user_profiles" to "postgres";
grant TRIGGER on table public."user_profiles" to "postgres";
grant MAINTAIN on table public."user_profiles" to "postgres";
grant INSERT on table public."user_profiles" to "anon";
grant SELECT on table public."user_profiles" to "anon";
grant UPDATE on table public."user_profiles" to "anon";
grant DELETE on table public."user_profiles" to "anon";
grant TRUNCATE on table public."user_profiles" to "anon";
grant REFERENCES on table public."user_profiles" to "anon";
grant TRIGGER on table public."user_profiles" to "anon";
grant MAINTAIN on table public."user_profiles" to "anon";
grant INSERT on table public."user_profiles" to "authenticated";
grant SELECT on table public."user_profiles" to "authenticated";
grant UPDATE on table public."user_profiles" to "authenticated";
grant DELETE on table public."user_profiles" to "authenticated";
grant TRUNCATE on table public."user_profiles" to "authenticated";
grant REFERENCES on table public."user_profiles" to "authenticated";
grant TRIGGER on table public."user_profiles" to "authenticated";
grant MAINTAIN on table public."user_profiles" to "authenticated";
grant INSERT on table public."user_profiles" to "service_role";
grant SELECT on table public."user_profiles" to "service_role";
grant UPDATE on table public."user_profiles" to "service_role";
grant DELETE on table public."user_profiles" to "service_role";
grant TRUNCATE on table public."user_profiles" to "service_role";
grant REFERENCES on table public."user_profiles" to "service_role";
grant TRIGGER on table public."user_profiles" to "service_role";
grant MAINTAIN on table public."user_profiles" to "service_role";
alter function public.tax_user_owns_business(uuid) owner to "postgres";
revoke all on function public.tax_user_owns_business(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.tax_user_owns_business(uuid) to "postgres";
grant EXECUTE on function public.tax_user_owns_business(uuid) to "authenticated";
grant EXECUTE on function public.tax_user_owns_business(uuid) to "service_role";
alter function public.refresh_billing_identity_summary_from_billing() owner to "postgres";
revoke all on function public.refresh_billing_identity_summary_from_billing() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.refresh_billing_identity_summary_from_billing() to "postgres";
grant EXECUTE on function public.refresh_billing_identity_summary_from_billing() to "service_role";
alter function public.enforce_business_profile_onboarding_status() owner to "postgres";
revoke all on function public.enforce_business_profile_onboarding_status() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.enforce_business_profile_onboarding_status() to "postgres";
grant EXECUTE on function public.enforce_business_profile_onboarding_status() to "service_role";
alter function public.claim_bookkeeping_processing_requests(text,integer,timestamp with time zone) owner to "postgres";
revoke all on function public.claim_bookkeeping_processing_requests(text,integer,timestamp with time zone) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.claim_bookkeeping_processing_requests(text,integer,timestamp with time zone) to "postgres";
grant EXECUTE on function public.claim_bookkeeping_processing_requests(text,integer,timestamp with time zone) to "service_role";
alter function public.get_operator_request_counts_bounded(uuid) owner to "postgres";
revoke all on function public.get_operator_request_counts_bounded(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.get_operator_request_counts_bounded(uuid) to "postgres";
grant EXECUTE on function public.get_operator_request_counts_bounded(uuid) to "service_role";
alter function public.enforce_bookkeeping_review_posting_state() owner to "postgres";
revoke all on function public.enforce_bookkeeping_review_posting_state() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.enforce_bookkeeping_review_posting_state() to public;
grant EXECUTE on function public.enforce_bookkeeping_review_posting_state() to "postgres";
grant EXECUTE on function public.enforce_bookkeeping_review_posting_state() to "service_role";
alter function public.plaid_residual_reconciliation_snapshot(uuid,text,text,uuid) owner to "postgres";
revoke all on function public.plaid_residual_reconciliation_snapshot(uuid,text,text,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.plaid_residual_reconciliation_snapshot(uuid,text,text,uuid) to "postgres";
grant EXECUTE on function public.plaid_residual_reconciliation_snapshot(uuid,text,text,uuid) to "service_role";
alter function public.assert_plaid_residual_operator_scope(uuid,text,text,uuid,uuid) owner to "postgres";
revoke all on function public.assert_plaid_residual_operator_scope(uuid,text,text,uuid,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.assert_plaid_residual_operator_scope(uuid,text,text,uuid,uuid) to "postgres";
grant EXECUTE on function public.assert_plaid_residual_operator_scope(uuid,text,text,uuid,uuid) to "service_role";
alter function public.assert_plaid_recovery_operator(uuid) owner to "postgres";
revoke all on function public.assert_plaid_recovery_operator(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.assert_plaid_recovery_operator(uuid) to "postgres";
grant EXECUTE on function public.assert_plaid_recovery_operator(uuid) to "service_role";
alter function public.touch_internal_admin_view_sessions_updated_at() owner to "postgres";
revoke all on function public.touch_internal_admin_view_sessions_updated_at() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.touch_internal_admin_view_sessions_updated_at() to "postgres";
grant EXECUTE on function public.touch_internal_admin_view_sessions_updated_at() to "service_role";
alter function public.bizzi_current_user_is_business_member(uuid) owner to "postgres";
revoke all on function public.bizzi_current_user_is_business_member(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.bizzi_current_user_is_business_member(uuid) to "postgres";
grant EXECUTE on function public.bizzi_current_user_is_business_member(uuid) to "service_role";
grant EXECUTE on function public.bizzi_current_user_is_business_member(uuid) to "authenticated";
alter function public.business_profile_has_active_qbo_connection(uuid) owner to "postgres";
revoke all on function public.business_profile_has_active_qbo_connection(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.business_profile_has_active_qbo_connection(uuid) to "postgres";
grant EXECUTE on function public.business_profile_has_active_qbo_connection(uuid) to "service_role";
alter function public.prevent_business_profile_identity_reassignment() owner to "postgres";
revoke all on function public.prevent_business_profile_identity_reassignment() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.prevent_business_profile_identity_reassignment() to "postgres";
grant EXECUTE on function public.prevent_business_profile_identity_reassignment() to "service_role";
alter function public.business_profile_has_active_plaid_connection(uuid) owner to "postgres";
revoke all on function public.business_profile_has_active_plaid_connection(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.business_profile_has_active_plaid_connection(uuid) to "postgres";
grant EXECUTE on function public.business_profile_has_active_plaid_connection(uuid) to "service_role";
alter function public.refresh_business_profile_onboarding_status_from_integration() owner to "postgres";
revoke all on function public.refresh_business_profile_onboarding_status_from_integration() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.refresh_business_profile_onboarding_status_from_integration() to "postgres";
grant EXECUTE on function public.refresh_business_profile_onboarding_status_from_integration() to "service_role";
alter function public.audit_bookkeeping_lifecycle_transition() owner to "postgres";
revoke all on function public.audit_bookkeeping_lifecycle_transition() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.audit_bookkeeping_lifecycle_transition() to public;
grant EXECUTE on function public.audit_bookkeeping_lifecycle_transition() to "postgres";
grant EXECUTE on function public.audit_bookkeeping_lifecycle_transition() to "service_role";
alter function public.refresh_billing_identity_summary_from_business_profile() owner to "postgres";
revoke all on function public.refresh_billing_identity_summary_from_business_profile() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.refresh_billing_identity_summary_from_business_profile() to "postgres";
grant EXECUTE on function public.refresh_billing_identity_summary_from_business_profile() to "service_role";
alter function public.refresh_billing_identity_summary_from_user_profile() owner to "postgres";
revoke all on function public.refresh_billing_identity_summary_from_user_profile() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.refresh_billing_identity_summary_from_user_profile() to "postgres";
grant EXECUTE on function public.refresh_billing_identity_summary_from_user_profile() to "service_role";
alter function public.prevent_user_business_link_identity_reassignment() owner to "postgres";
revoke all on function public.prevent_user_business_link_identity_reassignment() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.prevent_user_business_link_identity_reassignment() to "postgres";
grant EXECUTE on function public.prevent_user_business_link_identity_reassignment() to "service_role";
alter function public.set_updated_at() owner to "postgres";
revoke all on function public.set_updated_at() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.set_updated_at() to "postgres";
grant EXECUTE on function public.set_updated_at() to "service_role";
alter function public.set_user_profiles_full_name() owner to "postgres";
revoke all on function public.set_user_profiles_full_name() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.set_user_profiles_full_name() to "postgres";
grant EXECUTE on function public.set_user_profiles_full_name() to "service_role";
alter function public.tc_sync_txn_fields_from_bank_transactions() owner to "postgres";
revoke all on function public.tc_sync_txn_fields_from_bank_transactions() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.tc_sync_txn_fields_from_bank_transactions() to "postgres";
grant EXECUTE on function public.tc_sync_txn_fields_from_bank_transactions() to "service_role";
alter function public.billing_effective_bool(boolean,boolean,boolean) owner to "postgres";
revoke all on function public.billing_effective_bool(boolean,boolean,boolean) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.billing_effective_bool(boolean,boolean,boolean) to "postgres";
grant EXECUTE on function public.billing_effective_bool(boolean,boolean,boolean) to "service_role";
alter function public.count_bookkeeping_transactions_bounded(uuid,text,text,date,date) owner to "postgres";
revoke all on function public.count_bookkeeping_transactions_bounded(uuid,text,text,date,date) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.count_bookkeeping_transactions_bounded(uuid,text,text,date,date) to "postgres";
grant EXECUTE on function public.count_bookkeeping_transactions_bounded(uuid,text,text,date,date) to "service_role";
alter function public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer) owner to "postgres";
revoke all on function public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer) to "postgres";
grant EXECUTE on function public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer) to "service_role";
alter function public.billing_effective_status(text,text,text) owner to "postgres";
revoke all on function public.billing_effective_status(text,text,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.billing_effective_status(text,text,text) to "postgres";
grant EXECUTE on function public.billing_effective_status(text,text,text) to "service_role";
alter function public.billing_effective_text(text,text,text) owner to "postgres";
revoke all on function public.billing_effective_text(text,text,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.billing_effective_text(text,text,text) to "postgres";
grant EXECUTE on function public.billing_effective_text(text,text,text) to "service_role";
alter function public.billing_effective_timestamptz(timestamp with time zone,timestamp with time zone,timestamp with time zone) owner to "postgres";
revoke all on function public.billing_effective_timestamptz(timestamp with time zone,timestamp with time zone,timestamp with time zone) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.billing_effective_timestamptz(timestamp with time zone,timestamp with time zone,timestamp with time zone) to "postgres";
grant EXECUTE on function public.billing_effective_timestamptz(timestamp with time zone,timestamp with time zone,timestamp with time zone) to "service_role";
alter function public.bizzi_current_user_can_manage_business(uuid) owner to "postgres";
revoke all on function public.bizzi_current_user_can_manage_business(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.bizzi_current_user_can_manage_business(uuid) to "postgres";
grant EXECUTE on function public.bizzi_current_user_can_manage_business(uuid) to "service_role";
grant EXECUTE on function public.bizzi_current_user_can_manage_business(uuid) to "authenticated";
alter function public.refresh_business_profile_onboarding_status(uuid) owner to "postgres";
revoke all on function public.refresh_business_profile_onboarding_status(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.refresh_business_profile_onboarding_status(uuid) to "postgres";
grant EXECUTE on function public.refresh_business_profile_onboarding_status(uuid) to "service_role";
alter function public.acquire_posting_lock(uuid,uuid,timestamp with time zone,integer,text) owner to "postgres";
revoke all on function public.acquire_posting_lock(uuid,uuid,timestamp with time zone,integer,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.acquire_posting_lock(uuid,uuid,timestamp with time zone,integer,text) to "postgres";
grant EXECUTE on function public.acquire_posting_lock(uuid,uuid,timestamp with time zone,integer,text) to "service_role";
alter function public.enforce_active_credit_card_payment_pair_membership() owner to "postgres";
revoke all on function public.enforce_active_credit_card_payment_pair_membership() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.enforce_active_credit_card_payment_pair_membership() to public;
grant EXECUTE on function public.enforce_active_credit_card_payment_pair_membership() to "postgres";
grant EXECUTE on function public.enforce_active_credit_card_payment_pair_membership() to "service_role";
alter function public.approve_bookkeeping_transactions_atomic(uuid,uuid,text,jsonb,boolean) owner to "postgres";
revoke all on function public.approve_bookkeeping_transactions_atomic(uuid,uuid,text,jsonb,boolean) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.approve_bookkeeping_transactions_atomic(uuid,uuid,text,jsonb,boolean) to "postgres";
grant EXECUTE on function public.approve_bookkeeping_transactions_atomic(uuid,uuid,text,jsonb,boolean) to "service_role";
alter function public.validate_credit_card_payment_pair_business() owner to "postgres";
revoke all on function public.validate_credit_card_payment_pair_business() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.validate_credit_card_payment_pair_business() to public;
grant EXECUTE on function public.validate_credit_card_payment_pair_business() to "postgres";
grant EXECUTE on function public.validate_credit_card_payment_pair_business() to "service_role";
alter function public.refresh_operator_request_summary_after_business_scope_change() owner to "postgres";
revoke all on function public.refresh_operator_request_summary_after_business_scope_change() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.refresh_operator_request_summary_after_business_scope_change() to "postgres";
grant EXECUTE on function public.refresh_operator_request_summary_after_business_scope_change() to "service_role";
alter function public.refresh_operator_request_summary(uuid) owner to "postgres";
revoke all on function public.refresh_operator_request_summary(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.refresh_operator_request_summary(uuid) to "postgres";
grant EXECUTE on function public.refresh_operator_request_summary(uuid) to "service_role";
alter function public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamp with time zone,integer) owner to "postgres";
revoke all on function public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamp with time zone,integer) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamp with time zone,integer) to "postgres";
grant EXECUTE on function public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamp with time zone,integer) to "service_role";
alter function public.set_internal_staff_users_updated_at() owner to "postgres";
revoke all on function public.set_internal_staff_users_updated_at() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.set_internal_staff_users_updated_at() to "postgres";
grant EXECUTE on function public.set_internal_staff_users_updated_at() to "service_role";
alter function public.claim_credit_card_payment_pair_posting(uuid,uuid,text,text,timestamp with time zone,integer) owner to "postgres";
revoke all on function public.claim_credit_card_payment_pair_posting(uuid,uuid,text,text,timestamp with time zone,integer) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.claim_credit_card_payment_pair_posting(uuid,uuid,text,text,timestamp with time zone,integer) to "postgres";
grant EXECUTE on function public.claim_credit_card_payment_pair_posting(uuid,uuid,text,text,timestamp with time zone,integer) to "service_role";
alter function public.confirm_pending_transaction_settled(uuid,uuid,uuid,text,date,numeric,text,text,integer) owner to "postgres";
revoke all on function public.confirm_pending_transaction_settled(uuid,uuid,uuid,text,date,numeric,text,text,integer) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.confirm_pending_transaction_settled(uuid,uuid,uuid,text,date,numeric,text,text,integer) to "postgres";
grant EXECUTE on function public.confirm_pending_transaction_settled(uuid,uuid,uuid,text,date,numeric,text,text,integer) to "service_role";
alter function public.confirm_auto_post_effective_date_scope(uuid,text,date,uuid,uuid[],integer,integer,integer,text,timestamp with time zone,jsonb) owner to "postgres";
revoke all on function public.confirm_auto_post_effective_date_scope(uuid,text,date,uuid,uuid[],integer,integer,integer,text,timestamp with time zone,jsonb) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.confirm_auto_post_effective_date_scope(uuid,text,date,uuid,uuid[],integer,integer,integer,text,timestamp with time zone,jsonb) to "postgres";
grant EXECUTE on function public.confirm_auto_post_effective_date_scope(uuid,text,date,uuid,uuid[],integer,integer,integer,text,timestamp with time zone,jsonb) to "service_role";
alter function public.touch_bookkeeping_processing_requests_updated_at() owner to "postgres";
revoke all on function public.touch_bookkeeping_processing_requests_updated_at() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.touch_bookkeeping_processing_requests_updated_at() to "postgres";
grant EXECUTE on function public.touch_bookkeeping_processing_requests_updated_at() to "service_role";
alter function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) owner to "postgres";
revoke all on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) to "postgres";
grant EXECUTE on function public.bookkeeping_transaction_matches_status(text,text,jsonb,text) to "service_role";
alter function public.classify_bookkeeping_posting_outcome(text,text,text,timestamp with time zone,timestamp with time zone,jsonb,text,timestamp with time zone) owner to "postgres";
revoke all on function public.classify_bookkeeping_posting_outcome(text,text,text,timestamp with time zone,timestamp with time zone,jsonb,text,timestamp with time zone) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.classify_bookkeeping_posting_outcome(text,text,text,timestamp with time zone,timestamp with time zone,jsonb,text,timestamp with time zone) to "postgres";
grant EXECUTE on function public.classify_bookkeeping_posting_outcome(text,text,text,timestamp with time zone,timestamp with time zone,jsonb,text,timestamp with time zone) to "service_role";
alter function public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text) owner to "postgres";
revoke all on function public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text) to "postgres";
grant EXECUTE on function public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text) to "service_role";
alter function public.prevent_stale_stripe_entitlement_update() owner to "postgres";
revoke all on function public.prevent_stale_stripe_entitlement_update() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.prevent_stale_stripe_entitlement_update() to "postgres";
grant EXECUTE on function public.prevent_stale_stripe_entitlement_update() to "service_role";
alter function public.restore_bookkeeping_transaction(uuid,uuid,text,text,text) owner to "postgres";
revoke all on function public.restore_bookkeeping_transaction(uuid,uuid,text,text,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.restore_bookkeeping_transaction(uuid,uuid,text,text,text) to "postgres";
grant EXECUTE on function public.restore_bookkeeping_transaction(uuid,uuid,text,text,text) to "service_role";
alter function public.classify_bookkeeping_primary_feed(boolean,text,text,text,jsonb,text,timestamp with time zone,timestamp with time zone) owner to "postgres";
revoke all on function public.classify_bookkeeping_primary_feed(boolean,text,text,text,jsonb,text,timestamp with time zone,timestamp with time zone) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.classify_bookkeeping_primary_feed(boolean,text,text,text,jsonb,text,timestamp with time zone,timestamp with time zone) to "postgres";
grant EXECUTE on function public.classify_bookkeeping_primary_feed(boolean,text,text,text,jsonb,text,timestamp with time zone,timestamp with time zone) to "service_role";
alter function public.prevent_uncontrolled_qbo_realm_change() owner to "postgres";
revoke all on function public.prevent_uncontrolled_qbo_realm_change() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.prevent_uncontrolled_qbo_realm_change() to "postgres";
grant EXECUTE on function public.prevent_uncontrolled_qbo_realm_change() to "service_role";
alter function public.reject_immutable_financial_evidence_mutation() owner to "postgres";
revoke all on function public.reject_immutable_financial_evidence_mutation() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.reject_immutable_financial_evidence_mutation() to "postgres";
alter function public.refresh_billing_identity_summary(uuid) owner to "postgres";
revoke all on function public.refresh_billing_identity_summary(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.refresh_billing_identity_summary(uuid) to "postgres";
grant EXECUTE on function public.refresh_billing_identity_summary(uuid) to "service_role";
alter function public.audit_handled_posting_job_invariants(uuid) owner to "postgres";
revoke all on function public.audit_handled_posting_job_invariants(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.audit_handled_posting_job_invariants(uuid) to "postgres";
grant EXECUTE on function public.audit_handled_posting_job_invariants(uuid) to "service_role";
alter function public.sync_bookkeeping_posting_job() owner to "postgres";
revoke all on function public.sync_bookkeeping_posting_job() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.sync_bookkeeping_posting_job() to "postgres";
grant EXECUTE on function public.sync_bookkeeping_posting_job() to "service_role";
alter function public.release_plaid_sync_lease(uuid,uuid,text) owner to "postgres";
revoke all on function public.release_plaid_sync_lease(uuid,uuid,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.release_plaid_sync_lease(uuid,uuid,text) to "postgres";
grant EXECUTE on function public.release_plaid_sync_lease(uuid,uuid,text) to "service_role";
alter function public.claim_plaid_sync_lease(uuid,uuid,text,integer) owner to "postgres";
revoke all on function public.claim_plaid_sync_lease(uuid,uuid,text,integer) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.claim_plaid_sync_lease(uuid,uuid,text,integer) to "postgres";
grant EXECUTE on function public.claim_plaid_sync_lease(uuid,uuid,text,integer) to "service_role";
alter function public.confirm_plaid_replacement_account_lineage(uuid,text,text,uuid,text,uuid) owner to "postgres";
revoke all on function public.confirm_plaid_replacement_account_lineage(uuid,text,text,uuid,text,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.confirm_plaid_replacement_account_lineage(uuid,text,text,uuid,text,uuid) to "postgres";
grant EXECUTE on function public.confirm_plaid_replacement_account_lineage(uuid,text,text,uuid,text,uuid) to "service_role";
alter function public.bootstrap_plaid_replacement_recovery(uuid,text,text,uuid) owner to "postgres";
revoke all on function public.bootstrap_plaid_replacement_recovery(uuid,text,text,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.bootstrap_plaid_replacement_recovery(uuid,text,text,uuid) to "postgres";
grant EXECUTE on function public.bootstrap_plaid_replacement_recovery(uuid,text,text,uuid) to "service_role";
alter function public.select_plaid_replacement_recovery_account(uuid,text,text,text,uuid) owner to "postgres";
revoke all on function public.select_plaid_replacement_recovery_account(uuid,text,text,text,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.select_plaid_replacement_recovery_account(uuid,text,text,text,uuid) to "postgres";
grant EXECUTE on function public.select_plaid_replacement_recovery_account(uuid,text,text,text,uuid) to "service_role";
alter function public.begin_plaid_recovery_preview_rebuild(uuid,text,text,uuid,uuid,text) owner to "postgres";
revoke all on function public.begin_plaid_recovery_preview_rebuild(uuid,text,text,uuid,uuid,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.begin_plaid_recovery_preview_rebuild(uuid,text,text,uuid,uuid,text) to "postgres";
grant EXECUTE on function public.begin_plaid_recovery_preview_rebuild(uuid,text,text,uuid,uuid,text) to "service_role";
alter function public.confirm_plaid_replacement_lineage_and_advance(uuid,text,text,uuid,text,uuid) owner to "postgres";
revoke all on function public.confirm_plaid_replacement_lineage_and_advance(uuid,text,text,uuid,text,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.confirm_plaid_replacement_lineage_and_advance(uuid,text,text,uuid,text,uuid) to "postgres";
grant EXECUTE on function public.confirm_plaid_replacement_lineage_and_advance(uuid,text,text,uuid,text,uuid) to "service_role";
alter function public.link_pending_transaction_replacement(uuid,uuid,uuid,uuid,text,text) owner to "postgres";
revoke all on function public.link_pending_transaction_replacement(uuid,uuid,uuid,uuid,text,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.link_pending_transaction_replacement(uuid,uuid,uuid,uuid,text,text) to "postgres";
grant EXECUTE on function public.link_pending_transaction_replacement(uuid,uuid,uuid,uuid,text,text) to "service_role";
alter function public.invalidate_reporting_config_on_qbo_realm_change() owner to "postgres";
revoke all on function public.invalidate_reporting_config_on_qbo_realm_change() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.invalidate_reporting_config_on_qbo_realm_change() to "postgres";
alter function public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint) owner to "postgres";
revoke all on function public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint) to "postgres";
grant EXECUTE on function public.set_plaid_account_connection_state(uuid,text,text,uuid,text,text,bigint) to "service_role";
alter function public.tax_vehicle_serialize_evidence() owner to "postgres";
revoke all on function public.tax_vehicle_serialize_evidence() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.tax_vehicle_serialize_evidence() to public;
grant EXECUTE on function public.tax_vehicle_serialize_evidence() to "postgres";
grant EXECUTE on function public.tax_vehicle_serialize_evidence() to "service_role";
alter function public.ensure_plaid_transaction_categorizations(uuid,uuid[]) owner to "postgres";
revoke all on function public.ensure_plaid_transaction_categorizations(uuid,uuid[]) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.ensure_plaid_transaction_categorizations(uuid,uuid[]) to "postgres";
grant EXECUTE on function public.ensure_plaid_transaction_categorizations(uuid,uuid[]) to "service_role";
alter function public.complete_plaid_sync_admission(uuid,uuid,uuid,text,text,text,uuid[],timestamp with time zone,integer,integer,integer,integer) owner to "postgres";
revoke all on function public.complete_plaid_sync_admission(uuid,uuid,uuid,text,text,text,uuid[],timestamp with time zone,integer,integer,integer,integer) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.complete_plaid_sync_admission(uuid,uuid,uuid,text,text,text,uuid[],timestamp with time zone,integer,integer,integer,integer) to "postgres";
grant EXECUTE on function public.complete_plaid_sync_admission(uuid,uuid,uuid,text,text,text,uuid[],timestamp with time zone,integer,integer,integer,integer) to "service_role";
alter function public.classify_plaid_account_recovery_rows(uuid,text,text) owner to "postgres";
revoke all on function public.classify_plaid_account_recovery_rows(uuid,text,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.classify_plaid_account_recovery_rows(uuid,text,text) to "postgres";
grant EXECUTE on function public.classify_plaid_account_recovery_rows(uuid,text,text) to "service_role";
alter function public.plaid_residual_recovery_snapshot(uuid,text,text) owner to "postgres";
revoke all on function public.plaid_residual_recovery_snapshot(uuid,text,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.plaid_residual_recovery_snapshot(uuid,text,text) to "postgres";
grant EXECUTE on function public.plaid_residual_recovery_snapshot(uuid,text,text) to "service_role";
alter function public.get_plaid_account_recovery_facts(uuid,text,text) owner to "postgres";
revoke all on function public.get_plaid_account_recovery_facts(uuid,text,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.get_plaid_account_recovery_facts(uuid,text,text) to "postgres";
grant EXECUTE on function public.get_plaid_account_recovery_facts(uuid,text,text) to "service_role";
alter function public.preview_plaid_residual_orphan_recovery(uuid,text,text,uuid) owner to "postgres";
revoke all on function public.preview_plaid_residual_orphan_recovery(uuid,text,text,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.preview_plaid_residual_orphan_recovery(uuid,text,text,uuid) to "postgres";
grant EXECUTE on function public.preview_plaid_residual_orphan_recovery(uuid,text,text,uuid) to "service_role";
alter function public.apply_plaid_residual_orphan_recovery(uuid,text,text,uuid,uuid) owner to "postgres";
revoke all on function public.apply_plaid_residual_orphan_recovery(uuid,text,text,uuid,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.apply_plaid_residual_orphan_recovery(uuid,text,text,uuid,uuid) to "postgres";
grant EXECUTE on function public.apply_plaid_residual_orphan_recovery(uuid,text,text,uuid,uuid) to "service_role";
alter function public.auto_post_technical_block(transaction_categorizations,text,jsonb,date) owner to "postgres";
revoke all on function public.auto_post_technical_block(transaction_categorizations,text,jsonb,date) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.auto_post_technical_block(transaction_categorizations,text,jsonb,date) to "postgres";
alter function public.plaid_residual_reconciliation_rows(uuid,uuid) owner to "postgres";
revoke all on function public.plaid_residual_reconciliation_rows(uuid,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.plaid_residual_reconciliation_rows(uuid,uuid) to "postgres";
grant EXECUTE on function public.plaid_residual_reconciliation_rows(uuid,uuid) to "service_role";
alter function public.protect_plaid_residual_recovery_hold() owner to "postgres";
revoke all on function public.protect_plaid_residual_recovery_hold() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.protect_plaid_residual_recovery_hold() to "postgres";
grant EXECUTE on function public.protect_plaid_residual_recovery_hold() to "service_role";
alter function public.clear_approved_plaid_residual_holds(uuid,uuid,uuid,uuid[]) owner to "plaid_residual_hold_executor";
revoke all on function public.clear_approved_plaid_residual_holds(uuid,uuid,uuid,uuid[]) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.clear_approved_plaid_residual_holds(uuid,uuid,uuid,uuid[]) to "plaid_residual_hold_executor";
grant EXECUTE on function public.clear_approved_plaid_residual_holds(uuid,uuid,uuid,uuid[]) to "postgres";
alter function public.preview_plaid_residual_reconciliation(uuid,text,text,uuid,uuid) owner to "postgres";
revoke all on function public.preview_plaid_residual_reconciliation(uuid,text,text,uuid,uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.preview_plaid_residual_reconciliation(uuid,text,text,uuid,uuid) to "postgres";
grant EXECUTE on function public.preview_plaid_residual_reconciliation(uuid,text,text,uuid,uuid) to "service_role";
alter function public.release_plaid_residual_reconciliation(uuid,text,text,uuid,uuid,uuid,uuid[],jsonb,boolean) owner to "postgres";
revoke all on function public.release_plaid_residual_reconciliation(uuid,text,text,uuid,uuid,uuid,uuid[],jsonb,boolean) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.release_plaid_residual_reconciliation(uuid,text,text,uuid,uuid,uuid,uuid[],jsonb,boolean) to "postgres";
grant EXECUTE on function public.release_plaid_residual_reconciliation(uuid,text,text,uuid,uuid,uuid,uuid[],jsonb,boolean) to "service_role";
alter function public.record_plaid_reconnect_verification(uuid,text,text,uuid,text,jsonb) owner to "postgres";
revoke all on function public.record_plaid_reconnect_verification(uuid,text,text,uuid,text,jsonb) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.record_plaid_reconnect_verification(uuid,text,text,uuid,text,jsonb) to "postgres";
grant EXECUTE on function public.record_plaid_reconnect_verification(uuid,text,text,uuid,text,jsonb) to "service_role";
alter function public.guard_plaid_reconnect_sync_lease() owner to "postgres";
revoke all on function public.guard_plaid_reconnect_sync_lease() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.guard_plaid_reconnect_sync_lease() to public;
grant EXECUTE on function public.guard_plaid_reconnect_sync_lease() to "postgres";
grant EXECUTE on function public.guard_plaid_reconnect_sync_lease() to "service_role";
alter function public.finish_plaid_reconnect_checkpoint() owner to "postgres";
revoke all on function public.finish_plaid_reconnect_checkpoint() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.finish_plaid_reconnect_checkpoint() to public;
grant EXECUTE on function public.finish_plaid_reconnect_checkpoint() to "postgres";
grant EXECUTE on function public.finish_plaid_reconnect_checkpoint() to "service_role";
alter function public.plaid_bounded_recovery_fingerprint(uuid) owner to "postgres";
revoke all on function public.plaid_bounded_recovery_fingerprint(uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.plaid_bounded_recovery_fingerprint(uuid) to "postgres";
grant EXECUTE on function public.plaid_bounded_recovery_fingerprint(uuid) to "service_role";
alter function public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamp with time zone,text,timestamp with time zone,uuid,date,text) owner to "postgres";
revoke all on function public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamp with time zone,text,timestamp with time zone,uuid,date,text) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamp with time zone,text,timestamp with time zone,uuid,date,text) to "postgres";
grant EXECUTE on function public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamp with time zone,text,timestamp with time zone,uuid,date,text) to "service_role";
alter function public.validate_plaid_bounded_recovery(uuid,text,text,uuid,jsonb) owner to "postgres";
revoke all on function public.validate_plaid_bounded_recovery(uuid,text,text,uuid,jsonb) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.validate_plaid_bounded_recovery(uuid,text,text,uuid,jsonb) to "postgres";
grant EXECUTE on function public.validate_plaid_bounded_recovery(uuid,text,text,uuid,jsonb) to "service_role";
alter function public.stage_plaid_bounded_recovery(uuid,text,text,uuid,jsonb,text,jsonb,jsonb) owner to "postgres";
revoke all on function public.stage_plaid_bounded_recovery(uuid,text,text,uuid,jsonb,text,jsonb,jsonb) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.stage_plaid_bounded_recovery(uuid,text,text,uuid,jsonb,text,jsonb,jsonb) to "postgres";
grant EXECUTE on function public.stage_plaid_bounded_recovery(uuid,text,text,uuid,jsonb,text,jsonb,jsonb) to "service_role";
alter function public.admit_plaid_recovery_batch(uuid,uuid,text,uuid[],uuid) owner to "postgres";
revoke all on function public.admit_plaid_recovery_batch(uuid,uuid,text,uuid[],uuid) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.admit_plaid_recovery_batch(uuid,uuid,text,uuid[],uuid) to "postgres";
grant EXECUTE on function public.admit_plaid_recovery_batch(uuid,uuid,text,uuid[],uuid) to "service_role";
alter function public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean) owner to "postgres";
revoke all on function public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean) to "postgres";
grant EXECUTE on function public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean) to "service_role";
alter function public.auto_post_admission_meta(jsonb,jsonb) owner to "postgres";
revoke all on function public.auto_post_admission_meta(jsonb,jsonb) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.auto_post_admission_meta(jsonb,jsonb) to "postgres";
alter function public.check_auto_post_technical_integrity(uuid,uuid,text,jsonb) owner to "postgres";
revoke all on function public.check_auto_post_technical_integrity(uuid,uuid,text,jsonb) from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function public.check_auto_post_technical_integrity(uuid,uuid,text,jsonb) to "postgres";
grant EXECUTE on function public.check_auto_post_technical_integrity(uuid,uuid,text,jsonb) to "service_role";
grant UPDATE ("posting_hold_batch_id") on public."transaction_categorizations" to "plaid_residual_hold_executor";
alter function auth.uid() owner to "supabase_auth_admin";
revoke all on function auth.uid() from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant EXECUTE on function auth.uid() to public;
grant EXECUTE on function auth.uid() to "supabase_auth_admin";
grant EXECUTE on function auth.uid() to "dashboard_user";
alter schema "extensions" owner to "postgres";
revoke all on schema "extensions" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant USAGE on schema "extensions" to "postgres";
grant CREATE on schema "extensions" to "postgres";
grant USAGE on schema "extensions" to "anon";
grant USAGE on schema "extensions" to "authenticated";
grant USAGE on schema "extensions" to "service_role";
grant USAGE on schema "extensions" to "dashboard_user";
grant CREATE on schema "extensions" to "dashboard_user";
alter schema "auth" owner to "supabase_admin";
revoke all on schema "auth" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant USAGE on schema "auth" to "supabase_admin";
grant CREATE on schema "auth" to "supabase_admin";
grant USAGE on schema "auth" to "anon";
grant USAGE on schema "auth" to "authenticated";
grant USAGE on schema "auth" to "service_role";
grant USAGE on schema "auth" to "supabase_auth_admin";
grant CREATE on schema "auth" to "supabase_auth_admin";
grant USAGE on schema "auth" to "dashboard_user";
grant CREATE on schema "auth" to "dashboard_user";
grant USAGE on schema "auth" to "postgres";
alter schema "public" owner to "pg_database_owner";
revoke all on schema "public" from public,"dashboard_user","authenticated","anon","service_role","supabase_admin","authenticator","pgbouncer","supabase_auth_admin","supabase_storage_admin","supabase_replication_admin","supabase_read_only_user","supabase_realtime_admin","postgres","supabase_privileged_role","plaid_residual_hold_executor","cli_login_postgres";
grant USAGE on schema "public" to "pg_database_owner";
grant CREATE on schema "public" to "pg_database_owner";
grant USAGE on schema "public" to public;
grant USAGE on schema "public" to "postgres";
grant USAGE on schema "public" to "anon";
grant USAGE on schema "public" to "authenticated";
grant USAGE on schema "public" to "service_role";
grant USAGE on schema "public" to "plaid_residual_hold_executor";
alter default privileges for role "supabase_admin" in schema "public" revoke all on sequences from public;
alter default privileges for role "supabase_admin" in schema "public" grant SELECT,UPDATE,USAGE on sequences to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT,UPDATE,USAGE on sequences to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT,UPDATE,USAGE on sequences to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT,UPDATE,USAGE on sequences to "service_role";
alter default privileges for role "supabase_admin" in schema "public" revoke all on tables from public;
alter default privileges for role "supabase_admin" in schema "public" grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" revoke all on functions from public;
alter default privileges for role "supabase_admin" in schema "public" grant EXECUTE on functions to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant EXECUTE on functions to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant EXECUTE on functions to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant EXECUTE on functions to "service_role";
alter default privileges for role "postgres" in schema "public" revoke all on tables from public;
alter default privileges for role "postgres" in schema "public" grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on tables to "service_role";
alter default privileges for role "postgres" in schema "public" revoke all on functions from public;
alter default privileges for role "postgres" in schema "public" grant EXECUTE on functions to "postgres";
alter default privileges for role "postgres" in schema "public" grant EXECUTE on functions to "service_role";
alter default privileges for role "postgres" in schema "public" revoke all on sequences from public;
alter default privileges for role "postgres" in schema "public" grant SELECT,UPDATE,USAGE on sequences to "postgres";
alter default privileges for role "postgres" in schema "public" grant SELECT,UPDATE,USAGE on sequences to "service_role";
grant "pg_monitor" to "postgres" with admin true, inherit true, set true granted by "supabase_admin";
grant "pg_monitor" to "supabase_read_only_user" with admin false, inherit true, set true granted by "supabase_admin";
grant "pg_read_all_settings" to "pg_monitor" with admin false, inherit true, set true granted by "supabase_admin";
grant "pg_read_all_stats" to "pg_monitor" with admin false, inherit true, set true granted by "supabase_admin";
grant "pg_stat_scan_tables" to "pg_monitor" with admin false, inherit true, set true granted by "supabase_admin";
grant "pg_signal_backend" to "postgres" with admin true, inherit true, set true granted by "supabase_admin";
grant "pg_read_all_data" to "supabase_read_only_user" with admin false, inherit true, set true granted by "supabase_admin";
grant "pg_read_all_data" to "postgres" with admin true, inherit true, set true granted by "supabase_admin";
grant "pg_create_subscription" to "postgres" with admin true, inherit true, set true granted by "supabase_admin";
grant "postgres" to "cli_login_postgres" with admin false, inherit false, set true granted by "supabase_admin";
grant "anon" to "authenticator" with admin false, inherit false, set true granted by "supabase_admin";
grant "anon" to "postgres" with admin true, inherit true, set true granted by "supabase_admin";
grant "authenticated" to "postgres" with admin true, inherit true, set true granted by "supabase_admin";
grant "authenticated" to "authenticator" with admin false, inherit false, set true granted by "supabase_admin";
grant "service_role" to "postgres" with admin true, inherit true, set true granted by "supabase_admin";
grant "service_role" to "authenticator" with admin false, inherit false, set true granted by "supabase_admin";
grant "authenticator" to "supabase_storage_admin" with admin false, inherit false, set true granted by "supabase_admin";
grant "authenticator" to "postgres" with admin true, inherit true, set true granted by "supabase_admin";
grant "supabase_privileged_role" to "postgres" with admin false, inherit true, set true granted by "supabase_admin";
grant "plaid_residual_hold_executor" to "postgres" with admin true, inherit false, set false granted by "supabase_admin";
grant "plaid_residual_hold_executor" to "postgres" with admin false, inherit false, set false granted by "postgres";
alter database postgres owner to postgres;
alter role postgres nosuperuser inherit createrole createdb login replication bypassrls;
