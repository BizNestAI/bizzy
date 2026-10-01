-- One-business-per-subscription authority hardening.
-- Run scripts/preflight/one_business_per_subscription.sql before this migration.
-- This migration intentionally fails on ambiguous duplicates; it never repairs ownership.

begin;

alter table public.business_billing
  add column if not exists stripe_event_created_at_live timestamptz,
  add column if not exists stripe_event_created_at_test timestamptz,
  add column if not exists stripe_event_id_live text,
  add column if not exists stripe_event_id_test text;

create or replace function public.prevent_stale_stripe_entitlement_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
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
$$;
drop trigger if exists trg_business_billing_stale_stripe_event on public.business_billing;
create trigger trg_business_billing_stale_stripe_event
before update on public.business_billing for each row
execute function public.prevent_stale_stripe_entitlement_update();
revoke all on function public.prevent_stale_stripe_entitlement_update() from public, anon, authenticated;

do $$
begin
  if exists (
    select 1 from public.business_billing
    where stripe_subscription_id_live is not null
    group by stripe_subscription_id_live having count(*) > 1
  ) then
    raise exception 'ENTITLEMENT_PREFLIGHT_FAILED: duplicate live Stripe subscription ids';
  end if;
  if exists (
    select 1 from public.business_billing
    where stripe_subscription_id_test is not null
    group by stripe_subscription_id_test having count(*) > 1
  ) then
    raise exception 'ENTITLEMENT_PREFLIGHT_FAILED: duplicate test Stripe subscription ids';
  end if;
  if exists (
    select 1 from public.business_billing
    where stripe_subscription_id is not null
    group by stripe_subscription_id having count(*) > 1
  ) then
    raise exception 'ENTITLEMENT_PREFLIGHT_FAILED: duplicate legacy Stripe subscription ids';
  end if;
  if exists (
    select 1
    from public.business_billing legacy
    join public.business_billing canonical
      on canonical.stripe_subscription_id_live = legacy.stripe_subscription_id
     and canonical.business_id <> legacy.business_id
    where legacy.stripe_subscription_id is not null
  ) then
    raise exception 'ENTITLEMENT_PREFLIGHT_FAILED: legacy/live Stripe subscription reused across businesses';
  end if;
  if exists (
    select 1
    from public.business_billing legacy
    join public.business_billing canonical
      on canonical.stripe_subscription_id_test = legacy.stripe_subscription_id
     and canonical.business_id <> legacy.business_id
    where legacy.stripe_subscription_id is not null
  ) then
    raise exception 'ENTITLEMENT_PREFLIGHT_FAILED: legacy/test Stripe subscription reused across businesses';
  end if;
  if exists (
    select 1 from public.business_billing
    where stripe_subscription_id is not null
      and ((stripe_subscription_id_live is not null and stripe_subscription_id_live <> stripe_subscription_id)
        or (stripe_subscription_id_test is not null and stripe_subscription_id_test <> stripe_subscription_id))
  ) then
    raise exception 'ENTITLEMENT_PREFLIGHT_FAILED: legacy/canonical Stripe identity mismatch';
  end if;
end $$;

-- Legacy billing rows predate environment-specific columns and represent the
-- production Stripe integration. Backfill only rows with no canonical mode
-- identity; a populated test identity makes the legacy environment ambiguous.
update public.business_billing
set stripe_customer_id_live = stripe_customer_id,
    stripe_subscription_id_live = stripe_subscription_id,
    subscription_status_live = subscription_status,
    plan_price_id_live = plan_price_id,
    current_period_end_live = current_period_end,
    trial_end_live = trial_end,
    cancel_at_period_end_live = cancel_at_period_end,
    last_invoice_status_live = last_invoice_status,
    canceled_at_live = canceled_at,
    last_invoice_id_live = last_invoice_id,
    last_payment_failed_at_live = last_payment_failed_at,
    plan_type_live = plan_type
where stripe_subscription_id is not null
  and stripe_subscription_id_live is null
  and stripe_subscription_id_test is null;

create unique index if not exists business_billing_live_subscription_uidx
  on public.business_billing (stripe_subscription_id_live)
  where stripe_subscription_id_live is not null;
create unique index if not exists business_billing_test_subscription_uidx
  on public.business_billing (stripe_subscription_id_test)
  where stripe_subscription_id_test is not null;
create unique index if not exists business_billing_legacy_subscription_uidx
  on public.business_billing (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- A Stripe Customer may intentionally own multiple subscriptions/businesses. Customer IDs
-- therefore remain indexed, not unique; subscription IDs are the entitlement cardinality key.
create index if not exists business_billing_live_customer_idx
  on public.business_billing (stripe_customer_id_live)
  where stripe_customer_id_live is not null;
create index if not exists business_billing_test_customer_idx
  on public.business_billing (stripe_customer_id_test)
  where stripe_customer_id_test is not null;

drop policy if exists "Business owner can insert billing" on public.business_billing;
drop policy if exists "Business owner can update billing" on public.business_billing;
revoke insert, update, delete, truncate, references, trigger
  on table public.business_billing from anon, authenticated;
revoke all on table public.subscriptions from public, anon, authenticated;
grant all on table public.business_billing to service_role;
grant all on table public.subscriptions to service_role;

-- Read access remains tenant-scoped for compatibility. It does not establish authority;
-- all paid backend operations resolve this row through service-role middleware.
drop policy if exists "Business owner can read billing" on public.business_billing;
drop policy if exists business_billing_member_read on public.business_billing;
create policy business_billing_member_read
  on public.business_billing for select to authenticated
  using (public.bizzi_current_user_is_business_member(business_id));
grant select on table public.business_billing to authenticated;
revoke all on table public.business_billing from anon;

-- Membership identity is unique and browser membership creation remains unavailable.
do $$
begin
  if exists (
    select 1 from public.user_business_link
    where user_id is not null and business_id is not null
    group by user_id, business_id having count(*) > 1
  ) then
    raise exception 'MEMBERSHIP_PREFLIGHT_FAILED: duplicate user/business memberships';
  end if;
end $$;
create unique index if not exists user_business_link_user_business_uidx
  on public.user_business_link (user_id, business_id)
  where user_id is not null and business_id is not null;

commit;
