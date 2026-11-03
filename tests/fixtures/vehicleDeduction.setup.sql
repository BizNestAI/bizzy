-- Synthetic schema for exercising the real grouped/preview/vehicle commands.
-- Isolated disposable PostgreSQL only; never run against an application database.
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
create table public.business_profiles(id uuid primary key);
create table public.bank_transactions(id uuid primary key,business_id uuid,pending boolean default false,is_archived boolean default false);
create table public.transaction_tax_classifications(
 id uuid primary key default gen_random_uuid(),business_id uuid,transaction_id uuid,tax_year integer,
 source_qbo_account_id text, tax_category text,deductibility_status text,deductible_percent numeric,
 book_amount numeric,deductible_amount numeric default 0,nondeductible_amount numeric default 0,capitalizable_amount numeric default 0,
 tax_treatment jsonb,classification_status text,confidence_score numeric,confidence_level text,source text,
 requires_review boolean,reason text,user_override boolean default false,cpa_override boolean default false,
 metadata jsonb default '{}',rule_version text,rule_code text,updated_at timestamptz default now());
create table public.tax_deduction_rules(
 id uuid primary key default gen_random_uuid(),business_id uuid,scope text,rule_code text,tax_year integer,jurisdiction text,entity_type text,
 bookkeeping_category text,qbo_account_type text,qbo_account_subtype text,match_conditions jsonb,tax_category text,deductibility_status text,
 default_deductible_percent numeric,treatment jsonb,requires_review boolean,priority integer,explanation text,source_reference text,source_url text,
 verified_at timestamptz,effective_from date,effective_to date,is_active boolean,version text,updated_at timestamptz default now());
create table public.tax_classification_overrides(id uuid default gen_random_uuid(),business_id uuid,tax_year integer,transaction_id uuid,
 classification_id uuid,previous_values jsonb,new_values jsonb,override_source text,override_reason text,overridden_by uuid,created_at timestamptz);
create table public.tax_review_tasks(id uuid default gen_random_uuid(),business_id uuid,dedupe_key text,status text,resolved_by uuid,resolved_at timestamptz,updated_at timestamptz);
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
