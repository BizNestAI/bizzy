

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."deadline_status" AS ENUM (
    'upcoming',
    'due',
    'overdue',
    'done',
    'dismissed'
);


ALTER TYPE "public"."deadline_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "text", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer DEFAULT 600, "p_idempotency_key" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_row_count integer := 0;
begin
  update public.transaction_categorizations
     set meta =
       coalesce(meta, '{}'::jsonb)
       || jsonb_build_object(
         'posting_in_progress', true,
         'posting_lock_acquired_at', p_now_iso,
         'post_idempotency_key', p_idempotency_key
       ),
       last_post_attempt_at = p_now_iso,
       updated_at = p_now_iso
   where business_id = p_business_id
     and transaction_id = p_transaction_id
     and qbo_txn_id is null
     and post_after is not null
     and post_after <= p_now_iso
     and (
       coalesce((meta->>'posting_in_progress')::boolean, false) = false
       or (meta->>'posting_lock_acquired_at') is null
       or ((meta->>'posting_lock_acquired_at')::timestamptz < p_now_iso - make_interval(secs => p_lock_stale_seconds))
     );

  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;


ALTER FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "text", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "uuid", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


ALTER FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "uuid", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."transaction_tax_classifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "tax_year" integer NOT NULL,
    "transaction_date" "date",
    "source_qbo_txn_id" "text",
    "source_qbo_txn_type" "text",
    "source_qbo_account_id" "text",
    "source_qbo_account_name" "text",
    "tax_category" "text" DEFAULT 'unclassified'::"text" NOT NULL,
    "deductibility_status" "text" DEFAULT 'needs_review'::"text" NOT NULL,
    "deductible_percent" numeric DEFAULT 0 NOT NULL,
    "book_amount" numeric DEFAULT 0 NOT NULL,
    "deductible_amount" numeric DEFAULT 0 NOT NULL,
    "nondeductible_amount" numeric DEFAULT 0 NOT NULL,
    "capitalizable_amount" numeric DEFAULT 0 NOT NULL,
    "tax_treatment" "jsonb",
    "classification_status" "text" DEFAULT 'needs_review'::"text" NOT NULL,
    "confidence_score" numeric,
    "rule_id" "uuid",
    "reason" "text",
    "source" "text" DEFAULT 'system'::"text" NOT NULL,
    "user_override" boolean DEFAULT false NOT NULL,
    "cpa_override" boolean DEFAULT false NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "confidence_level" "text",
    "rule_code" "text",
    "rule_version" "text",
    "rule_priority" integer,
    CONSTRAINT "transaction_tax_classifications_amounts_check" CHECK ((("deductible_amount" >= (0)::numeric) AND ("nondeductible_amount" >= (0)::numeric) AND ("capitalizable_amount" >= (0)::numeric))),
    CONSTRAINT "transaction_tax_classifications_confidence_check" CHECK ((("confidence_score" IS NULL) OR (("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (100)::numeric)))),
    CONSTRAINT "transaction_tax_classifications_deductibility_check" CHECK (("deductibility_status" = ANY (ARRAY['fully_deductible'::"text", 'partially_deductible'::"text", 'nondeductible'::"text", 'capitalizable'::"text", 'balance_sheet'::"text", 'needs_review'::"text"]))),
    CONSTRAINT "transaction_tax_classifications_percent_check" CHECK ((("deductible_percent" >= (0)::numeric) AND ("deductible_percent" <= (100)::numeric))),
    CONSTRAINT "transaction_tax_classifications_source_check" CHECK (("source" = ANY (ARRAY['system'::"text", 'rule_engine'::"text", 'user'::"text", 'cpa'::"text", 'imported'::"text"]))),
    CONSTRAINT "transaction_tax_classifications_status_check" CHECK (("classification_status" = ANY (ARRAY['needs_review'::"text", 'auto_classified'::"text", 'user_confirmed'::"text", 'cpa_confirmed'::"text", 'excluded'::"text"]))),
    CONSTRAINT "transaction_tax_classifications_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."transaction_tax_classifications" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_tax_classification_override"("p_business_id" "uuid", "p_tax_year" integer, "p_transaction_id" "uuid", "p_actor_user_id" "uuid", "p_override_source" "text", "p_override_reason" "text", "p_tax_category" "text", "p_deductibility_status" "text", "p_deductible_percent" numeric, "p_tax_treatment" "jsonb", "p_classification_status" "text", "p_book_amount" numeric, "p_deductible_amount" numeric, "p_nondeductible_amount" numeric, "p_capitalizable_amount" numeric, "p_confidence_score" numeric, "p_confidence_level" "text", "p_source" "text", "p_requires_review" boolean, "p_reason" "text", "p_user_override" boolean, "p_cpa_override" boolean, "p_expected_updated_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "public"."transaction_tax_classifications"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_current public.transaction_tax_classifications%rowtype;
  v_updated public.transaction_tax_classifications%rowtype;
  v_previous_values jsonb;
  v_new_values jsonb;
  v_effective_user_override boolean;
  v_effective_cpa_override boolean;
begin
  if p_business_id is null or p_transaction_id is null then
    raise exception 'invalid_tax_classification_override: business_id and transaction_id are required'
      using errcode = '22023';
  end if;

  if p_tax_year is null or p_tax_year < 2000 or p_tax_year > 2100 then
    raise exception 'invalid_tax_classification_override: tax_year must be between 2000 and 2100'
      using errcode = '22023';
  end if;

  if p_override_reason is null or length(trim(p_override_reason)) = 0 then
    raise exception 'invalid_tax_classification_override: override_reason is required'
      using errcode = '22023';
  end if;

  if p_deductible_percent is null or p_deductible_percent < 0 or p_deductible_percent > 100 then
    raise exception 'invalid_tax_classification_override: deductible_percent must be between 0 and 100'
      using errcode = '22023';
  end if;

  if p_deductible_amount is null or p_deductible_amount < 0
     or p_nondeductible_amount is null or p_nondeductible_amount < 0
     or p_capitalizable_amount is null or p_capitalizable_amount < 0 then
    raise exception 'invalid_tax_classification_override: tax amount components must be nonnegative'
      using errcode = '22023';
  end if;

  if p_deductibility_status not in (
    'fully_deductible',
    'partially_deductible',
    'nondeductible',
    'capitalizable',
    'balance_sheet',
    'needs_review'
  ) then
    raise exception 'invalid_tax_classification_override: invalid deductibility_status'
      using errcode = '22023';
  end if;

  if p_classification_status not in (
    'needs_review',
    'auto_classified',
    'user_confirmed',
    'cpa_confirmed',
    'excluded'
  ) then
    raise exception 'invalid_tax_classification_override: invalid classification_status'
      using errcode = '22023';
  end if;

  if p_classification_status = 'cpa_confirmed'
     and coalesce(p_override_source, '') not in ('cpa', 'admin') then
    raise exception 'invalid_tax_classification_override: CPA confirmation requires CPA or admin source'
      using errcode = '22023';
  end if;

  select *
    into v_current
  from public.transaction_tax_classifications
  where business_id = p_business_id
    and transaction_id = p_transaction_id
    and tax_year = p_tax_year
  for update;

  if not found then
    raise exception 'classification_not_found'
      using errcode = 'P0002';
  end if;

  if p_expected_updated_at is not null
     and v_current.updated_at is distinct from p_expected_updated_at then
    raise exception 'classification_conflict'
      using errcode = '40001';
  end if;

  v_effective_user_override :=
    coalesce(p_user_override, false)
    or coalesce(v_current.user_override, false)
    or p_classification_status = 'user_confirmed';

  v_effective_cpa_override :=
    coalesce(p_cpa_override, false)
    or coalesce(v_current.cpa_override, false)
    or p_classification_status = 'cpa_confirmed';

  v_previous_values := jsonb_build_object(
    'tax_category', v_current.tax_category,
    'deductibility_status', v_current.deductibility_status,
    'deductible_percent', v_current.deductible_percent,
    'book_amount', v_current.book_amount,
    'deductible_amount', v_current.deductible_amount,
    'nondeductible_amount', v_current.nondeductible_amount,
    'capitalizable_amount', v_current.capitalizable_amount,
    'tax_treatment', v_current.tax_treatment,
    'classification_status', v_current.classification_status,
    'confidence_score', v_current.confidence_score,
    'confidence_level', v_current.confidence_level,
    'source', v_current.source,
    'requires_review', v_current.requires_review,
    'reason', v_current.reason,
    'user_override', v_current.user_override,
    'cpa_override', v_current.cpa_override,
    'metadata', v_current.metadata
  );

  v_new_values := jsonb_build_object(
    'tax_category', p_tax_category,
    'deductibility_status', p_deductibility_status,
    'deductible_percent', p_deductible_percent,
    'book_amount', p_book_amount,
    'deductible_amount', p_deductible_amount,
    'nondeductible_amount', p_nondeductible_amount,
    'capitalizable_amount', p_capitalizable_amount,
    'tax_treatment', p_tax_treatment,
    'classification_status', p_classification_status,
    'confidence_score', p_confidence_score,
    'confidence_level', p_confidence_level,
    'source', p_source,
    'requires_review', p_requires_review,
    'reason', p_reason,
    'user_override', v_effective_user_override,
    'cpa_override', v_effective_cpa_override,
    'metadata', coalesce(v_current.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
  );

  insert into public.tax_classification_overrides (
    business_id,
    tax_year,
    transaction_id,
    classification_id,
    previous_values,
    new_values,
    override_source,
    override_reason,
    overridden_by,
    created_at
  )
  values (
    p_business_id,
    p_tax_year,
    p_transaction_id,
    v_current.id,
    v_previous_values,
    v_new_values,
    p_override_source,
    p_override_reason,
    p_actor_user_id,
    now()
  );

  update public.transaction_tax_classifications
  set
    tax_category = p_tax_category,
    deductibility_status = p_deductibility_status,
    deductible_percent = p_deductible_percent,
    book_amount = p_book_amount,
    deductible_amount = p_deductible_amount,
    nondeductible_amount = p_nondeductible_amount,
    capitalizable_amount = p_capitalizable_amount,
    tax_treatment = p_tax_treatment,
    classification_status = p_classification_status,
    confidence_score = p_confidence_score,
    confidence_level = p_confidence_level,
    source = p_source,
    requires_review = p_requires_review,
    reason = p_reason,
    user_override = v_effective_user_override,
    cpa_override = v_effective_cpa_override,
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at = now()
  where id = v_current.id
  returning * into v_updated;

  return v_updated;
end;
$$;


ALTER FUNCTION "public"."apply_tax_classification_override"("p_business_id" "uuid", "p_tax_year" integer, "p_transaction_id" "uuid", "p_actor_user_id" "uuid", "p_override_source" "text", "p_override_reason" "text", "p_tax_category" "text", "p_deductibility_status" "text", "p_deductible_percent" numeric, "p_tax_treatment" "jsonb", "p_classification_status" "text", "p_book_amount" numeric, "p_deductible_amount" numeric, "p_nondeductible_amount" numeric, "p_capitalizable_amount" numeric, "p_confidence_score" numeric, "p_confidence_level" "text", "p_source" "text", "p_requires_review" boolean, "p_reason" "text", "p_user_override" boolean, "p_cpa_override" boolean, "p_expected_updated_at" timestamp with time zone, "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."billing_effective_bool"("p_legacy_value" boolean, "p_live_value" boolean, "p_test_value" boolean) RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select coalesce(p_live_value, p_test_value, p_legacy_value, false);
$$;


ALTER FUNCTION "public"."billing_effective_bool"("p_legacy_value" boolean, "p_live_value" boolean, "p_test_value" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."billing_effective_status"("p_legacy_status" "text", "p_live_status" "text", "p_test_status" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
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
$$;


ALTER FUNCTION "public"."billing_effective_status"("p_legacy_status" "text", "p_live_status" "text", "p_test_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."billing_effective_text"("p_legacy_value" "text", "p_live_value" "text", "p_test_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select coalesce(
    nullif(p_live_value, ''),
    nullif(p_test_value, ''),
    nullif(p_legacy_value, '')
  );
$$;


ALTER FUNCTION "public"."billing_effective_text"("p_legacy_value" "text", "p_live_value" "text", "p_test_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."billing_effective_timestamptz"("p_legacy_value" timestamp with time zone, "p_live_value" timestamp with time zone, "p_test_value" timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select coalesce(p_live_value, p_test_value, p_legacy_value);
$$;


ALTER FUNCTION "public"."billing_effective_timestamptz"("p_legacy_value" timestamp with time zone, "p_live_value" timestamp with time zone, "p_test_value" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bizzy_docs_tsv_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.search_lexeme :=
    setweight(to_tsvector('simple', coalesce(new.title,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.filename,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce((new.content->>'plain_excerpt'),'')), 'C');
  return new;
end$$;


ALTER FUNCTION "public"."bizzy_docs_tsv_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_contractor_cfo_insight_run"("p_run_key" "text", "p_scheduled_for" timestamp with time zone, "p_lock_owner" "text" DEFAULT NULL::"text", "p_lock_ttl_seconds" integer DEFAULT 7200) RETURNS TABLE("claimed" boolean, "run_id" "uuid", "reason" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_now timestamptz := now();
  v_run public.contractor_cfo_insight_runs%rowtype;
  v_ttl interval := make_interval(secs => greatest(coalesce(p_lock_ttl_seconds, 7200), 60));
begin
  if p_run_key is null or length(trim(p_run_key)) = 0 then
    return query select false, null::uuid, 'missing_run_key';
    return;
  end if;

  insert into public.contractor_cfo_insight_runs (
    run_key,
    scheduled_for,
    status,
    lock_owner,
    lock_expires_at,
    started_at,
    created_at,
    updated_at
  )
  values (
    p_run_key,
    p_scheduled_for,
    'running',
    p_lock_owner,
    v_now + v_ttl,
    v_now,
    v_now,
    v_now
  )
  on conflict (run_key) do nothing
  returning * into v_run;

  if v_run.id is not null then
    return query select true, v_run.id, 'claimed';
    return;
  end if;

  select *
  into v_run
  from public.contractor_cfo_insight_runs
  where run_key = p_run_key
  for update;

  if v_run.id is null then
    return query select false, null::uuid, 'not_found';
    return;
  end if;

  if v_run.status = 'running' and v_run.lock_expires_at > v_now then
    return query select false, v_run.id, 'already_running';
    return;
  end if;

  if v_run.status = 'completed' then
    return query select false, v_run.id, 'already_completed';
    return;
  end if;

  update public.contractor_cfo_insight_runs
  set
    status = 'running',
    lock_owner = p_lock_owner,
    lock_expires_at = v_now + v_ttl,
    started_at = v_now,
    finished_at = null,
    error = null,
    updated_at = v_now
  where id = v_run.id
  returning * into v_run;

  return query select true, v_run.id, 'reclaimed';
end;
$$;


ALTER FUNCTION "public"."claim_contractor_cfo_insight_run"("p_run_key" "text", "p_scheduled_for" timestamp with time zone, "p_lock_owner" "text", "p_lock_ttl_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_scheduled_job_lock"("p_job_key" "text", "p_scheduled_for" timestamp with time zone, "p_locked_by" "text" DEFAULT NULL::"text", "p_lock_ttl_seconds" integer DEFAULT 7200, "p_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS TABLE("claimed" boolean, "lock_id" "uuid", "reason" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_now timestamptz := now();
  v_lock public.scheduled_job_locks%rowtype;
  v_ttl interval := make_interval(secs => greatest(coalesce(p_lock_ttl_seconds, 7200), 60));
begin
  if p_job_key is null or length(trim(p_job_key)) = 0 then
    return query select false, null::uuid, 'missing_job_key';
    return;
  end if;

  insert into public.scheduled_job_locks (
    job_key,
    scheduled_for,
    locked_at,
    locked_by,
    completed_at,
    status,
    metadata,
    created_at,
    updated_at
  )
  values (
    p_job_key,
    p_scheduled_for,
    v_now,
    p_locked_by,
    null,
    'running',
    coalesce(p_metadata, '{}'::jsonb),
    v_now,
    v_now
  )
  on conflict (job_key) do nothing
  returning * into v_lock;

  if v_lock.id is not null then
    return query select true, v_lock.id, 'claimed';
    return;
  end if;

  select *
  into v_lock
  from public.scheduled_job_locks
  where job_key = p_job_key
  for update;

  if v_lock.id is null then
    return query select false, null::uuid, 'not_found';
    return;
  end if;

  if v_lock.status = 'completed' then
    return query select false, v_lock.id, 'already_completed';
    return;
  end if;

  if v_lock.status = 'running' and v_lock.locked_at > v_now - v_ttl then
    return query select false, v_lock.id, 'already_running';
    return;
  end if;

  update public.scheduled_job_locks
  set
    locked_at = v_now,
    locked_by = p_locked_by,
    completed_at = null,
    status = 'running',
    metadata = coalesce(v_lock.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at = v_now
  where id = v_lock.id
  returning * into v_lock;

  return query select true, v_lock.id, 'reclaimed';
end;
$$;


ALTER FUNCTION "public"."claim_scheduled_job_lock"("p_job_key" "text", "p_scheduled_for" timestamp with time zone, "p_locked_by" "text", "p_lock_ttl_seconds" integer, "p_metadata" "jsonb") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_recalculation_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_year" integer NOT NULL,
    "event_type" "text" NOT NULL,
    "trigger_source" "text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "event_id" "text" NOT NULL,
    "correlation_id" "text",
    "source_record_id" "text",
    "source_table" "text",
    "first_event_at" timestamp with time zone NOT NULL,
    "last_event_at" timestamp with time zone NOT NULL,
    "process_after" timestamp with time zone NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer DEFAULT 5 NOT NULL,
    "locked_at" timestamp with time zone,
    "locked_by" "text",
    "completed_at" timestamp with time zone,
    "calculation_run_id" "uuid",
    "outcome" "text",
    "error_code" "text",
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_recalc_priority_check" CHECK (("priority" = ANY (ARRAY['critical'::"text", 'high'::"text", 'normal'::"text", 'low'::"text"]))),
    CONSTRAINT "tax_recalc_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'completed'::"text", 'skipped'::"text", 'failed'::"text", 'dead_letter'::"text"])))
);


ALTER TABLE "public"."tax_recalculation_requests" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_tax_recalculation_requests"("p_worker_id" "text", "p_batch_size" integer DEFAULT 10, "p_now" timestamp with time zone DEFAULT "now"()) RETURNS SETOF "public"."tax_recalculation_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  return query
  with claimable as (
    select id
    from public.tax_recalculation_requests
    where status in ('pending', 'failed')
      and process_after <= p_now
      and attempt_count < max_attempts
      and (
        locked_at is null
        or locked_at < p_now - interval '30 minutes'
      )
    order by
      case priority
        when 'critical' then 4
        when 'high' then 3
        when 'normal' then 2
        else 1
      end desc,
      process_after asc
    for update skip locked
    limit greatest(1, least(coalesce(p_batch_size, 10), 100))
  )
  update public.tax_recalculation_requests r
     set status = 'processing',
         locked_at = p_now,
         locked_by = p_worker_id,
         attempt_count = r.attempt_count + 1,
         updated_at = p_now
    from claimable
   where r.id = claimable.id
  returning r.*;
end;
$$;


ALTER FUNCTION "public"."claim_tax_recalculation_requests"("p_worker_id" "text", "p_batch_size" integer, "p_now" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compute_days_overdue"("due_date" "date") RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select case
    when $1 is null then 0
    when $1 > current_date then 0
    else (current_date - $1)
  end;
$_$;


ALTER FUNCTION "public"."compute_days_overdue"("due_date" "date") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_calculation_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_profile_id" "uuid",
    "tax_year" integer NOT NULL,
    "as_of_date" "date" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "calculation_type" "text" DEFAULT 'full_estimate'::"text" NOT NULL,
    "trigger_source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "calculation_version" "text" NOT NULL,
    "entity_type" "text",
    "filing_status" "text",
    "state_code" "text",
    "book_revenue_ytd" numeric DEFAULT 0 NOT NULL,
    "book_expenses_ytd" numeric DEFAULT 0 NOT NULL,
    "book_profit_ytd" numeric DEFAULT 0 NOT NULL,
    "deductible_expenses_ytd" numeric DEFAULT 0 NOT NULL,
    "nondeductible_addbacks_ytd" numeric DEFAULT 0 NOT NULL,
    "tax_adjustments_ytd" numeric DEFAULT 0 NOT NULL,
    "taxable_income_ytd" numeric DEFAULT 0 NOT NULL,
    "projected_taxable_income" numeric DEFAULT 0 NOT NULL,
    "estimated_federal_tax" numeric DEFAULT 0 NOT NULL,
    "estimated_state_tax" numeric DEFAULT 0 NOT NULL,
    "estimated_se_tax" numeric DEFAULT 0 NOT NULL,
    "estimated_payroll_tax_effect" numeric DEFAULT 0 NOT NULL,
    "estimated_other_tax" numeric DEFAULT 0 NOT NULL,
    "qbi_deduction_estimate" numeric DEFAULT 0 NOT NULL,
    "estimated_total_tax" numeric DEFAULT 0 NOT NULL,
    "payments_ytd" numeric DEFAULT 0 NOT NULL,
    "withholding_ytd" numeric DEFAULT 0 NOT NULL,
    "remaining_projected_liability" numeric DEFAULT 0 NOT NULL,
    "safe_harbor_target" numeric DEFAULT 0 NOT NULL,
    "safe_harbor_covered" numeric DEFAULT 0 NOT NULL,
    "safe_harbor_gap" numeric DEFAULT 0 NOT NULL,
    "recommended_reserve" numeric DEFAULT 0 NOT NULL,
    "current_reserve" numeric DEFAULT 0 NOT NULL,
    "reserve_gap" numeric DEFAULT 0 NOT NULL,
    "confidence_score" numeric,
    "assumptions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "warnings" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "missing_inputs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "source_freshness" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_code" "text",
    "error_message" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "calculation_fingerprint" "text",
    "supersedes_run_id" "uuid",
    "superseded_by_run_id" "uuid",
    "superseded_at" timestamp with time zone,
    "supersession_reason" "text",
    "completion_type" "text",
    "request_id" "text",
    "persisted_component_count" integer DEFAULT 0,
    "expected_component_count" integer DEFAULT 0,
    "calculation_payload_version" "text",
    "confidence_level" "text",
    "confidence_status" "text",
    "confidence_factors" "jsonb" DEFAULT '[]'::"jsonb",
    "confidence_penalties" "jsonb" DEFAULT '[]'::"jsonb",
    "confidence_blockers" "jsonb" DEFAULT '[]'::"jsonb",
    "confidence_methodology_version" "text",
    "estimate_ready" boolean DEFAULT false,
    "reserve_ready" boolean DEFAULT false,
    "workpaper_status" "text" DEFAULT 'legacy_incomplete'::"text" NOT NULL,
    "workpaper_version" "text",
    "workpaper_line_count" integer DEFAULT 0 NOT NULL,
    "workpaper_section_availability" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "rule_version_map" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source_lineage_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "payment_application_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "workpaper_reconciliation_status" "text",
    "workpaper_reconciliation" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "workpaper_completed_at" timestamp with time zone,
    "calculation_graph_version" "text",
    "calculation_graph_status" "text" DEFAULT 'legacy_incomplete'::"text" NOT NULL,
    "calculation_graph_node_count" integer DEFAULT 0 NOT NULL,
    "calculation_graph_validation" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "calculation_input_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "calculation_graph_completed_at" timestamp with time zone,
    CONSTRAINT "tax_calculation_runs_confidence_check" CHECK ((("confidence_score" IS NULL) OR (("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (100)::numeric)))),
    CONSTRAINT "tax_calculation_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'failed'::"text", 'partial'::"text"]))),
    CONSTRAINT "tax_calculation_runs_type_check" CHECK (("calculation_type" = ANY (ARRAY['full_estimate'::"text", 'ytd_actual'::"text", 'projection'::"text", 'reserve_only'::"text", 'manual_override'::"text"]))),
    CONSTRAINT "tax_calculation_runs_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_calculation_runs" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_tax_calculation_run"("p_run_id" "uuid", "p_business_id" "uuid", "p_status" "text", "p_completion_type" "text", "p_summary" "jsonb", "p_components" "jsonb", "p_assumptions" "jsonb" DEFAULT '[]'::"jsonb", "p_warnings" "jsonb" DEFAULT '[]'::"jsonb", "p_missing_inputs" "jsonb" DEFAULT '[]'::"jsonb", "p_source_freshness" "jsonb" DEFAULT '{}'::"jsonb", "p_confidence_score" numeric DEFAULT NULL::numeric, "p_supersedes_run_id" "uuid" DEFAULT NULL::"uuid", "p_supersession_reason" "text" DEFAULT NULL::"text") RETURNS "public"."tax_calculation_runs"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_run public.tax_calculation_runs%rowtype;
  v_component_count integer;
  v_inserted_count integer;
  v_component jsonb;
  v_final public.tax_calculation_runs%rowtype;
begin
  if p_status not in ('completed', 'partial') then
    raise exception 'invalid_run_status';
  end if;

  if jsonb_typeof(coalesce(p_components, '[]'::jsonb)) <> 'array' then
    raise exception 'components_must_be_array';
  end if;

  v_component_count := jsonb_array_length(coalesce(p_components, '[]'::jsonb));
  if v_component_count <= 0 then
    raise exception 'incomplete_component_set';
  end if;

  select *
    into v_run
    from public.tax_calculation_runs
   where id = p_run_id
     and business_id = p_business_id
   for update;

  if not found then
    raise exception 'run_not_found';
  end if;

  if v_run.status <> 'running' then
    raise exception 'run_not_running';
  end if;

  for v_component in select * from jsonb_array_elements(p_components)
  loop
    insert into public.tax_calculation_components (
      run_id,
      business_id,
      component_key,
      component_type,
      component_name,
      taxable_base,
      rate,
      amount,
      direction,
      explanation,
      source_refs,
      sort_order,
      metadata,
      created_at
    )
    values (
      p_run_id,
      p_business_id,
      v_component->>'component_key',
      v_component->>'component_type',
      v_component->>'component_name',
      nullif(v_component->>'taxable_base', '')::numeric,
      nullif(v_component->>'rate', '')::numeric,
      coalesce(nullif(v_component->>'amount', '')::numeric, 0),
      v_component->>'direction',
      v_component->>'explanation',
      coalesce(v_component->'source_refs', '{}'::jsonb),
      coalesce(nullif(v_component->>'sort_order', '')::integer, 0),
      coalesce(v_component->'metadata', '{}'::jsonb),
      now()
    );
  end loop;

  get diagnostics v_inserted_count = row_count;
  -- row_count from the loop only reflects the last insert, so verify against the table.
  select count(*) into v_inserted_count
    from public.tax_calculation_components
   where run_id = p_run_id
     and business_id = p_business_id;

  if v_inserted_count <> v_component_count then
    raise exception 'component_count_mismatch';
  end if;

  update public.tax_calculation_runs
     set status = p_status,
         completion_type = p_completion_type,
         tax_profile_id = nullif(p_summary->>'tax_profile_id', '')::uuid,
         entity_type = p_summary->>'entity_type',
         filing_status = p_summary->>'filing_status',
         state_code = p_summary->>'state_code',
         book_revenue_ytd = nullif(p_summary->>'book_revenue_ytd', '')::numeric,
         book_expenses_ytd = nullif(p_summary->>'book_expenses_ytd', '')::numeric,
         book_profit_ytd = nullif(p_summary->>'book_profit_ytd', '')::numeric,
         deductible_expenses_ytd = nullif(p_summary->>'deductible_expenses_ytd', '')::numeric,
         nondeductible_addbacks_ytd = nullif(p_summary->>'nondeductible_addbacks_ytd', '')::numeric,
         tax_adjustments_ytd = nullif(p_summary->>'tax_adjustments_ytd', '')::numeric,
         taxable_income_ytd = nullif(p_summary->>'taxable_income_ytd', '')::numeric,
         projected_taxable_income = nullif(p_summary->>'projected_taxable_income', '')::numeric,
         estimated_federal_tax = nullif(p_summary->>'estimated_federal_tax', '')::numeric,
         estimated_state_tax = nullif(p_summary->>'estimated_state_tax', '')::numeric,
         estimated_se_tax = nullif(p_summary->>'estimated_se_tax', '')::numeric,
         estimated_payroll_tax_effect = nullif(p_summary->>'estimated_payroll_tax_effect', '')::numeric,
         estimated_other_tax = nullif(p_summary->>'estimated_other_tax', '')::numeric,
         qbi_deduction_estimate = nullif(p_summary->>'qbi_deduction_estimate', '')::numeric,
         estimated_total_tax = nullif(p_summary->>'estimated_total_tax', '')::numeric,
         payments_ytd = nullif(p_summary->>'payments_ytd', '')::numeric,
         withholding_ytd = nullif(p_summary->>'withholding_ytd', '')::numeric,
         remaining_projected_liability = nullif(p_summary->>'remaining_projected_liability', '')::numeric,
         safe_harbor_target = nullif(p_summary->>'safe_harbor_target', '')::numeric,
         safe_harbor_covered = nullif(p_summary->>'safe_harbor_covered', '')::numeric,
         safe_harbor_gap = nullif(p_summary->>'safe_harbor_gap', '')::numeric,
         recommended_reserve = nullif(p_summary->>'recommended_reserve', '')::numeric,
         current_reserve = nullif(p_summary->>'current_reserve', '')::numeric,
         reserve_gap = nullif(p_summary->>'reserve_gap', '')::numeric,
         confidence_score = p_confidence_score,
         confidence_level = p_summary->>'confidence_level',
         confidence_status = p_summary->>'confidence_status',
         confidence_factors = coalesce(p_summary->'confidence_factors', '[]'::jsonb),
         confidence_penalties = coalesce(p_summary->'confidence_penalties', '[]'::jsonb),
         confidence_blockers = coalesce(p_summary->'confidence_blockers', '[]'::jsonb),
         confidence_methodology_version = p_summary->>'confidence_methodology_version',
         estimate_ready = coalesce((p_summary->>'estimate_ready')::boolean, false),
         reserve_ready = coalesce((p_summary->>'reserve_ready')::boolean, false),
         assumptions = p_assumptions,
         warnings = p_warnings,
         missing_inputs = p_missing_inputs,
         source_freshness = p_source_freshness,
         expected_component_count = v_component_count,
         persisted_component_count = v_inserted_count,
         completed_at = now()
   where id = p_run_id
     and business_id = p_business_id
   returning * into v_final;

  if p_supersedes_run_id is not null then
    insert into public.tax_calculation_run_links (
      business_id,
      older_run_id,
      newer_run_id,
      relation_type,
      reason,
      created_at
    )
    values (
      p_business_id,
      p_supersedes_run_id,
      p_run_id,
      'supersedes',
      p_supersession_reason,
      now()
    )
    on conflict do nothing;
  end if;

  return v_final;
end;
$$;


ALTER FUNCTION "public"."finalize_tax_calculation_run"("p_run_id" "uuid", "p_business_id" "uuid", "p_status" "text", "p_completion_type" "text", "p_summary" "jsonb", "p_components" "jsonb", "p_assumptions" "jsonb", "p_warnings" "jsonb", "p_missing_inputs" "jsonb", "p_source_freshness" "jsonb", "p_confidence_score" numeric, "p_supersedes_run_id" "uuid", "p_supersession_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tax_deduction_transaction_drilldown"("p_business_id" "uuid", "p_tax_year" integer, "p_as_of_date" "date" DEFAULT NULL::"date", "p_tax_category" "text" DEFAULT NULL::"text", "p_month" "text" DEFAULT NULL::"text", "p_deductibility_status" "text" DEFAULT NULL::"text", "p_classification_status" "text" DEFAULT NULL::"text", "p_confidence_level" "text" DEFAULT NULL::"text", "p_qbo_account_id" "text" DEFAULT NULL::"text", "p_merchant" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT NULL::"text", "p_min_amount" numeric DEFAULT NULL::numeric, "p_max_amount" numeric DEFAULT NULL::numeric, "p_sort" "text" DEFAULT 'date_desc'::"text", "p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public'
    AS $_$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_as_of date := coalesce(p_as_of_date, make_date(p_tax_year, 12, 31));
  v_date_from date := make_date(p_tax_year, 1, 1);
  v_date_to date := make_date(p_tax_year, 12, 31);
  v_result jsonb;
begin
  if p_business_id is null then
    raise exception 'business_id is required' using errcode = '22023';
  end if;
  if p_tax_year is null or p_tax_year < 2000 or p_tax_year > 2100 then
    raise exception 'tax_year must be between 2000 and 2100' using errcode = '22023';
  end if;
  if p_sort not in ('date_desc', 'date_asc', 'amount_desc', 'amount_asc', 'confidence_asc', 'confidence_desc', 'updated_desc') then
    raise exception 'unsupported sort' using errcode = '22023';
  end if;
  if p_month is not null then
    if p_month !~ '^\d{4}-\d{2}$' then
      raise exception 'month must be YYYY-MM' using errcode = '22023';
    end if;
    v_date_from := (p_month || '-01')::date;
    v_date_to := (v_date_from + interval '1 month - 1 day')::date;
  end if;
  v_date_to := least(v_date_to, v_as_of);

  with joined as (
    select
      c.id as classification_id,
      c.business_id,
      c.transaction_id,
      c.tax_year,
      coalesce(c.transaction_date, b.date) as txn_date,
      b.name as description,
      b.merchant_name,
      b.counterparty_name,
      coalesce(c.book_amount, b.signed_amount, 0) as signed_amount,
      abs(coalesce(c.book_amount, b.signed_amount, 0)) as absolute_amount,
      coalesce(b.direction, c.metadata->>'direction') as direction,
      coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') as qbo_account_id,
      coalesce(c.source_qbo_account_name, c.metadata->>'source_qbo_account_name', c.metadata->>'bookkeeping_category') as qbo_account_name,
      coalesce(c.source_qbo_txn_id, c.metadata->>'source_qbo_txn_id') as qbo_txn_id,
      coalesce(c.source_qbo_txn_type, c.metadata->>'source_qbo_txn_type') as qbo_txn_type,
      c.tax_category,
      c.deductibility_status,
      coalesce(c.deductible_percent, 0) as deductible_percent,
      coalesce(c.deductible_amount, 0) as deductible_amount,
      coalesce(c.nondeductible_amount, 0) as nondeductible_amount,
      coalesce(c.capitalizable_amount, 0) as capitalizable_amount,
      c.tax_treatment,
      c.classification_status,
      c.confidence_score,
      c.confidence_level,
      c.rule_id,
      c.rule_code,
      c.reason,
      c.requires_review,
      c.user_override,
      c.cpa_override,
      c.source,
      c.metadata,
      c.created_at,
      c.updated_at,
      o.override_source,
      o.created_at as override_created_at
    from public.transaction_tax_classifications c
    join public.bank_transactions b
      on b.business_id = c.business_id
     and b.id = c.transaction_id
    left join lateral (
      select override_source, created_at
      from public.tax_classification_overrides o
      where o.business_id = c.business_id
        and o.tax_year = c.tax_year
        and o.transaction_id = c.transaction_id
      order by o.created_at desc nulls last
      limit 1
    ) o on true
    where c.business_id = p_business_id
      and c.tax_year = p_tax_year
      and b.business_id = p_business_id
      and b.pending is not true
      and b.is_archived is not true
      and coalesce(c.transaction_date, b.date) >= v_date_from
      and coalesce(c.transaction_date, b.date) <= v_date_to
      and (p_tax_category is null or c.tax_category = p_tax_category)
      and (p_deductibility_status is null or c.deductibility_status = p_deductibility_status)
      and (p_classification_status is null or c.classification_status = p_classification_status)
      and (p_confidence_level is null or c.confidence_level = p_confidence_level)
      and (p_qbo_account_id is null or coalesce(c.source_qbo_account_id, c.metadata->>'source_qbo_account_id') = p_qbo_account_id)
      and (p_merchant is null or b.merchant_name ilike '%' || p_merchant || '%' or b.counterparty_name ilike '%' || p_merchant || '%')
      and (p_search is null
        or b.name ilike '%' || p_search || '%'
        or b.merchant_name ilike '%' || p_search || '%'
        or b.counterparty_name ilike '%' || p_search || '%'
        or coalesce(c.source_qbo_account_name, c.metadata->>'source_qbo_account_name', c.metadata->>'bookkeeping_category') ilike '%' || p_search || '%'
        or c.tax_category ilike '%' || p_search || '%'
      )
      and (p_min_amount is null or abs(coalesce(c.book_amount, b.signed_amount, 0)) >= p_min_amount)
      and (p_max_amount is null or abs(coalesce(c.book_amount, b.signed_amount, 0)) <= p_max_amount)
  ),
  totals as (
    select
      count(*)::integer as total_count,
      coalesce(sum(absolute_amount), 0) as book_amount,
      coalesce(sum(deductible_amount), 0) as deductible_amount,
      coalesce(sum(nondeductible_amount), 0) as nondeductible_amount,
      coalesce(sum(capitalizable_amount), 0) as capitalizable_amount,
      coalesce(sum(case when requires_review is true or classification_status = 'needs_review' then absolute_amount else 0 end), 0) as needs_review_amount
    from joined
  ),
  filters as (
    select
      coalesce(jsonb_agg(distinct tax_category) filter (where tax_category is not null), '[]'::jsonb) as tax_categories,
      coalesce(jsonb_agg(distinct classification_status) filter (where classification_status is not null), '[]'::jsonb) as classification_statuses,
      coalesce(jsonb_agg(distinct deductibility_status) filter (where deductibility_status is not null), '[]'::jsonb) as deductibility_statuses,
      coalesce(jsonb_agg(distinct to_char(txn_date, 'YYYY-MM')) filter (where txn_date is not null), '[]'::jsonb) as months,
      coalesce(jsonb_agg(distinct confidence_level) filter (where confidence_level is not null), '[]'::jsonb) as confidence_levels,
      coalesce(jsonb_agg(distinct jsonb_build_object('id', qbo_account_id, 'name', qbo_account_name)) filter (where qbo_account_name is not null), '[]'::jsonb) as qbo_accounts
    from joined
  ),
  paged as (
    select *
    from joined
    order by
      case when p_sort = 'date_asc' then txn_date end asc nulls last,
      case when p_sort = 'date_desc' then txn_date end desc nulls last,
      case when p_sort = 'amount_asc' then absolute_amount end asc nulls last,
      case when p_sort = 'amount_desc' then absolute_amount end desc nulls last,
      case when p_sort = 'confidence_asc' then confidence_score end asc nulls last,
      case when p_sort = 'confidence_desc' then confidence_score end desc nulls last,
      case when p_sort = 'updated_desc' then updated_at end desc nulls last,
      txn_date desc nulls last,
      updated_at desc nulls last,
      classification_id desc
    limit v_limit
    offset v_offset
  ),
  rows_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'transactionId', transaction_id,
      'date', txn_date,
      'description', description,
      'merchantName', merchant_name,
      'counterpartyName', counterparty_name,
      'signedAmount', signed_amount,
      'absoluteAmount', absolute_amount,
      'direction', direction,
      'qboAccountId', qbo_account_id,
      'qboAccountName', qbo_account_name,
      'qboTxnId', qbo_txn_id,
      'qboTxnType', qbo_txn_type,
      'taxCategory', tax_category,
      'deductibilityStatus', deductibility_status,
      'deductiblePercent', deductible_percent,
      'deductibleAmount', deductible_amount,
      'nondeductibleAmount', nondeductible_amount,
      'capitalizableAmount', capitalizable_amount,
      'taxTreatment', tax_treatment,
      'classificationStatus', classification_status,
      'confidenceScore', confidence_score,
      'confidenceLevel', confidence_level,
      'rule', jsonb_build_object('id', rule_id, 'code', rule_code, 'explanation', reason, 'supportLevel', metadata->>'rule_support_level'),
      'reason', reason,
      'warnings', coalesce(metadata->'warnings', '[]'::jsonb) || coalesce(metadata->'source_warnings', '[]'::jsonb),
      'requiresReview', coalesce(requires_review, false) or classification_status = 'needs_review',
      'override', jsonb_build_object('hasOverride', coalesce(user_override, false) or coalesce(cpa_override, false) or override_source is not null, 'source', coalesce(override_source, source), 'lastChangedAt', override_created_at),
      'sourceTruth', metadata->'source_truth',
      'postedAt', metadata->>'posted_at',
      'classifiedAt', coalesce(metadata->>'classified_at', created_at::text),
      'updatedAt', updated_at
    ) order by
      case when p_sort = 'date_asc' then txn_date end asc nulls last,
      case when p_sort = 'date_desc' then txn_date end desc nulls last,
      case when p_sort = 'amount_asc' then absolute_amount end asc nulls last,
      case when p_sort = 'amount_desc' then absolute_amount end desc nulls last,
      case when p_sort = 'confidence_asc' then confidence_score end asc nulls last,
      case when p_sort = 'confidence_desc' then confidence_score end desc nulls last,
      case when p_sort = 'updated_desc' then updated_at end desc nulls last,
      txn_date desc nulls last,
      updated_at desc nulls last,
      classification_id desc
    ), '[]'::jsonb) as rows
    from paged
  )
  select jsonb_build_object(
    'rows', rows_json.rows,
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'offset', v_offset,
      'returned', jsonb_array_length(rows_json.rows),
      'total', totals.total_count,
      'hasMore', (v_offset + v_limit) < totals.total_count
    ),
    'totalsForFilter', jsonb_build_object(
      'bookAmount', totals.book_amount,
      'deductibleAmount', totals.deductible_amount,
      'nondeductibleAmount', totals.nondeductible_amount,
      'capitalizableAmount', totals.capitalizable_amount,
      'needsReviewAmount', totals.needs_review_amount
    ),
    'availableFilters', jsonb_build_object(
      'taxCategories', filters.tax_categories,
      'classificationStatuses', filters.classification_statuses,
      'deductibilityStatuses', filters.deductibility_statuses,
      'qboAccounts', filters.qbo_accounts,
      'months', filters.months,
      'confidenceLevels', filters.confidence_levels
    ),
    'warnings', '[]'::jsonb
  )
  into v_result
  from totals, filters, rows_json;

  return v_result;
end;
$_$;


ALTER FUNCTION "public"."get_tax_deduction_transaction_drilldown"("p_business_id" "uuid", "p_tax_year" integer, "p_as_of_date" "date", "p_tax_category" "text", "p_month" "text", "p_deductibility_status" "text", "p_classification_status" "text", "p_confidence_level" "text", "p_qbo_account_id" "text", "p_merchant" "text", "p_search" "text", "p_min_amount" numeric, "p_max_amount" numeric, "p_sort" "text", "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."gpt_messages_after_delete_trg"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  -- Only recalc if the deleted row was the newest; simplest approach is to just recalc always
  perform public.recalc_thread_last_message(old.thread_id);
  return old;
end;
$$;


ALTER FUNCTION "public"."gpt_messages_after_delete_trg"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_confirmed_auth_user_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  first_name_text text;
  last_name_text text;
  full_name_text text;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;

  first_name_text := nullif(trim(coalesce(new.raw_user_meta_data->>'first_name', '')), '');
  last_name_text := nullif(trim(coalesce(new.raw_user_meta_data->>'last_name', '')), '');
  full_name_text := nullif(
    trim(coalesce(new.raw_user_meta_data->>'full_name', concat_ws(' ', first_name_text, last_name_text))),
    ''
  );

  insert into public.user_profiles (
    id,
    email,
    role,
    first_name,
    last_name,
    full_name
  )
  values (
    new.id,
    new.email,
    'owner',
    first_name_text,
    last_name_text,
    full_name_text
  )
  on conflict (id) do update
  set
    email = excluded.email,
    first_name = coalesce(public.user_profiles.first_name, excluded.first_name),
    last_name = coalesce(public.user_profiles.last_name, excluded.last_name),
    full_name = coalesce(public.user_profiles.full_name, excluded.full_name),
    role = coalesce(public.user_profiles.role, excluded.role);

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_confirmed_auth_user_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_member"("p_user" "uuid", "p_business" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1
      from public.user_business_link ubl
     where ubl.user_id = p_user
       and ubl.business_id = p_business
  );
$$;


ALTER FUNCTION "public"."is_member"("p_user" "uuid", "p_business" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_bizzy_memory"("user_uuid" "uuid", "query_embedding" "public"."vector", "match_threshold" double precision DEFAULT 0.75, "match_count" integer DEFAULT 3, "tag_filter" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("id" "uuid", "input_text" "text", "bizzy_response" "text", "tags" "text"[], "kpis" "jsonb", "similarity" double precision)
    LANGUAGE "sql" STABLE
    AS $$
  select
    bm.id,
    bm.input_text,
    bm.bizzy_response,
    bm.tags,
    bm.kpis,
    1 - (bm.embedding <=> query_embedding) as similarity
  from public.bizzy_memory bm
  where bm.user_id = user_uuid
    and bm.embedding is not null
    and (tag_filter is null or bm.tags && tag_filter)
    and (1 - (bm.embedding <=> query_embedding)) >= match_threshold
  order by bm.embedding <=> query_embedding asc
  limit match_count;
$$;


ALTER FUNCTION "public"."match_bizzy_memory"("user_uuid" "uuid", "query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "tag_filter" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_memories"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_count" integer DEFAULT 3) RETURNS TABLE("id" "uuid", "input_text" "text", "bizzy_response" "text", "tags" "text"[], "kpis" "jsonb", "created_at" timestamp without time zone)
    LANGUAGE "sql" STABLE
    AS $$
  select
    id,
    input_text,
    bizzy_response,
    tags,
    kpis,
    created_at
  from bizzy_memory
  where user_id = match_user_id
  order by embedding <#> query_embedding
  limit match_count;
$$;


ALTER FUNCTION "public"."match_memories"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_completed_tax_run_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if tg_op = 'DELETE' and old.status = 'completed' then
    raise exception
      'Completed tax calculation runs are immutable';
  end if;

  if tg_op = 'UPDATE' and old.status = 'completed' then
    raise exception
      'Completed tax calculation runs are immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."prevent_completed_tax_run_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalc_thread_last_message"("p_thread" "uuid") RETURNS "void"
    LANGUAGE "sql"
    AS $$
  with m as (
    select created_at, content
      from public.gpt_messages
     where thread_id = p_thread
     order by created_at desc
     limit 1
  )
  update public.gpt_threads t
     set last_message_at      = m.created_at,
         last_message_excerpt = left(m.content, 140),
         updated_at           = now()
    from m
   where t.id = p_thread;
$$;


ALTER FUNCTION "public"."recalc_thread_last_message"("p_thread" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_billing_identity_summary"("p_business_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."refresh_billing_identity_summary"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_billing_identity_summary_from_billing"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  perform public.refresh_billing_identity_summary(new.business_id);
  return new;
end;
$$;


ALTER FUNCTION "public"."refresh_billing_identity_summary_from_billing"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_billing_identity_summary_from_business_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform public.refresh_billing_identity_summary(new.id);
  return new;
end;
$$;


ALTER FUNCTION "public"."refresh_billing_identity_summary_from_business_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_billing_identity_summary_from_user_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."refresh_billing_identity_summary_from_user_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_bid_estimate_line_items_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_bid_estimate_line_items_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_bid_estimates_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_bid_estimates_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_job_costing_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_job_costing_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_job_financial_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_job_financial_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_job_margin_targets_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_job_margin_targets_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_job_transaction_assignments_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_job_transaction_assignments_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_user_profiles_full_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.full_name :=
    nullif(trim(coalesce(new.first_name,'') || ' ' || coalesce(new.last_name,'')), '');
  return new;
end;
$$;


ALTER FUNCTION "public"."set_user_profiles_full_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_tax_payment_year_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.tax_year is null and new.year is not null then
    new.tax_year := new.year;
  elsif new.year is null and new.tax_year is not null then
    new.year := new.tax_year;
  elsif new.tax_year is distinct from new.year then
    -- Prefer canonical tax_year when both are supplied.
    new.year := new.tax_year;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."sync_tax_payment_year_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tax_user_owns_business"("p_business_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.business_profiles bp
    where bp.id = p_business_id
      and bp.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."tax_user_owns_business"("p_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tc_sync_txn_fields_from_bank_transactions"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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
$$;


ALTER FUNCTION "public"."tc_sync_txn_fields_from_bank_transactions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_gpt_thread_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  update public.gpt_threads
     set updated_at          = now(),
         last_message_at     = new.created_at,
         last_message_excerpt= left(new.content, 140)
   where id = new.thread_id;
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_gpt_thread_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_tax_recalculation_requests_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_tax_recalculation_requests_updated_at"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."account_breakdown" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "month" "text" NOT NULL,
    "account_name" "text" NOT NULL,
    "account_type" "text" NOT NULL,
    "balance" numeric,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "embedding_text" "text",
    "embedding" "public"."vector"(1536)
);


ALTER TABLE "public"."account_breakdown" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."affordability_assessments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "user_id" "uuid",
    "expense_name" "text",
    "amount" numeric,
    "frequency" "text",
    "start_date" "date",
    "notes" "text",
    "verdict" "text",
    "rationale" "text",
    "impact" "jsonb",
    "recommendation" "jsonb",
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."affordability_assessments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stripe_invoice_id" "text" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "amount_due" integer,
    "amount_paid" integer,
    "status" "text",
    "hosted_invoice_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "due_date" "date",
    "customer_name" "text"
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ar_aging" AS
 SELECT "business_id",
    "id" AS "invoice_id",
    COALESCE("customer_name", 'Client'::"text") AS "client",
    (GREATEST((COALESCE("amount_due", 0) - COALESCE("amount_paid", 0)), 0))::numeric AS "amount",
    GREATEST(0, (CURRENT_DATE - COALESCE("due_date", ("created_at")::"date"))) AS "days",
    COALESCE("due_date", ("created_at")::"date") AS "due_date",
    "status"
   FROM "public"."invoices" "i"
  WHERE (GREATEST((COALESCE("amount_due", 0) - COALESCE("amount_paid", 0)), 0) > 0);


ALTER VIEW "public"."ar_aging" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ar_open_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "source" "text" DEFAULT 'qbo'::"text" NOT NULL,
    "qbo_env" "text" DEFAULT 'production'::"text" NOT NULL,
    "qbo_realm_id" "text",
    "qbo_invoice_id" "text" NOT NULL,
    "qbo_customer_id" "text",
    "doc_number" "text",
    "client_name" "text" NOT NULL,
    "invoice_date" "date",
    "due_date" "date",
    "terms" "text",
    "currency" "text",
    "total_amount" numeric,
    "balance" numeric DEFAULT 0 NOT NULL,
    "is_job" boolean DEFAULT false NOT NULL,
    "parent_customer_name" "text",
    "parent_qbo_customer_id" "text",
    "status" "text" DEFAULT 'unpaid'::"text" NOT NULL,
    "days_overdue" integer DEFAULT 0 NOT NULL,
    "do_not_contact" boolean DEFAULT false NOT NULL,
    "last_payment_at" timestamp with time zone,
    "last_contacted_at" timestamp with time zone,
    "next_followup_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ar_open_items_balance_nonnegative" CHECK (("balance" >= (0)::numeric)),
    CONSTRAINT "ar_open_items_status_check" CHECK (("status" = ANY (ARRAY['unpaid'::"text", 'partial'::"text", 'overdue'::"text", 'paid'::"text"])))
);


ALTER TABLE "public"."ar_open_items" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ar_aging_v2" AS
 SELECT "business_id",
    "qbo_invoice_id",
    "client_name" AS "client",
    "balance" AS "amount",
    "days_overdue" AS "days",
    "due_date",
    "status"
   FROM "public"."ar_open_items"
  WHERE (("balance" > (0)::numeric) AND ("status" <> 'paid'::"text"));


ALTER VIEW "public"."ar_aging_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ar_followups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "created_by" "text" DEFAULT 'bizzi'::"text" NOT NULL,
    "source" "text" DEFAULT 'qbo'::"text" NOT NULL,
    "ar_open_item_id" "uuid",
    "qbo_env" "text" DEFAULT 'production'::"text" NOT NULL,
    "qbo_invoice_id" "text",
    "qbo_customer_id" "text",
    "doc_number" "text",
    "client_name" "text",
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "intent" "text" DEFAULT 'payment_followup'::"text" NOT NULL,
    "step_number" integer DEFAULT 1 NOT NULL,
    "requires_approval" boolean DEFAULT true NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "do_not_contact" boolean DEFAULT false NOT NULL,
    "subject" "text",
    "body" "text",
    "tone" "text",
    "ai_model" "text",
    "ai_prompt_version" "text",
    "ai_context" "jsonb",
    "ai_confidence" numeric,
    "ai_notes" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "scheduled_for" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "provider" "text",
    "provider_message_id" "text",
    "to_email" "text",
    "to_phone" "text",
    "cc_emails" "text"[],
    "bcc_emails" "text"[],
    "last_error" "text",
    "meta" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "round" integer DEFAULT 1 NOT NULL,
    "customer_name" "text",
    "invoice_number" "text",
    "amount_due" numeric,
    "due_date" "date",
    "drafted_at" timestamp with time zone,
    "copied_at" timestamp with time zone,
    CONSTRAINT "ar_followups_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'scheduled'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text", 'canceled'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."ar_followups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assignment_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "assignment_id" "uuid",
    "assigned_by" "text" DEFAULT 'user'::"text" NOT NULL,
    "confidence_score" numeric,
    "method_used" "text"[] DEFAULT '{}'::"text"[],
    "source" "text" DEFAULT 'manual'::"text",
    "user_feedback" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."assignment_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."balance_sheet_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "month" "date" NOT NULL,
    "cash" numeric DEFAULT 0,
    "accounts_receivable" numeric DEFAULT 0,
    "accounts_payable" numeric DEFAULT 0,
    "loans" numeric DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."balance_sheet_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bank_sync_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "plaid_item_id" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "status" "text" DEFAULT 'ok'::"text" NOT NULL,
    "added_count" integer DEFAULT 0 NOT NULL,
    "modified_count" integer DEFAULT 0 NOT NULL,
    "removed_count" integer DEFAULT 0 NOT NULL,
    "error_message" "text",
    "meta" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bank_sync_runs_status_check" CHECK (("status" = ANY (ARRAY['ok'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."bank_sync_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bank_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "plaid_item_id" "text" NOT NULL,
    "plaid_account_id" "text" NOT NULL,
    "plaid_transaction_id" "text" NOT NULL,
    "pending" boolean DEFAULT false NOT NULL,
    "date" "date" NOT NULL,
    "authorized_date" "date",
    "name" "text" NOT NULL,
    "merchant_name" "text",
    "merchant_entity_id" "text",
    "payment_channel" "text",
    "transaction_type" "text",
    "check_number" "text",
    "amount" numeric NOT NULL,
    "iso_currency_code" "text",
    "unofficial_currency_code" "text",
    "category_primary" "text",
    "category_detailed" "text",
    "category_confidence" "text",
    "personal_finance_category" "jsonb",
    "location" "jsonb",
    "counterparties" "jsonb",
    "plaid_last_modified_at" timestamp with time zone,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "raw" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "plaid_amount_raw" numeric,
    "direction" "text",
    "signed_amount" numeric,
    "counterparty_name" "text",
    "counterparty_source" "text",
    "counterparty_confidence" "text",
    "qbo_entity_type" "text",
    "qbo_entity_id" "text",
    "is_archived" boolean DEFAULT false NOT NULL,
    "archived_at" timestamp with time zone,
    "pending_transaction_id" "text",
    "duplicate_fingerprint" "text",
    "archived_reason" "text",
    CONSTRAINT "bank_transactions_counterparty_conf_check" CHECK ((("counterparty_confidence" IS NULL) OR ("counterparty_confidence" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"])))),
    CONSTRAINT "bank_transactions_counterparty_source_check" CHECK ((("counterparty_source" IS NULL) OR ("counterparty_source" = ANY (ARRAY['plaid_merchant'::"text", 'plaid_counterparty'::"text", 'memo_parse'::"text", 'qbo_match'::"text", 'user_override'::"text"])))),
    CONSTRAINT "bank_transactions_direction_check" CHECK ((("direction" IS NULL) OR ("direction" = ANY (ARRAY['INFLOW'::"text", 'OUTFLOW'::"text", 'UNKNOWN'::"text"])))),
    CONSTRAINT "bank_transactions_qbo_entity_type_check" CHECK ((("qbo_entity_type" IS NULL) OR ("qbo_entity_type" = ANY (ARRAY['vendor'::"text", 'customer'::"text"]))))
);


ALTER TABLE "public"."bank_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_estimate_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "bid_estimate_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit" "text",
    "unit_cost" numeric DEFAULT 0 NOT NULL,
    "total_cost" numeric DEFAULT 0 NOT NULL,
    "markup_percent" numeric,
    "selling_price" numeric,
    "source" "text" DEFAULT 'generated'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bid_estimate_line_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_estimates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_name" "text",
    "prospect_name" "text",
    "bid_title" "text" NOT NULL,
    "job_type" "text",
    "trade_type" "text",
    "scope_description" "text" NOT NULL,
    "square_footage" numeric,
    "desired_margin_percent" numeric,
    "minimum_margin_percent" numeric,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "estimated_labor_cost" numeric DEFAULT 0 NOT NULL,
    "estimated_material_cost" numeric DEFAULT 0 NOT NULL,
    "estimated_subcontractor_cost" numeric DEFAULT 0 NOT NULL,
    "estimated_permit_cost" numeric DEFAULT 0 NOT NULL,
    "estimated_other_cost" numeric DEFAULT 0 NOT NULL,
    "estimated_total_cost" numeric DEFAULT 0 NOT NULL,
    "recommended_price" numeric DEFAULT 0 NOT NULL,
    "projected_gross_margin" numeric DEFAULT 0 NOT NULL,
    "projected_margin_percent" numeric,
    "deposit_amount" numeric,
    "payment_schedule" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "risk_flags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "historical_basis" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "proposal_text" "text",
    "internal_notes" "text",
    "converted_job_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "converted_at" timestamp with time zone,
    CONSTRAINT "bid_estimates_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'won'::"text", 'lost'::"text", 'converted'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."bid_estimates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bid_outcomes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "bid_estimate_id" "uuid" NOT NULL,
    "outcome" "text" NOT NULL,
    "won_amount" numeric,
    "lost_reason" "text",
    "competitor_price" numeric,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "bid_outcomes_outcome_check" CHECK (("outcome" = ANY (ARRAY['won'::"text", 'lost'::"text", 'no_response'::"text", 'revised'::"text"])))
);


ALTER TABLE "public"."bid_outcomes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_billing" (
    "business_id" "uuid" NOT NULL,
    "stripe_customer_id" "text",
    "stripe_subscription_id" "text",
    "subscription_status" "text" DEFAULT 'free'::"text" NOT NULL,
    "plan_price_id" "text",
    "current_period_end" timestamp with time zone,
    "trial_end" timestamp with time zone,
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "plan_type" "text",
    "last_invoice_status" "text",
    "canceled_at" timestamp with time zone,
    "last_invoice_id" "text",
    "last_payment_failed_at" timestamp with time zone,
    "stripe_customer_id_live" "text",
    "stripe_customer_id_test" "text",
    "stripe_subscription_id_live" "text",
    "stripe_subscription_id_test" "text",
    "subscription_status_live" "text",
    "subscription_status_test" "text",
    "plan_price_id_live" "text",
    "plan_price_id_test" "text",
    "current_period_end_live" timestamp with time zone,
    "current_period_end_test" timestamp with time zone,
    "trial_end_live" timestamp with time zone,
    "trial_end_test" timestamp with time zone,
    "cancel_at_period_end_live" boolean,
    "cancel_at_period_end_test" boolean,
    "last_invoice_status_live" "text",
    "last_invoice_status_test" "text",
    "canceled_at_live" timestamp with time zone,
    "canceled_at_test" timestamp with time zone,
    "last_invoice_id_live" "text",
    "last_invoice_id_test" "text",
    "last_payment_failed_at_live" timestamp with time zone,
    "last_payment_failed_at_test" timestamp with time zone,
    "plan_type_live" "text",
    "plan_type_test" "text",
    "business_name" "text",
    "customer_user_id" "uuid",
    "customer_email" "text",
    "customer_full_name" "text",
    "billing_display_status" "text",
    "billing_display_plan_type" "text"
);


ALTER TABLE "public"."business_billing" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."billing_customer_overview" AS
 SELECT "business_id",
    "business_name",
    "customer_user_id" AS "user_id",
    "customer_full_name",
    "customer_email",
    "public"."billing_effective_text"("stripe_customer_id", "stripe_customer_id_live", "stripe_customer_id_test") AS "stripe_customer_id",
    "public"."billing_effective_text"("stripe_subscription_id", "stripe_subscription_id_live", "stripe_subscription_id_test") AS "stripe_subscription_id",
    "public"."billing_effective_status"("subscription_status", "subscription_status_live", "subscription_status_test") AS "subscription_status",
    "public"."billing_effective_text"("plan_type", "plan_type_live", "plan_type_test") AS "plan_type",
    "public"."billing_effective_text"("plan_price_id", "plan_price_id_live", "plan_price_id_test") AS "plan_price_id",
    "public"."billing_effective_timestamptz"("current_period_end", "current_period_end_live", "current_period_end_test") AS "current_period_end",
    "public"."billing_effective_bool"("cancel_at_period_end", "cancel_at_period_end_live", "cancel_at_period_end_test") AS "cancel_at_period_end",
    "public"."billing_effective_text"("last_invoice_status", "last_invoice_status_live", "last_invoice_status_test") AS "last_invoice_status",
    "updated_at"
   FROM "public"."business_billing" "bb";


ALTER VIEW "public"."billing_customer_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_customers" (
    "user_id" "uuid" NOT NULL,
    "stripe_customer_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."billing_customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bizzy_deadlines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "source" "text" NOT NULL,
    "title" "text" NOT NULL,
    "due_date" "date" NOT NULL,
    "amount" numeric(14,2),
    "status" "public"."deadline_status" DEFAULT 'upcoming'::"public"."deadline_status" NOT NULL,
    "related_module" "text",
    "related_entity" "jsonb",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bizzy_deadlines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bizzy_docs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "category" "text" NOT NULL,
    "content" "jsonb" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "filename" "text",
    "size" bigint,
    "mime_type" "text",
    "author" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "search_lexeme" "tsvector",
    "file_hash" "text",
    "storage_bucket" "text",
    "storage_path" "text",
    CONSTRAINT "bizzy_docs_category_check" CHECK (("category" = ANY (ARRAY['financials'::"text", 'tax'::"text", 'marketing'::"text", 'investments'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."bizzy_docs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bizzy_headlines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "headline" "text" NOT NULL,
    "kind" "text" DEFAULT 'generic'::"text" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb",
    "valid_for" "date" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bizzy_headlines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bizzy_memory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "embedding" "public"."vector"(1536),
    "input_text" "text" NOT NULL,
    "bizzy_response" "text" NOT NULL,
    "tags" "text"[],
    "kpis" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bizzy_memory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bizzy_timeline" (
    "user_id" "uuid" NOT NULL,
    "latest_activity" "text",
    "recent_alerts" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bizzy_timeline" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookkeeping_health" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "uncategorized_count" integer DEFAULT 0,
    "needs_review_count" integer DEFAULT 0,
    "confidence_score" numeric(5,2),
    "last_sync_at" timestamp with time zone,
    "last_evaluated_at" timestamp with time zone DEFAULT "now"(),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "plaid_last_sync_at" timestamp with time zone,
    "qbo_last_post_at" timestamp with time zone,
    "posted_count" integer DEFAULT 0 NOT NULL,
    "auto_approved_count" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    CONSTRAINT "bookkeeping_health_status_check" CHECK (("status" = ANY (ARRAY['unknown'::"text", 'healthy'::"text", 'needs_review'::"text", 'syncing'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."bookkeeping_health" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookkeeping_post_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" NOT NULL,
    "qbo_txn_id" "text",
    "qbo_txn_type" "text",
    "error_message" "text",
    "retry_count" integer,
    "post_after" timestamp with time zone,
    "payload_summary" "jsonb",
    "response_summary" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bookkeeping_post_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_profiles" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "business_name" "text" NOT NULL,
    "industry" "text" NOT NULL,
    "team_size" integer NOT NULL,
    "annual_revenue" "text",
    "state" "text" NOT NULL,
    "services_offered" "text" NOT NULL,
    "billing_model" "text",
    "founded_year" integer,
    "top_challenge" "text"
);


ALTER TABLE "public"."business_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "module" "text" NOT NULL,
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "start_ts" timestamp with time zone NOT NULL,
    "end_ts" timestamp with time zone NOT NULL,
    "all_day" boolean DEFAULT false NOT NULL,
    "location" "text",
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "visibility" "text" DEFAULT 'private'::"text" NOT NULL,
    "links" "jsonb",
    "color" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "calendar_events_module_check" CHECK (("module" = ANY (ARRAY['financials'::"text", 'tax'::"text", 'marketing'::"text", 'investments'::"text", 'ops'::"text"]))),
    CONSTRAINT "calendar_events_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'in_progress'::"text", 'done'::"text", 'canceled'::"text"]))),
    CONSTRAINT "calendar_events_type_check" CHECK (("type" = ANY (ARRAY['job'::"text", 'lead'::"text", 'post'::"text", 'email'::"text", 'invoice'::"text", 'deadline'::"text", 'meeting'::"text", 'task'::"text"]))),
    CONSTRAINT "calendar_events_visibility_check" CHECK (("visibility" = ANY (ARRAY['private'::"text", 'team'::"text"])))
);


ALTER TABLE "public"."calendar_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cashflow_forecast" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "month" "date" NOT NULL,
    "revenue" numeric,
    "expenses" numeric,
    "cash_in" numeric,
    "cash_out" numeric,
    "net_cash" numeric,
    "ending_cash" numeric,
    "embedding_text" "text",
    "embedding" "public"."vector"(1536),
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "source" "text" DEFAULT 'auto'::"text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."cashflow_forecast" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."categorization_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "match_type" "text" NOT NULL,
    "match_value" "text" NOT NULL,
    "qbo_account_id" "text" NOT NULL,
    "qbo_account_name" "text",
    "auto_approve" boolean DEFAULT false NOT NULL,
    "confidence_override" "text",
    "priority" integer DEFAULT 100 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "categorization_rules_conf_check" CHECK ((("confidence_override" IS NULL) OR ("confidence_override" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"])))),
    CONSTRAINT "categorization_rules_match_type_check" CHECK (("match_type" = ANY (ARRAY['contains'::"text", 'equals'::"text", 'merchant_entity_id'::"text", 'regex'::"text"])))
);


ALTER TABLE "public"."categorization_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clarification_learning_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid",
    "vendor_key" "text",
    "memo_key" "text",
    "user_answer_text" "text" NOT NULL,
    "resulting_qbo_account_id" "text",
    "resulting_qbo_account_name" "text",
    "meta" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."clarification_learning_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clarification_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reason_code" "text" DEFAULT 'other'::"text" NOT NULL,
    "prompt_text" "text" DEFAULT 'What was this for?'::"text" NOT NULL,
    "answer_text" "text",
    "answered_at" timestamp with time zone,
    "answered_by" "text",
    "last_notified_at" timestamp with time zone,
    "dismissed_until" timestamp with time zone,
    "meta" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "clarification_requests_answered_by_check" CHECK ((("answered_by" IS NULL) OR ("answered_by" = ANY (ARRAY['user'::"text", 'bizzi'::"text"])))),
    CONSTRAINT "clarification_requests_reason_code_check" CHECK (("reason_code" = ANY (ARRAY['low_confidence'::"text", 'missing_vendor'::"text", 'check'::"text", 'suspense'::"text", 'no_safe_default'::"text", 'other'::"text"]))),
    CONSTRAINT "clarification_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'answered'::"text", 'expired'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."clarification_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_revenue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "client_name" "text" NOT NULL,
    "job_id" "uuid",
    "revenue" numeric NOT NULL,
    "month" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."client_revenue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contractor_cfo_insight_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_key" "text" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "lock_owner" "text",
    "lock_expires_at" timestamp with time zone DEFAULT ("now"() + '02:00:00'::interval) NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "businesses_count" integer DEFAULT 0 NOT NULL,
    "inserted_count" integer DEFAULT 0 NOT NULL,
    "skipped_count" integer DEFAULT 0 NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contractor_cfo_insight_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'failed'::"text", 'skipped'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."contractor_cfo_insight_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_external_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "source_system" "text" NOT NULL,
    "source_entity_type" "text" NOT NULL,
    "external_entity_id" "text" NOT NULL,
    "external_parent_id" "text",
    "realm_id" "text",
    "sync_token" "text",
    "display_name" "text",
    "company_name" "text",
    "email" "text",
    "phone" "text",
    "is_sub_customer" boolean DEFAULT false NOT NULL,
    "active" boolean,
    "balance" numeric,
    "billing_address" "jsonb",
    "shipping_address" "jsonb",
    "currency" "text",
    "source_updated_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone,
    "sync_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fully_qualified_name" "text",
    "balance_with_jobs" numeric,
    "sparse" boolean,
    "potential_job_source" boolean DEFAULT false NOT NULL,
    "qbo_env" "text"
);


ALTER TABLE "public"."customer_external_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "display_name" "text" NOT NULL,
    "company_name" "text",
    "email" "text",
    "phone" "text",
    "billing_address" "jsonb",
    "shipping_address" "jsonb",
    "service_address" "jsonb",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "provider" "text" NOT NULL,
    "google_email" "text" NOT NULL,
    "scopes" "text"[] DEFAULT '{}'::"text"[],
    "token_expiry" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "email_accounts_provider_check" CHECK (("provider" = 'gmail'::"text"))
);


ALTER TABLE "public"."email_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "external_id" "text",
    "external_source" "text",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."employees" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_costs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "cost_type" "text",
    "amount" numeric,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "job_costs_cost_type_check" CHECK (("cost_type" = ANY (ARRAY['labor'::"text", 'materials'::"text", 'subcontractor'::"text", 'equipment'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."job_costs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."expense_categories" AS
 SELECT "business_id",
    ("date_trunc"('month'::"text", "created_at"))::"date" AS "month",
    "lower"(COALESCE("cost_type", 'other'::"text")) AS "category",
    "sum"("amount") AS "amount"
   FROM "public"."job_costs" "jc"
  GROUP BY "business_id", (("date_trunc"('month'::"text", "created_at"))::"date"), ("lower"(COALESCE("cost_type", 'other'::"text")))
  ORDER BY (("date_trunc"('month'::"text", "created_at"))::"date") DESC, ("sum"("amount")) DESC;


ALTER VIEW "public"."expense_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expense_category_map" (
    "id" bigint NOT NULL,
    "business_id" "uuid" NOT NULL,
    "qbo_account" "text" NOT NULL,
    "category" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."expense_category_map" OWNER TO "postgres";


ALTER TABLE "public"."expense_category_map" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."expense_category_map_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."expense_totals_monthly" (
    "id" bigint NOT NULL,
    "business_id" "uuid" NOT NULL,
    "month" "date" NOT NULL,
    "category" "text" NOT NULL,
    "amount" numeric DEFAULT 0 NOT NULL,
    "source" "text" DEFAULT 'qbo'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."expense_totals_monthly" OWNER TO "postgres";


ALTER TABLE "public"."expense_totals_monthly" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."expense_totals_monthly_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."financial_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "month" "text" NOT NULL,
    "total_revenue" numeric,
    "total_expenses" numeric,
    "net_profit" numeric,
    "profit_margin" numeric,
    "top_spending_category" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "embedding_text" "text",
    "embedding" "public"."vector"(1536),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."financial_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_monthly_review_stamps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "review_month" "date" NOT NULL,
    "status" "text" DEFAULT 'finalized'::"text" NOT NULL,
    "reviewed_by" "text",
    "reviewer_user_id" "uuid",
    "completed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "financial_monthly_review_stamps_month_start" CHECK (("review_month" = ("date_trunc"('month'::"text", ("review_month")::timestamp with time zone))::"date")),
    CONSTRAINT "financial_monthly_review_stamps_status_check" CHECK (("status" = ANY (ARRAY['completed'::"text", 'closed'::"text", 'finalized'::"text"])))
);


ALTER TABLE "public"."financial_monthly_review_stamps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_moves" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "business_id" "uuid",
    "month" "date" NOT NULL,
    "title" "text",
    "rationale" "text",
    "timeframe" "text",
    "embedding_text" "text",
    "embedding" "public"."vector"(1536),
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"())
);


ALTER TABLE "public"."financial_moves" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_summaries" (
    "user_id" "uuid" NOT NULL,
    "revenue_ytd" numeric,
    "margin_pct" numeric,
    "top_expense_categories" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"(),
    "embedding_text" "text",
    "embedding" "public"."vector"(1536)
);


ALTER TABLE "public"."financial_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."goal_tracking" (
    "user_id" "uuid" NOT NULL,
    "kpis" "text"[],
    "objectives" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"(),
    "embedding_text" "text",
    "embedding" "public"."vector"(1536)
);


ALTER TABLE "public"."goal_tracking" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gpt_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "embedding_text" "text",
    "embedding" "public"."vector"(1536),
    "thread_id" "uuid",
    "business_id" "uuid",
    CONSTRAINT "gpt_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text", 'developer'::"text"])))
);


ALTER TABLE "public"."gpt_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gpt_messages_backup" (
    "id" "uuid",
    "user_id" "uuid",
    "role" "text",
    "content" "text",
    "created_at" timestamp with time zone,
    "embedding_text" "text",
    "embedding" "public"."vector"(1536)
);


ALTER TABLE "public"."gpt_messages_backup" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gpt_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "title" "text" DEFAULT 'Untitled'::"text" NOT NULL,
    "first_intent" "text",
    "module" "text",
    "pinned" boolean DEFAULT false NOT NULL,
    "archived" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_message_excerpt" "text",
    "last_message_at" timestamp with time zone
);


ALTER TABLE "public"."gpt_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gpt_usage" (
    "user_id" "uuid" NOT NULL,
    "month" "text" NOT NULL,
    "query_count" integer DEFAULT 0 NOT NULL,
    "last_used" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."gpt_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insight_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "insight_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "feedback" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "insight_feedback_feedback_check" CHECK (("feedback" = ANY (ARRAY['helpful'::"text", 'not_helpful'::"text", 'too_frequent'::"text", 'not_relevant'::"text", 'acted_on'::"text"])))
);


ALTER TABLE "public"."insight_feedback" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insight_preferences" (
    "user_id" "uuid" NOT NULL,
    "show_alerts_right_rail" boolean DEFAULT true,
    "show_insights_right_rail" boolean DEFAULT true,
    "show_fyi_right_rail" boolean DEFAULT false,
    "email_enabled" boolean DEFAULT false,
    "sms_enabled" boolean DEFAULT false
);


ALTER TABLE "public"."insight_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insight_reads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "insight_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "read_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."insight_reads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "business_id" "uuid" NOT NULL,
    "module" "text" NOT NULL,
    "type" "text" NOT NULL,
    "severity" "text" DEFAULT 'medium'::"text",
    "title" "text" NOT NULL,
    "body" "text",
    "metrics" "jsonb" DEFAULT '[]'::"jsonb",
    "primary_cta" "jsonb",
    "secondary_cta" "jsonb",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "source_event_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone,
    "snoozed_until" timestamp with time zone,
    "is_read" boolean DEFAULT false NOT NULL,
    "read_at" timestamp with time zone,
    "category" "text",
    "confidence_score" numeric,
    "recommended_actions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "primary_cta_label" "text",
    "primary_cta_action" "text",
    "primary_cta_payload" "jsonb",
    "secondary_cta_label" "text",
    "secondary_cta_action" "text",
    "secondary_cta_payload" "jsonb",
    "dedupe_key" "text",
    "trigger_source" "text",
    "source_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "dismissed_at" timestamp with time zone,
    "status" "text",
    "account_id" "text",
    CONSTRAINT "insights_module_check" CHECK (("module" = ANY (ARRAY['contractor_cfo'::"text", 'tax'::"text", 'financials'::"text", 'marketing'::"text", 'investments'::"text"]))),
    CONSTRAINT "insights_severity_check" CHECK (("severity" = ANY (ARRAY['critical'::"text", 'high'::"text", 'medium'::"text", 'low'::"text"]))),
    CONSTRAINT "insights_type_check" CHECK (("type" = ANY (ARRAY['alert'::"text", 'insight'::"text", 'fyi'::"text"])))
);


ALTER TABLE "public"."insights" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."insights_history" AS
 SELECT "i"."id",
    "i"."user_id",
    "i"."business_id",
    "i"."module",
    "i"."type",
    "i"."severity",
    "i"."title",
    "i"."body",
    "i"."metrics",
    "i"."primary_cta",
    "i"."secondary_cta",
    "i"."tags",
    "i"."source_event_id",
    "i"."created_at",
    "i"."expires_at",
    "i"."snoozed_until",
    ("ir"."read_at" IS NOT NULL) AS "is_read"
   FROM ("public"."insights" "i"
     LEFT JOIN "public"."insight_reads" "ir" ON (("ir"."insight_id" = "i"."id")));


ALTER VIEW "public"."insights_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."integration_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "status" "text" DEFAULT 'disconnected'::"text" NOT NULL,
    "connected_at" timestamp with time zone,
    "last_sync_at" timestamp with time zone,
    "external_id" "text",
    "meta" "jsonb",
    "error_code" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "integration_connections_status_check" CHECK (("status" = ANY (ARRAY['connected'::"text", 'disconnected'::"text", 'error'::"text", 'reauth_required'::"text", 'pending'::"text"])))
);


ALTER TABLE "public"."integration_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text",
    "external_account_id" "text",
    "name" "text",
    "type" "text",
    "masked_number" "text",
    "currency" "text" DEFAULT 'USD'::"text",
    "last_synced_at" timestamp with time zone
);


ALTER TABLE "public"."investment_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_balances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "text" NOT NULL,
    "institution" "text",
    "account_name" "text",
    "account_type" "text",
    "balance_usd" numeric DEFAULT 0 NOT NULL,
    "ytd_return_pct" numeric,
    "ytd_gain_usd" numeric,
    "asset_allocation_json" "jsonb",
    "holdings_json" "jsonb",
    "last_updated" timestamp with time zone NOT NULL,
    "as_of" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."investment_balances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_assignment_instruction_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "instruction_text" "text" NOT NULL,
    "parsed_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "target_jobs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "matched_count" integer DEFAULT 0 NOT NULL,
    "total_amount" numeric DEFAULT 0 NOT NULL,
    "assigned_count" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "source" "text" DEFAULT 'natural_language'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_assignment_instruction_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_assignment_suggestions" (
    "id" "text" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "text" NOT NULL,
    "job_id" "text" NOT NULL,
    "confidence" numeric DEFAULT 0 NOT NULL,
    "reason" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "source" "text" DEFAULT 'rule_based'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rejected_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "suggested_job_id" "uuid",
    "confidence_score" numeric NOT NULL,
    "confidence_label" "text" NOT NULL,
    "methods_used" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "reasoning" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "user_feedback" "text",
    "accepted_assignment_id" "uuid",
    CONSTRAINT "job_assignment_suggestions_source_check" CHECK (("source" = ANY (ARRAY['rule_based'::"text", 'ai'::"text"]))),
    CONSTRAINT "job_assignment_suggestions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'accepted'::"text", 'rejected'::"text", 'ignored'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."job_assignment_suggestions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "candidate_type" "text" DEFAULT 'job_from_document'::"text" NOT NULL,
    "source_system" "text" DEFAULT 'quickbooks'::"text" NOT NULL,
    "source_entity_type" "text" NOT NULL,
    "source_entity_id" "text" NOT NULL,
    "source_customer_id" "uuid",
    "qbo_customer_id" "text",
    "qbo_subcustomer_id" "text",
    "qbo_project_id" "text",
    "suggested_job_name" "text",
    "customer_name" "text",
    "project_job_number" "text",
    "service_address" "jsonb",
    "invoice_estimate_amount" numeric,
    "document_number" "text",
    "document_date" "date",
    "memo" "text",
    "line_item_summary" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "recurring_indicator" boolean DEFAULT false NOT NULL,
    "confidence_score" numeric DEFAULT 0 NOT NULL,
    "confidence_level" "text" DEFAULT 'manual_review'::"text" NOT NULL,
    "detection_reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "candidate_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "possible_job_matches" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "confirmed_job_id" "uuid",
    "dismissal_reason" "text",
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "realm_id" "text",
    "qbo_env" "text",
    CONSTRAINT "job_candidates_confidence_level_check" CHECK (("confidence_level" = ANY (ARRAY['authoritative'::"text", 'high'::"text", 'medium'::"text", 'low'::"text", 'manual_review'::"text", 'ignored'::"text"]))),
    CONSTRAINT "job_candidates_status_check" CHECK (("candidate_status" = ANY (ARRAY['pending'::"text", 'approved_new'::"text", 'linked_existing'::"text", 'merged'::"text", 'dismissed'::"text", 'superseded'::"text"])))
);


ALTER TABLE "public"."job_candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_change_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "job_id" "text" NOT NULL,
    "description" "text" NOT NULL,
    "additional_revenue" numeric DEFAULT 0 NOT NULL,
    "additional_cost" numeric DEFAULT 0 NOT NULL,
    "change_order_date" "date" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "job_change_orders_additional_cost_check" CHECK (("additional_cost" >= (0)::numeric)),
    CONSTRAINT "job_change_orders_additional_revenue_check" CHECK (("additional_revenue" >= (0)::numeric))
);


ALTER TABLE "public"."job_change_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_costing_realm_integrity_conflicts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "migration_name" "text" NOT NULL,
    "business_id" "uuid",
    "table_name" "text" NOT NULL,
    "conflict_key" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "duplicate_count" integer DEFAULT 0 NOT NULL,
    "sample_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_costing_realm_integrity_conflicts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_employees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "role" "text",
    "assigned_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."job_employees" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_external_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "source_system" "text" NOT NULL,
    "source_entity_type" "text" NOT NULL,
    "external_entity_id" "text" NOT NULL,
    "external_parent_id" "text",
    "realm_id" "text",
    "sync_token" "text",
    "source_updated_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone,
    "sync_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "qbo_env" "text"
);


ALTER TABLE "public"."job_external_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_identity_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "source_system" "text" DEFAULT 'quickbooks'::"text" NOT NULL,
    "mapping_type" "text" NOT NULL,
    "source_entity_type" "text",
    "source_entity_id" "text",
    "qbo_customer_id" "text",
    "qbo_subcustomer_id" "text",
    "qbo_project_id" "text",
    "normalized_address_key" "text",
    "invoice_pattern" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "confidence_source" "text" DEFAULT 'user_confirmed'::"text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "realm_id" "text",
    "qbo_env" "text",
    CONSTRAINT "job_identity_mappings_type_check" CHECK (("mapping_type" = ANY (ARRAY['qbo_project'::"text", 'qbo_subcustomer'::"text", 'qbo_customer'::"text", 'address'::"text", 'invoice_pattern'::"text", 'external_job_id'::"text"])))
);


ALTER TABLE "public"."job_identity_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_margin_targets" (
    "business_id" "uuid" NOT NULL,
    "trade_type" "text" NOT NULL,
    "target_margin_percent" numeric DEFAULT 35 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "job_margin_targets_percent_check" CHECK ((("target_margin_percent" > (0)::numeric) AND ("target_margin_percent" < (95)::numeric)))
);


ALTER TABLE "public"."job_margin_targets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_payment_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "payment_record_id" "uuid" NOT NULL,
    "revenue_document_id" "uuid" NOT NULL,
    "applied_amount" numeric DEFAULT 0 NOT NULL,
    "linked_transaction_type" "text",
    "linked_transaction_id" "text",
    "allocation_source" "text" DEFAULT 'qbo_linked_txn'::"text" NOT NULL,
    "snapshot_version" "text",
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "external_revenue_document_id" "text",
    "external_revenue_document_type" "text"
);


ALTER TABLE "public"."job_payment_allocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_payment_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "source_system" "text" DEFAULT 'qbo'::"text" NOT NULL,
    "external_payment_id" "text",
    "payment_date" "date",
    "total_amount" numeric DEFAULT 0 NOT NULL,
    "unapplied_amount" numeric DEFAULT 0 NOT NULL,
    "currency" "text",
    "deposit_ref" "jsonb",
    "sync_token" "text",
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source_updated_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone,
    "sync_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "realm_id" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "private_note" "text",
    "linked_txn" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "line_allocations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "qbo_env" "text"
);


ALTER TABLE "public"."job_payment_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_revenue_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "job_id" "uuid",
    "customer_id" "uuid",
    "source_system" "text" DEFAULT 'manual'::"text" NOT NULL,
    "source_document_type" "text" NOT NULL,
    "external_document_id" "text",
    "document_number" "text",
    "document_date" "date",
    "due_date" "date",
    "total_amount" numeric DEFAULT 0 NOT NULL,
    "open_balance" numeric DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "currency" "text",
    "customer_ref" "jsonb",
    "project_ref" "jsonb",
    "linked_txn" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "line_summaries" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "billing_address" "jsonb",
    "shipping_address" "jsonb",
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source_updated_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone,
    "sync_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "realm_id" "text",
    "sync_token" "text",
    "exchange_rate" numeric,
    "email_status" "text",
    "print_status" "text",
    "private_note" "text",
    "customer_memo" "text",
    "expiration_date" "date",
    "qbo_env" "text",
    CONSTRAINT "job_revenue_documents_type_check" CHECK (("source_document_type" = ANY (ARRAY['invoice'::"text", 'estimate'::"text", 'sales_receipt'::"text", 'credit_memo'::"text", 'contract'::"text", 'change_order'::"text"])))
);


ALTER TABLE "public"."job_revenue_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_revenue_evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "job_id" "uuid",
    "bank_transaction_id" "uuid",
    "qbo_txn_id" "text",
    "qbo_txn_type" "text",
    "matched_payment_record_id" "uuid",
    "match_type" "text" DEFAULT 'unmatched_bank_inflow'::"text" NOT NULL,
    "match_confidence" numeric,
    "amount" numeric DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "realm_id" "text",
    "qbo_env" "text",
    CONSTRAINT "job_revenue_evidence_match_type_check" CHECK (("match_type" = ANY (ARRAY['unmatched_bank_inflow'::"text", 'invoice_evidence'::"text", 'payment_evidence'::"text", 'settlement_evidence'::"text", 'deposit_evidence'::"text", 'sales_receipt_evidence'::"text", 'credit_memo_evidence'::"text", 'non_job_transaction'::"text"])))
);


ALTER TABLE "public"."job_revenue_evidence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_transaction_assignment_role_backfill_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "reviewed_count" integer DEFAULT 0 NOT NULL,
    "updated_count" integer DEFAULT 0 NOT NULL,
    "needs_review_count" integer DEFAULT 0 NOT NULL,
    "skipped_count" integer DEFAULT 0 NOT NULL,
    "diagnostics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_message" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "job_assignment_role_backfill_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'succeeded'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."job_transaction_assignment_role_backfill_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_transaction_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "job_id" "uuid",
    "job_label" "text",
    "assignment_source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "prompt" "text",
    "confidence" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "qbo_txn_id" "text",
    "qbo_txn_type" "text",
    "final_qbo_account_id" "text",
    "final_qbo_account_name" "text",
    "allocated_amount" numeric NOT NULL,
    "allocation_percent" numeric DEFAULT 100 NOT NULL,
    "source" "text" DEFAULT 'manual_drag_drop'::"text" NOT NULL,
    "notes" "text",
    "financial_role" "text",
    "revenue_evidence_id" "uuid",
    "revenue_document_id" "uuid",
    "payment_record_id" "uuid",
    "assignment_resolution" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "job_transaction_assignments_financial_role_check" CHECK ((("financial_role" IS NULL) OR ("financial_role" = ANY (ARRAY['expense_cost'::"text", 'unmatched_revenue'::"text", 'invoice_evidence'::"text", 'payment_evidence'::"text", 'settlement_evidence'::"text", 'non_job_transaction'::"text", 'needs_financial_role_review'::"text", 'expense'::"text", 'qbo_payment'::"text", 'bank_deposit_evidence'::"text", 'sales_receipt'::"text", 'credit_memo'::"text", 'unmatched_inflow'::"text"]))))
);


ALTER TABLE "public"."job_transaction_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "client_name" "text",
    "job_name" "text",
    "start_date" "date",
    "end_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "address" "text",
    "city" "text",
    "state" "text",
    "postal_code" "text",
    "latitude" numeric,
    "longitude" numeric,
    "target_margin" numeric,
    "status" "text" DEFAULT 'active'::"text",
    "trade_type" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "customer_id" "uuid",
    "job_number" "text",
    "source_type" "text" DEFAULT 'manual'::"text",
    "creation_method" "text" DEFAULT 'manual'::"text",
    "job_costing_revenue_basis" "text",
    "contract_amount" numeric,
    "sync_status" "text" DEFAULT 'not_synced'::"text",
    "archived_at" timestamp with time zone,
    "source_of_truth" "text" DEFAULT 'manual_link_only'::"text" NOT NULL,
    CONSTRAINT "jobs_revenue_basis_check" CHECK ((("job_costing_revenue_basis" IS NULL) OR ("job_costing_revenue_basis" = ANY (ARRAY['invoiced'::"text", 'collected'::"text", 'contract_value'::"text", 'recognized'::"text"])))),
    CONSTRAINT "jobs_source_of_truth_check" CHECK (("source_of_truth" = ANY (ARRAY['qbo_project_authoritative'::"text", 'bizzi_authoritative'::"text", 'manual_link_only'::"text", 'external_system_authoritative'::"text"])))
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."jobs_profitability" AS
 SELECT "j"."business_id",
    "j"."id" AS "job_id",
    "j"."job_name",
    COALESCE("r"."revenue", (0)::numeric) AS "revenue",
    COALESCE("c"."cost_total", (0)::numeric) AS "cost_total",
    (COALESCE("r"."revenue", (0)::numeric) - COALESCE("c"."cost_total", (0)::numeric)) AS "profit",
        CASE
            WHEN (COALESCE("r"."revenue", (0)::numeric) > (0)::numeric) THEN "round"((((COALESCE("r"."revenue", (0)::numeric) - COALESCE("c"."cost_total", (0)::numeric)) / COALESCE("r"."revenue", (0)::numeric)) * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS "margin",
    ("date_trunc"('month'::"text", COALESCE("r"."first_rev_at", "c"."first_cost_at", "j"."created_at")))::"date" AS "month"
   FROM (("public"."jobs" "j"
     LEFT JOIN ( SELECT "client_revenue"."job_id",
            "sum"("client_revenue"."revenue") AS "revenue",
            "min"("client_revenue"."created_at") AS "first_rev_at"
           FROM "public"."client_revenue"
          GROUP BY "client_revenue"."job_id") "r" ON (("r"."job_id" = "j"."id")))
     LEFT JOIN ( SELECT "job_costs"."job_id",
            "sum"("job_costs"."amount") AS "cost_total",
            "min"("job_costs"."created_at") AS "first_cost_at"
           FROM "public"."job_costs"
          GROUP BY "job_costs"."job_id") "c" ON (("c"."job_id" = "j"."id")));


ALTER VIEW "public"."jobs_profitability" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kpi_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "business_id" "uuid" NOT NULL,
    "month" "text" NOT NULL,
    "labor_pct" numeric,
    "overhead_pct" numeric,
    "avg_job_size" numeric,
    "client_concentration_pct" numeric,
    "top_clients" integer,
    "jobs_completed" integer,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"())
);


ALTER TABLE "public"."kpi_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."linked_financial_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "item_id" "text" NOT NULL,
    "access_token_enc" "bytea" NOT NULL,
    "institution_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."linked_financial_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetings" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "business_id" "uuid",
    "title" "text",
    "date" "date",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"())
);


ALTER TABLE "public"."meetings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monthly_financial_pulse" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "month" "date" NOT NULL,
    "revenue_summary" "text",
    "spending_trend" "text",
    "variance_from_forecast" "text",
    "business_insights" "text"[],
    "motivational_message" "text",
    "embedding_text" "text",
    "embedding" "public"."vector"(1536),
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"())
);


ALTER TABLE "public"."monthly_financial_pulse" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monthly_forecast" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "business_id" "uuid",
    "month" "date" NOT NULL,
    "revenue" numeric,
    "direct_costs" numeric,
    "labor" numeric,
    "overhead" numeric,
    "marketing" numeric,
    "other_expenses" numeric,
    "net_profit" numeric,
    "source" "text" DEFAULT 'auto'::"text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "embedding_text" "text",
    "embedding" "public"."vector"(1536),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."monthly_forecast" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monthly_review_audit_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid",
    "business_id" "uuid",
    "review_month" "date",
    "actor_user_id" "uuid",
    "actor_email" "text",
    "event_type" "text" NOT NULL,
    "section_key" "text",
    "previous_value" "jsonb",
    "next_value" "jsonb",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."monthly_review_audit_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monthly_review_reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid",
    "business_id" "uuid",
    "review_month" "date" NOT NULL,
    "reminder_type" "text" DEFAULT 'manual'::"text" NOT NULL,
    "message" "text",
    "assigned_reviewer_email" "text",
    "due_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."monthly_review_reminders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monthly_review_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "review_month" "date" NOT NULL,
    "status" "text" DEFAULT 'in_progress'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "finalized_by" "uuid",
    "finalized_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "active_editor_user_id" "uuid",
    "active_editor_email" "text",
    "active_editor_started_at" timestamp with time zone,
    "active_editor_expires_at" timestamp with time zone,
    "assigned_reviewer_id" "uuid",
    "assigned_reviewer_email" "text",
    "assignment_notes" "text",
    "evidence_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "evidence_hash" "text",
    "readiness_score" numeric DEFAULT 0 NOT NULL,
    "last_reminder_at" timestamp with time zone,
    CONSTRAINT "monthly_review_runs_month_start" CHECK (("review_month" = ("date_trunc"('month'::"text", ("review_month")::timestamp with time zone))::"date")),
    CONSTRAINT "monthly_review_runs_status_check" CHECK (("status" = ANY (ARRAY['in_progress'::"text", 'ready_to_finalize'::"text", 'finalized'::"text", 'reopened'::"text"])))
);


ALTER TABLE "public"."monthly_review_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monthly_review_sections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "section_key" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "evidence_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "evidence_hash" "text",
    CONSTRAINT "monthly_review_sections_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'in_review'::"text", 'reviewed'::"text", 'blocked'::"text", 'not_applicable'::"text"])))
);


ALTER TABLE "public"."monthly_review_sections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "business_id" "uuid",
    "type" "text",
    "message" "text",
    "read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_connection_states" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "state_hash" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."oauth_connection_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plaid_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "plaid_item_id" "text" NOT NULL,
    "plaid_account_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "official_name" "text",
    "mask" "text",
    "type" "text",
    "subtype" "text",
    "iso_currency_code" "text",
    "unofficial_currency_code" "text",
    "current_balance" numeric,
    "available_balance" numeric,
    "limit_balance" numeric,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_sync_at" timestamp with time zone,
    "disconnected_at" timestamp with time zone
);


ALTER TABLE "public"."plaid_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plaid_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "plaid_item_id" "text" NOT NULL,
    "plaid_access_token" "text" NOT NULL,
    "institution_id" "text",
    "institution_name" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "cursor" "text",
    "last_sync_at" timestamp with time zone,
    "last_success_at" timestamp with time zone,
    "error_code" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb",
    "sync_in_progress" boolean DEFAULT false NOT NULL,
    "sync_started_at" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "disconnected_at" timestamp with time zone,
    CONSTRAINT "plaid_items_status_check" CHECK (("status" = ANY (ARRAY['connected'::"text", 'error'::"text", 'reauth_required'::"text", 'disconnected'::"text"])))
);


ALTER TABLE "public"."plaid_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plaid_qbo_account_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "plaid_account_id" "text" NOT NULL,
    "qbo_account_id" "text" NOT NULL,
    "qbo_account_name" "text" NOT NULL,
    "qbo_account_type" "text" NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "confidence" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "plaid_qbo_account_mappings_type_check" CHECK (("qbo_account_type" = ANY (ARRAY['Bank'::"text", 'CreditCard'::"text", 'Other'::"text"])))
);


ALTER TABLE "public"."plaid_qbo_account_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."positions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "security_id" "uuid" NOT NULL,
    "quantity" numeric DEFAULT 0 NOT NULL,
    "cost_basis_total" numeric,
    "cost_basis_method" "text",
    "average_price" numeric,
    "as_of_date" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."positions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prices_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "security_id" "uuid",
    "ticker" "text" NOT NULL,
    "price" numeric NOT NULL,
    "price_as_of" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."prices_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."securities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticker" "text",
    "name" "text",
    "cusip" "text",
    "asset_class" "text",
    "exchange" "text",
    "currency" "text" DEFAULT 'USD'::"text"
);


ALTER TABLE "public"."securities" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."positions_view" WITH ("security_invoker"='on') AS
 SELECT "p"."user_id",
    "ia"."name" AS "account_name",
    "s"."ticker",
    "s"."name" AS "security_name",
    "s"."asset_class",
    "s"."currency",
    "p"."quantity",
    COALESCE("p"."average_price", NULL::numeric) AS "average_price",
    "p"."cost_basis_total",
    "pc"."price",
    ("p"."quantity" * "pc"."price") AS "market_value",
    (("p"."quantity" * "pc"."price") - COALESCE("p"."cost_basis_total", (0)::numeric)) AS "unrealized_pl",
        CASE
            WHEN (COALESCE("p"."cost_basis_total", (0)::numeric) = (0)::numeric) THEN NULL::numeric
            ELSE (((("p"."quantity" * "pc"."price") - "p"."cost_basis_total") / "p"."cost_basis_total") * (100)::numeric)
        END AS "unrealized_pl_pct",
    "pc"."price_as_of"
   FROM ((("public"."positions" "p"
     JOIN "public"."securities" "s" ON (("s"."id" = "p"."security_id")))
     JOIN "public"."investment_accounts" "ia" ON (("ia"."id" = "p"."account_id")))
     LEFT JOIN "public"."prices_cache" "pc" ON (("pc"."security_id" = "s"."id")));


ALTER VIEW "public"."positions_view" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."post_gallery" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "caption" "text",
    "category" "text",
    "cta" "text",
    "image_idea" "text",
    "platform" "text",
    "status" "text" DEFAULT 'draft'::"text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "metrics_json" "jsonb",
    "scheduled_at" timestamp with time zone,
    CONSTRAINT "post_gallery_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'scheduled'::"text", 'published'::"text"])))
);


ALTER TABLE "public"."post_gallery" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "name" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prompt_usage" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "module" "text" NOT NULL,
    "prompt_text" "text" NOT NULL,
    "inserted_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "business_id" "uuid",
    "used_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."prompt_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_backfill_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "qbo_env" "text" DEFAULT 'production'::"text" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "anchor_year" integer,
    "anchor_month" integer,
    "months_total" integer DEFAULT 12 NOT NULL,
    "months_done" integer DEFAULT 0 NOT NULL,
    "last_month_processed" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_error" "text",
    "last_log" "text",
    "started_by" "uuid",
    "last_success_at" timestamp with time zone,
    "last_success_month" "text",
    CONSTRAINT "qbo_backfill_jobs_anchor_month_check" CHECK ((("anchor_month" IS NULL) OR (("anchor_month" >= 1) AND ("anchor_month" <= 12)))),
    CONSTRAINT "qbo_backfill_jobs_env_check" CHECK (("qbo_env" = ANY (ARRAY['sandbox'::"text", 'production'::"text"]))),
    CONSTRAINT "qbo_backfill_jobs_months_done_check" CHECK ((("months_done" >= 0) AND ("months_done" <= "months_total"))),
    CONSTRAINT "qbo_backfill_jobs_months_total_check" CHECK ((("months_total" >= 1) AND ("months_total" <= 36))),
    CONSTRAINT "qbo_backfill_jobs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'failed'::"text", 'canceled'::"text"])))
);


ALTER TABLE "public"."qbo_backfill_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_cdc_cursors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "realm_id" "text" NOT NULL,
    "qbo_env" "text" DEFAULT 'sandbox'::"text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "last_successful_changed_since" timestamp with time zone,
    "overlap_minutes" integer DEFAULT 10 NOT NULL,
    "last_run_id" "uuid",
    "entities_queried" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "items_processed" integer DEFAULT 0 NOT NULL,
    "failures" integer DEFAULT 0 NOT NULL,
    "retries" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_successful_cursor" timestamp with time zone,
    "last_requested_changed_since" timestamp with time zone,
    "overlap_duration_minutes" integer DEFAULT 10 NOT NULL,
    "last_attempted_at" timestamp with time zone,
    "last_completed_at" timestamp with time zone,
    "status" "text" DEFAULT 'idle'::"text" NOT NULL,
    "processed_count" integer DEFAULT 0 NOT NULL,
    "failure" "text",
    "retry_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "qbo_cdc_cursors_status_check" CHECK (("status" = ANY (ARRAY['idle'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."qbo_cdc_cursors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_coa_creations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "qbo_account_id" "text" NOT NULL,
    "qbo_account_name" "text" NOT NULL,
    "account_type" "text" NOT NULL,
    "created_by" "text" DEFAULT 'bizzi'::"text" NOT NULL,
    "source" "text" DEFAULT 'suggest'::"text" NOT NULL,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."qbo_coa_creations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "qbo_customer_id" "text" NOT NULL,
    "qbo_parent_customer_id" "text",
    "realm_id" "text",
    "sync_token" "text",
    "display_name" "text" NOT NULL,
    "company_name" "text",
    "email" "text",
    "phone" "text",
    "is_sub_customer" boolean DEFAULT false NOT NULL,
    "active" boolean,
    "balance" numeric,
    "billing_address" "jsonb",
    "shipping_address" "jsonb",
    "currency" "text",
    "source_updated_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone,
    "sync_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fully_qualified_name" "text",
    "balance_with_jobs" numeric,
    "sparse" boolean
);


ALTER TABLE "public"."qbo_customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_entity_sync_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "realm_id" "text" NOT NULL,
    "qbo_env" "text" DEFAULT 'sandbox'::"text" NOT NULL,
    "sync_type" "text" DEFAULT 'job_costing_entities'::"text" NOT NULL,
    "mode" "text" DEFAULT 'incremental'::"text" NOT NULL,
    "since" timestamp with time zone,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "entity_counts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "missing_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "orphan_allocations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "duplicate_external_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "reconciliation_failures" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "last_error" "text",
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "trigger_source" "text",
    "parent_run_id" "uuid",
    "latency_ms" integer,
    "fetched_count" integer DEFAULT 0 NOT NULL,
    "created_count" integer DEFAULT 0 NOT NULL,
    "updated_count" integer DEFAULT 0 NOT NULL,
    "unchanged_count" integer DEFAULT 0 NOT NULL,
    "deleted_count" integer DEFAULT 0 NOT NULL,
    "linked_count" integer DEFAULT 0 NOT NULL,
    "candidates_created_count" integer DEFAULT 0 NOT NULL,
    "errors_count" integer DEFAULT 0 NOT NULL,
    "retries_count" integer DEFAULT 0 NOT NULL,
    "cursor" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."qbo_entity_sync_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_job_costing_backfill_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "realm_id" "text",
    "qbo_env" "text" DEFAULT 'sandbox'::"text" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "start_date" "date",
    "end_date" "date",
    "mode" "text" DEFAULT 'initial_backfill'::"text" NOT NULL,
    "batch_size" integer DEFAULT 1000 NOT NULL,
    "current_entity" "text",
    "current_since" timestamp with time zone,
    "current_until" timestamp with time zone,
    "progress" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "counts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_message" "text",
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "date_range_start" "date",
    "date_range_end" "date",
    "current_start_position" integer DEFAULT 1 NOT NULL,
    "completed_entities" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "last_committed_page" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "fetched_count" integer DEFAULT 0 NOT NULL,
    "committed_count" integer DEFAULT 0 NOT NULL,
    "failed_record_count" integer DEFAULT 0 NOT NULL,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "retry_state" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "qbo_job_costing_backfill_runs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'paused'::"text"])))
);


