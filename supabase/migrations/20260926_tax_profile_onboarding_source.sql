-- Allow canonical Tax Profile rows completed through onboarding to preserve source provenance.
-- Forward-only contract migration. Does not create profiles, classifications, or calculations.

do $$
declare
  unexpected_sources text[];
begin
  select coalesce(array_agg(distinct source order by source), array[]::text[])
    into unexpected_sources
  from public.tax_profiles
  where source is not null
    and source not in ('user', 'onboarding', 'cpa', 'imported', 'inferred', 'system');

  if array_length(unexpected_sources, 1) is not null then
    raise exception 'Unexpected tax_profiles.source values: %', unexpected_sources;
  end if;
end;
$$;

alter table public.tax_profiles
  drop constraint if exists tax_profiles_source_check;

alter table public.tax_profiles
  add constraint tax_profiles_source_check
  check (source in ('user', 'onboarding', 'cpa', 'imported', 'inferred', 'system'));

comment on column public.tax_profiles.source is
  'Canonical source of Tax Profile facts. onboarding means the required Tax Profile fields were collected during business onboarding; it does not imply a tax calculation has run.';
