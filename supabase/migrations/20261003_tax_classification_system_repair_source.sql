begin;

do $$
declare
  v_constraint_expr text;
  v_unexpected_count integer;
begin
  if to_regclass('public.tax_classification_overrides') is null then
    raise exception 'tax_classification_overrides_missing';
  end if;

  select regexp_replace(pg_get_expr(c.conbin, c.conrelid), '\s+', ' ', 'g')
  into v_constraint_expr
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'public'
    and r.relname = 'tax_classification_overrides'
    and c.conname = 'tax_classification_overrides_source_check'
    and c.contype = 'c';

  if v_constraint_expr is null then
    raise exception 'tax_classification_overrides_source_check_missing';
  end if;

  if v_constraint_expr <> '(override_source = ANY (ARRAY[''user''::text, ''cpa''::text, ''admin''::text, ''system_correction''::text]))' then
    raise exception 'tax_classification_overrides_source_check_unexpected: %', v_constraint_expr;
  end if;

  select count(*)::integer
  into v_unexpected_count
  from public.tax_classification_overrides
  where override_source is null
     or override_source not in ('user', 'cpa', 'admin', 'system_correction');

  if v_unexpected_count <> 0 then
    raise exception 'tax_classification_overrides_source_values_unexpected: %', v_unexpected_count;
  end if;
end $$;

alter table public.tax_classification_overrides
  drop constraint tax_classification_overrides_source_check;

alter table public.tax_classification_overrides
  add constraint tax_classification_overrides_source_check
  check (override_source in ('user', 'cpa', 'admin', 'system_correction', 'system_repair'));

commit;
