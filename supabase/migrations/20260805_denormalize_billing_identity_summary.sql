-- Make billing rows easier to inspect in Supabase without changing the source of truth.
-- business_billing remains the canonical billing table for the app.

alter table public.business_billing
  add column if not exists business_name text,
  add column if not exists customer_user_id uuid,
  add column if not exists customer_email text,
  add column if not exists customer_full_name text,
  add column if not exists billing_display_status text,
  add column if not exists billing_display_plan_type text;

create index if not exists business_billing_business_name_idx
  on public.business_billing using btree (business_name);

create index if not exists business_billing_customer_user_idx
  on public.business_billing using btree (customer_user_id);

create index if not exists business_billing_customer_email_idx
  on public.business_billing using btree (customer_email);

create index if not exists business_billing_display_status_idx
  on public.business_billing using btree (billing_display_status);

alter table public.user_profiles
  add column if not exists billing_business_id uuid,
  add column if not exists billing_business_name text,
  add column if not exists billing_stripe_customer_id text,
  add column if not exists billing_stripe_subscription_id text,
  add column if not exists billing_subscription_status text,
  add column if not exists billing_plan_type text,
  add column if not exists billing_current_period_end timestamp with time zone,
  add column if not exists billing_updated_at timestamp with time zone;

create index if not exists user_profiles_billing_business_idx
  on public.user_profiles using btree (billing_business_id);

create index if not exists user_profiles_billing_customer_idx
  on public.user_profiles using btree (billing_stripe_customer_id);

create index if not exists user_profiles_billing_status_idx
  on public.user_profiles using btree (billing_subscription_status);

alter table public.subscriptions
  add column if not exists business_name text,
  add column if not exists customer_email text,
  add column if not exists customer_full_name text,
  add column if not exists plan_type text,
  add column if not exists plan_price_id text,
  add column if not exists cancel_at_period_end boolean,
  add column if not exists trial_end timestamp with time zone,
  add column if not exists last_invoice_status text;

create unique index if not exists subscriptions_business_id_key
  on public.subscriptions using btree (business_id);

create index if not exists subscriptions_status_idx
  on public.subscriptions using btree (status);

create or replace function public.billing_effective_status(
  p_legacy_status text,
  p_live_status text,
  p_test_status text
)
returns text
language sql
immutable
as $$
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

create or replace function public.billing_effective_text(
  p_legacy_value text,
  p_live_value text,
  p_test_value text
)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(p_live_value, ''),
    nullif(p_test_value, ''),
    nullif(p_legacy_value, '')
  );
$$;

create or replace function public.billing_effective_timestamptz(
  p_legacy_value timestamp with time zone,
  p_live_value timestamp with time zone,
  p_test_value timestamp with time zone
)
returns timestamp with time zone
language sql
immutable
as $$
  select coalesce(p_live_value, p_test_value, p_legacy_value);
$$;

create or replace function public.billing_effective_bool(
  p_legacy_value boolean,
  p_live_value boolean,
  p_test_value boolean
)
returns boolean
language sql
immutable
as $$
  select coalesce(p_live_value, p_test_value, p_legacy_value, false);
$$;

create or replace function public.refresh_billing_identity_summary(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

create or replace function public.refresh_billing_identity_summary_from_billing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  perform public.refresh_billing_identity_summary(new.business_id);
  return new;
end;
$$;

drop trigger if exists trg_business_billing_identity_summary on public.business_billing;
create trigger trg_business_billing_identity_summary
after insert or update on public.business_billing
for each row
execute function public.refresh_billing_identity_summary_from_billing();

create or replace function public.refresh_billing_identity_summary_from_business_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_billing_identity_summary(new.id);
  return new;
end;
$$;

drop trigger if exists trg_business_profiles_billing_identity_summary on public.business_profiles;
create trigger trg_business_profiles_billing_identity_summary
after insert or update of business_name, user_id on public.business_profiles
for each row
execute function public.refresh_billing_identity_summary_from_business_profile();

create or replace function public.refresh_billing_identity_summary_from_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

drop trigger if exists trg_user_profiles_billing_identity_summary on public.user_profiles;
create trigger trg_user_profiles_billing_identity_summary
after insert or update of email, first_name, last_name, full_name on public.user_profiles
for each row
execute function public.refresh_billing_identity_summary_from_user_profile();

do $$
declare
  billing_row record;
begin
  for billing_row in
    select business_id from public.business_billing
  loop
    perform public.refresh_billing_identity_summary(billing_row.business_id);
  end loop;
end;
$$;

create or replace view public.billing_customer_overview as
select
  bb.business_id,
  bb.business_name,
  bb.customer_user_id as user_id,
  bb.customer_full_name,
  bb.customer_email,
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
  public.billing_effective_text(
    bb.plan_price_id,
    bb.plan_price_id_live,
    bb.plan_price_id_test
  ) as plan_price_id,
  public.billing_effective_timestamptz(
    bb.current_period_end,
    bb.current_period_end_live,
    bb.current_period_end_test
  ) as current_period_end,
  public.billing_effective_bool(
    bb.cancel_at_period_end,
    bb.cancel_at_period_end_live,
    bb.cancel_at_period_end_test
  ) as cancel_at_period_end,
  public.billing_effective_text(
    bb.last_invoice_status,
    bb.last_invoice_status_live,
    bb.last_invoice_status_test
  ) as last_invoice_status,
  bb.updated_at
from public.business_billing bb;

revoke all on public.billing_customer_overview from public, anon, authenticated;

revoke execute on function public.refresh_billing_identity_summary(uuid) from public, anon, authenticated;
revoke execute on function public.refresh_billing_identity_summary_from_billing() from public, anon, authenticated;
revoke execute on function public.refresh_billing_identity_summary_from_business_profile() from public, anon, authenticated;
revoke execute on function public.refresh_billing_identity_summary_from_user_profile() from public, anon, authenticated;