ALTER TABLE "public"."qbo_job_costing_backfill_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_job_costing_daily_sync_state" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "realm_id" "text" NOT NULL,
    "qbo_env" "text" DEFAULT 'sandbox'::"text" NOT NULL,
    "last_daily_sync_at" timestamp with time zone,
    "last_status" "text",
    "last_run_id" "uuid",
    "next_run_after" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."qbo_job_costing_daily_sync_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_posted_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "qbo_env" "text" DEFAULT 'production'::"text" NOT NULL,
    "realm_id" "text",
    "qbo_txn_type" "text" NOT NULL,
    "qbo_txn_id" "text",
    "qbo_sync_token" "text",
    "status" "text" DEFAULT 'posted'::"text" NOT NULL,
    "posted_at" timestamp with time zone DEFAULT "now"(),
    "error" "text",
    "payload" "jsonb",
    "response" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "qbo_posted_transactions_env_check" CHECK (("qbo_env" = ANY (ARRAY['sandbox'::"text", 'production'::"text"]))),
    CONSTRAINT "qbo_posted_transactions_status_check" CHECK (("status" = ANY (ARRAY['posted'::"text", 'failed'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."qbo_posted_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "job_id" "uuid",
    "customer_id" "uuid",
    "realm_id" "text" NOT NULL,
    "qbo_env" "text" DEFAULT 'sandbox'::"text" NOT NULL,
    "qbo_project_id" "text" NOT NULL,
    "qbo_parent_customer_id" "text",
    "display_name" "text",
    "fully_qualified_name" "text",
    "project_name" "text",
    "status" "text",
    "active" boolean,
    "start_date" "date",
    "end_date" "date",
    "billing_address" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "shipping_address" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "sync_token" "text",
    "source_updated_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone,
    "sync_status" "text" DEFAULT 'synced'::"text" NOT NULL,
    "source_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."qbo_projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_projects_capabilities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "realm_id" "text" NOT NULL,
    "qbo_env" "text" DEFAULT 'sandbox'::"text" NOT NULL,
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "checked_at" timestamp with time zone,
    "accounting_scope_present" boolean DEFAULT false NOT NULL,
    "project_scope_present" boolean DEFAULT false NOT NULL,
    "projects_enabled_preference" boolean,
    "entitlement_response" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_response" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_successful_project_sync" timestamp with time zone,
    "source_of_truth" "text" DEFAULT 'manual_link_only'::"text" NOT NULL,
    "auto_import_enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "qbo_projects_capabilities_source_of_truth_check" CHECK (("source_of_truth" = ANY (ARRAY['qbo_project_authoritative'::"text", 'bizzi_authoritative'::"text", 'manual_link_only'::"text", 'external_system_authoritative'::"text"]))),
    CONSTRAINT "qbo_projects_capabilities_status_check" CHECK (("status" = ANY (ARRAY['available_and_enabled'::"text", 'available_but_projects_disabled'::"text", 'scope_not_authorized'::"text", 'partner_entitlement_missing'::"text", 'unsupported_qbo_plan'::"text", 'graphql_unavailable'::"text", 'unknown'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."qbo_projects_capabilities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_vendor_creations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "qbo_entity_type" "text" DEFAULT 'vendor'::"text" NOT NULL,
    "qbo_entity_id" "text" NOT NULL,
    "vendor_name" "text" NOT NULL,
    "created_by" "text" DEFAULT 'bizzi'::"text" NOT NULL,
    "source" "text" DEFAULT 'posting'::"text" NOT NULL,
    "source_transaction_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "qbo_vendor_creations_entity_type_check" CHECK (("qbo_entity_type" = ANY (ARRAY['vendor'::"text", 'customer'::"text"])))
);


ALTER TABLE "public"."qbo_vendor_creations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_webhook_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "realm_id" "text" NOT NULL,
    "qbo_env" "text" DEFAULT 'sandbox'::"text" NOT NULL,
    "event_hash" "text" NOT NULL,
    "intuit_tid" "text",
    "event_timestamp" timestamp with time zone,
    "event_received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "operation" "text" NOT NULL,
    "last_updated_at" timestamp with time zone,
    "processing_status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "next_attempt_at" timestamp with time zone,
    "processed_at" timestamp with time zone,
    "superseded_by_event_id" "uuid",
    "out_of_order" boolean DEFAULT false NOT NULL,
    "error_message" "text",
    "sync_result" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "raw_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "qbo_webhook_events_operation_check" CHECK (("operation" = ANY (ARRAY['create'::"text", 'update'::"text", 'delete'::"text", 'void'::"text", 'merge'::"text", 'unknown'::"text"]))),
    CONSTRAINT "qbo_webhook_events_status_check" CHECK (("processing_status" = ANY (ARRAY['queued'::"text", 'processing'::"text", 'succeeded'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."qbo_webhook_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quickbooks_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "realm_id" "text" NOT NULL,
    "token_type" "text" DEFAULT 'Bearer'::"text",
    "expires_in" integer,
    "x_refresh_token_expires_in" integer,
    "scope" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "company_name" "text",
    "access_token_expires_at" timestamp with time zone,
    "refresh_token_expires_at" timestamp with time zone,
    "connected_company_name" "text",
    "connected_legal_name" "text",
    "connected_at" timestamp with time zone,
    "qbo_env" "text" DEFAULT 'production'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "disconnected_at" timestamp with time zone,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_connected_at" timestamp with time zone,
    "company_id" "text",
    "display_name" "text",
    CONSTRAINT "quickbooks_tokens_qbo_env_check" CHECK (("qbo_env" = ANY (ARRAY['sandbox'::"text", 'production'::"text"])))
);


ALTER TABLE "public"."quickbooks_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reconciliation_health" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "plaid_account_id" "text" NOT NULL,
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "bank_balance" numeric,
    "book_balance" numeric,
    "diff_amount" numeric,
    "last_checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reconciliation_health_status_check" CHECK (("status" = ANY (ARRAY['ok'::"text", 'investigating'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."reconciliation_health" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reconciliation_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "plaid_account_id" "text" NOT NULL,
    "bank_transaction_id" "uuid",
    "qbo_txn_id" "text",
    "qbo_txn_type" "text",
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "txn_date" "date",
    "merchant" "text",
    "description" "text",
    "amount" numeric,
    "direction" "text" DEFAULT 'unknown'::"text",
    "category_name" "text",
    "posted_at" timestamp with time zone,
    "reconciled_at" timestamp with time zone,
    "note" "text",
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reconciliation_items_direction_check" CHECK (("direction" = ANY (ARRAY['inflow'::"text", 'outflow'::"text", 'unknown'::"text"]))),
    CONSTRAINT "reconciliation_items_status_check" CHECK (("status" = ANY (ARRAY['matched'::"text", 'needs_review'::"text", 'approved_waiting_post'::"text", 'pending'::"text", 'failed_post'::"text", 'missing_in_qbo'::"text", 'duplicate_in_qbo'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."reconciliation_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reconciliation_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "scope" "text" DEFAULT 'last_30_days'::"text" NOT NULL,
    "period_start" "date",
    "period_end" "date",
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "overall_note" "text",
    "total_seen" integer,
    "matched_count" integer,
    "needs_review_count" integer,
    "approved_waiting_post_count" integer,
    "pending_count" integer,
    "failed_post_count" integer,
    "missing_in_qbo_count" integer,
    "duplicate_in_qbo_count" integer,
    "last_checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reconciliation_runs_status_check" CHECK (("status" = ANY (ARRAY['ok'::"text", 'investigating'::"text", 'partial'::"text", 'failed'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."reconciliation_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."report_metadata" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "year" integer NOT NULL,
    "month" integer NOT NULL,
    "revenue" numeric,
    "net_profit" numeric,
    "includes_forecast" boolean DEFAULT false,
    "storage_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "generated_at" timestamp with time zone,
    "qbo_report_hash" "text",
    "source_start_date" "text",
    "source_end_date" "text",
    "accounting_method" "text",
    "monthly_review_published_at" timestamp with time zone,
    "monthly_review_published_by" "uuid",
    "monthly_review_run_id" "uuid",
    "monthly_review_source" "text" DEFAULT 'system'::"text" NOT NULL
);


ALTER TABLE "public"."report_metadata" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."review_sources" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "external_id" "text",
    "connected" boolean DEFAULT false,
    "connected_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "review_sources_provider_check" CHECK (("provider" = ANY (ARRAY['google'::"text", 'facebook'::"text", 'yelp'::"text"])))
);


ALTER TABLE "public"."review_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scenarios" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "scenario_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scenarios" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scheduled_job_locks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_key" "text" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "locked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "locked_by" "text",
    "completed_at" timestamp with time zone,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "scheduled_job_locks_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'skipped'::"text", 'failed'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."scheduled_job_locks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."state_tax_rule_configs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tax_year" integer NOT NULL,
    "state_code" "text" NOT NULL,
    "rule_type" "text" NOT NULL,
    "entity_type" "text",
    "filing_status" "text",
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "version" "text" DEFAULT 'v1'::"text" NOT NULL,
    "support_level" "text" DEFAULT 'unverified'::"text" NOT NULL,
    "source_name" "text",
    "source_url" "text",
    "verified_at" timestamp with time zone,
    "effective_from" "date",
    "effective_to" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "state_tax_rule_configs_dates_check" CHECK ((("effective_to" IS NULL) OR ("effective_from" IS NULL) OR ("effective_to" >= "effective_from"))),
    CONSTRAINT "state_tax_rule_configs_state_code_check" CHECK (("char_length"("state_code") = 2)),
    CONSTRAINT "state_tax_rule_configs_support_level_check" CHECK (("support_level" = ANY (ARRAY['verified'::"text", 'supported'::"text", 'simplified'::"text", 'legacy_estimate'::"text", 'unverified'::"text", 'unsupported'::"text"]))),
    CONSTRAINT "state_tax_rule_configs_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."state_tax_rule_configs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "stripe_customer_id" "text",
    "stripe_subscription_id" "text",
    "status" "text",
    "current_period_end" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "business_name" "text",
    "customer_email" "text",
    "customer_full_name" "text",
    "plan_type" "text",
    "plan_price_id" "text",
    "cancel_at_period_end" boolean,
    "trial_end" timestamp with time zone,
    "last_invoice_status" "text"
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_adjustments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_year" integer NOT NULL,
    "adjustment_type" "text" NOT NULL,
    "category" "text",
    "description" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "direction" "text" NOT NULL,
    "source" "text" DEFAULT 'system'::"text" NOT NULL,
    "source_transaction_id" "uuid",
    "calculation_run_id" "uuid",
    "is_recurring" boolean DEFAULT false NOT NULL,
    "effective_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "user_confirmed" boolean DEFAULT false NOT NULL,
    "confirmed_by" "uuid",
    "confirmed_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_adjustments_direction_check" CHECK (("direction" = ANY (ARRAY['increase_taxable_income'::"text", 'decrease_taxable_income'::"text", 'increase_tax'::"text", 'decrease_tax'::"text"]))),
    CONSTRAINT "tax_adjustments_source_check" CHECK (("source" = ANY (ARRAY['system'::"text", 'rule_engine'::"text", 'user'::"text", 'cpa'::"text", 'imported'::"text"]))),
    CONSTRAINT "tax_adjustments_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_adjustments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_calculation_components" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "component_key" "text" NOT NULL,
    "component_type" "text" NOT NULL,
    "component_name" "text" NOT NULL,
    "taxable_base" numeric,
    "rate" numeric,
    "amount" numeric DEFAULT 0 NOT NULL,
    "direction" "text" DEFAULT 'informational'::"text" NOT NULL,
    "explanation" "text",
    "source_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "sort_order" integer DEFAULT 100 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_calc_components_direction_check" CHECK (("direction" = ANY (ARRAY['increase_taxable_income'::"text", 'decrease_taxable_income'::"text", 'increase_tax'::"text", 'decrease_tax'::"text", 'payment_credit'::"text", 'reserve_adjustment'::"text", 'informational'::"text"])))
);


ALTER TABLE "public"."tax_calculation_components" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_calculation_nodes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_year" integer NOT NULL,
    "node_code" "text" NOT NULL,
    "node_type" "text" NOT NULL,
    "section_code" "text" NOT NULL,
    "parent_node_code" "text",
    "parent_node_id" "uuid",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "label" "text" NOT NULL,
    "description" "text",
    "amount" numeric,
    "unit" "text" DEFAULT 'money'::"text",
    "display_sign" "text",
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "status" "text" DEFAULT 'calculated'::"text" NOT NULL,
    "actual_or_projected" "text",
    "support_level" "text",
    "confidence" numeric,
    "formula_code" "text",
    "formula_operator" "text",
    "formula_expression" "text",
    "formula_description" "text",
    "input_values" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "child_node_codes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "child_node_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "source_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "rule_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "assumption_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "drilldown_type" "text",
    "drilldown_params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "reconciliation_expected_amount" numeric,
    "reconciliation_actual_amount" numeric,
    "reconciliation_difference" numeric,
    "reconciliation_status" "text",
    "calculation_engine" "text",
    "calculation_engine_path" "text",
    "calculation_version" "text",
    "traceability_status" "text" DEFAULT 'incomplete_lineage'::"text" NOT NULL,
    "traceability_reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "reproducibility_status" "text" DEFAULT 'incomplete_lineage'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tax_calculation_nodes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_calculation_run_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "older_run_id" "uuid" NOT NULL,
    "newer_run_id" "uuid" NOT NULL,
    "relation_type" "text" DEFAULT 'supersedes'::"text" NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tax_calculation_run_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_calculation_workpaper_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_year" integer NOT NULL,
    "code" "text" NOT NULL,
    "label" "text" NOT NULL,
    "section" "text" NOT NULL,
    "parent_code" "text",
    "parent_id" "uuid",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "amount" numeric,
    "quantity" numeric,
    "percentage" numeric,
    "display_sign" "text",
    "status" "text" DEFAULT 'calculated'::"text" NOT NULL,
    "support_level" "text",
    "confidence" numeric,
    "formula_code" "text",
    "formula_description" "text",
    "rule_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "rule_versions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "explanation" "text",
    "source_type" "text",
    "source_refs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_projection" boolean DEFAULT false NOT NULL,
    "is_actual" boolean DEFAULT false NOT NULL,
    "materiality" "text",
    "drill_down_type" "text",
    "drill_down_params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tax_calculation_workpaper_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_classification_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "classification_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "tax_year" integer NOT NULL,
    "previous_values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "new_values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "override_source" "text" NOT NULL,
    "override_reason" "text",
    "overridden_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_classification_overrides_source_check" CHECK (("override_source" = ANY (ARRAY['user'::"text", 'cpa'::"text", 'admin'::"text", 'system_correction'::"text"]))),
    CONSTRAINT "tax_classification_overrides_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_classification_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_deadlines" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "business_id" "uuid",
    "label" "text",
    "due_date" "date",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "tax_year" integer,
    "jurisdiction" "text",
    "state_code" "text",
    "deadline_type" "text",
    "quarter" integer,
    "status" "text" DEFAULT 'upcoming'::"text" NOT NULL,
    "amount_due" numeric,
    "source" "text" DEFAULT 'system'::"text" NOT NULL,
    "rule_config_id" "uuid",
    "completed_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "tax_deadlines_jurisdiction_check" CHECK ((("jurisdiction" IS NULL) OR ("jurisdiction" = ANY (ARRAY['federal'::"text", 'state'::"text", 'local'::"text"])))),
    CONSTRAINT "tax_deadlines_quarter_check" CHECK ((("quarter" IS NULL) OR (("quarter" >= 1) AND ("quarter" <= 4)))),
    CONSTRAINT "tax_deadlines_status_check" CHECK (("status" = ANY (ARRAY['upcoming'::"text", 'due_soon'::"text", 'overdue'::"text", 'completed'::"text", 'dismissed'::"text"]))),
    CONSTRAINT "tax_deadlines_tax_year_check" CHECK ((("tax_year" IS NULL) OR (("tax_year" >= 2000) AND ("tax_year" <= 2100))))
);


ALTER TABLE "public"."tax_deadlines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_deduction_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid",
    "scope" "text" DEFAULT 'global'::"text" NOT NULL,
    "rule_code" "text" NOT NULL,
    "tax_year" integer NOT NULL,
    "jurisdiction" "text" DEFAULT 'federal'::"text" NOT NULL,
    "entity_type" "text",
    "bookkeeping_category" "text",
    "qbo_account_type" "text",
    "qbo_account_subtype" "text",
    "match_conditions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "tax_category" "text" NOT NULL,
    "deductibility_status" "text" NOT NULL,
    "default_deductible_percent" numeric DEFAULT 0 NOT NULL,
    "treatment" "jsonb" NOT NULL,
    "requires_review" boolean DEFAULT false NOT NULL,
    "priority" integer DEFAULT 100 NOT NULL,
    "explanation" "text" NOT NULL,
    "source_reference" "text",
    "source_url" "text",
    "verified_at" timestamp with time zone,
    "effective_from" "date",
    "effective_to" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "version" "text" DEFAULT 'v1'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_deduction_rules_dates_check" CHECK ((("effective_to" IS NULL) OR ("effective_from" IS NULL) OR ("effective_to" >= "effective_from"))),
    CONSTRAINT "tax_deduction_rules_deductibility_check" CHECK (("deductibility_status" = ANY (ARRAY['fully_deductible'::"text", 'partially_deductible'::"text", 'nondeductible'::"text", 'capitalizable'::"text", 'balance_sheet'::"text", 'needs_review'::"text"]))),
    CONSTRAINT "tax_deduction_rules_percent_check" CHECK ((("default_deductible_percent" >= (0)::numeric) AND ("default_deductible_percent" <= (100)::numeric))),
    CONSTRAINT "tax_deduction_rules_scope_check" CHECK (("scope" = ANY (ARRAY['global'::"text", 'business_override'::"text"]))),
    CONSTRAINT "tax_deduction_rules_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_deduction_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "year" integer NOT NULL,
    "quarter" integer,
    "payment_date" "date" NOT NULL,
    "amount" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tax_year" integer,
    "jurisdiction" "text",
    "state_code" "text",
    "payment_type" "text",
    "agency" "text",
    "confirmation_number" "text",
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "external_id" "text",
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_payments_jurisdiction_check" CHECK ((("jurisdiction" IS NULL) OR ("jurisdiction" = ANY (ARRAY['federal'::"text", 'state'::"text", 'local'::"text"])))),
    CONSTRAINT "tax_payments_payment_type_check" CHECK ((("payment_type" IS NULL) OR ("payment_type" = ANY (ARRAY['estimated_payment'::"text", 'withholding'::"text", 'extension_payment'::"text", 'balance_due'::"text", 'refund_applied'::"text", 'prior_year_credit'::"text", 'other'::"text"])))),
    CONSTRAINT "tax_payments_quarter_check" CHECK ((("quarter" >= 1) AND ("quarter" <= 4))),
    CONSTRAINT "tax_payments_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'qbo'::"text", 'bank_match'::"text", 'payroll'::"text", 'imported'::"text", 'system'::"text"]))),
    CONSTRAINT "tax_payments_tax_year_check" CHECK ((("tax_year" IS NULL) OR (("tax_year" >= 2000) AND ("tax_year" <= 2100))))
);


ALTER TABLE "public"."tax_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_profile_memory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "memory_key" "text" NOT NULL,
    "value_json" "jsonb" NOT NULL,
    "effective_from" "date" DEFAULT CURRENT_DATE NOT NULL,
    "effective_to" "date",
    "source" "text" DEFAULT 'user'::"text" NOT NULL,
    "confidence_score" numeric,
    "confirmed_by" "uuid",
    "confirmed_at" timestamp with time zone,
    "last_reviewed_at" timestamp with time zone,
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_profile_memory_confidence_check" CHECK ((("confidence_score" IS NULL) OR (("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (100)::numeric)))),
    CONSTRAINT "tax_profile_memory_dates_check" CHECK ((("effective_to" IS NULL) OR ("effective_to" >= "effective_from"))),
    CONSTRAINT "tax_profile_memory_source_check" CHECK (("source" = ANY (ARRAY['user'::"text", 'cpa'::"text", 'imported'::"text", 'inferred'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."tax_profile_memory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_year" integer NOT NULL,
    "entity_type" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "tax_election" "text",
    "filing_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "primary_tax_state" "text",
    "accounting_method" "text" DEFAULT 'cash'::"text" NOT NULL,
    "qbi_eligible" boolean,
    "self_employment_tax_applies" boolean,
    "safe_harbor_method" "text" DEFAULT 'current_year_90'::"text" NOT NULL,
    "prior_year_total_tax" numeric,
    "prior_year_agi" numeric,
    "owner_reasonable_salary" numeric,
    "owner_w2_wages_ytd" numeric,
    "federal_withholding_ytd" numeric DEFAULT 0 NOT NULL,
    "state_withholding_ytd" numeric DEFAULT 0 NOT NULL,
    "health_insurance_deduction_ytd" numeric DEFAULT 0 NOT NULL,
    "retirement_contributions_ytd" numeric DEFAULT 0 NOT NULL,
    "hsa_contributions_ytd" numeric DEFAULT 0 NOT NULL,
    "reserve_buffer_percent" numeric DEFAULT 5 NOT NULL,
    "profile_status" "text" DEFAULT 'incomplete'::"text" NOT NULL,
    "confidence_score" numeric,
    "source" "text" DEFAULT 'user'::"text" NOT NULL,
    "last_reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_profiles_accounting_method_check" CHECK (("accounting_method" = ANY (ARRAY['cash'::"text", 'accrual'::"text", 'other'::"text"]))),
    CONSTRAINT "tax_profiles_confidence_check" CHECK ((("confidence_score" IS NULL) OR (("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (100)::numeric)))),
    CONSTRAINT "tax_profiles_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['sole_proprietor'::"text", 'single_member_llc'::"text", 's_corp'::"text", 'unknown'::"text"]))),
    CONSTRAINT "tax_profiles_filing_status_check" CHECK (("filing_status" = ANY (ARRAY['single'::"text", 'married_filing_jointly'::"text", 'married_filing_separately'::"text", 'head_of_household'::"text", 'qualifying_surviving_spouse'::"text", 'unknown'::"text"]))),
    CONSTRAINT "tax_profiles_nonnegative_amounts_check" CHECK (((COALESCE("prior_year_total_tax", (0)::numeric) >= (0)::numeric) AND (COALESCE("prior_year_agi", (0)::numeric) >= (0)::numeric) AND (COALESCE("owner_reasonable_salary", (0)::numeric) >= (0)::numeric) AND (COALESCE("owner_w2_wages_ytd", (0)::numeric) >= (0)::numeric) AND ("federal_withholding_ytd" >= (0)::numeric) AND ("state_withholding_ytd" >= (0)::numeric) AND ("health_insurance_deduction_ytd" >= (0)::numeric) AND ("retirement_contributions_ytd" >= (0)::numeric) AND ("hsa_contributions_ytd" >= (0)::numeric))),
    CONSTRAINT "tax_profiles_profile_status_check" CHECK (("profile_status" = ANY (ARRAY['incomplete'::"text", 'active'::"text", 'needs_review'::"text", 'archived'::"text"]))),
    CONSTRAINT "tax_profiles_reserve_buffer_check" CHECK ((("reserve_buffer_percent" >= (0)::numeric) AND ("reserve_buffer_percent" <= (100)::numeric))),
    CONSTRAINT "tax_profiles_safe_harbor_method_check" CHECK (("safe_harbor_method" = ANY (ARRAY['current_year_90'::"text", 'prior_year_100'::"text", 'prior_year_110'::"text", 'custom'::"text", 'unknown'::"text"]))),
    CONSTRAINT "tax_profiles_source_check" CHECK (("source" = ANY (ARRAY['user'::"text", 'cpa'::"text", 'imported'::"text", 'inferred'::"text", 'system'::"text"]))),
    CONSTRAINT "tax_profiles_tax_election_check" CHECK ((("tax_election" IS NULL) OR ("tax_election" = ANY (ARRAY['sole_proprietor'::"text", 'disregarded_entity'::"text", 's_corp'::"text", 'unknown'::"text"])))),
    CONSTRAINT "tax_profiles_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_projection_scenarios" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_profile_id" "uuid",
    "latest_calculation_run_id" "uuid",
    "tax_year" integer NOT NULL,
    "as_of_date" "date" NOT NULL,
    "scenario_type" "text" DEFAULT 'base'::"text" NOT NULL,
    "scenario_name" "text" NOT NULL,
    "projected_revenue" numeric DEFAULT 0 NOT NULL,
    "projected_expenses" numeric DEFAULT 0 NOT NULL,
    "projected_book_profit" numeric DEFAULT 0 NOT NULL,
    "projected_taxable_income" numeric DEFAULT 0 NOT NULL,
    "projected_tax" numeric DEFAULT 0 NOT NULL,
    "assumptions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "confidence_score" numeric,
    "source" "text" DEFAULT 'system'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_projection_scenarios_confidence_check" CHECK ((("confidence_score" IS NULL) OR (("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (100)::numeric)))),
    CONSTRAINT "tax_projection_scenarios_source_check" CHECK (("source" = ANY (ARRAY['system'::"text", 'forecast'::"text", 'user'::"text", 'cpa'::"text", 'imported'::"text"]))),
    CONSTRAINT "tax_projection_scenarios_type_check" CHECK (("scenario_type" = ANY (ARRAY['base'::"text", 'conservative'::"text", 'optimistic'::"text", 'user_override'::"text"]))),
    CONSTRAINT "tax_projection_scenarios_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_projection_scenarios" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_reserve_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "plaid_account_id" "text",
    "qbo_account_id" "text",
    "name" "text" NOT NULL,
    "tracking_method" "text" DEFAULT 'manual'::"text" NOT NULL,
    "manual_balance" numeric,
    "current_balance" numeric,
    "is_primary" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_verified_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_reserve_accounts_nonnegative_balance_check" CHECK (((COALESCE("manual_balance", (0)::numeric) >= (0)::numeric) AND (COALESCE("current_balance", (0)::numeric) >= (0)::numeric))),
    CONSTRAINT "tax_reserve_accounts_tracking_method_check" CHECK (("tracking_method" = ANY (ARRAY['plaid'::"text", 'qbo'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."tax_reserve_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_reserve_policy_configs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "policy_code" "text" NOT NULL,
    "tax_year" integer NOT NULL,
    "jurisdiction" "text" DEFAULT 'general'::"text" NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "support_level" "text" DEFAULT 'simplified'::"text" NOT NULL,
    "source_name" "text",
    "source_url" "text",
    "verified_at" timestamp with time zone,
    "effective_from" "date",
    "effective_to" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "version" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tax_reserve_policy_configs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_reserve_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "calculation_run_id" "uuid",
    "reserve_account_id" "uuid",
    "tax_year" integer NOT NULL,
    "as_of_date" "date" NOT NULL,
    "projected_liability" numeric DEFAULT 0 NOT NULL,
    "payments_made" numeric DEFAULT 0 NOT NULL,
    "current_reserve" numeric DEFAULT 0 NOT NULL,
    "reserve_buffer_percent" numeric DEFAULT 0 NOT NULL,
    "reserve_buffer_amount" numeric DEFAULT 0 NOT NULL,
    "recommended_reserve" numeric DEFAULT 0 NOT NULL,
    "reserve_gap" numeric DEFAULT 0 NOT NULL,
    "immediate_transfer_recommended" numeric DEFAULT 0 NOT NULL,
    "weekly_set_aside" numeric DEFAULT 0 NOT NULL,
    "monthly_set_aside" numeric DEFAULT 0 NOT NULL,
    "next_payment_amount" numeric DEFAULT 0 NOT NULL,
    "next_payment_date" "date",
    "status" "text" DEFAULT 'setup_incomplete'::"text" NOT NULL,
    "assumptions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_reserve_snapshots_buffer_percent_check" CHECK ((("reserve_buffer_percent" >= (0)::numeric) AND ("reserve_buffer_percent" <= (100)::numeric))),
    CONSTRAINT "tax_reserve_snapshots_status_check" CHECK (("status" = ANY (ARRAY['on_track'::"text", 'slightly_behind'::"text", 'reserve_gap'::"text", 'critical_shortfall'::"text", 'setup_incomplete'::"text"]))),
    CONSTRAINT "tax_reserve_snapshots_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_reserve_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_review_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "tax_year" integer NOT NULL,
    "task_type" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "text",
    "title" "text" NOT NULL,
    "description" "text",
    "severity" "text" DEFAULT 'medium'::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "due_date" "date",
    "dedupe_key" "text",
    "assigned_to" "uuid",
    "resolution" "text",
    "resolution_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_review_tasks_severity_check" CHECK (("severity" = ANY (ARRAY['critical'::"text", 'high'::"text", 'medium'::"text", 'low'::"text"]))),
    CONSTRAINT "tax_review_tasks_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'resolved'::"text", 'dismissed'::"text", 'expired'::"text"]))),
    CONSTRAINT "tax_review_tasks_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_review_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_rule_configs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tax_year" integer NOT NULL,
    "jurisdiction" "text" DEFAULT 'federal'::"text" NOT NULL,
    "rule_type" "text" NOT NULL,
    "filing_status" "text",
    "entity_type" "text",
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "version" "text" DEFAULT 'v1'::"text" NOT NULL,
    "support_level" "text" DEFAULT 'unverified'::"text" NOT NULL,
    "source_name" "text",
    "source_url" "text",
    "verified_at" timestamp with time zone,
    "effective_from" "date",
    "effective_to" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_rule_configs_dates_check" CHECK ((("effective_to" IS NULL) OR ("effective_from" IS NULL) OR ("effective_to" >= "effective_from"))),
    CONSTRAINT "tax_rule_configs_jurisdiction_check" CHECK (("jurisdiction" = ANY (ARRAY['federal'::"text", 'general'::"text"]))),
    CONSTRAINT "tax_rule_configs_support_level_check" CHECK (("support_level" = ANY (ARRAY['verified'::"text", 'supported'::"text", 'simplified'::"text", 'legacy_estimate'::"text", 'unverified'::"text", 'unsupported'::"text"]))),
    CONSTRAINT "tax_rule_configs_year_check" CHECK ((("tax_year" >= 2000) AND ("tax_year" <= 2100)))
);


ALTER TABLE "public"."tax_rule_configs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_scheduler_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_type" "text" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "worker_id" "text",
    "businesses_scanned" integer DEFAULT 0 NOT NULL,
    "businesses_eligible" integer DEFAULT 0 NOT NULL,
    "requests_queued" integer DEFAULT 0 NOT NULL,
    "businesses_skipped" integer DEFAULT 0 NOT NULL,
    "runs_reused" integer DEFAULT 0 NOT NULL,
    "failures" integer DEFAULT 0 NOT NULL,
    "warnings" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_scheduler_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'skipped'::"text", 'failed'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."tax_scheduler_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tax_snapshots" (
    "id" bigint NOT NULL,
    "business_id" "uuid" NOT NULL,
    "month" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tax_year" integer,
    "as_of_date" "date",
    "snapshot_type" "text" DEFAULT 'monthly_summary'::"text" NOT NULL,
    "calculation_run_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tax_snapshots" OWNER TO "postgres";


ALTER TABLE "public"."tax_snapshots" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."tax_snapshots_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."tax_state_rates" (
    "state" "text" NOT NULL,
    "kind" "text" DEFAULT 'flat'::"text" NOT NULL,
    "rate" numeric,
    "brackets" "jsonb"
);


ALTER TABLE "public"."tax_state_rates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."transaction_categorizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'needs_review'::"text" NOT NULL,
    "suggested_qbo_account_id" "text",
    "suggested_qbo_account_name" "text",
    "confidence" "text",
    "reason" "text",
    "final_qbo_account_id" "text",
    "final_qbo_account_name" "text",
    "decided_by" "text" DEFAULT 'bizzi'::"text" NOT NULL,
    "decided_at" timestamp with time zone,
    "model" "text",
    "prompt_version" "text",
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "post_after" timestamp with time zone,
    "qbo_txn_id" "text",
    "qbo_txn_type" "text",
    "posted_at" timestamp with time zone,
    "last_post_attempt_at" timestamp with time zone,
    "post_error" "text",
    "reconciled_at" timestamp with time zone,
    "txn_date" "date",
    "txn_name" "text",
    "signed_amount" numeric,
    "is_archived" boolean DEFAULT false NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "transaction_categorizations_conf_check" CHECK ((("confidence" IS NULL) OR ("confidence" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"])))),
    CONSTRAINT "transaction_categorizations_status_check" CHECK (("status" = ANY (ARRAY['needs_review'::"text", 'auto_approved'::"text", 'approved'::"text", 'ignored'::"text", 'posted'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."transaction_categorizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_business_link" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "business_id" "uuid",
    "role" "text" DEFAULT 'owner'::"text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"())
);


ALTER TABLE "public"."user_business_link" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'owner'::"text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "first_name" "text",
    "last_name" "text",
    "full_name" "text",
    "billing_business_id" "uuid",
    "billing_business_name" "text",
    "billing_stripe_customer_id" "text",
    "billing_stripe_subscription_id" "text",
    "billing_subscription_status" "text",
    "billing_plan_type" "text",
    "billing_current_period_end" timestamp with time zone,
    "billing_updated_at" timestamp with time zone
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "vendor_name" "text" NOT NULL,
    "normalized_vendor_name" "text" NOT NULL,
    "address" "text",
    "city" "text",
    "state" "text",
    "postal_code" "text",
    "latitude" numeric,
    "longitude" numeric,
    "source" "text" DEFAULT 'manual'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."vendor_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "match_type" "text" NOT NULL,
    "match_value" "text" NOT NULL,
    "counterparty_name" "text" NOT NULL,
    "counterparty_confidence" "text" DEFAULT 'medium'::"text" NOT NULL,
    "qbo_entity_type" "text",
    "qbo_entity_id" "text",
    "source" "text" DEFAULT 'bizzi'::"text" NOT NULL,
    "usage_count" integer DEFAULT 0 NOT NULL,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "default_qbo_account_id" "text",
    "default_qbo_account_name" "text",
    "direction_hint" "text",
    "confidence" "text",
    "notes" "text",
    "rule_kind" "text" DEFAULT 'identity'::"text" NOT NULL,
    CONSTRAINT "vendor_rules_confidence_check" CHECK ((("confidence" IS NULL) OR ("confidence" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"])))),
    CONSTRAINT "vendor_rules_counterparty_confidence_check" CHECK (("counterparty_confidence" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"]))),
    CONSTRAINT "vendor_rules_direction_hint_check" CHECK ((("direction_hint" IS NULL) OR ("direction_hint" = ANY (ARRAY['INFLOW'::"text", 'OUTFLOW'::"text", 'UNKNOWN'::"text"])))),
    CONSTRAINT "vendor_rules_match_type_check" CHECK (("match_type" = ANY (ARRAY['merchant_entity_id'::"text", 'memo_prefix'::"text", 'regex'::"text"]))),
    CONSTRAINT "vendor_rules_qbo_entity_type_check" CHECK ((("qbo_entity_type" IS NULL) OR ("qbo_entity_type" = ANY (ARRAY['vendor'::"text", 'customer'::"text"])))),
    CONSTRAINT "vendor_rules_rule_kind_check" CHECK (("rule_kind" = ANY (ARRAY['identity'::"text", 'category_default'::"text"])))
);


ALTER TABLE "public"."vendor_rules" OWNER TO "postgres";


ALTER TABLE ONLY "public"."account_breakdown"
    ADD CONSTRAINT "account_breakdown_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."affordability_assessments"
    ADD CONSTRAINT "affordability_assessments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ar_followups"
    ADD CONSTRAINT "ar_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ar_open_items"
    ADD CONSTRAINT "ar_open_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assignment_history"
    ADD CONSTRAINT "assignment_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."balance_sheet_history"
    ADD CONSTRAINT "balance_sheet_history_business_id_month_key" UNIQUE ("business_id", "month");



ALTER TABLE ONLY "public"."balance_sheet_history"
    ADD CONSTRAINT "balance_sheet_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_sync_runs"
    ADD CONSTRAINT "bank_sync_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_estimate_line_items"
    ADD CONSTRAINT "bid_estimate_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_estimates"
    ADD CONSTRAINT "bid_estimates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bid_outcomes"
    ADD CONSTRAINT "bid_outcomes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_customers"
    ADD CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."bizzy_deadlines"
    ADD CONSTRAINT "bizzy_deadlines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bizzy_docs"
    ADD CONSTRAINT "bizzy_docs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bizzy_headlines"
    ADD CONSTRAINT "bizzy_headlines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bizzy_memory"
    ADD CONSTRAINT "bizzy_memory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bizzy_timeline"
    ADD CONSTRAINT "bizzy_timeline_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."bookkeeping_health"
    ADD CONSTRAINT "bookkeeping_health_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookkeeping_post_attempts"
    ADD CONSTRAINT "bookkeeping_post_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_billing"
    ADD CONSTRAINT "business_billing_pkey" PRIMARY KEY ("business_id");



ALTER TABLE ONLY "public"."business_profiles"
    ADD CONSTRAINT "business_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cashflow_forecast"
    ADD CONSTRAINT "cashflow_forecast_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."categorization_rules"
    ADD CONSTRAINT "categorization_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clarification_learning_events"
    ADD CONSTRAINT "clarification_learning_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clarification_requests"
    ADD CONSTRAINT "clarification_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_revenue"
    ADD CONSTRAINT "client_revenue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contractor_cfo_insight_runs"
    ADD CONSTRAINT "contractor_cfo_insight_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contractor_cfo_insight_runs"
    ADD CONSTRAINT "contractor_cfo_insight_runs_run_key_key" UNIQUE ("run_key");



ALTER TABLE ONLY "public"."customer_external_links"
    ADD CONSTRAINT "customer_external_links_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."customer_external_links"
    ADD CONSTRAINT "customer_external_links_qbo_realm_required" CHECK ((("source_system" <> ALL (ARRAY['quickbooks'::"text", 'qbo'::"text"])) OR ("realm_id" IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."customer_external_links"
    ADD CONSTRAINT "customer_external_links_realm_unique" UNIQUE ("business_id", "realm_id", "source_system", "source_entity_type", "external_entity_id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_accounts"
    ADD CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_accounts"
    ADD CONSTRAINT "email_accounts_user_id_provider_google_email_key" UNIQUE ("user_id", "provider", "google_email");



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expense_category_map"
    ADD CONSTRAINT "expense_category_map_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expense_totals_monthly"
    ADD CONSTRAINT "expense_totals_monthly_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expense_totals_monthly"
    ADD CONSTRAINT "expense_totals_monthly_uniq" UNIQUE ("business_id", "month", "category");



ALTER TABLE ONLY "public"."financial_metrics"
    ADD CONSTRAINT "financial_metrics_business_id_month_key" UNIQUE ("business_id", "month");



ALTER TABLE ONLY "public"."financial_metrics"
    ADD CONSTRAINT "financial_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_monthly_review_stamps"
    ADD CONSTRAINT "financial_monthly_review_stamps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_monthly_review_stamps"
    ADD CONSTRAINT "financial_monthly_review_stamps_unique_month" UNIQUE ("business_id", "review_month");



ALTER TABLE ONLY "public"."financial_moves"
    ADD CONSTRAINT "financial_moves_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_summaries"
    ADD CONSTRAINT "financial_summaries_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."goal_tracking"
    ADD CONSTRAINT "goal_tracking_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."gpt_messages"
    ADD CONSTRAINT "gpt_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gpt_threads"
    ADD CONSTRAINT "gpt_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gpt_usage"
    ADD CONSTRAINT "gpt_usage_pkey" PRIMARY KEY ("user_id", "month");



ALTER TABLE ONLY "public"."insight_feedback"
    ADD CONSTRAINT "insight_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insight_preferences"
    ADD CONSTRAINT "insight_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."insight_reads"
    ADD CONSTRAINT "insight_reads_insight_id_user_id_key" UNIQUE ("insight_id", "user_id");



ALTER TABLE ONLY "public"."insight_reads"
    ADD CONSTRAINT "insight_reads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insights"
    ADD CONSTRAINT "insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."integration_connections"
    ADD CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_accounts"
    ADD CONSTRAINT "investment_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_balances"
    ADD CONSTRAINT "investment_balances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_assignment_instruction_history"
    ADD CONSTRAINT "job_assignment_instruction_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_assignment_suggestions"
    ADD CONSTRAINT "job_assignment_suggestions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_assignment_suggestions"
    ADD CONSTRAINT "job_assignment_suggestions_unique_v2" UNIQUE ("business_id", "transaction_id", "suggested_job_id");



ALTER TABLE ONLY "public"."job_candidates"
    ADD CONSTRAINT "job_candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."job_candidates"
    ADD CONSTRAINT "job_candidates_qbo_realm_required" CHECK ((("source_system" <> ALL (ARRAY['quickbooks'::"text", 'qbo'::"text"])) OR ("realm_id" IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."job_candidates"
    ADD CONSTRAINT "job_candidates_source_realm_unique" UNIQUE ("business_id", "realm_id", "source_system", "source_entity_type", "source_entity_id");



ALTER TABLE ONLY "public"."job_change_orders"
    ADD CONSTRAINT "job_change_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_costing_realm_integrity_conflicts"
    ADD CONSTRAINT "job_costing_realm_integrity_conflicts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_costs"
    ADD CONSTRAINT "job_costs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_employees"
    ADD CONSTRAINT "job_employees_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_employees"
    ADD CONSTRAINT "job_employees_unique" UNIQUE ("business_id", "job_id", "employee_id");



ALTER TABLE ONLY "public"."job_external_links"
    ADD CONSTRAINT "job_external_links_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."job_external_links"
    ADD CONSTRAINT "job_external_links_qbo_realm_required" CHECK ((("source_system" <> ALL (ARRAY['quickbooks'::"text", 'qbo'::"text"])) OR ("realm_id" IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."job_external_links"
    ADD CONSTRAINT "job_external_links_realm_unique" UNIQUE ("business_id", "realm_id", "source_system", "source_entity_type", "external_entity_id");



ALTER TABLE ONLY "public"."job_identity_mappings"
    ADD CONSTRAINT "job_identity_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."job_identity_mappings"
    ADD CONSTRAINT "job_identity_mappings_qbo_realm_required" CHECK ((("source_system" <> ALL (ARRAY['quickbooks'::"text", 'qbo'::"text"])) OR ("realm_id" IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."job_margin_targets"
    ADD CONSTRAINT "job_margin_targets_pkey" PRIMARY KEY ("business_id", "trade_type");



ALTER TABLE ONLY "public"."job_payment_allocations"
    ADD CONSTRAINT "job_payment_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_payment_allocations"
    ADD CONSTRAINT "job_payment_allocations_unique" UNIQUE ("business_id", "payment_record_id", "revenue_document_id", "linked_transaction_type", "linked_transaction_id");



ALTER TABLE ONLY "public"."job_payment_records"
    ADD CONSTRAINT "job_payment_records_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."job_payment_records"
    ADD CONSTRAINT "job_payment_records_qbo_realm_required" CHECK ((("source_system" <> ALL (ARRAY['quickbooks'::"text", 'qbo'::"text"])) OR ("realm_id" IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."job_payment_records"
    ADD CONSTRAINT "job_payment_records_realm_unique" UNIQUE ("business_id", "realm_id", "source_system", "external_payment_id");



ALTER TABLE ONLY "public"."job_revenue_documents"
    ADD CONSTRAINT "job_revenue_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."job_revenue_documents"
    ADD CONSTRAINT "job_revenue_documents_qbo_realm_required" CHECK ((("source_system" <> ALL (ARRAY['quickbooks'::"text", 'qbo'::"text"])) OR ("realm_id" IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."job_revenue_documents"
    ADD CONSTRAINT "job_revenue_documents_realm_unique" UNIQUE ("business_id", "realm_id", "source_system", "source_document_type", "external_document_id");



ALTER TABLE ONLY "public"."job_revenue_evidence"
    ADD CONSTRAINT "job_revenue_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."job_revenue_evidence"
    ADD CONSTRAINT "job_revenue_evidence_qbo_realm_required" CHECK ((("qbo_txn_id" IS NULL) OR ("realm_id" IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."job_transaction_assignment_role_backfill_runs"
    ADD CONSTRAINT "job_transaction_assignment_role_backfill_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_transaction_assignments"
    ADD CONSTRAINT "job_transaction_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_transaction_assignments"
    ADD CONSTRAINT "job_transaction_assignments_unique" UNIQUE ("business_id", "job_id", "transaction_id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kpi_metrics"
    ADD CONSTRAINT "kpi_metrics_business_id_month_key" UNIQUE ("business_id", "month");



ALTER TABLE ONLY "public"."kpi_metrics"
    ADD CONSTRAINT "kpi_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."linked_financial_items"
    ADD CONSTRAINT "linked_financial_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthly_financial_pulse"
    ADD CONSTRAINT "monthly_financial_pulse_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthly_forecast"
    ADD CONSTRAINT "monthly_forecast_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthly_review_audit_events"
    ADD CONSTRAINT "monthly_review_audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthly_review_reminders"
    ADD CONSTRAINT "monthly_review_reminders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthly_review_runs"
    ADD CONSTRAINT "monthly_review_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthly_review_runs"
    ADD CONSTRAINT "monthly_review_runs_unique_month" UNIQUE ("business_id", "review_month");



ALTER TABLE ONLY "public"."monthly_review_sections"
    ADD CONSTRAINT "monthly_review_sections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthly_review_sections"
    ADD CONSTRAINT "monthly_review_sections_unique_key" UNIQUE ("run_id", "section_key");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_connection_states"
    ADD CONSTRAINT "oauth_connection_states_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_connection_states"
    ADD CONSTRAINT "oauth_connection_states_state_hash_key" UNIQUE ("state_hash");



ALTER TABLE ONLY "public"."plaid_accounts"
    ADD CONSTRAINT "plaid_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plaid_items"
    ADD CONSTRAINT "plaid_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plaid_qbo_account_mappings"
    ADD CONSTRAINT "plaid_qbo_account_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."post_gallery"
    ADD CONSTRAINT "post_gallery_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prices_cache"
    ADD CONSTRAINT "prices_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prompt_usage"
    ADD CONSTRAINT "prompt_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_backfill_jobs"
    ADD CONSTRAINT "qbo_backfill_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_cdc_cursors"
    ADD CONSTRAINT "qbo_cdc_cursors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_coa_creations"
    ADD CONSTRAINT "qbo_coa_creations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_customers"
    ADD CONSTRAINT "qbo_customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_customers"
    ADD CONSTRAINT "qbo_customers_unique" UNIQUE ("business_id", "realm_id", "qbo_customer_id");



ALTER TABLE ONLY "public"."qbo_entity_sync_runs"
    ADD CONSTRAINT "qbo_entity_sync_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_job_costing_backfill_runs"
    ADD CONSTRAINT "qbo_job_costing_backfill_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_job_costing_daily_sync_state"
    ADD CONSTRAINT "qbo_job_costing_daily_sync_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_posted_transactions"
    ADD CONSTRAINT "qbo_posted_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_projects_capabilities"
    ADD CONSTRAINT "qbo_projects_capabilities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_projects_capabilities"
    ADD CONSTRAINT "qbo_projects_capabilities_unique" UNIQUE ("business_id", "realm_id", "qbo_env");



ALTER TABLE ONLY "public"."qbo_projects"
    ADD CONSTRAINT "qbo_projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_projects"
    ADD CONSTRAINT "qbo_projects_unique" UNIQUE ("business_id", "realm_id", "qbo_project_id");



ALTER TABLE ONLY "public"."qbo_vendor_creations"
    ADD CONSTRAINT "qbo_vendor_creations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_webhook_events"
    ADD CONSTRAINT "qbo_webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."quickbooks_tokens"
    ADD CONSTRAINT "quickbooks_tokens_business_id_key" UNIQUE ("business_id");



ALTER TABLE ONLY "public"."quickbooks_tokens"
    ADD CONSTRAINT "quickbooks_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reconciliation_health"
    ADD CONSTRAINT "reconciliation_health_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reconciliation_items"
    ADD CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reconciliation_runs"
    ADD CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."report_metadata"
    ADD CONSTRAINT "report_metadata_business_year_month_uniq" UNIQUE ("business_id", "year", "month");



ALTER TABLE ONLY "public"."report_metadata"
    ADD CONSTRAINT "report_metadata_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."review_sources"
    ADD CONSTRAINT "review_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scenarios"
    ADD CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scheduled_job_locks"
    ADD CONSTRAINT "scheduled_job_locks_job_key_key" UNIQUE ("job_key");



ALTER TABLE ONLY "public"."scheduled_job_locks"
    ADD CONSTRAINT "scheduled_job_locks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."securities"
    ADD CONSTRAINT "securities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."securities"
    ADD CONSTRAINT "securities_ticker_key" UNIQUE ("ticker");



ALTER TABLE ONLY "public"."state_tax_rule_configs"
    ADD CONSTRAINT "state_tax_rule_configs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_calculation_components"
    ADD CONSTRAINT "tax_calc_components_run_key_uq" UNIQUE ("run_id", "component_key");



ALTER TABLE ONLY "public"."tax_calculation_components"
    ADD CONSTRAINT "tax_calculation_components_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_calculation_nodes"
    ADD CONSTRAINT "tax_calculation_nodes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_calculation_nodes"
    ADD CONSTRAINT "tax_calculation_nodes_run_id_node_code_key" UNIQUE ("run_id", "node_code");



ALTER TABLE ONLY "public"."tax_calculation_run_links"
    ADD CONSTRAINT "tax_calculation_run_links_business_id_older_run_id_newer_ru_key" UNIQUE ("business_id", "older_run_id", "newer_run_id", "relation_type");



ALTER TABLE ONLY "public"."tax_calculation_run_links"
    ADD CONSTRAINT "tax_calculation_run_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_calculation_runs"
    ADD CONSTRAINT "tax_calculation_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_calculation_workpaper_lines"
    ADD CONSTRAINT "tax_calculation_workpaper_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_calculation_workpaper_lines"
    ADD CONSTRAINT "tax_calculation_workpaper_lines_run_id_code_key" UNIQUE ("run_id", "code");



ALTER TABLE ONLY "public"."tax_classification_overrides"
    ADD CONSTRAINT "tax_classification_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_deadlines"
    ADD CONSTRAINT "tax_deadlines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_deduction_rules"
    ADD CONSTRAINT "tax_deduction_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_payments"
    ADD CONSTRAINT "tax_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_profile_memory"
    ADD CONSTRAINT "tax_profile_memory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_profiles"
    ADD CONSTRAINT "tax_profiles_business_year_uq" UNIQUE ("business_id", "tax_year");



ALTER TABLE ONLY "public"."tax_profiles"
    ADD CONSTRAINT "tax_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_projection_scenarios"
    ADD CONSTRAINT "tax_projection_scenarios_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_recalculation_requests"
    ADD CONSTRAINT "tax_recalculation_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_reserve_accounts"
    ADD CONSTRAINT "tax_reserve_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_reserve_policy_configs"
    ADD CONSTRAINT "tax_reserve_policy_configs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_reserve_policy_configs"
    ADD CONSTRAINT "tax_reserve_policy_configs_policy_code_tax_year_version_key" UNIQUE ("policy_code", "tax_year", "version");



ALTER TABLE ONLY "public"."tax_reserve_snapshots"
    ADD CONSTRAINT "tax_reserve_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_review_tasks"
    ADD CONSTRAINT "tax_review_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_rule_configs"
    ADD CONSTRAINT "tax_rule_configs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_scheduler_runs"
    ADD CONSTRAINT "tax_scheduler_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_snapshots"
    ADD CONSTRAINT "tax_snapshots_business_id_month_key" UNIQUE ("business_id", "month");



ALTER TABLE ONLY "public"."tax_snapshots"
    ADD CONSTRAINT "tax_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tax_state_rates"
    ADD CONSTRAINT "tax_state_rates_pkey" PRIMARY KEY ("state");



ALTER TABLE ONLY "public"."transaction_categorizations"
    ADD CONSTRAINT "transaction_categorizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."transaction_tax_classifications"
    ADD CONSTRAINT "transaction_tax_classifications_business_txn_year_uq" UNIQUE ("business_id", "transaction_id", "tax_year");



ALTER TABLE ONLY "public"."transaction_tax_classifications"
    ADD CONSTRAINT "transaction_tax_classifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expense_category_map"
    ADD CONSTRAINT "uniq_cat_map" UNIQUE ("business_id", "qbo_account");



ALTER TABLE ONLY "public"."prices_cache"
    ADD CONSTRAINT "uniq_ticker" UNIQUE ("ticker");



ALTER TABLE ONLY "public"."user_business_link"
    ADD CONSTRAINT "user_business_link_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendor_locations"
    ADD CONSTRAINT "vendor_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendor_rules"
    ADD CONSTRAINT "vendor_rules_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "account_breakdown_uniq" ON "public"."account_breakdown" USING "btree" ("business_id", "month", "account_type", "account_name");



CREATE INDEX "ar_followups_business_invoice_idx" ON "public"."ar_followups" USING "btree" ("business_id", "qbo_env", "qbo_invoice_id");



CREATE INDEX "ar_followups_invoice_idx" ON "public"."ar_followups" USING "btree" ("business_id", "qbo_env", "qbo_invoice_id");



CREATE UNIQUE INDEX "ar_followups_invoice_round_idx" ON "public"."ar_followups" USING "btree" ("business_id", "qbo_env", "qbo_invoice_id", "round");



CREATE INDEX "ar_followups_open_item_idx" ON "public"."ar_followups" USING "btree" ("business_id", "ar_open_item_id");



CREATE INDEX "ar_followups_scheduled_idx" ON "public"."ar_followups" USING "btree" ("status", "scheduled_for") WHERE ("status" = ANY (ARRAY['scheduled'::"text", 'sending'::"text"]));



CREATE UNIQUE INDEX "ar_followups_unique_step_per_invoice" ON "public"."ar_followups" USING "btree" ("business_id", COALESCE("qbo_env", 'unknown'::"text"), "qbo_invoice_id", "channel", "step_number") WHERE ("qbo_invoice_id" IS NOT NULL);



CREATE INDEX "ar_open_items_business_balance_idx" ON "public"."ar_open_items" USING "btree" ("business_id", "balance" DESC);



CREATE INDEX "ar_open_items_business_due_idx" ON "public"."ar_open_items" USING "btree" ("business_id", "due_date");



CREATE INDEX "ar_open_items_business_status_idx" ON "public"."ar_open_items" USING "btree" ("business_id", "status");



CREATE INDEX "ar_open_items_next_followup_idx" ON "public"."ar_open_items" USING "btree" ("business_id", "next_followup_at") WHERE ("next_followup_at" IS NOT NULL);



CREATE UNIQUE INDEX "ar_open_items_unique_conflict" ON "public"."ar_open_items" USING "btree" ("business_id", "source", "qbo_env", "qbo_invoice_id");



CREATE INDEX "assignment_history_business_assigned_by_idx" ON "public"."assignment_history" USING "btree" ("business_id", "assigned_by");



CREATE INDEX "assignment_history_business_created_at_idx" ON "public"."assignment_history" USING "btree" ("business_id", "created_at");



CREATE INDEX "assignment_history_business_job_idx" ON "public"."assignment_history" USING "btree" ("business_id", "job_id");



CREATE INDEX "assignment_history_business_transaction_idx" ON "public"."assignment_history" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "bank_sync_runs_business_item_started_idx" ON "public"."bank_sync_runs" USING "btree" ("business_id", "plaid_item_id", "started_at" DESC);



CREATE INDEX "bank_transactions_business_account_date_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "plaid_account_id", "date" DESC);



CREATE INDEX "bank_transactions_business_date_id_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "date" DESC, "id");



CREATE INDEX "bank_transactions_business_pending_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "pending");



CREATE UNIQUE INDEX "bank_transactions_business_plaid_txn_uq" ON "public"."bank_transactions" USING "btree" ("business_id", "plaid_transaction_id");



CREATE INDEX "bank_txn_business_counterparty_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "counterparty_name");



CREATE INDEX "bank_txn_business_date_amount_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "date" DESC, "amount");



CREATE INDEX "bank_txn_business_fingerprint_active_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "duplicate_fingerprint") WHERE ("is_archived" = false);



CREATE INDEX "bank_txn_business_merchant_entity_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "merchant_entity_id");



CREATE INDEX "bank_txn_business_pending_txn_active_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "pending_transaction_id") WHERE (("is_archived" = false) AND ("pending_transaction_id" IS NOT NULL));



CREATE INDEX "bank_txn_business_pending_txn_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "pending_transaction_id");



CREATE INDEX "bank_txn_business_qbo_entity_idx" ON "public"."bank_transactions" USING "btree" ("business_id", "qbo_entity_type", "qbo_entity_id");



CREATE INDEX "bid_estimate_line_items_business_bid_estimate_idx" ON "public"."bid_estimate_line_items" USING "btree" ("business_id", "bid_estimate_id");



CREATE INDEX "bid_estimate_line_items_business_category_idx" ON "public"."bid_estimate_line_items" USING "btree" ("business_id", "category");



CREATE INDEX "bid_estimates_business_created_at_idx" ON "public"."bid_estimates" USING "btree" ("business_id", "created_at");



CREATE INDEX "bid_estimates_business_idx" ON "public"."bid_estimates" USING "btree" ("business_id");



CREATE INDEX "bid_estimates_business_job_type_idx" ON "public"."bid_estimates" USING "btree" ("business_id", "job_type");



CREATE INDEX "bid_estimates_business_status_idx" ON "public"."bid_estimates" USING "btree" ("business_id", "status");



CREATE INDEX "bid_estimates_business_trade_type_idx" ON "public"."bid_estimates" USING "btree" ("business_id", "trade_type");



CREATE INDEX "bid_outcomes_business_bid_estimate_idx" ON "public"."bid_outcomes" USING "btree" ("business_id", "bid_estimate_id");



CREATE INDEX "bizzy_deadlines_biz_due_idx" ON "public"."bizzy_deadlines" USING "btree" ("business_id", "due_date");



CREATE INDEX "bizzy_deadlines_status_idx" ON "public"."bizzy_deadlines" USING "btree" ("status");



CREATE INDEX "bizzy_docs_biz_cat_created_idx" ON "public"."bizzy_docs" USING "btree" ("business_id", "category", "created_at" DESC);



CREATE UNIQUE INDEX "bizzy_docs_business_filehash_uq" ON "public"."bizzy_docs" USING "btree" ("business_id", "file_hash") WHERE ("file_hash" IS NOT NULL);



CREATE INDEX "bizzy_docs_business_idx" ON "public"."bizzy_docs" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "bizzy_docs_category_idx" ON "public"."bizzy_docs" USING "btree" ("category");



CREATE INDEX "bizzy_docs_search_idx" ON "public"."bizzy_docs" USING "gin" ("search_lexeme");



CREATE INDEX "bizzy_docs_search_lexeme_idx" ON "public"."bizzy_docs" USING "gin" ("search_lexeme");



CREATE INDEX "bizzy_docs_tags_gin" ON "public"."bizzy_docs" USING "gin" ("tags");



CREATE INDEX "bizzy_docs_user_idx" ON "public"."bizzy_docs" USING "btree" ("user_id");



CREATE INDEX "bizzy_headlines_biz_idx" ON "public"."bizzy_headlines" USING "btree" ("business_id", "created_at" DESC);



CREATE UNIQUE INDEX "bizzy_headlines_unique_day" ON "public"."bizzy_headlines" USING "btree" ("business_id", "valid_for");



CREATE INDEX "bizzy_memory_embedding_idx" ON "public"."bizzy_memory" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE UNIQUE INDEX "bookkeeping_health_business_id_unique" ON "public"."bookkeeping_health" USING "btree" ("business_id");



CREATE INDEX "bookkeeping_post_attempts_business_attempted_at_idx" ON "public"."bookkeeping_post_attempts" USING "btree" ("business_id", "attempted_at" DESC);



CREATE INDEX "bookkeeping_post_attempts_business_status_idx" ON "public"."bookkeeping_post_attempts" USING "btree" ("business_id", "status");



CREATE INDEX "bookkeeping_post_attempts_business_transaction_idx" ON "public"."bookkeeping_post_attempts" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "business_billing_business_name_idx" ON "public"."business_billing" USING "btree" ("business_name");



CREATE INDEX "business_billing_customer_email_idx" ON "public"."business_billing" USING "btree" ("customer_email");



CREATE INDEX "business_billing_customer_idx" ON "public"."business_billing" USING "btree" ("stripe_customer_id");



CREATE INDEX "business_billing_customer_user_idx" ON "public"."business_billing" USING "btree" ("customer_user_id");



CREATE INDEX "business_billing_display_status_idx" ON "public"."business_billing" USING "btree" ("billing_display_status");



CREATE INDEX "business_billing_status_idx" ON "public"."business_billing" USING "btree" ("subscription_status");



CREATE INDEX "business_billing_subscription_idx" ON "public"."business_billing" USING "btree" ("stripe_subscription_id");



CREATE INDEX "cashflow_forecast_embedding_idx" ON "public"."cashflow_forecast" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "categorization_rules_business_active_idx" ON "public"."categorization_rules" USING "btree" ("business_id", "is_active", "priority");



CREATE INDEX "clarification_learning_events_business_created_at_idx" ON "public"."clarification_learning_events" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "clarification_learning_events_business_txn_idx" ON "public"."clarification_learning_events" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "clarification_learning_events_business_vendor_key_idx" ON "public"."clarification_learning_events" USING "btree" ("business_id", "vendor_key");



CREATE INDEX "clarification_requests_business_created_at_idx" ON "public"."clarification_requests" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "clarification_requests_business_reason_code_idx" ON "public"."clarification_requests" USING "btree" ("business_id", "reason_code");



CREATE INDEX "clarification_requests_business_status_idx" ON "public"."clarification_requests" USING "btree" ("business_id", "status");



CREATE INDEX "clarification_requests_business_txn_idx" ON "public"."clarification_requests" USING "btree" ("business_id", "transaction_id");



CREATE UNIQUE INDEX "clarification_requests_business_txn_uq" ON "public"."clarification_requests" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "client_rev_client_idx" ON "public"."client_revenue" USING "btree" ("client_name", "business_id");



CREATE INDEX "contractor_cfo_insight_runs_scheduled_for_idx" ON "public"."contractor_cfo_insight_runs" USING "btree" ("scheduled_for" DESC);



CREATE INDEX "contractor_cfo_insight_runs_status_idx" ON "public"."contractor_cfo_insight_runs" USING "btree" ("status", "lock_expires_at");



CREATE INDEX "customer_external_links_business_customer_idx" ON "public"."customer_external_links" USING "btree" ("business_id", "customer_id");



CREATE INDEX "customer_external_links_parent_idx" ON "public"."customer_external_links" USING "btree" ("business_id", "source_system", "external_parent_id");



CREATE INDEX "customers_business_display_idx" ON "public"."customers" USING "btree" ("business_id", "display_name");



CREATE INDEX "customers_business_idx" ON "public"."customers" USING "btree" ("business_id");



CREATE INDEX "employees_business_external_idx" ON "public"."employees" USING "btree" ("business_id", "external_source", "external_id");



CREATE INDEX "employees_business_idx" ON "public"."employees" USING "btree" ("business_id");



CREATE UNIQUE INDEX "financial_metrics_business_month_idx" ON "public"."financial_metrics" USING "btree" ("business_id", "month");



CREATE INDEX "financial_monthly_review_stamps_business_month_idx" ON "public"."financial_monthly_review_stamps" USING "btree" ("business_id", "review_month" DESC);



CREATE UNIQUE INDEX "financial_moves_business_month_title_unique" ON "public"."financial_moves" USING "btree" ("business_id", "month", "title");



CREATE INDEX "idx_account_breakdown_business_month" ON "public"."account_breakdown" USING "btree" ("business_id", "month");



CREATE INDEX "idx_bank_transactions_business_archived" ON "public"."bank_transactions" USING "btree" ("business_id", "is_archived");



CREATE INDEX "idx_breakdown_business_month" ON "public"."account_breakdown" USING "btree" ("business_id", "month");



CREATE INDEX "idx_calendar_events_business_start" ON "public"."calendar_events" USING "btree" ("business_id", "start_ts");



CREATE INDEX "idx_cat_map_business" ON "public"."expense_category_map" USING "btree" ("business_id");



CREATE INDEX "idx_client_rev_job" ON "public"."client_revenue" USING "btree" ("job_id");



CREATE INDEX "idx_email_accounts_business" ON "public"."email_accounts" USING "btree" ("business_id");



CREATE INDEX "idx_email_accounts_user" ON "public"."email_accounts" USING "btree" ("user_id");



CREATE INDEX "idx_exp_totals_business_category" ON "public"."expense_totals_monthly" USING "btree" ("business_id", "category");



CREATE INDEX "idx_exp_totals_business_month" ON "public"."expense_totals_monthly" USING "btree" ("business_id", "month");



CREATE INDEX "idx_gpt_messages_biz_created" ON "public"."gpt_messages" USING "btree" ("business_id", "created_at");



CREATE INDEX "idx_gpt_messages_thread" ON "public"."gpt_messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "idx_gpt_messages_thread_created_desc" ON "public"."gpt_messages" USING "btree" ("thread_id", "created_at" DESC);



CREATE INDEX "idx_gpt_threads_biz_arch_pin_updated" ON "public"."gpt_threads" USING "btree" ("business_id", "archived", "pinned", "updated_at" DESC);



CREATE INDEX "idx_gpt_threads_biz_lastmsg" ON "public"."gpt_threads" USING "btree" ("business_id", "archived", "pinned", "last_message_at" DESC);



CREATE INDEX "idx_gpt_threads_title_trgm" ON "public"."gpt_threads" USING "gin" ("title" "public"."gin_trgm_ops");



CREATE INDEX "idx_gpt_threads_user_business" ON "public"."gpt_threads" USING "btree" ("user_id", "business_id", "updated_at" DESC);



CREATE INDEX "idx_inv_bal_user_acc_asof" ON "public"."investment_balances" USING "btree" ("user_id", "account_id", "as_of" DESC);



CREATE INDEX "idx_invoices_business_created" ON "public"."invoices" USING "btree" ("business_id", "created_at");



CREATE INDEX "idx_invoices_status" ON "public"."invoices" USING "btree" ("status");



CREATE INDEX "idx_job_costs_job" ON "public"."job_costs" USING "btree" ("job_id");



CREATE INDEX "idx_jobs_business" ON "public"."jobs" USING "btree" ("business_id");



CREATE INDEX "idx_metrics_business_month" ON "public"."financial_metrics" USING "btree" ("business_id", "month");



CREATE INDEX "idx_plaid_accounts_business_active" ON "public"."plaid_accounts" USING "btree" ("business_id", "is_active");



CREATE INDEX "idx_plaid_items_business_active" ON "public"."plaid_items" USING "btree" ("business_id", "is_active");



CREATE INDEX "idx_positions_account" ON "public"."positions" USING "btree" ("account_id");



CREATE INDEX "idx_positions_security" ON "public"."positions" USING "btree" ("security_id");



CREATE INDEX "idx_positions_user" ON "public"."positions" USING "btree" ("user_id");



CREATE INDEX "idx_prices_ticker" ON "public"."prices_cache" USING "btree" ("ticker");



CREATE INDEX "idx_prompt_usage_user_mod" ON "public"."prompt_usage" USING "btree" ("user_id", "module", "used_at" DESC);



CREATE INDEX "idx_qbo_backfill_jobs_business_started" ON "public"."qbo_backfill_jobs" USING "btree" ("business_id", "started_at" DESC);



CREATE INDEX "idx_qbo_backfill_jobs_business_status" ON "public"."qbo_backfill_jobs" USING "btree" ("business_id", "status");



CREATE INDEX "idx_qbo_backfill_jobs_last_success" ON "public"."qbo_backfill_jobs" USING "btree" ("business_id", "last_success_at" DESC);



CREATE INDEX "idx_qbo_projects_business" ON "public"."qbo_projects" USING "btree" ("business_id");



CREATE INDEX "idx_qbo_projects_capabilities_business" ON "public"."qbo_projects_capabilities" USING "btree" ("business_id");



CREATE INDEX "idx_qbo_projects_job" ON "public"."qbo_projects" USING "btree" ("job_id");



CREATE INDEX "idx_qbo_projects_parent_customer" ON "public"."qbo_projects" USING "btree" ("business_id", "realm_id", "qbo_parent_customer_id");



CREATE INDEX "idx_quickbooks_tokens_business_id" ON "public"."quickbooks_tokens" USING "btree" ("business_id");



CREATE INDEX "idx_quickbooks_tokens_company_name" ON "public"."quickbooks_tokens" USING "btree" ("company_name");



CREATE INDEX "idx_report_metadata_business_month" ON "public"."report_metadata" USING "btree" ("business_id", "year", "month");



CREATE INDEX "idx_scenarios_business_id" ON "public"."scenarios" USING "btree" ("business_id");



CREATE INDEX "idx_scenarios_user_id" ON "public"."scenarios" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_securities_ticker" ON "public"."securities" USING "btree" ("ticker");



CREATE INDEX "idx_transaction_categorizations_business_archived" ON "public"."transaction_categorizations" USING "btree" ("business_id", "is_archived");



CREATE INDEX "insight_feedback_business_created_at_idx" ON "public"."insight_feedback" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "insight_feedback_business_feedback_idx" ON "public"."insight_feedback" USING "btree" ("business_id", "feedback");



CREATE INDEX "insight_feedback_business_insight_idx" ON "public"."insight_feedback" USING "btree" ("business_id", "insight_id");



CREATE INDEX "insights_active_business_module_idx" ON "public"."insights" USING "btree" ("business_id", "module", "created_at" DESC) WHERE ("dismissed_at" IS NULL);



CREATE INDEX "insights_business_category_created_idx" ON "public"."insights" USING "btree" ("business_id", "category", "created_at" DESC);



CREATE INDEX "insights_business_created_idx" ON "public"."insights" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "insights_business_dedupe_key_idx" ON "public"."insights" USING "btree" ("business_id", "dedupe_key") WHERE ("dedupe_key" IS NOT NULL);



CREATE INDEX "insights_business_expires_at_idx" ON "public"."insights" USING "btree" ("business_id", "expires_at") WHERE ("expires_at" IS NOT NULL);



CREATE INDEX "insights_business_module_created_at_idx" ON "public"."insights" USING "btree" ("business_id", "module", "created_at" DESC);



CREATE INDEX "insights_business_snoozed_until_idx" ON "public"."insights" USING "btree" ("business_id", "snoozed_until") WHERE ("snoozed_until" IS NOT NULL);



CREATE INDEX "insights_business_source_event_id_idx" ON "public"."insights" USING "btree" ("business_id", "source_event_id") WHERE ("source_event_id" IS NOT NULL);



CREATE INDEX "insights_business_status_idx" ON "public"."insights" USING "btree" ("business_id", "status") WHERE ("status" IS NOT NULL);



CREATE INDEX "insights_module_created_idx" ON "public"."insights" USING "btree" ("module", "created_at" DESC);



CREATE INDEX "integration_connections_business_idx" ON "public"."integration_connections" USING "btree" ("business_id");



CREATE UNIQUE INDEX "integration_connections_business_provider_uq" ON "public"."integration_connections" USING "btree" ("business_id", "provider");



CREATE INDEX "job_assignment_instruction_history_business_created_idx" ON "public"."job_assignment_instruction_history" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "job_assignment_role_backfill_business_idx" ON "public"."job_transaction_assignment_role_backfill_runs" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "job_assignment_suggestions_business_status_idx" ON "public"."job_assignment_suggestions" USING "btree" ("business_id", "status", "updated_at" DESC);



CREATE INDEX "job_assignment_suggestions_business_status_v2_idx" ON "public"."job_assignment_suggestions" USING "btree" ("business_id", "status");



CREATE INDEX "job_assignment_suggestions_confidence_score_idx" ON "public"."job_assignment_suggestions" USING "btree" ("business_id", "confidence_score");



CREATE INDEX "job_assignment_suggestions_suggested_job_idx" ON "public"."job_assignment_suggestions" USING "btree" ("business_id", "suggested_job_id");



CREATE INDEX "job_assignment_suggestions_transaction_idx" ON "public"."job_assignment_suggestions" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "job_assignment_suggestions_transaction_v2_idx" ON "public"."job_assignment_suggestions" USING "btree" ("business_id", "transaction_id");



CREATE UNIQUE INDEX "job_assignment_suggestions_unique_pair_idx" ON "public"."job_assignment_suggestions" USING "btree" ("business_id", "transaction_id", "job_id");



CREATE UNIQUE INDEX "job_assignment_suggestions_unique_suggested_job_idx" ON "public"."job_assignment_suggestions" USING "btree" ("business_id", "transaction_id", "suggested_job_id") WHERE ("suggested_job_id" IS NOT NULL);



CREATE INDEX "job_candidates_business_customer_idx" ON "public"."job_candidates" USING "btree" ("business_id", "source_customer_id");



CREATE INDEX "job_candidates_business_status_idx" ON "public"."job_candidates" USING "btree" ("business_id", "candidate_status", "confidence_score" DESC);



CREATE INDEX "job_candidates_qbo_customer_idx" ON "public"."job_candidates" USING "btree" ("business_id", "qbo_customer_id", "qbo_subcustomer_id");



CREATE INDEX "job_change_orders_business_job_date_idx" ON "public"."job_change_orders" USING "btree" ("business_id", "job_id", "change_order_date" DESC);



CREATE INDEX "job_costs_job_idx" ON "public"."job_costs" USING "btree" ("job_id");



CREATE INDEX "job_employees_business_employee_idx" ON "public"."job_employees" USING "btree" ("business_id", "employee_id");



CREATE INDEX "job_employees_business_job_idx" ON "public"."job_employees" USING "btree" ("business_id", "job_id");



CREATE INDEX "job_external_links_business_job_idx" ON "public"."job_external_links" USING "btree" ("business_id", "job_id");



CREATE UNIQUE INDEX "job_identity_mappings_address_realm_unique_idx" ON "public"."job_identity_mappings" USING "btree" ("business_id", "realm_id", "source_system", "mapping_type", "normalized_address_key") WHERE (("active" = true) AND ("normalized_address_key" IS NOT NULL));



CREATE INDEX "job_identity_mappings_business_job_idx" ON "public"."job_identity_mappings" USING "btree" ("business_id", "job_id", "active");



CREATE UNIQUE INDEX "job_identity_mappings_source_entity_realm_unique_idx" ON "public"."job_identity_mappings" USING "btree" ("business_id", "realm_id", "source_system", "mapping_type", "source_entity_id") WHERE (("active" = true) AND ("source_entity_id" IS NOT NULL));



CREATE INDEX "job_margin_targets_business_idx" ON "public"."job_margin_targets" USING "btree" ("business_id");



CREATE INDEX "job_payment_allocations_business_document_idx" ON "public"."job_payment_allocations" USING "btree" ("business_id", "revenue_document_id");



CREATE UNIQUE INDEX "job_payment_allocations_dedupe_idx" ON "public"."job_payment_allocations" USING "btree" ("business_id", "payment_record_id", "revenue_document_id", COALESCE("linked_transaction_type", ''::"text"), COALESCE("linked_transaction_id", ''::"text"));



CREATE INDEX "job_payment_records_business_customer_idx" ON "public"."job_payment_records" USING "btree" ("business_id", "customer_id");



CREATE INDEX "job_payment_records_realm_idx" ON "public"."job_payment_records" USING "btree" ("business_id", "realm_id");



CREATE INDEX "job_revenue_documents_business_customer_idx" ON "public"."job_revenue_documents" USING "btree" ("business_id", "customer_id");



CREATE INDEX "job_revenue_documents_business_job_idx" ON "public"."job_revenue_documents" USING "btree" ("business_id", "job_id");



CREATE UNIQUE INDEX "job_revenue_documents_manual_unique_idx" ON "public"."job_revenue_documents" USING "btree" ("business_id", "source_document_type", "document_number") WHERE (("external_document_id" IS NULL) AND ("document_number" IS NOT NULL));



CREATE INDEX "job_revenue_documents_realm_idx" ON "public"."job_revenue_documents" USING "btree" ("business_id", "realm_id");



CREATE UNIQUE INDEX "job_revenue_evidence_bank_unique_idx" ON "public"."job_revenue_evidence" USING "btree" ("business_id", "bank_transaction_id", COALESCE("job_id", '00000000-0000-0000-0000-000000000000'::"uuid")) WHERE ("bank_transaction_id" IS NOT NULL);



CREATE UNIQUE INDEX "job_revenue_evidence_qbo_deposit_unique_idx" ON "public"."job_revenue_evidence" USING "btree" ("business_id", "realm_id", "qbo_txn_type", "qbo_txn_id") WHERE (("qbo_txn_type" = 'Deposit'::"text") AND ("qbo_txn_id" IS NOT NULL));



CREATE UNIQUE INDEX "job_revenue_evidence_qbo_realm_unique_idx" ON "public"."job_revenue_evidence" USING "btree" ("business_id", "realm_id", "qbo_txn_type", "qbo_txn_id", COALESCE("job_id", '00000000-0000-0000-0000-000000000000'::"uuid")) WHERE ("qbo_txn_id" IS NOT NULL);



CREATE INDEX "job_transaction_assignments_business_idx" ON "public"."job_transaction_assignments" USING "btree" ("business_id");



CREATE INDEX "job_transaction_assignments_business_job_idx" ON "public"."job_transaction_assignments" USING "btree" ("business_id", "job_id");



CREATE INDEX "job_transaction_assignments_business_transaction_idx" ON "public"."job_transaction_assignments" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "job_transaction_assignments_job_idx" ON "public"."job_transaction_assignments" USING "btree" ("business_id", "job_id");



CREATE UNIQUE INDEX "job_transaction_assignments_txn_idx" ON "public"."job_transaction_assignments" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "jobs_business_completed_at_idx" ON "public"."jobs" USING "btree" ("business_id", "completed_at" DESC) WHERE ("completed_at" IS NOT NULL);



CREATE INDEX "jobs_business_customer_idx" ON "public"."jobs" USING "btree" ("business_id", "customer_id");



CREATE INDEX "jobs_business_idx" ON "public"."jobs" USING "btree" ("business_id");



CREATE INDEX "jobs_business_status_idx" ON "public"."jobs" USING "btree" ("business_id", "status");



CREATE INDEX "jobs_business_sync_status_idx" ON "public"."jobs" USING "btree" ("business_id", "sync_status");



CREATE UNIQUE INDEX "monthly_financial_pulse_business_id_month_idx" ON "public"."monthly_financial_pulse" USING "btree" ("business_id", "month");



CREATE UNIQUE INDEX "monthly_forecast_business_month_idx" ON "public"."monthly_forecast" USING "btree" ("business_id", "month");



CREATE INDEX "monthly_review_audit_events_business_month_idx" ON "public"."monthly_review_audit_events" USING "btree" ("business_id", "review_month", "created_at" DESC);



CREATE INDEX "monthly_review_audit_events_run_idx" ON "public"."monthly_review_audit_events" USING "btree" ("run_id", "created_at" DESC);



CREATE INDEX "monthly_review_reminders_business_month_idx" ON "public"."monthly_review_reminders" USING "btree" ("business_id", "review_month", "created_at" DESC);



CREATE INDEX "monthly_review_reminders_run_idx" ON "public"."monthly_review_reminders" USING "btree" ("run_id", "created_at" DESC);



CREATE INDEX "monthly_review_runs_active_editor_idx" ON "public"."monthly_review_runs" USING "btree" ("active_editor_expires_at") WHERE ("active_editor_expires_at" IS NOT NULL);



CREATE INDEX "monthly_review_runs_business_month_idx" ON "public"."monthly_review_runs" USING "btree" ("business_id", "review_month" DESC);



CREATE INDEX "monthly_review_sections_run_idx" ON "public"."monthly_review_sections" USING "btree" ("run_id");



CREATE INDEX "oauth_connection_states_expiry_idx" ON "public"."oauth_connection_states" USING "btree" ("provider", "expires_at") WHERE ("used_at" IS NULL);



CREATE INDEX "oauth_connection_states_provider_state_idx" ON "public"."oauth_connection_states" USING "btree" ("provider", "state_hash");



CREATE UNIQUE INDEX "plaid_accounts_business_account_uq" ON "public"."plaid_accounts" USING "btree" ("business_id", "plaid_account_id");



CREATE INDEX "plaid_accounts_business_connected_at_idx" ON "public"."plaid_accounts" USING "btree" ("business_id", "connected_at" DESC);



CREATE INDEX "plaid_accounts_business_item_idx" ON "public"."plaid_accounts" USING "btree" ("business_id", "plaid_item_id");



CREATE INDEX "plaid_accounts_business_last_sync_at_idx" ON "public"."plaid_accounts" USING "btree" ("business_id", "last_sync_at" DESC);



CREATE INDEX "plaid_items_business_idx" ON "public"."plaid_items" USING "btree" ("business_id");



CREATE UNIQUE INDEX "plaid_items_business_item_uq" ON "public"."plaid_items" USING "btree" ("business_id", "plaid_item_id");



CREATE INDEX "plaid_items_sync_in_progress_idx" ON "public"."plaid_items" USING "btree" ("sync_in_progress");



CREATE INDEX "plaid_qbo_account_mappings_business_idx" ON "public"."plaid_qbo_account_mappings" USING "btree" ("business_id");



CREATE UNIQUE INDEX "plaid_qbo_account_mappings_business_plaid_uq" ON "public"."plaid_qbo_account_mappings" USING "btree" ("business_id", "plaid_account_id");



CREATE INDEX "qbo_backfill_resume_idx" ON "public"."qbo_job_costing_backfill_runs" USING "btree" ("business_id", "realm_id", "qbo_env", "status", "created_at" DESC);



CREATE UNIQUE INDEX "qbo_cdc_cursors_business_entity_uidx" ON "public"."qbo_cdc_cursors" USING "btree" ("business_id", "realm_id", "qbo_env", "entity_type");



CREATE INDEX "qbo_cdc_cursors_due_idx" ON "public"."qbo_cdc_cursors" USING "btree" ("business_id", "realm_id", "qbo_env", "entity_type", "status", "last_attempted_at");



CREATE UNIQUE INDEX "qbo_coa_creations_business_account_uq" ON "public"."qbo_coa_creations" USING "btree" ("business_id", "qbo_account_id");



CREATE INDEX "qbo_coa_creations_business_created_idx" ON "public"."qbo_coa_creations" USING "btree" ("business_id", "created_at" DESC);



CREATE INDEX "qbo_coa_creations_business_name_idx" ON "public"."qbo_coa_creations" USING "btree" ("business_id", "qbo_account_name");



CREATE INDEX "qbo_customers_business_idx" ON "public"."qbo_customers" USING "btree" ("business_id");



CREATE INDEX "qbo_customers_parent_idx" ON "public"."qbo_customers" USING "btree" ("business_id", "realm_id", "qbo_parent_customer_id");



CREATE INDEX "qbo_entity_sync_runs_business_started_idx" ON "public"."qbo_entity_sync_runs" USING "btree" ("business_id", "started_at" DESC);



CREATE INDEX "qbo_job_costing_backfill_business_idx" ON "public"."qbo_job_costing_backfill_runs" USING "btree" ("business_id", "created_at" DESC);



CREATE UNIQUE INDEX "qbo_job_costing_daily_state_business_uidx" ON "public"."qbo_job_costing_daily_sync_state" USING "btree" ("business_id", "realm_id", "qbo_env");



CREATE INDEX "qbo_posted_transactions_business_posted_at_idx" ON "public"."qbo_posted_transactions" USING "btree" ("business_id", "posted_at" DESC);



CREATE INDEX "qbo_posted_transactions_business_status_idx" ON "public"."qbo_posted_transactions" USING "btree" ("business_id", "status");



CREATE UNIQUE INDEX "qbo_posted_transactions_business_txn_uq" ON "public"."qbo_posted_transactions" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "qbo_vendor_creations_business_created_idx" ON "public"."qbo_vendor_creations" USING "btree" ("business_id", "created_at" DESC);



CREATE UNIQUE INDEX "qbo_vendor_creations_business_entity_uq" ON "public"."qbo_vendor_creations" USING "btree" ("business_id", "qbo_entity_type", "qbo_entity_id");



CREATE INDEX "qbo_vendor_creations_business_name_idx" ON "public"."qbo_vendor_creations" USING "btree" ("business_id", "vendor_name");



CREATE INDEX "qbo_vendor_creations_business_txn_idx" ON "public"."qbo_vendor_creations" USING "btree" ("business_id", "source_transaction_id");



CREATE UNIQUE INDEX "qbo_webhook_events_hash_uidx" ON "public"."qbo_webhook_events" USING "btree" ("event_hash");



CREATE INDEX "qbo_webhook_events_queue_idx" ON "public"."qbo_webhook_events" USING "btree" ("processing_status", "next_attempt_at", "event_timestamp");



CREATE UNIQUE INDEX "qbo_webhook_events_realm_entity_event_uidx" ON "public"."qbo_webhook_events" USING "btree" ("realm_id", "qbo_env", "entity_type", "entity_id", "operation", "event_timestamp") WHERE ("event_timestamp" IS NOT NULL);



CREATE INDEX "qbo_webhook_events_realm_entity_idx" ON "public"."qbo_webhook_events" USING "btree" ("realm_id", "qbo_env", "entity_type", "entity_id", "event_timestamp" DESC);



CREATE UNIQUE INDEX "quickbooks_tokens_active_realm_env_uidx" ON "public"."quickbooks_tokens" USING "btree" ("realm_id", "qbo_env") WHERE (("is_active" = true) AND ("status" = 'active'::"text") AND ("realm_id" IS NOT NULL));



CREATE UNIQUE INDEX "quickbooks_tokens_business_env_uq" ON "public"."quickbooks_tokens" USING "btree" ("business_id", "qbo_env");



CREATE UNIQUE INDEX "quickbooks_tokens_business_id_uidx" ON "public"."quickbooks_tokens" USING "btree" ("business_id");



CREATE UNIQUE INDEX "quickbooks_tokens_business_id_unique" ON "public"."quickbooks_tokens" USING "btree" ("business_id");



CREATE INDEX "quickbooks_tokens_realm_env_idx" ON "public"."quickbooks_tokens" USING "btree" ("realm_id", "qbo_env") WHERE (("is_active" = true) AND ("status" = 'active'::"text") AND ("realm_id" IS NOT NULL));



CREATE INDEX "reconciliation_health_business_last_checked_idx" ON "public"."reconciliation_health" USING "btree" ("business_id", "last_checked_at" DESC);



CREATE UNIQUE INDEX "reconciliation_health_business_plaid_uq" ON "public"."reconciliation_health" USING "btree" ("business_id", "plaid_account_id");



CREATE INDEX "reconciliation_items_business_plaid_account_idx" ON "public"."reconciliation_items" USING "btree" ("business_id", "plaid_account_id");



CREATE INDEX "reconciliation_items_business_run_idx" ON "public"."reconciliation_items" USING "btree" ("business_id", "run_id");



CREATE INDEX "reconciliation_items_business_status_idx" ON "public"."reconciliation_items" USING "btree" ("business_id", "status");



CREATE INDEX "reconciliation_items_business_txn_date_idx" ON "public"."reconciliation_items" USING "btree" ("business_id", "txn_date" DESC);



CREATE UNIQUE INDEX "reconciliation_items_run_bank_txn_uq" ON "public"."reconciliation_items" USING "btree" ("run_id", "bank_transaction_id") WHERE ("bank_transaction_id" IS NOT NULL);



CREATE INDEX "reconciliation_runs_business_last_checked_idx" ON "public"."reconciliation_runs" USING "btree" ("business_id", "last_checked_at" DESC);



CREATE INDEX "report_metadata_business_year_month_idx" ON "public"."report_metadata" USING "btree" ("business_id", "year", "month");



CREATE INDEX "report_metadata_monthly_review_published_idx" ON "public"."report_metadata" USING "btree" ("business_id", "year" DESC, "month" DESC) WHERE ("monthly_review_published_at" IS NOT NULL);



CREATE INDEX "scheduled_job_locks_scheduled_for_idx" ON "public"."scheduled_job_locks" USING "btree" ("scheduled_for" DESC);



CREATE INDEX "scheduled_job_locks_status_locked_idx" ON "public"."scheduled_job_locks" USING "btree" ("status", "locked_at");



CREATE INDEX "state_tax_rule_configs_active_lookup_idx" ON "public"."state_tax_rule_configs" USING "btree" ("tax_year", "state_code", "rule_type", "is_active");



CREATE UNIQUE INDEX "state_tax_rule_configs_natural_key_uq" ON "public"."state_tax_rule_configs" USING "btree" ("tax_year", "state_code", "rule_type", COALESCE("entity_type", ''::"text"), COALESCE("filing_status", ''::"text"), "version");



CREATE UNIQUE INDEX "subscriptions_business_id_key" ON "public"."subscriptions" USING "btree" ("business_id");



CREATE INDEX "subscriptions_status_idx" ON "public"."subscriptions" USING "btree" ("status");



CREATE INDEX "tax_adjustments_business_year_idx" ON "public"."tax_adjustments" USING "btree" ("business_id", "tax_year", "effective_date");



CREATE INDEX "tax_adjustments_source_transaction_idx" ON "public"."tax_adjustments" USING "btree" ("source_transaction_id") WHERE ("source_transaction_id" IS NOT NULL);



CREATE INDEX "tax_calc_components_business_type_idx" ON "public"."tax_calculation_components" USING "btree" ("business_id", "component_type");



CREATE INDEX "tax_calc_components_run_sort_idx" ON "public"."tax_calculation_components" USING "btree" ("run_id", "sort_order", "created_at");



CREATE INDEX "tax_calc_run_links_business_newer_idx" ON "public"."tax_calculation_run_links" USING "btree" ("business_id", "newer_run_id");



CREATE INDEX "tax_calc_run_links_business_older_idx" ON "public"."tax_calculation_run_links" USING "btree" ("business_id", "older_run_id");



CREATE INDEX "tax_calc_runs_business_year_completed_idx" ON "public"."tax_calculation_runs" USING "btree" ("business_id", "tax_year", "completed_at" DESC);



CREATE INDEX "tax_calc_runs_business_year_date_idx" ON "public"."tax_calculation_runs" USING "btree" ("business_id", "tax_year", "as_of_date" DESC, "created_at" DESC);



CREATE INDEX "tax_calc_runs_business_year_fingerprint_idx" ON "public"."tax_calculation_runs" USING "btree" ("business_id", "tax_year", "calculation_fingerprint");



CREATE INDEX "tax_calc_runs_latest_completed_idx" ON "public"."tax_calculation_runs" USING "btree" ("business_id", "tax_year", "completed_at" DESC) WHERE ("status" = 'completed'::"text");



CREATE INDEX "tax_calc_runs_status_idx" ON "public"."tax_calculation_runs" USING "btree" ("business_id", "status", "created_at" DESC);



CREATE INDEX "tax_calc_runs_superseded_by_idx" ON "public"."tax_calculation_runs" USING "btree" ("superseded_by_run_id");



CREATE INDEX "tax_calc_runs_supersedes_idx" ON "public"."tax_calculation_runs" USING "btree" ("supersedes_run_id");



CREATE INDEX "tax_calculation_nodes_business_year_idx" ON "public"."tax_calculation_nodes" USING "btree" ("business_id", "tax_year");



CREATE INDEX "tax_calculation_nodes_parent_code_idx" ON "public"."tax_calculation_nodes" USING "btree" ("run_id", "parent_node_code");



CREATE INDEX "tax_calculation_nodes_rule_refs_gin_idx" ON "public"."tax_calculation_nodes" USING "gin" ("rule_refs");



CREATE INDEX "tax_calculation_nodes_run_section_idx" ON "public"."tax_calculation_nodes" USING "btree" ("run_id", "section_code", "sort_order");



CREATE INDEX "tax_calculation_nodes_source_refs_gin_idx" ON "public"."tax_calculation_nodes" USING "gin" ("source_refs");



CREATE INDEX "tax_calculation_nodes_traceability_idx" ON "public"."tax_calculation_nodes" USING "btree" ("run_id", "traceability_status");



CREATE INDEX "tax_class_overrides_business_txn_idx" ON "public"."tax_classification_overrides" USING "btree" ("business_id", "transaction_id", "created_at" DESC);



CREATE INDEX "tax_class_overrides_classification_idx" ON "public"."tax_classification_overrides" USING "btree" ("classification_id", "created_at" DESC);



CREATE INDEX "tax_deadlines_business_due_date_idx" ON "public"."tax_deadlines" USING "btree" ("business_id", "due_date");



CREATE INDEX "tax_deadlines_business_year_status_idx" ON "public"."tax_deadlines" USING "btree" ("business_id", "tax_year", "status");



CREATE UNIQUE INDEX "tax_deduction_rules_business_code_uq" ON "public"."tax_deduction_rules" USING "btree" ("business_id", "rule_code", "tax_year", "version") WHERE ("business_id" IS NOT NULL);



CREATE INDEX "tax_deduction_rules_engine_idx" ON "public"."tax_deduction_rules" USING "btree" ("tax_year", "jurisdiction", "scope", "business_id", "is_active", "priority", "rule_code");



CREATE UNIQUE INDEX "tax_deduction_rules_global_code_uq" ON "public"."tax_deduction_rules" USING "btree" ("rule_code", "tax_year", "version") WHERE ("business_id" IS NULL);



CREATE INDEX "tax_deduction_rules_lookup_idx" ON "public"."tax_deduction_rules" USING "btree" ("tax_year", "bookkeeping_category", "is_active", "priority");



CREATE INDEX "tax_deduction_rules_match_conditions_gin_idx" ON "public"."tax_deduction_rules" USING "gin" ("match_conditions");



CREATE INDEX "tax_payments_bq" ON "public"."tax_payments" USING "btree" ("business_id", "year", "quarter");



CREATE INDEX "tax_payments_business_date_idx" ON "public"."tax_payments" USING "btree" ("business_id", "payment_date" DESC);



CREATE INDEX "tax_payments_business_external_id_idx" ON "public"."tax_payments" USING "btree" ("business_id", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "tax_payments_business_tax_year_idx" ON "public"."tax_payments" USING "btree" ("business_id", "tax_year", "jurisdiction");



CREATE UNIQUE INDEX "tax_profile_memory_active_key_uq" ON "public"."tax_profile_memory" USING "btree" ("business_id", "memory_key") WHERE ("effective_to" IS NULL);



CREATE INDEX "tax_profile_memory_business_key_idx" ON "public"."tax_profile_memory" USING "btree" ("business_id", "memory_key");



CREATE INDEX "tax_profile_memory_effective_dates_idx" ON "public"."tax_profile_memory" USING "btree" ("business_id", "effective_from", "effective_to");



CREATE INDEX "tax_profiles_business_year_idx" ON "public"."tax_profiles" USING "btree" ("business_id", "tax_year" DESC);



CREATE INDEX "tax_profiles_status_idx" ON "public"."tax_profiles" USING "btree" ("business_id", "profile_status");



CREATE INDEX "tax_projection_scenarios_active_idx" ON "public"."tax_projection_scenarios" USING "btree" ("business_id", "tax_year", "is_active", "scenario_type");



CREATE UNIQUE INDEX "tax_projection_scenarios_natural_key_uq" ON "public"."tax_projection_scenarios" USING "btree" ("business_id", "tax_year", "scenario_type", "as_of_date", "scenario_name");



CREATE INDEX "tax_recalculation_requests_business_year_status_idx" ON "public"."tax_recalculation_requests" USING "btree" ("business_id", "tax_year", "status");



CREATE INDEX "tax_recalculation_requests_due_idx" ON "public"."tax_recalculation_requests" USING "btree" ("status", "process_after");



CREATE UNIQUE INDEX "tax_recalculation_requests_event_id_uidx" ON "public"."tax_recalculation_requests" USING "btree" ("event_id");



CREATE INDEX "tax_recalculation_requests_last_event_idx" ON "public"."tax_recalculation_requests" USING "btree" ("last_event_at" DESC);



CREATE INDEX "tax_recalculation_requests_locked_idx" ON "public"."tax_recalculation_requests" USING "btree" ("locked_at");



CREATE INDEX "tax_reserve_accounts_business_active_idx" ON "public"."tax_reserve_accounts" USING "btree" ("business_id", "is_active");



CREATE INDEX "tax_reserve_accounts_plaid_idx" ON "public"."tax_reserve_accounts" USING "btree" ("business_id", "plaid_account_id") WHERE ("plaid_account_id" IS NOT NULL);



CREATE UNIQUE INDEX "tax_reserve_accounts_primary_uq" ON "public"."tax_reserve_accounts" USING "btree" ("business_id") WHERE (("is_primary" = true) AND ("is_active" = true));



CREATE INDEX "tax_reserve_snapshots_business_year_date_idx" ON "public"."tax_reserve_snapshots" USING "btree" ("business_id", "tax_year", "as_of_date" DESC, "created_at" DESC);



CREATE INDEX "tax_reserve_snapshots_run_idx" ON "public"."tax_reserve_snapshots" USING "btree" ("calculation_run_id") WHERE ("calculation_run_id" IS NOT NULL);



CREATE UNIQUE INDEX "tax_review_tasks_active_dedupe_uq" ON "public"."tax_review_tasks" USING "btree" ("business_id", "dedupe_key") WHERE (("dedupe_key" IS NOT NULL) AND ("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text"])));



CREATE INDEX "tax_review_tasks_business_status_idx" ON "public"."tax_review_tasks" USING "btree" ("business_id", "tax_year", "status", "severity");



CREATE INDEX "tax_review_tasks_entity_idx" ON "public"."tax_review_tasks" USING "btree" ("business_id", "entity_type", "entity_id");



CREATE INDEX "tax_rule_configs_active_lookup_idx" ON "public"."tax_rule_configs" USING "btree" ("tax_year", "rule_type", "is_active");



CREATE UNIQUE INDEX "tax_rule_configs_natural_key_uq" ON "public"."tax_rule_configs" USING "btree" ("tax_year", "jurisdiction", "rule_type", COALESCE("filing_status", ''::"text"), COALESCE("entity_type", ''::"text"), "version");



CREATE INDEX "tax_scheduler_runs_job_scheduled_idx" ON "public"."tax_scheduler_runs" USING "btree" ("job_type", "scheduled_for" DESC);



CREATE INDEX "tax_scheduler_runs_status_idx" ON "public"."tax_scheduler_runs" USING "btree" ("status", "started_at" DESC);



CREATE INDEX "tax_snapshots_business_year_date_idx" ON "public"."tax_snapshots" USING "btree" ("business_id", "tax_year", "as_of_date" DESC);



CREATE INDEX "tax_snapshots_calculation_run_idx" ON "public"."tax_snapshots" USING "btree" ("calculation_run_id") WHERE ("calculation_run_id" IS NOT NULL);



CREATE INDEX "tax_workpaper_lines_business_year_idx" ON "public"."tax_calculation_workpaper_lines" USING "btree" ("business_id", "tax_year");



CREATE INDEX "tax_workpaper_lines_parent_code_idx" ON "public"."tax_calculation_workpaper_lines" USING "btree" ("run_id", "parent_code");



CREATE INDEX "tax_workpaper_lines_rule_versions_gin_idx" ON "public"."tax_calculation_workpaper_lines" USING "gin" ("rule_versions");



CREATE INDEX "tax_workpaper_lines_run_section_idx" ON "public"."tax_calculation_workpaper_lines" USING "btree" ("run_id", "section", "sort_order");



CREATE INDEX "tax_workpaper_lines_source_refs_gin_idx" ON "public"."tax_calculation_workpaper_lines" USING "gin" ("source_refs");



CREATE INDEX "transaction_categorizations_business_reconciled_at_idx" ON "public"."transaction_categorizations" USING "btree" ("business_id", "reconciled_at" DESC);



CREATE INDEX "transaction_tax_classifications_business_year_category_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "tax_year", "tax_category");



CREATE INDEX "transaction_tax_classifications_business_year_date_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "tax_year", "transaction_date" DESC, "updated_at" DESC, "id" DESC);



CREATE INDEX "transaction_tax_classifications_business_year_deductibility_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "tax_year", "deductibility_status");



CREATE INDEX "transaction_tax_classifications_business_year_status_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "tax_year", "classification_status");



CREATE INDEX "transaction_tax_classifications_business_year_updated_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "tax_year", "updated_at" DESC, "id" DESC);



CREATE INDEX "transaction_tax_classifications_rule_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "tax_year", "rule_code", "rule_version");



CREATE INDEX "txn_categ_business_post_after_idx" ON "public"."transaction_categorizations" USING "btree" ("business_id", "post_after");



CREATE INDEX "txn_categ_business_signed_amount_idx" ON "public"."transaction_categorizations" USING "btree" ("business_id", "signed_amount");



CREATE INDEX "txn_categ_business_status_idx" ON "public"."transaction_categorizations" USING "btree" ("business_id", "status");



CREATE INDEX "txn_categ_business_txn_date_idx" ON "public"."transaction_categorizations" USING "btree" ("business_id", "txn_date" DESC);



CREATE INDEX "txn_categ_business_txn_name_idx" ON "public"."transaction_categorizations" USING "btree" ("business_id", "txn_name");



CREATE UNIQUE INDEX "txn_categ_business_txn_uq" ON "public"."transaction_categorizations" USING "btree" ("business_id", "transaction_id");



CREATE INDEX "txn_categ_meta_gin_idx" ON "public"."transaction_categorizations" USING "gin" ("meta");



CREATE INDEX "txn_categ_qbo_txn_id_idx" ON "public"."transaction_categorizations" USING "btree" ("qbo_txn_id");



CREATE INDEX "txn_categ_status_post_after_idx" ON "public"."transaction_categorizations" USING "btree" ("status", "post_after");



CREATE INDEX "txn_tax_class_business_category_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "tax_year", "tax_category");



CREATE INDEX "txn_tax_class_business_status_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "classification_status");



CREATE INDEX "txn_tax_class_business_year_idx" ON "public"."transaction_tax_classifications" USING "btree" ("business_id", "tax_year");



CREATE INDEX "txn_tax_class_metadata_gin_idx" ON "public"."transaction_tax_classifications" USING "gin" ("metadata");



CREATE INDEX "txn_tax_class_transaction_idx" ON "public"."transaction_tax_classifications" USING "btree" ("transaction_id");



CREATE UNIQUE INDEX "uniq_insight_reads" ON "public"."insight_reads" USING "btree" ("user_id", "insight_id");



CREATE UNIQUE INDEX "uniq_linked_item" ON "public"."linked_financial_items" USING "btree" ("user_id", "provider", "item_id");



CREATE UNIQUE INDEX "unique_forecast_per_month" ON "public"."cashflow_forecast" USING "btree" ("business_id", "month");



CREATE UNIQUE INDEX "uq_qbo_backfill_jobs_running" ON "public"."qbo_backfill_jobs" USING "btree" ("business_id", "qbo_env") WHERE ("status" = 'running'::"text");



CREATE INDEX "user_profiles_billing_business_idx" ON "public"."user_profiles" USING "btree" ("billing_business_id");



CREATE INDEX "user_profiles_billing_customer_idx" ON "public"."user_profiles" USING "btree" ("billing_stripe_customer_id");



CREATE INDEX "user_profiles_billing_status_idx" ON "public"."user_profiles" USING "btree" ("billing_subscription_status");



CREATE INDEX "user_profiles_full_name_idx" ON "public"."user_profiles" USING "btree" ("full_name");



CREATE INDEX "vendor_locations_business_idx" ON "public"."vendor_locations" USING "btree" ("business_id");



CREATE INDEX "vendor_locations_business_normalized_vendor_idx" ON "public"."vendor_locations" USING "btree" ("business_id", "normalized_vendor_name");



CREATE INDEX "vendor_rules_business_counterparty_idx" ON "public"."vendor_rules" USING "btree" ("business_id", "counterparty_name");



CREATE INDEX "vendor_rules_business_default_coa_idx" ON "public"."vendor_rules" USING "btree" ("business_id", "default_qbo_account_id");



CREATE UNIQUE INDEX "vendor_rules_business_match_uq" ON "public"."vendor_rules" USING "btree" ("business_id", "match_type", "match_value");



CREATE INDEX "vendor_rules_business_qbo_entity_idx" ON "public"."vendor_rules" USING "btree" ("business_id", "qbo_entity_type", "qbo_entity_id");



CREATE INDEX "vendor_rules_business_rule_kind_idx" ON "public"."vendor_rules" USING "btree" ("business_id", "rule_kind");



CREATE INDEX "vendor_rules_memo_prefix_idx" ON "public"."vendor_rules" USING "btree" ("business_id", "match_value") WHERE ("match_type" = 'memo_prefix'::"text");



CREATE INDEX "vendor_rules_merchant_entity_id_idx" ON "public"."vendor_rules" USING "btree" ("business_id", "match_value") WHERE ("match_type" = 'merchant_entity_id'::"text");



CREATE OR REPLACE TRIGGER "bid_estimate_line_items_set_updated_at" BEFORE UPDATE ON "public"."bid_estimate_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_bid_estimate_line_items_updated_at"();



CREATE OR REPLACE TRIGGER "bid_estimates_set_updated_at" BEFORE UPDATE ON "public"."bid_estimates" FOR EACH ROW EXECUTE FUNCTION "public"."set_bid_estimates_updated_at"();



CREATE OR REPLACE TRIGGER "customer_external_links_set_updated_at" BEFORE UPDATE ON "public"."customer_external_links" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_financial_updated_at"();



CREATE OR REPLACE TRIGGER "customers_set_updated_at" BEFORE UPDATE ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_financial_updated_at"();



CREATE OR REPLACE TRIGGER "employees_set_updated_at" BEFORE UPDATE ON "public"."employees" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_costing_updated_at"();



CREATE OR REPLACE TRIGGER "job_assignment_suggestions_set_updated_at" BEFORE UPDATE ON "public"."job_assignment_suggestions" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_costing_updated_at"();



CREATE OR REPLACE TRIGGER "job_candidates_set_updated_at" BEFORE UPDATE ON "public"."job_candidates" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "job_external_links_set_updated_at" BEFORE UPDATE ON "public"."job_external_links" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_financial_updated_at"();



CREATE OR REPLACE TRIGGER "job_identity_mappings_set_updated_at" BEFORE UPDATE ON "public"."job_identity_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "job_margin_targets_set_updated_at" BEFORE UPDATE ON "public"."job_margin_targets" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_margin_targets_updated_at"();



CREATE OR REPLACE TRIGGER "job_payment_allocations_set_updated_at" BEFORE UPDATE ON "public"."job_payment_allocations" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_financial_updated_at"();



CREATE OR REPLACE TRIGGER "job_payment_records_set_updated_at" BEFORE UPDATE ON "public"."job_payment_records" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_financial_updated_at"();



CREATE OR REPLACE TRIGGER "job_revenue_documents_set_updated_at" BEFORE UPDATE ON "public"."job_revenue_documents" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_financial_updated_at"();



CREATE OR REPLACE TRIGGER "job_revenue_evidence_set_updated_at" BEFORE UPDATE ON "public"."job_revenue_evidence" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_financial_updated_at"();



CREATE OR REPLACE TRIGGER "job_transaction_assignments_set_updated_at_v2" BEFORE UPDATE ON "public"."job_transaction_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_costing_updated_at"();



CREATE OR REPLACE TRIGGER "qbo_customers_set_updated_at" BEFORE UPDATE ON "public"."qbo_customers" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_financial_updated_at"();



CREATE OR REPLACE TRIGGER "trg_ar_followups_updated_at" BEFORE UPDATE ON "public"."ar_followups" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_ar_open_items_updated_at" BEFORE UPDATE ON "public"."ar_open_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_bank_sync_runs_updated_at" BEFORE UPDATE ON "public"."bank_sync_runs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_bank_transactions_updated_at" BEFORE UPDATE ON "public"."bank_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_bizzy_docs_set_updated_at" BEFORE UPDATE ON "public"."bizzy_docs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_bizzy_docs_tsv" BEFORE INSERT OR UPDATE OF "title", "filename", "content" ON "public"."bizzy_docs" FOR EACH ROW EXECUTE FUNCTION "public"."bizzy_docs_tsv_update"();



CREATE OR REPLACE TRIGGER "trg_business_billing_identity_summary" AFTER INSERT OR UPDATE ON "public"."business_billing" FOR EACH ROW EXECUTE FUNCTION "public"."refresh_billing_identity_summary_from_billing"();



CREATE OR REPLACE TRIGGER "trg_business_profiles_billing_identity_summary" AFTER INSERT OR UPDATE OF "business_name", "user_id" ON "public"."business_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."refresh_billing_identity_summary_from_business_profile"();



CREATE OR REPLACE TRIGGER "trg_categorization_rules_updated_at" BEFORE UPDATE ON "public"."categorization_rules" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_clarification_learning_events_updated_at" BEFORE UPDATE ON "public"."clarification_learning_events" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_clarification_requests_updated_at" BEFORE UPDATE ON "public"."clarification_requests" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_email_accounts_updated_at" BEFORE UPDATE ON "public"."email_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_financial_metrics_updated_at" BEFORE UPDATE ON "public"."financial_metrics" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_gpt_messages_after_delete" AFTER DELETE ON "public"."gpt_messages" FOR EACH ROW EXECUTE FUNCTION "public"."gpt_messages_after_delete_trg"();



CREATE OR REPLACE TRIGGER "trg_integration_connections_updated_at" BEFORE UPDATE ON "public"."integration_connections" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_linked_financial_items_updated_at" BEFORE UPDATE ON "public"."linked_financial_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_plaid_accounts_updated_at" BEFORE UPDATE ON "public"."plaid_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_plaid_items_updated_at" BEFORE UPDATE ON "public"."plaid_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_plaid_qbo_account_mappings_updated_at" BEFORE UPDATE ON "public"."plaid_qbo_account_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_prevent_completed_tax_run_mutation" BEFORE DELETE OR UPDATE ON "public"."tax_calculation_runs" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_completed_tax_run_mutation"();



CREATE OR REPLACE TRIGGER "trg_qbo_coa_creations_updated_at" BEFORE UPDATE ON "public"."qbo_coa_creations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_qbo_posted_transactions_updated_at" BEFORE UPDATE ON "public"."qbo_posted_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_qbo_vendor_creations_updated_at" BEFORE UPDATE ON "public"."qbo_vendor_creations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_reconciliation_health_updated_at" BEFORE UPDATE ON "public"."reconciliation_health" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_reconciliation_items_updated_at" BEFORE UPDATE ON "public"."reconciliation_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_reconciliation_runs_updated_at" BEFORE UPDATE ON "public"."reconciliation_runs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_state_tax_rule_configs_updated_at" BEFORE UPDATE ON "public"."state_tax_rule_configs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sync_tax_payment_year_fields" BEFORE INSERT OR UPDATE OF "year", "tax_year" ON "public"."tax_payments" FOR EACH ROW EXECUTE FUNCTION "public"."sync_tax_payment_year_fields"();



CREATE OR REPLACE TRIGGER "trg_tax_adjustments_updated_at" BEFORE UPDATE ON "public"."tax_adjustments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_deadlines_updated_at" BEFORE UPDATE ON "public"."tax_deadlines" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_deduction_rules_updated_at" BEFORE UPDATE ON "public"."tax_deduction_rules" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_payments_updated_at" BEFORE UPDATE ON "public"."tax_payments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_profile_memory_updated_at" BEFORE UPDATE ON "public"."tax_profile_memory" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_profiles_updated_at" BEFORE UPDATE ON "public"."tax_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_projection_scenarios_updated_at" BEFORE UPDATE ON "public"."tax_projection_scenarios" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_recalculation_requests_updated_at" BEFORE UPDATE ON "public"."tax_recalculation_requests" FOR EACH ROW EXECUTE FUNCTION "public"."touch_tax_recalculation_requests_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_reserve_accounts_updated_at" BEFORE UPDATE ON "public"."tax_reserve_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_review_tasks_updated_at" BEFORE UPDATE ON "public"."tax_review_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_rule_configs_updated_at" BEFORE UPDATE ON "public"."tax_rule_configs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tax_snapshots_updated_at" BEFORE UPDATE ON "public"."tax_snapshots" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tc_sync_txn_fields" BEFORE INSERT OR UPDATE OF "business_id", "transaction_id" ON "public"."transaction_categorizations" FOR EACH ROW EXECUTE FUNCTION "public"."tc_sync_txn_fields_from_bank_transactions"();



CREATE OR REPLACE TRIGGER "trg_touch_gpt_thread_updated_at" AFTER INSERT ON "public"."gpt_messages" FOR EACH ROW EXECUTE FUNCTION "public"."touch_gpt_thread_updated_at"();



CREATE OR REPLACE TRIGGER "trg_transaction_categorizations_updated_at" BEFORE UPDATE ON "public"."transaction_categorizations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_transaction_tax_classifications_updated_at" BEFORE UPDATE ON "public"."transaction_tax_classifications" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_user_profiles_billing_identity_summary" AFTER INSERT OR UPDATE OF "email", "first_name", "last_name", "full_name" ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."refresh_billing_identity_summary_from_user_profile"();



CREATE OR REPLACE TRIGGER "trg_user_profiles_full_name" BEFORE INSERT OR UPDATE OF "first_name", "last_name" ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_profiles_full_name"();



CREATE OR REPLACE TRIGGER "trg_vendor_rules_updated_at" BEFORE UPDATE ON "public"."vendor_rules" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "vendor_locations_set_updated_at" BEFORE UPDATE ON "public"."vendor_locations" FOR EACH ROW EXECUTE FUNCTION "public"."set_job_costing_updated_at"();



ALTER TABLE ONLY "public"."affordability_assessments"
    ADD CONSTRAINT "affordability_assessments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id");



ALTER TABLE ONLY "public"."ar_followups"
    ADD CONSTRAINT "ar_followups_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ar_followups"
    ADD CONSTRAINT "ar_followups_open_item_fkey" FOREIGN KEY ("ar_open_item_id") REFERENCES "public"."ar_open_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ar_followups"
    ADD CONSTRAINT "ar_followups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ar_open_items"
    ADD CONSTRAINT "ar_open_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ar_open_items"
    ADD CONSTRAINT "ar_open_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."balance_sheet_history"
    ADD CONSTRAINT "balance_sheet_history_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_sync_runs"
    ADD CONSTRAINT "bank_sync_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_estimate_line_items"
    ADD CONSTRAINT "bid_estimate_line_items_bid_estimate_id_fkey" FOREIGN KEY ("bid_estimate_id") REFERENCES "public"."bid_estimates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bid_outcomes"
    ADD CONSTRAINT "bid_outcomes_bid_estimate_id_fkey" FOREIGN KEY ("bid_estimate_id") REFERENCES "public"."bid_estimates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bizzy_memory"
    ADD CONSTRAINT "bizzy_memory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bizzy_timeline"
    ADD CONSTRAINT "bizzy_timeline_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookkeeping_health"
    ADD CONSTRAINT "bookkeeping_health_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_profiles"
    ADD CONSTRAINT "business_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."categorization_rules"
    ADD CONSTRAINT "categorization_rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clarification_learning_events"
    ADD CONSTRAINT "clarification_learning_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clarification_learning_events"
    ADD CONSTRAINT "clarification_learning_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."clarification_requests"
    ADD CONSTRAINT "clarification_requests_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clarification_requests"
    ADD CONSTRAINT "clarification_requests_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."client_revenue"
    ADD CONSTRAINT "client_revenue_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id");



ALTER TABLE ONLY "public"."client_revenue"
    ADD CONSTRAINT "client_revenue_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id");



ALTER TABLE ONLY "public"."client_revenue"
    ADD CONSTRAINT "client_revenue_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."customer_external_links"
    ADD CONSTRAINT "customer_external_links_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."email_accounts"
    ADD CONSTRAINT "email_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."email_accounts"
    ADD CONSTRAINT "email_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_monthly_review_stamps"
    ADD CONSTRAINT "financial_monthly_review_stamps_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_moves"
    ADD CONSTRAINT "financial_moves_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_moves"
    ADD CONSTRAINT "financial_moves_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_summaries"
    ADD CONSTRAINT "financial_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."goal_tracking"
    ADD CONSTRAINT "goal_tracking_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gpt_messages"
    ADD CONSTRAINT "gpt_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."gpt_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gpt_messages"
    ADD CONSTRAINT "gpt_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gpt_threads"
    ADD CONSTRAINT "gpt_threads_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gpt_threads"
    ADD CONSTRAINT "gpt_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gpt_usage"
    ADD CONSTRAINT "gpt_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insight_reads"
    ADD CONSTRAINT "insight_reads_insight_id_fkey" FOREIGN KEY ("insight_id") REFERENCES "public"."insights"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."integration_connections"
    ADD CONSTRAINT "integration_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_accounts"
    ADD CONSTRAINT "investment_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_balances"
    ADD CONSTRAINT "investment_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_candidates"
    ADD CONSTRAINT "job_candidates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_candidates"
    ADD CONSTRAINT "job_candidates_confirmed_job_id_fkey" FOREIGN KEY ("confirmed_job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_candidates"
    ADD CONSTRAINT "job_candidates_source_customer_id_fkey" FOREIGN KEY ("source_customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_costs"
    ADD CONSTRAINT "job_costs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id");



ALTER TABLE ONLY "public"."job_costs"
    ADD CONSTRAINT "job_costs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id");



ALTER TABLE ONLY "public"."job_costs"
    ADD CONSTRAINT "job_costs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."job_external_links"
    ADD CONSTRAINT "job_external_links_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_identity_mappings"
    ADD CONSTRAINT "job_identity_mappings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_identity_mappings"
    ADD CONSTRAINT "job_identity_mappings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_payment_allocations"
    ADD CONSTRAINT "job_payment_allocations_payment_record_id_fkey" FOREIGN KEY ("payment_record_id") REFERENCES "public"."job_payment_records"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_payment_allocations"
    ADD CONSTRAINT "job_payment_allocations_revenue_document_id_fkey" FOREIGN KEY ("revenue_document_id") REFERENCES "public"."job_revenue_documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_payment_records"
    ADD CONSTRAINT "job_payment_records_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_revenue_documents"
    ADD CONSTRAINT "job_revenue_documents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_revenue_documents"
    ADD CONSTRAINT "job_revenue_documents_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_revenue_evidence"
    ADD CONSTRAINT "job_revenue_evidence_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_revenue_evidence"
    ADD CONSTRAINT "job_revenue_evidence_matched_payment_record_id_fkey" FOREIGN KEY ("matched_payment_record_id") REFERENCES "public"."job_payment_records"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_transaction_assignment_role_backfill_runs"
    ADD CONSTRAINT "job_transaction_assignment_role_backfill_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_transaction_assignments"
    ADD CONSTRAINT "job_transaction_assignments_payment_record_id_fkey" FOREIGN KEY ("payment_record_id") REFERENCES "public"."job_payment_records"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_transaction_assignments"
    ADD CONSTRAINT "job_transaction_assignments_revenue_document_id_fkey" FOREIGN KEY ("revenue_document_id") REFERENCES "public"."job_revenue_documents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_transaction_assignments"
    ADD CONSTRAINT "job_transaction_assignments_revenue_evidence_id_fkey" FOREIGN KEY ("revenue_evidence_id") REFERENCES "public"."job_revenue_evidence"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."kpi_metrics"
    ADD CONSTRAINT "kpi_metrics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."linked_financial_items"
    ADD CONSTRAINT "linked_financial_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_financial_pulse"
    ADD CONSTRAINT "monthly_financial_pulse_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_forecast"
    ADD CONSTRAINT "monthly_forecast_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_forecast"
    ADD CONSTRAINT "monthly_forecast_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_review_audit_events"
    ADD CONSTRAINT "monthly_review_audit_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_review_audit_events"
    ADD CONSTRAINT "monthly_review_audit_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."monthly_review_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_review_reminders"
    ADD CONSTRAINT "monthly_review_reminders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_review_reminders"
    ADD CONSTRAINT "monthly_review_reminders_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."monthly_review_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_review_runs"
    ADD CONSTRAINT "monthly_review_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monthly_review_sections"
    ADD CONSTRAINT "monthly_review_sections_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."monthly_review_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_connection_states"
    ADD CONSTRAINT "oauth_connection_states_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."plaid_accounts"
    ADD CONSTRAINT "plaid_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."plaid_items"
    ADD CONSTRAINT "plaid_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."plaid_items"
    ADD CONSTRAINT "plaid_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."plaid_qbo_account_mappings"
    ADD CONSTRAINT "plaid_qbo_account_mappings_business_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."investment_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_security_id_fkey" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."positions"
    ADD CONSTRAINT "positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."post_gallery"
    ADD CONSTRAINT "post_gallery_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."prices_cache"
    ADD CONSTRAINT "prices_cache_security_id_fkey" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."prompt_usage"
    ADD CONSTRAINT "prompt_usage_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."prompt_usage"
    ADD CONSTRAINT "prompt_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_backfill_jobs"
    ADD CONSTRAINT "qbo_backfill_jobs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_cdc_cursors"
    ADD CONSTRAINT "qbo_cdc_cursors_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_cdc_cursors"
    ADD CONSTRAINT "qbo_cdc_cursors_last_run_id_fkey" FOREIGN KEY ("last_run_id") REFERENCES "public"."qbo_entity_sync_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."qbo_coa_creations"
    ADD CONSTRAINT "qbo_coa_creations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_customers"
    ADD CONSTRAINT "qbo_customers_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."qbo_entity_sync_runs"
    ADD CONSTRAINT "qbo_entity_sync_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_job_costing_backfill_runs"
    ADD CONSTRAINT "qbo_job_costing_backfill_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_job_costing_daily_sync_state"
    ADD CONSTRAINT "qbo_job_costing_daily_sync_state_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_job_costing_daily_sync_state"
    ADD CONSTRAINT "qbo_job_costing_daily_sync_state_last_run_id_fkey" FOREIGN KEY ("last_run_id") REFERENCES "public"."qbo_entity_sync_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."qbo_posted_transactions"
    ADD CONSTRAINT "qbo_posted_transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_posted_transactions"
    ADD CONSTRAINT "qbo_posted_transactions_txn_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_projects"
    ADD CONSTRAINT "qbo_projects_business_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id");



ALTER TABLE ONLY "public"."qbo_projects_capabilities"
    ADD CONSTRAINT "qbo_projects_capabilities_business_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id");



ALTER TABLE ONLY "public"."qbo_projects"
    ADD CONSTRAINT "qbo_projects_customer_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");



ALTER TABLE ONLY "public"."qbo_projects"
    ADD CONSTRAINT "qbo_projects_job_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id");



ALTER TABLE ONLY "public"."qbo_vendor_creations"
    ADD CONSTRAINT "qbo_vendor_creations_business_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."qbo_vendor_creations"
    ADD CONSTRAINT "qbo_vendor_creations_txn_fkey" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."qbo_webhook_events"
    ADD CONSTRAINT "qbo_webhook_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."qbo_webhook_events"
    ADD CONSTRAINT "qbo_webhook_events_superseded_by_event_id_fkey" FOREIGN KEY ("superseded_by_event_id") REFERENCES "public"."qbo_webhook_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."quickbooks_tokens"
    ADD CONSTRAINT "quickbooks_tokens_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reconciliation_health"
    ADD CONSTRAINT "reconciliation_health_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reconciliation_items"
    ADD CONSTRAINT "reconciliation_items_bank_transaction_id_fkey" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reconciliation_items"
    ADD CONSTRAINT "reconciliation_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reconciliation_items"
    ADD CONSTRAINT "reconciliation_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reconciliation_runs"
    ADD CONSTRAINT "reconciliation_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."report_metadata"
    ADD CONSTRAINT "report_metadata_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."report_metadata"
    ADD CONSTRAINT "report_metadata_monthly_review_run_id_fkey" FOREIGN KEY ("monthly_review_run_id") REFERENCES "public"."monthly_review_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_calculation_run_fkey" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."tax_calculation_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_source_transaction_id_fkey" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_calculation_components"
    ADD CONSTRAINT "tax_calculation_components_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_calculation_components"
    ADD CONSTRAINT "tax_calculation_components_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."tax_calculation_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_calculation_nodes"
    ADD CONSTRAINT "tax_calculation_nodes_parent_node_id_fkey" FOREIGN KEY ("parent_node_id") REFERENCES "public"."tax_calculation_nodes"("id");



ALTER TABLE ONLY "public"."tax_calculation_nodes"
    ADD CONSTRAINT "tax_calculation_nodes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."tax_calculation_runs"("id");



ALTER TABLE ONLY "public"."tax_calculation_run_links"
    ADD CONSTRAINT "tax_calculation_run_links_newer_run_id_fkey" FOREIGN KEY ("newer_run_id") REFERENCES "public"."tax_calculation_runs"("id");



ALTER TABLE ONLY "public"."tax_calculation_run_links"
    ADD CONSTRAINT "tax_calculation_run_links_older_run_id_fkey" FOREIGN KEY ("older_run_id") REFERENCES "public"."tax_calculation_runs"("id");



ALTER TABLE ONLY "public"."tax_calculation_runs"
    ADD CONSTRAINT "tax_calculation_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_calculation_runs"
    ADD CONSTRAINT "tax_calculation_runs_tax_profile_id_fkey" FOREIGN KEY ("tax_profile_id") REFERENCES "public"."tax_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_calculation_workpaper_lines"
    ADD CONSTRAINT "tax_calculation_workpaper_lines_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."tax_calculation_workpaper_lines"("id");



ALTER TABLE ONLY "public"."tax_calculation_workpaper_lines"
    ADD CONSTRAINT "tax_calculation_workpaper_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."tax_calculation_runs"("id");



ALTER TABLE ONLY "public"."tax_classification_overrides"
    ADD CONSTRAINT "tax_classification_overrides_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_classification_overrides"
    ADD CONSTRAINT "tax_classification_overrides_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "public"."transaction_tax_classifications"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_classification_overrides"
    ADD CONSTRAINT "tax_classification_overrides_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_deadlines"
    ADD CONSTRAINT "tax_deadlines_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_deduction_rules"
    ADD CONSTRAINT "tax_deduction_rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_payments"
    ADD CONSTRAINT "tax_payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_profile_memory"
    ADD CONSTRAINT "tax_profile_memory_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_profiles"
    ADD CONSTRAINT "tax_profiles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_projection_scenarios"
    ADD CONSTRAINT "tax_projection_scenarios_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_projection_scenarios"
    ADD CONSTRAINT "tax_projection_scenarios_latest_calculation_run_id_fkey" FOREIGN KEY ("latest_calculation_run_id") REFERENCES "public"."tax_calculation_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_projection_scenarios"
    ADD CONSTRAINT "tax_projection_scenarios_tax_profile_id_fkey" FOREIGN KEY ("tax_profile_id") REFERENCES "public"."tax_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_recalculation_requests"
    ADD CONSTRAINT "tax_recalculation_requests_calculation_run_id_fkey" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."tax_calculation_runs"("id");



ALTER TABLE ONLY "public"."tax_reserve_accounts"
    ADD CONSTRAINT "tax_reserve_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_reserve_snapshots"
    ADD CONSTRAINT "tax_reserve_snapshots_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_reserve_snapshots"
    ADD CONSTRAINT "tax_reserve_snapshots_calculation_run_id_fkey" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."tax_calculation_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_reserve_snapshots"
    ADD CONSTRAINT "tax_reserve_snapshots_reserve_account_id_fkey" FOREIGN KEY ("reserve_account_id") REFERENCES "public"."tax_reserve_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tax_review_tasks"
    ADD CONSTRAINT "tax_review_tasks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_snapshots"
    ADD CONSTRAINT "tax_snapshots_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tax_snapshots"
    ADD CONSTRAINT "tax_snapshots_calculation_run_fkey" FOREIGN KEY ("calculation_run_id") REFERENCES "public"."tax_calculation_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."transaction_categorizations"
    ADD CONSTRAINT "transaction_categorizations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transaction_categorizations"
    ADD CONSTRAINT "transaction_categorizations_txn_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transaction_tax_classifications"
    ADD CONSTRAINT "transaction_tax_classifications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transaction_tax_classifications"
    ADD CONSTRAINT "transaction_tax_classifications_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."tax_deduction_rules"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."transaction_tax_classifications"
    ADD CONSTRAINT "transaction_tax_classifications_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_business_link"
    ADD CONSTRAINT "user_business_link_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_business_link"
    ADD CONSTRAINT "user_business_link_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_rules"
    ADD CONSTRAINT "vendor_rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."business_profiles"("id") ON DELETE CASCADE;



CREATE POLICY "Allow Inserts for Logged-In Users" ON "public"."gpt_messages" FOR INSERT WITH CHECK (true);



CREATE POLICY "Allow access to own client revenue" ON "public"."client_revenue" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow access to own job costs" ON "public"."job_costs" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow delete own posts" ON "public"."post_gallery" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow insert from server only" ON "public"."cashflow_forecast" FOR INSERT WITH CHECK (true);



CREATE POLICY "Allow insert own posts" ON "public"."post_gallery" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow owner to select their business link" ON "public"."user_business_link" FOR SELECT TO "authenticated" USING ((("auth"."uid"() = "user_id") AND ("role" = 'owner'::"text")));



CREATE POLICY "Allow read/write for job owner" ON "public"."jobs" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow select for own GPT usage" ON "public"."gpt_usage" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow select own posts" ON "public"."post_gallery" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow update own posts" ON "public"."post_gallery" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow user to read own forecasts" ON "public"."cashflow_forecast" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Allow users to read their own GPT usage" ON "public"."gpt_usage" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Business owner can insert billing" ON "public"."business_billing" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "business_billing"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "Business owner can read billing" ON "public"."business_billing" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "business_billing"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "Business owner can update billing" ON "public"."business_billing" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "business_billing"."business_id") AND ("bp"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "business_billing"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "Can read their forecast" ON "public"."monthly_forecast" FOR SELECT USING (("business_id" = "auth"."uid"()));



CREATE POLICY "Enable insert for authenticated users only" ON "public"."bizzy_memory" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Enable insert for authenticated users only" ON "public"."business_profiles" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Enable insert for authenticated users only" ON "public"."user_business_link" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Enable insert for users based on user_id" ON "public"."bizzy_memory" FOR INSERT WITH CHECK (true);



CREATE POLICY "User can manage their own business profile" ON "public"."business_profiles" USING (true);



CREATE POLICY "Users can access deadlines for their business" ON "public"."tax_deadlines" USING (("business_id" IN ( SELECT "user_business_link"."business_id"
   FROM "public"."user_business_link"
  WHERE ("user_business_link"."user_id" = "auth"."uid"()))));



CREATE POLICY "Users can access their own meetings" ON "public"."meetings" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can access their own memory" ON "public"."bizzy_memory" USING (true) WITH CHECK (true);



CREATE POLICY "Users can access their own notifications" ON "public"."notifications" USING (true);



CREATE POLICY "Users can access their own profile" ON "public"."profiles" USING (true);



CREATE POLICY "Users can access their own scenarios" ON "public"."scenarios" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own KPI metrics" ON "public"."kpi_metrics" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own prompt usage" ON "public"."prompt_usage" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can read and update their own usage" ON "public"."gpt_usage" USING (true) WITH CHECK (true);



CREATE POLICY "Users can read completed monthly review stamps for their busine" ON "public"."financial_monthly_review_stamps" FOR SELECT TO "authenticated" USING ((("status" = ANY (ARRAY['completed'::"text", 'closed'::"text", 'finalized'::"text"])) AND (EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "financial_monthly_review_stamps"."business_id") AND ("ubl"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can read their own financial moves" ON "public"."financial_moves" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can read their own pulse data" ON "public"."monthly_financial_pulse" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own KPI metrics" ON "public"."kpi_metrics" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view COA creations for their business" ON "public"."qbo_coa_creations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "qbo_coa_creations"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view their own business reports" ON "public"."report_metadata" FOR SELECT USING (("auth"."uid"() IN ( SELECT "business_profiles"."user_id"
   FROM "public"."business_profiles"
  WHERE ("report_metadata"."business_id" = "report_metadata"."business_id"))));



CREATE POLICY "Users can view their own prompt usage" ON "public"."prompt_usage" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."ar_followups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assignment_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bid_estimate_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bid_estimates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bid_outcomes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bizzy_docs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bizzy_memory" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bizzy_timeline" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookkeeping_post_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_billing" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cashflow_forecast" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clarification_learning_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clarification_learning_events_delete_own_business" ON "public"."clarification_learning_events" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_learning_events"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "clarification_learning_events_insert_own_business" ON "public"."clarification_learning_events" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_learning_events"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "clarification_learning_events_select_own_business" ON "public"."clarification_learning_events" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_learning_events"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "clarification_learning_events_update_own_business" ON "public"."clarification_learning_events" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_learning_events"."business_id") AND ("bp"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_learning_events"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."clarification_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clarification_requests_delete_own_business" ON "public"."clarification_requests" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_requests"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "clarification_requests_insert_own_business" ON "public"."clarification_requests" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_requests"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "clarification_requests_select_own_business" ON "public"."clarification_requests" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_requests"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "clarification_requests_update_own_business" ON "public"."clarification_requests" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_requests"."business_id") AND ("bp"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "clarification_requests"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."client_revenue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contractor_cfo_insight_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customer_external_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delete_docs_if_owner" ON "public"."bizzy_docs" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "bizzy_docs"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "docs_delete" ON "public"."bizzy_docs" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "docs_insert" ON "public"."bizzy_docs" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "docs_select" ON "public"."bizzy_docs" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "docs_update" ON "public"."bizzy_docs" FOR UPDATE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."email_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_accounts_delete_own" ON "public"."email_accounts" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "email_accounts_insert_own" ON "public"."email_accounts" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "email_accounts_select_own" ON "public"."email_accounts" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "email_accounts_update_own" ON "public"."email_accounts" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."employees" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_monthly_review_stamps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_moves" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_summaries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."goal_tracking" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gpt_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gpt_messages_insert" ON "public"."gpt_messages" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."gpt_threads" "t"
  WHERE (("t"."id" = "gpt_messages"."thread_id") AND "public"."is_member"("t"."user_id", "t"."business_id")))));



CREATE POLICY "gpt_messages_select" ON "public"."gpt_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."gpt_threads" "t"
  WHERE (("t"."id" = "gpt_messages"."thread_id") AND "public"."is_member"("t"."user_id", "t"."business_id")))));



ALTER TABLE "public"."gpt_threads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gpt_threads_insert" ON "public"."gpt_threads" FOR INSERT WITH CHECK ("public"."is_member"("user_id", "business_id"));



CREATE POLICY "gpt_threads_select" ON "public"."gpt_threads" FOR SELECT USING ("public"."is_member"("user_id", "business_id"));



ALTER TABLE "public"."gpt_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insert_docs_if_owner" ON "public"."bizzy_docs" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "bizzy_docs"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."insight_feedback" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."insights" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insights_select_any" ON "public"."insights" FOR SELECT USING (true);



CREATE POLICY "jc_tenant_delete" ON "public"."assignment_history" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."customer_external_links" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."customers" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_assignment_instruction_history" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_assignment_suggestions" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_candidates" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_costing_realm_integrity_conflicts" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_external_links" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_identity_mappings" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_payment_allocations" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_payment_records" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_revenue_documents" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_revenue_evidence" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."job_transaction_assignments" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."qbo_cdc_cursors" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."qbo_customers" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."qbo_entity_sync_runs" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."qbo_job_costing_backfill_runs" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."qbo_job_costing_daily_sync_state" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."qbo_projects" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."qbo_projects_capabilities" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_delete" ON "public"."qbo_webhook_events" FOR DELETE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."assignment_history" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."customer_external_links" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."customers" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_assignment_instruction_history" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_assignment_suggestions" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_candidates" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_costing_realm_integrity_conflicts" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_external_links" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_identity_mappings" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_payment_allocations" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_payment_records" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_revenue_documents" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_revenue_evidence" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."job_transaction_assignments" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."qbo_cdc_cursors" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."qbo_customers" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."qbo_entity_sync_runs" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."qbo_job_costing_backfill_runs" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."qbo_job_costing_daily_sync_state" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."qbo_projects" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."qbo_projects_capabilities" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_insert" ON "public"."qbo_webhook_events" FOR INSERT TO "authenticated" WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."assignment_history" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."customer_external_links" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."customers" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_assignment_instruction_history" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_assignment_suggestions" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_candidates" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_costing_realm_integrity_conflicts" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_external_links" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_identity_mappings" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_payment_allocations" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_payment_records" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_revenue_documents" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_revenue_evidence" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."job_transaction_assignments" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."qbo_cdc_cursors" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."qbo_customers" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."qbo_entity_sync_runs" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."qbo_job_costing_backfill_runs" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."qbo_job_costing_daily_sync_state" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."qbo_projects" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."qbo_projects_capabilities" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_select" ON "public"."qbo_webhook_events" FOR SELECT TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."assignment_history" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."customer_external_links" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."customers" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_assignment_instruction_history" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_assignment_suggestions" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_candidates" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_costing_realm_integrity_conflicts" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_external_links" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_identity_mappings" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_payment_allocations" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_payment_records" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_revenue_documents" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_revenue_evidence" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."job_transaction_assignments" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."qbo_cdc_cursors" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."qbo_customers" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."qbo_entity_sync_runs" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."qbo_job_costing_backfill_runs" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."qbo_job_costing_daily_sync_state" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."qbo_projects" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."qbo_projects_capabilities" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



CREATE POLICY "jc_tenant_update" ON "public"."qbo_webhook_events" FOR UPDATE TO "authenticated" USING ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id"))) WITH CHECK ((("business_id" IS NOT NULL) AND "public"."tax_user_owns_business"("business_id")));



ALTER TABLE "public"."job_assignment_instruction_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_assignment_suggestions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_candidates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_change_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_costing_realm_integrity_conflicts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_costs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_employees" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_external_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_identity_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_margin_targets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_payment_allocations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_payment_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_revenue_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_revenue_evidence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_transaction_assignment_role_backfill_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_transaction_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kpi_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meetings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monthly_financial_pulse" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monthly_review_audit_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monthly_review_reminders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monthly_review_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monthly_review_sections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "msgs_delete" ON "public"."gpt_messages" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM ("public"."gpt_threads" "t"
     JOIN "public"."user_business_link" "l" ON (("l"."business_id" = "t"."business_id")))
  WHERE (("t"."id" = "gpt_messages"."thread_id") AND ("l"."user_id" = "auth"."uid"())))));



CREATE POLICY "msgs_insert" ON "public"."gpt_messages" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."gpt_threads" "t"
     JOIN "public"."user_business_link" "l" ON (("l"."business_id" = "t"."business_id")))
  WHERE (("t"."id" = "gpt_messages"."thread_id") AND ("l"."user_id" = "auth"."uid"())))));



CREATE POLICY "msgs_read" ON "public"."gpt_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."gpt_threads" "t"
     JOIN "public"."user_business_link" "l" ON (("l"."business_id" = "t"."business_id")))
  WHERE (("t"."id" = "gpt_messages"."thread_id") AND ("l"."user_id" = "auth"."uid"())))));



CREATE POLICY "msgs_update" ON "public"."gpt_messages" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."gpt_threads" "t"
     JOIN "public"."user_business_link" "l" ON (("l"."business_id" = "t"."business_id")))
  WHERE (("t"."id" = "gpt_messages"."thread_id") AND ("l"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."gpt_threads" "t"
     JOIN "public"."user_business_link" "l" ON (("l"."business_id" = "t"."business_id")))
  WHERE (("t"."id" = "gpt_messages"."thread_id") AND ("l"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_connection_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."post_gallery" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prompt_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "prompt_usage_insert_self" ON "public"."prompt_usage" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "prompt_usage_select_self" ON "public"."prompt_usage" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."qbo_cdc_cursors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_coa_creations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_entity_sync_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_job_costing_backfill_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_job_costing_daily_sync_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_projects_capabilities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_vendor_creations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "qbo_vendor_creations_read" ON "public"."qbo_vendor_creations" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "qbo_vendor_creations"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."qbo_webhook_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "read_messages" ON "public"."gpt_messages" FOR SELECT USING (("thread_id" IN ( SELECT "gpt_threads"."id"
   FROM "public"."gpt_threads"
  WHERE ("gpt_threads"."business_id" IN ( SELECT "user_business_link"."business_id"
           FROM "public"."user_business_link"
          WHERE ("user_business_link"."user_id" = "auth"."uid"()))))));



CREATE POLICY "read_threads" ON "public"."gpt_threads" FOR SELECT USING (("business_id" IN ( SELECT "user_business_link"."business_id"
   FROM "public"."user_business_link"
  WHERE ("user_business_link"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."reconciliation_health" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reconciliation_health_insert" ON "public"."reconciliation_health" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "reconciliation_health"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



CREATE POLICY "reconciliation_health_read" ON "public"."reconciliation_health" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "reconciliation_health"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



CREATE POLICY "reconciliation_health_update" ON "public"."reconciliation_health" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "reconciliation_health"."business_id") AND ("ubl"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "reconciliation_health"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."reconciliation_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reconciliation_items_read" ON "public"."reconciliation_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "reconciliation_items"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."reconciliation_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reconciliation_runs_read" ON "public"."reconciliation_runs" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "reconciliation_runs"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."report_metadata" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scenarios" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scheduled_job_locks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "select_docs_if_owner" ON "public"."bizzy_docs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "bizzy_docs"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."state_tax_rule_configs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_adjustments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_calculation_components" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_calculation_nodes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tax_calculation_nodes_business_isolation_select" ON "public"."tax_calculation_nodes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "tax_calculation_nodes"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."tax_calculation_run_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_calculation_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_calculation_workpaper_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_classification_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_deadlines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tax_deadlines_read" ON "public"."tax_deadlines" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."tax_deduction_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tax_payments_mod" ON "public"."tax_payments" USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "tax_payments"."business_id") AND ("ubl"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "tax_payments"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



CREATE POLICY "tax_payments_select" ON "public"."tax_payments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "ubl"
  WHERE (("ubl"."business_id" = "tax_payments"."business_id") AND ("ubl"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."tax_profile_memory" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_projection_scenarios" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_recalculation_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_reserve_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_reserve_policy_configs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_reserve_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_review_tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_rule_configs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_scheduler_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tax_state_rates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tax_state_rates_read" ON "public"."tax_state_rates" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "tax_workpaper_lines_business_isolation_select" ON "public"."tax_calculation_workpaper_lines" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "tax_calculation_workpaper_lines"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



CREATE POLICY "threads_delete" ON "public"."gpt_threads" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "l"
  WHERE (("l"."user_id" = "auth"."uid"()) AND ("l"."business_id" = "gpt_threads"."business_id")))));



CREATE POLICY "threads_insert" ON "public"."gpt_threads" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "l"
  WHERE (("l"."user_id" = "auth"."uid"()) AND ("l"."business_id" = "gpt_threads"."business_id")))));



CREATE POLICY "threads_read" ON "public"."gpt_threads" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "l"
  WHERE (("l"."user_id" = "auth"."uid"()) AND ("l"."business_id" = "gpt_threads"."business_id")))));



CREATE POLICY "threads_update" ON "public"."gpt_threads" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "l"
  WHERE (("l"."user_id" = "auth"."uid"()) AND ("l"."business_id" = "gpt_threads"."business_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_business_link" "l"
  WHERE (("l"."user_id" = "auth"."uid"()) AND ("l"."business_id" = "gpt_threads"."business_id")))));



ALTER TABLE "public"."transaction_tax_classifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "update_docs_if_owner" ON "public"."bizzy_docs" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."business_profiles" "bp"
  WHERE (("bp"."id" = "bizzy_docs"."business_id") AND ("bp"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."user_business_link" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_profiles_insert_own" ON "public"."user_profiles" FOR INSERT TO "authenticated" WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "user_profiles_select_own" ON "public"."user_profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "user_profiles_update_own" ON "public"."user_profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



ALTER TABLE "public"."vendor_locations" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "text", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "text", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "text", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "uuid", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "uuid", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."acquire_posting_lock"("p_business_id" "uuid", "p_transaction_id" "uuid", "p_now_iso" timestamp with time zone, "p_lock_stale_seconds" integer, "p_idempotency_key" "text") TO "service_role";



GRANT ALL ON TABLE "public"."transaction_tax_classifications" TO "anon";
GRANT ALL ON TABLE "public"."transaction_tax_classifications" TO "authenticated";
GRANT ALL ON TABLE "public"."transaction_tax_classifications" TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_tax_classification_override"("p_business_id" "uuid", "p_tax_year" integer, "p_transaction_id" "uuid", "p_actor_user_id" "uuid", "p_override_source" "text", "p_override_reason" "text", "p_tax_category" "text", "p_deductibility_status" "text", "p_deductible_percent" numeric, "p_tax_treatment" "jsonb", "p_classification_status" "text", "p_book_amount" numeric, "p_deductible_amount" numeric, "p_nondeductible_amount" numeric, "p_capitalizable_amount" numeric, "p_confidence_score" numeric, "p_confidence_level" "text", "p_source" "text", "p_requires_review" boolean, "p_reason" "text", "p_user_override" boolean, "p_cpa_override" boolean, "p_expected_updated_at" timestamp with time zone, "p_metadata" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_tax_classification_override"("p_business_id" "uuid", "p_tax_year" integer, "p_transaction_id" "uuid", "p_actor_user_id" "uuid", "p_override_source" "text", "p_override_reason" "text", "p_tax_category" "text", "p_deductibility_status" "text", "p_deductible_percent" numeric, "p_tax_treatment" "jsonb", "p_classification_status" "text", "p_book_amount" numeric, "p_deductible_amount" numeric, "p_nondeductible_amount" numeric, "p_capitalizable_amount" numeric, "p_confidence_score" numeric, "p_confidence_level" "text", "p_source" "text", "p_requires_review" boolean, "p_reason" "text", "p_user_override" boolean, "p_cpa_override" boolean, "p_expected_updated_at" timestamp with time zone, "p_metadata" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_tax_classification_override"("p_business_id" "uuid", "p_tax_year" integer, "p_transaction_id" "uuid", "p_actor_user_id" "uuid", "p_override_source" "text", "p_override_reason" "text", "p_tax_category" "text", "p_deductibility_status" "text", "p_deductible_percent" numeric, "p_tax_treatment" "jsonb", "p_classification_status" "text", "p_book_amount" numeric, "p_deductible_amount" numeric, "p_nondeductible_amount" numeric, "p_capitalizable_amount" numeric, "p_confidence_score" numeric, "p_confidence_level" "text", "p_source" "text", "p_requires_review" boolean, "p_reason" "text", "p_user_override" boolean, "p_cpa_override" boolean, "p_expected_updated_at" timestamp with time zone, "p_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_tax_classification_override"("p_business_id" "uuid", "p_tax_year" integer, "p_transaction_id" "uuid", "p_actor_user_id" "uuid", "p_override_source" "text", "p_override_reason" "text", "p_tax_category" "text", "p_deductibility_status" "text", "p_deductible_percent" numeric, "p_tax_treatment" "jsonb", "p_classification_status" "text", "p_book_amount" numeric, "p_deductible_amount" numeric, "p_nondeductible_amount" numeric, "p_capitalizable_amount" numeric, "p_confidence_score" numeric, "p_confidence_level" "text", "p_source" "text", "p_requires_review" boolean, "p_reason" "text", "p_user_override" boolean, "p_cpa_override" boolean, "p_expected_updated_at" timestamp with time zone, "p_metadata" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."billing_effective_bool"("p_legacy_value" boolean, "p_live_value" boolean, "p_test_value" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."billing_effective_bool"("p_legacy_value" boolean, "p_live_value" boolean, "p_test_value" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."billing_effective_bool"("p_legacy_value" boolean, "p_live_value" boolean, "p_test_value" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."billing_effective_status"("p_legacy_status" "text", "p_live_status" "text", "p_test_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."billing_effective_status"("p_legacy_status" "text", "p_live_status" "text", "p_test_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."billing_effective_status"("p_legacy_status" "text", "p_live_status" "text", "p_test_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."billing_effective_text"("p_legacy_value" "text", "p_live_value" "text", "p_test_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."billing_effective_text"("p_legacy_value" "text", "p_live_value" "text", "p_test_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."billing_effective_text"("p_legacy_value" "text", "p_live_value" "text", "p_test_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."billing_effective_timestamptz"("p_legacy_value" timestamp with time zone, "p_live_value" timestamp with time zone, "p_test_value" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."billing_effective_timestamptz"("p_legacy_value" timestamp with time zone, "p_live_value" timestamp with time zone, "p_test_value" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."billing_effective_timestamptz"("p_legacy_value" timestamp with time zone, "p_live_value" timestamp with time zone, "p_test_value" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."bizzy_docs_tsv_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."bizzy_docs_tsv_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bizzy_docs_tsv_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_contractor_cfo_insight_run"("p_run_key" "text", "p_scheduled_for" timestamp with time zone, "p_lock_owner" "text", "p_lock_ttl_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_contractor_cfo_insight_run"("p_run_key" "text", "p_scheduled_for" timestamp with time zone, "p_lock_owner" "text", "p_lock_ttl_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_contractor_cfo_insight_run"("p_run_key" "text", "p_scheduled_for" timestamp with time zone, "p_lock_owner" "text", "p_lock_ttl_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_scheduled_job_lock"("p_job_key" "text", "p_scheduled_for" timestamp with time zone, "p_locked_by" "text", "p_lock_ttl_seconds" integer, "p_metadata" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_scheduled_job_lock"("p_job_key" "text", "p_scheduled_for" timestamp with time zone, "p_locked_by" "text", "p_lock_ttl_seconds" integer, "p_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_scheduled_job_lock"("p_job_key" "text", "p_scheduled_for" timestamp with time zone, "p_locked_by" "text", "p_lock_ttl_seconds" integer, "p_metadata" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."tax_recalculation_requests" TO "anon";
GRANT ALL ON TABLE "public"."tax_recalculation_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_recalculation_requests" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_tax_recalculation_requests"("p_worker_id" "text", "p_batch_size" integer, "p_now" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_tax_recalculation_requests"("p_worker_id" "text", "p_batch_size" integer, "p_now" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_tax_recalculation_requests"("p_worker_id" "text", "p_batch_size" integer, "p_now" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."compute_days_overdue"("due_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."compute_days_overdue"("due_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_days_overdue"("due_date" "date") TO "service_role";



GRANT ALL ON TABLE "public"."tax_calculation_runs" TO "anon";
GRANT ALL ON TABLE "public"."tax_calculation_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_calculation_runs" TO "service_role";



REVOKE ALL ON FUNCTION "public"."finalize_tax_calculation_run"("p_run_id" "uuid", "p_business_id" "uuid", "p_status" "text", "p_completion_type" "text", "p_summary" "jsonb", "p_components" "jsonb", "p_assumptions" "jsonb", "p_warnings" "jsonb", "p_missing_inputs" "jsonb", "p_source_freshness" "jsonb", "p_confidence_score" numeric, "p_supersedes_run_id" "uuid", "p_supersession_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_tax_calculation_run"("p_run_id" "uuid", "p_business_id" "uuid", "p_status" "text", "p_completion_type" "text", "p_summary" "jsonb", "p_components" "jsonb", "p_assumptions" "jsonb", "p_warnings" "jsonb", "p_missing_inputs" "jsonb", "p_source_freshness" "jsonb", "p_confidence_score" numeric, "p_supersedes_run_id" "uuid", "p_supersession_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tax_deduction_transaction_drilldown"("p_business_id" "uuid", "p_tax_year" integer, "p_as_of_date" "date", "p_tax_category" "text", "p_month" "text", "p_deductibility_status" "text", "p_classification_status" "text", "p_confidence_level" "text", "p_qbo_account_id" "text", "p_merchant" "text", "p_search" "text", "p_min_amount" numeric, "p_max_amount" numeric, "p_sort" "text", "p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_tax_deduction_transaction_drilldown"("p_business_id" "uuid", "p_tax_year" integer, "p_as_of_date" "date", "p_tax_category" "text", "p_month" "text", "p_deductibility_status" "text", "p_classification_status" "text", "p_confidence_level" "text", "p_qbo_account_id" "text", "p_merchant" "text", "p_search" "text", "p_min_amount" numeric, "p_max_amount" numeric, "p_sort" "text", "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tax_deduction_transaction_drilldown"("p_business_id" "uuid", "p_tax_year" integer, "p_as_of_date" "date", "p_tax_category" "text", "p_month" "text", "p_deductibility_status" "text", "p_classification_status" "text", "p_confidence_level" "text", "p_qbo_account_id" "text", "p_merchant" "text", "p_search" "text", "p_min_amount" numeric, "p_max_amount" numeric, "p_sort" "text", "p_limit" integer, "p_offset" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."gpt_messages_after_delete_trg"() TO "anon";
GRANT ALL ON FUNCTION "public"."gpt_messages_after_delete_trg"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."gpt_messages_after_delete_trg"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_confirmed_auth_user_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_confirmed_auth_user_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_confirmed_auth_user_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_member"("p_user" "uuid", "p_business" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_member"("p_user" "uuid", "p_business" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_member"("p_user" "uuid", "p_business" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_bizzy_memory"("user_uuid" "uuid", "query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "tag_filter" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."match_bizzy_memory"("user_uuid" "uuid", "query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "tag_filter" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_bizzy_memory"("user_uuid" "uuid", "query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "tag_filter" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_memories"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_memories"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_memories"("query_embedding" "public"."vector", "match_user_id" "uuid", "match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_completed_tax_run_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_completed_tax_run_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_completed_tax_run_mutation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."recalc_thread_last_message"("p_thread" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."recalc_thread_last_message"("p_thread" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."recalc_thread_last_message"("p_thread" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_billing_identity_summary"("p_business_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_billing_identity_summary"("p_business_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_billing_identity_summary_from_billing"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_billing_identity_summary_from_billing"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_billing_identity_summary_from_business_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_billing_identity_summary_from_business_profile"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_billing_identity_summary_from_user_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_billing_identity_summary_from_user_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_bid_estimate_line_items_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_bid_estimate_line_items_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_bid_estimate_line_items_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_bid_estimates_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_bid_estimates_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_bid_estimates_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_job_costing_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_job_costing_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_job_costing_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_job_financial_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_job_financial_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_job_financial_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_job_margin_targets_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_job_margin_targets_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_job_margin_targets_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_job_transaction_assignments_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_job_transaction_assignments_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_job_transaction_assignments_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_user_profiles_full_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_user_profiles_full_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_user_profiles_full_name"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_tax_payment_year_fields"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_tax_payment_year_fields"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_tax_payment_year_fields"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."tax_user_owns_business"("p_business_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tax_user_owns_business"("p_business_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."tax_user_owns_business"("p_business_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."tc_sync_txn_fields_from_bank_transactions"() TO "anon";
GRANT ALL ON FUNCTION "public"."tc_sync_txn_fields_from_bank_transactions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tc_sync_txn_fields_from_bank_transactions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_gpt_thread_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_gpt_thread_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_gpt_thread_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_tax_recalculation_requests_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_tax_recalculation_requests_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_tax_recalculation_requests_updated_at"() TO "service_role";



GRANT ALL ON TABLE "public"."account_breakdown" TO "anon";
GRANT ALL ON TABLE "public"."account_breakdown" TO "authenticated";
GRANT ALL ON TABLE "public"."account_breakdown" TO "service_role";



GRANT ALL ON TABLE "public"."affordability_assessments" TO "anon";
GRANT ALL ON TABLE "public"."affordability_assessments" TO "authenticated";
GRANT ALL ON TABLE "public"."affordability_assessments" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."ar_aging" TO "anon";
GRANT ALL ON TABLE "public"."ar_aging" TO "authenticated";
GRANT ALL ON TABLE "public"."ar_aging" TO "service_role";



GRANT ALL ON TABLE "public"."ar_open_items" TO "anon";
GRANT ALL ON TABLE "public"."ar_open_items" TO "authenticated";
GRANT ALL ON TABLE "public"."ar_open_items" TO "service_role";



GRANT ALL ON TABLE "public"."ar_aging_v2" TO "anon";
GRANT ALL ON TABLE "public"."ar_aging_v2" TO "authenticated";
GRANT ALL ON TABLE "public"."ar_aging_v2" TO "service_role";



GRANT ALL ON TABLE "public"."ar_followups" TO "anon";
GRANT ALL ON TABLE "public"."ar_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."ar_followups" TO "service_role";



GRANT ALL ON TABLE "public"."assignment_history" TO "anon";
GRANT ALL ON TABLE "public"."assignment_history" TO "authenticated";
GRANT ALL ON TABLE "public"."assignment_history" TO "service_role";



GRANT ALL ON TABLE "public"."balance_sheet_history" TO "anon";
GRANT ALL ON TABLE "public"."balance_sheet_history" TO "authenticated";
GRANT ALL ON TABLE "public"."balance_sheet_history" TO "service_role";



GRANT ALL ON TABLE "public"."bank_sync_runs" TO "anon";
GRANT ALL ON TABLE "public"."bank_sync_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_sync_runs" TO "service_role";



GRANT ALL ON TABLE "public"."bank_transactions" TO "anon";
GRANT ALL ON TABLE "public"."bank_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."bid_estimate_line_items" TO "anon";
GRANT ALL ON TABLE "public"."bid_estimate_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_estimate_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."bid_estimates" TO "anon";
GRANT ALL ON TABLE "public"."bid_estimates" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_estimates" TO "service_role";



GRANT ALL ON TABLE "public"."bid_outcomes" TO "anon";
GRANT ALL ON TABLE "public"."bid_outcomes" TO "authenticated";
GRANT ALL ON TABLE "public"."bid_outcomes" TO "service_role";



GRANT ALL ON TABLE "public"."business_billing" TO "anon";
GRANT ALL ON TABLE "public"."business_billing" TO "authenticated";
GRANT ALL ON TABLE "public"."business_billing" TO "service_role";



GRANT ALL ON TABLE "public"."billing_customer_overview" TO "service_role";



GRANT ALL ON TABLE "public"."billing_customers" TO "anon";
GRANT ALL ON TABLE "public"."billing_customers" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_customers" TO "service_role";



GRANT ALL ON TABLE "public"."bizzy_deadlines" TO "anon";
GRANT ALL ON TABLE "public"."bizzy_deadlines" TO "authenticated";
GRANT ALL ON TABLE "public"."bizzy_deadlines" TO "service_role";



GRANT ALL ON TABLE "public"."bizzy_docs" TO "anon";
GRANT ALL ON TABLE "public"."bizzy_docs" TO "authenticated";
GRANT ALL ON TABLE "public"."bizzy_docs" TO "service_role";



GRANT ALL ON TABLE "public"."bizzy_headlines" TO "anon";
GRANT ALL ON TABLE "public"."bizzy_headlines" TO "authenticated";
GRANT ALL ON TABLE "public"."bizzy_headlines" TO "service_role";



GRANT ALL ON TABLE "public"."bizzy_memory" TO "anon";
GRANT ALL ON TABLE "public"."bizzy_memory" TO "authenticated";
GRANT ALL ON TABLE "public"."bizzy_memory" TO "service_role";



GRANT ALL ON TABLE "public"."bizzy_timeline" TO "anon";
GRANT ALL ON TABLE "public"."bizzy_timeline" TO "authenticated";
GRANT ALL ON TABLE "public"."bizzy_timeline" TO "service_role";



GRANT ALL ON TABLE "public"."bookkeeping_health" TO "anon";
GRANT ALL ON TABLE "public"."bookkeeping_health" TO "authenticated";
GRANT ALL ON TABLE "public"."bookkeeping_health" TO "service_role";



GRANT ALL ON TABLE "public"."bookkeeping_post_attempts" TO "anon";
GRANT ALL ON TABLE "public"."bookkeeping_post_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."bookkeeping_post_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."business_profiles" TO "anon";
GRANT ALL ON TABLE "public"."business_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."business_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_events" TO "service_role";



GRANT ALL ON TABLE "public"."cashflow_forecast" TO "anon";
GRANT ALL ON TABLE "public"."cashflow_forecast" TO "authenticated";
GRANT ALL ON TABLE "public"."cashflow_forecast" TO "service_role";



GRANT ALL ON TABLE "public"."categorization_rules" TO "anon";
GRANT ALL ON TABLE "public"."categorization_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."categorization_rules" TO "service_role";



GRANT ALL ON TABLE "public"."clarification_learning_events" TO "anon";
GRANT ALL ON TABLE "public"."clarification_learning_events" TO "authenticated";
GRANT ALL ON TABLE "public"."clarification_learning_events" TO "service_role";



GRANT ALL ON TABLE "public"."clarification_requests" TO "anon";
GRANT ALL ON TABLE "public"."clarification_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."clarification_requests" TO "service_role";



GRANT ALL ON TABLE "public"."client_revenue" TO "anon";
GRANT ALL ON TABLE "public"."client_revenue" TO "authenticated";
GRANT ALL ON TABLE "public"."client_revenue" TO "service_role";



GRANT ALL ON TABLE "public"."contractor_cfo_insight_runs" TO "anon";
GRANT ALL ON TABLE "public"."contractor_cfo_insight_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."contractor_cfo_insight_runs" TO "service_role";



GRANT ALL ON TABLE "public"."customer_external_links" TO "anon";
GRANT ALL ON TABLE "public"."customer_external_links" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_external_links" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON TABLE "public"."email_accounts" TO "anon";
GRANT ALL ON TABLE "public"."email_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."email_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."employees" TO "anon";
GRANT ALL ON TABLE "public"."employees" TO "authenticated";
GRANT ALL ON TABLE "public"."employees" TO "service_role";



GRANT ALL ON TABLE "public"."job_costs" TO "anon";
GRANT ALL ON TABLE "public"."job_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."job_costs" TO "service_role";



GRANT ALL ON TABLE "public"."expense_categories" TO "anon";
GRANT ALL ON TABLE "public"."expense_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."expense_categories" TO "service_role";



GRANT ALL ON TABLE "public"."expense_category_map" TO "anon";
GRANT ALL ON TABLE "public"."expense_category_map" TO "authenticated";
GRANT ALL ON TABLE "public"."expense_category_map" TO "service_role";



GRANT ALL ON SEQUENCE "public"."expense_category_map_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."expense_category_map_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."expense_category_map_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."expense_totals_monthly" TO "anon";
GRANT ALL ON TABLE "public"."expense_totals_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."expense_totals_monthly" TO "service_role";



GRANT ALL ON SEQUENCE "public"."expense_totals_monthly_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."expense_totals_monthly_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."expense_totals_monthly_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."financial_metrics" TO "anon";
GRANT ALL ON TABLE "public"."financial_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."financial_monthly_review_stamps" TO "anon";
GRANT ALL ON TABLE "public"."financial_monthly_review_stamps" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_monthly_review_stamps" TO "service_role";



GRANT ALL ON TABLE "public"."financial_moves" TO "anon";
GRANT ALL ON TABLE "public"."financial_moves" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_moves" TO "service_role";



GRANT ALL ON TABLE "public"."financial_summaries" TO "anon";
GRANT ALL ON TABLE "public"."financial_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."goal_tracking" TO "anon";
GRANT ALL ON TABLE "public"."goal_tracking" TO "authenticated";
GRANT ALL ON TABLE "public"."goal_tracking" TO "service_role";



GRANT ALL ON TABLE "public"."gpt_messages" TO "anon";
GRANT ALL ON TABLE "public"."gpt_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."gpt_messages" TO "service_role";



GRANT ALL ON TABLE "public"."gpt_messages_backup" TO "anon";
GRANT ALL ON TABLE "public"."gpt_messages_backup" TO "authenticated";
GRANT ALL ON TABLE "public"."gpt_messages_backup" TO "service_role";



GRANT ALL ON TABLE "public"."gpt_threads" TO "anon";
GRANT ALL ON TABLE "public"."gpt_threads" TO "authenticated";
GRANT ALL ON TABLE "public"."gpt_threads" TO "service_role";



GRANT ALL ON TABLE "public"."gpt_usage" TO "anon";
GRANT ALL ON TABLE "public"."gpt_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."gpt_usage" TO "service_role";



GRANT ALL ON TABLE "public"."insight_feedback" TO "anon";
GRANT ALL ON TABLE "public"."insight_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."insight_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."insight_preferences" TO "anon";
GRANT ALL ON TABLE "public"."insight_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."insight_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."insight_reads" TO "anon";
GRANT ALL ON TABLE "public"."insight_reads" TO "authenticated";
GRANT ALL ON TABLE "public"."insight_reads" TO "service_role";



GRANT ALL ON TABLE "public"."insights" TO "anon";
GRANT ALL ON TABLE "public"."insights" TO "authenticated";
GRANT ALL ON TABLE "public"."insights" TO "service_role";



GRANT ALL ON TABLE "public"."insights_history" TO "anon";
GRANT ALL ON TABLE "public"."insights_history" TO "authenticated";
GRANT ALL ON TABLE "public"."insights_history" TO "service_role";



GRANT ALL ON TABLE "public"."integration_connections" TO "anon";
GRANT ALL ON TABLE "public"."integration_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."integration_connections" TO "service_role";



GRANT ALL ON TABLE "public"."investment_accounts" TO "anon";
GRANT ALL ON TABLE "public"."investment_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."investment_balances" TO "anon";
GRANT ALL ON TABLE "public"."investment_balances" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_balances" TO "service_role";



GRANT ALL ON TABLE "public"."job_assignment_instruction_history" TO "anon";
GRANT ALL ON TABLE "public"."job_assignment_instruction_history" TO "authenticated";
GRANT ALL ON TABLE "public"."job_assignment_instruction_history" TO "service_role";



GRANT ALL ON TABLE "public"."job_assignment_suggestions" TO "anon";
GRANT ALL ON TABLE "public"."job_assignment_suggestions" TO "authenticated";
GRANT ALL ON TABLE "public"."job_assignment_suggestions" TO "service_role";



GRANT ALL ON TABLE "public"."job_candidates" TO "anon";
GRANT ALL ON TABLE "public"."job_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."job_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."job_change_orders" TO "anon";
GRANT ALL ON TABLE "public"."job_change_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."job_change_orders" TO "service_role";



GRANT ALL ON TABLE "public"."job_costing_realm_integrity_conflicts" TO "anon";
GRANT ALL ON TABLE "public"."job_costing_realm_integrity_conflicts" TO "authenticated";
GRANT ALL ON TABLE "public"."job_costing_realm_integrity_conflicts" TO "service_role";



GRANT ALL ON TABLE "public"."job_employees" TO "anon";
GRANT ALL ON TABLE "public"."job_employees" TO "authenticated";
GRANT ALL ON TABLE "public"."job_employees" TO "service_role";



GRANT ALL ON TABLE "public"."job_external_links" TO "anon";
GRANT ALL ON TABLE "public"."job_external_links" TO "authenticated";
GRANT ALL ON TABLE "public"."job_external_links" TO "service_role";



GRANT ALL ON TABLE "public"."job_identity_mappings" TO "anon";
GRANT ALL ON TABLE "public"."job_identity_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."job_identity_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."job_margin_targets" TO "anon";
GRANT ALL ON TABLE "public"."job_margin_targets" TO "authenticated";
GRANT ALL ON TABLE "public"."job_margin_targets" TO "service_role";



GRANT ALL ON TABLE "public"."job_payment_allocations" TO "anon";
GRANT ALL ON TABLE "public"."job_payment_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."job_payment_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."job_payment_records" TO "anon";
GRANT ALL ON TABLE "public"."job_payment_records" TO "authenticated";
GRANT ALL ON TABLE "public"."job_payment_records" TO "service_role";



GRANT ALL ON TABLE "public"."job_revenue_documents" TO "anon";
GRANT ALL ON TABLE "public"."job_revenue_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."job_revenue_documents" TO "service_role";



GRANT ALL ON TABLE "public"."job_revenue_evidence" TO "anon";
GRANT ALL ON TABLE "public"."job_revenue_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."job_revenue_evidence" TO "service_role";



GRANT ALL ON TABLE "public"."job_transaction_assignment_role_backfill_runs" TO "anon";
GRANT ALL ON TABLE "public"."job_transaction_assignment_role_backfill_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."job_transaction_assignment_role_backfill_runs" TO "service_role";



GRANT ALL ON TABLE "public"."job_transaction_assignments" TO "anon";
GRANT ALL ON TABLE "public"."job_transaction_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."job_transaction_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON TABLE "public"."jobs_profitability" TO "anon";
GRANT ALL ON TABLE "public"."jobs_profitability" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs_profitability" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_metrics" TO "anon";
GRANT ALL ON TABLE "public"."kpi_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."linked_financial_items" TO "anon";
GRANT ALL ON TABLE "public"."linked_financial_items" TO "authenticated";
GRANT ALL ON TABLE "public"."linked_financial_items" TO "service_role";



GRANT ALL ON TABLE "public"."meetings" TO "anon";
GRANT ALL ON TABLE "public"."meetings" TO "authenticated";
GRANT ALL ON TABLE "public"."meetings" TO "service_role";



GRANT ALL ON TABLE "public"."monthly_financial_pulse" TO "anon";
GRANT ALL ON TABLE "public"."monthly_financial_pulse" TO "authenticated";
GRANT ALL ON TABLE "public"."monthly_financial_pulse" TO "service_role";



GRANT ALL ON TABLE "public"."monthly_forecast" TO "anon";
GRANT ALL ON TABLE "public"."monthly_forecast" TO "authenticated";
GRANT ALL ON TABLE "public"."monthly_forecast" TO "service_role";



GRANT ALL ON TABLE "public"."monthly_review_audit_events" TO "anon";
GRANT ALL ON TABLE "public"."monthly_review_audit_events" TO "authenticated";
GRANT ALL ON TABLE "public"."monthly_review_audit_events" TO "service_role";



GRANT ALL ON TABLE "public"."monthly_review_reminders" TO "anon";
GRANT ALL ON TABLE "public"."monthly_review_reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."monthly_review_reminders" TO "service_role";



GRANT ALL ON TABLE "public"."monthly_review_runs" TO "anon";
GRANT ALL ON TABLE "public"."monthly_review_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."monthly_review_runs" TO "service_role";



GRANT ALL ON TABLE "public"."monthly_review_sections" TO "anon";
GRANT ALL ON TABLE "public"."monthly_review_sections" TO "authenticated";
GRANT ALL ON TABLE "public"."monthly_review_sections" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_connection_states" TO "anon";
GRANT ALL ON TABLE "public"."oauth_connection_states" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_connection_states" TO "service_role";



GRANT ALL ON TABLE "public"."plaid_accounts" TO "anon";
GRANT ALL ON TABLE "public"."plaid_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."plaid_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."plaid_items" TO "anon";
GRANT ALL ON TABLE "public"."plaid_items" TO "authenticated";
GRANT ALL ON TABLE "public"."plaid_items" TO "service_role";



GRANT ALL ON TABLE "public"."plaid_qbo_account_mappings" TO "anon";
GRANT ALL ON TABLE "public"."plaid_qbo_account_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."plaid_qbo_account_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."positions" TO "anon";
GRANT ALL ON TABLE "public"."positions" TO "authenticated";
GRANT ALL ON TABLE "public"."positions" TO "service_role";



GRANT ALL ON TABLE "public"."prices_cache" TO "anon";
GRANT ALL ON TABLE "public"."prices_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."prices_cache" TO "service_role";



GRANT ALL ON TABLE "public"."securities" TO "anon";
GRANT ALL ON TABLE "public"."securities" TO "authenticated";
GRANT ALL ON TABLE "public"."securities" TO "service_role";



GRANT ALL ON TABLE "public"."positions_view" TO "anon";
GRANT ALL ON TABLE "public"."positions_view" TO "authenticated";
GRANT ALL ON TABLE "public"."positions_view" TO "service_role";



GRANT ALL ON TABLE "public"."post_gallery" TO "anon";
GRANT ALL ON TABLE "public"."post_gallery" TO "authenticated";
GRANT ALL ON TABLE "public"."post_gallery" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."prompt_usage" TO "anon";
GRANT ALL ON TABLE "public"."prompt_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."prompt_usage" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_backfill_jobs" TO "anon";
GRANT ALL ON TABLE "public"."qbo_backfill_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_backfill_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_cdc_cursors" TO "anon";
GRANT ALL ON TABLE "public"."qbo_cdc_cursors" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_cdc_cursors" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_coa_creations" TO "anon";
GRANT ALL ON TABLE "public"."qbo_coa_creations" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_coa_creations" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_customers" TO "anon";
GRANT ALL ON TABLE "public"."qbo_customers" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_customers" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_entity_sync_runs" TO "anon";
GRANT ALL ON TABLE "public"."qbo_entity_sync_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_entity_sync_runs" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_job_costing_backfill_runs" TO "anon";
GRANT ALL ON TABLE "public"."qbo_job_costing_backfill_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_job_costing_backfill_runs" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_job_costing_daily_sync_state" TO "anon";
GRANT ALL ON TABLE "public"."qbo_job_costing_daily_sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_job_costing_daily_sync_state" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_posted_transactions" TO "anon";
GRANT ALL ON TABLE "public"."qbo_posted_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_posted_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_projects" TO "anon";
GRANT ALL ON TABLE "public"."qbo_projects" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_projects" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_projects_capabilities" TO "anon";
GRANT ALL ON TABLE "public"."qbo_projects_capabilities" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_projects_capabilities" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_vendor_creations" TO "anon";
GRANT ALL ON TABLE "public"."qbo_vendor_creations" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_vendor_creations" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."qbo_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."quickbooks_tokens" TO "anon";
GRANT ALL ON TABLE "public"."quickbooks_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."quickbooks_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."reconciliation_health" TO "anon";
GRANT ALL ON TABLE "public"."reconciliation_health" TO "authenticated";
GRANT ALL ON TABLE "public"."reconciliation_health" TO "service_role";



GRANT ALL ON TABLE "public"."reconciliation_items" TO "anon";
GRANT ALL ON TABLE "public"."reconciliation_items" TO "authenticated";
GRANT ALL ON TABLE "public"."reconciliation_items" TO "service_role";



GRANT ALL ON TABLE "public"."reconciliation_runs" TO "anon";
GRANT ALL ON TABLE "public"."reconciliation_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."reconciliation_runs" TO "service_role";



GRANT ALL ON TABLE "public"."report_metadata" TO "anon";
GRANT ALL ON TABLE "public"."report_metadata" TO "authenticated";
GRANT ALL ON TABLE "public"."report_metadata" TO "service_role";



GRANT ALL ON TABLE "public"."review_sources" TO "anon";
GRANT ALL ON TABLE "public"."review_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."review_sources" TO "service_role";



GRANT ALL ON TABLE "public"."scenarios" TO "anon";
GRANT ALL ON TABLE "public"."scenarios" TO "authenticated";
GRANT ALL ON TABLE "public"."scenarios" TO "service_role";



GRANT ALL ON TABLE "public"."scheduled_job_locks" TO "anon";
GRANT ALL ON TABLE "public"."scheduled_job_locks" TO "authenticated";
GRANT ALL ON TABLE "public"."scheduled_job_locks" TO "service_role";



GRANT ALL ON TABLE "public"."state_tax_rule_configs" TO "anon";
GRANT ALL ON TABLE "public"."state_tax_rule_configs" TO "authenticated";
GRANT ALL ON TABLE "public"."state_tax_rule_configs" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."tax_adjustments" TO "anon";
GRANT ALL ON TABLE "public"."tax_adjustments" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_adjustments" TO "service_role";



GRANT ALL ON TABLE "public"."tax_calculation_components" TO "anon";
GRANT ALL ON TABLE "public"."tax_calculation_components" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_calculation_components" TO "service_role";



GRANT ALL ON TABLE "public"."tax_calculation_nodes" TO "anon";
GRANT ALL ON TABLE "public"."tax_calculation_nodes" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_calculation_nodes" TO "service_role";



GRANT ALL ON TABLE "public"."tax_calculation_run_links" TO "anon";
GRANT ALL ON TABLE "public"."tax_calculation_run_links" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_calculation_run_links" TO "service_role";



GRANT ALL ON TABLE "public"."tax_calculation_workpaper_lines" TO "anon";
GRANT ALL ON TABLE "public"."tax_calculation_workpaper_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_calculation_workpaper_lines" TO "service_role";



GRANT ALL ON TABLE "public"."tax_classification_overrides" TO "anon";
GRANT ALL ON TABLE "public"."tax_classification_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_classification_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."tax_deadlines" TO "anon";
GRANT ALL ON TABLE "public"."tax_deadlines" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_deadlines" TO "service_role";



GRANT ALL ON TABLE "public"."tax_deduction_rules" TO "anon";
GRANT ALL ON TABLE "public"."tax_deduction_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_deduction_rules" TO "service_role";



GRANT ALL ON TABLE "public"."tax_payments" TO "anon";
GRANT ALL ON TABLE "public"."tax_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_payments" TO "service_role";



GRANT ALL ON TABLE "public"."tax_profile_memory" TO "anon";
GRANT ALL ON TABLE "public"."tax_profile_memory" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_profile_memory" TO "service_role";



GRANT ALL ON TABLE "public"."tax_profiles" TO "anon";
GRANT ALL ON TABLE "public"."tax_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."tax_projection_scenarios" TO "anon";
GRANT ALL ON TABLE "public"."tax_projection_scenarios" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_projection_scenarios" TO "service_role";



GRANT ALL ON TABLE "public"."tax_reserve_accounts" TO "anon";
GRANT ALL ON TABLE "public"."tax_reserve_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_reserve_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."tax_reserve_policy_configs" TO "anon";
GRANT ALL ON TABLE "public"."tax_reserve_policy_configs" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_reserve_policy_configs" TO "service_role";



GRANT ALL ON TABLE "public"."tax_reserve_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."tax_reserve_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_reserve_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."tax_review_tasks" TO "anon";
GRANT ALL ON TABLE "public"."tax_review_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_review_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."tax_rule_configs" TO "anon";
GRANT ALL ON TABLE "public"."tax_rule_configs" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_rule_configs" TO "service_role";



GRANT ALL ON TABLE "public"."tax_scheduler_runs" TO "anon";
GRANT ALL ON TABLE "public"."tax_scheduler_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_scheduler_runs" TO "service_role";



GRANT ALL ON TABLE "public"."tax_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."tax_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_snapshots" TO "service_role";



GRANT ALL ON SEQUENCE "public"."tax_snapshots_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."tax_snapshots_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."tax_snapshots_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."tax_state_rates" TO "anon";
GRANT ALL ON TABLE "public"."tax_state_rates" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_state_rates" TO "service_role";



GRANT ALL ON TABLE "public"."transaction_categorizations" TO "anon";
GRANT ALL ON TABLE "public"."transaction_categorizations" TO "authenticated";
GRANT ALL ON TABLE "public"."transaction_categorizations" TO "service_role";



GRANT ALL ON TABLE "public"."user_business_link" TO "anon";
GRANT ALL ON TABLE "public"."user_business_link" TO "authenticated";
GRANT ALL ON TABLE "public"."user_business_link" TO "service_role";



GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_locations" TO "anon";
GRANT ALL ON TABLE "public"."vendor_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_locations" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_rules" TO "anon";
GRANT ALL ON TABLE "public"."vendor_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_rules" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";






