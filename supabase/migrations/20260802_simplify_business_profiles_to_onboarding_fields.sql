-- Simplify business_profiles to the fields collected on the current onboarding page.
-- Page fields: business_name, industry, team_size, annual_revenue, founded_year,
-- state, services_offered, billing_model, top_challenge.

alter table public.business_profiles
  add column if not exists top_challenge text;

update public.business_profiles
set
  annual_revenue = coalesce(annual_revenue, annual_revenue_band),
  billing_model = coalesce(billing_model, profile_meta ->> 'billing_model'),
  top_challenge = coalesce(top_challenge, profile_meta ->> 'top_challenge'),
  founded_year = coalesce(
    founded_year,
    case
      when (profile_meta ->> 'founded_year') ~ '^\d{4}$'
        then (profile_meta ->> 'founded_year')::integer
      else null
    end
  ),
  services_offered = coalesce(services_offered, '')
where
  annual_revenue is null
  or billing_model is null
  or top_challenge is null
  or founded_year is null
  or services_offered is null;

alter table public.business_profiles
  alter column services_offered set not null;

alter table public.business_profiles
  drop constraint if exists business_profiles_job_costing_revenue_basis_check;

alter table public.business_profiles
  drop column if exists timezone,
  drop column if exists logo_url,
  drop column if exists created_at,
  drop column if exists location,
  drop column if exists annual_revenue_band,
  drop column if exists operating_area,
  drop column if exists service_radius,
  drop column if exists average_job_size,
  drop column if exists accounting_stack,
  drop column if exists ops_platform,
  drop column if exists marketing_channels,
  drop column if exists primary_channel,
  drop column if exists accept_sample_data,
  drop column if exists google_review_link,
  drop column if exists facebook_page_url,
  drop column if exists owner_name,
  drop column if exists owner_role,
  drop column if exists website_url,
  drop column if exists insights_focus,
  drop column if exists profile_meta,
  drop column if exists has_viewed_integrations_page,
  drop column if exists onboarding_completed_once,
  drop column if exists job_costing_revenue_basis;
