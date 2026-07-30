-- Canonical tax deductions transaction drill-down.
-- Read-only, business-scoped, and safe for customer-facing API responses.

do $$
begin
  if to_regclass('public.transaction_tax_classifications') is not null then
    create index if not exists transaction_tax_classifications_business_year_status_idx
      on public.transaction_tax_classifications (business_id, tax_year, classification_status);

    create index if not exists transaction_tax_classifications_business_year_deductibility_idx
      on public.transaction_tax_classifications (business_id, tax_year, deductibility_status);

    create index if not exists transaction_tax_classifications_business_year_category_idx
      on public.transaction_tax_classifications (business_id, tax_year, tax_category);

    create index if not exists transaction_tax_classifications_business_year_date_idx
      on public.transaction_tax_classifications (business_id, tax_year, transaction_date desc, updated_at desc, id desc);

    create index if not exists transaction_tax_classifications_business_year_updated_idx
      on public.transaction_tax_classifications (business_id, tax_year, updated_at desc, id desc);
  end if;

  if to_regclass('public.bank_transactions') is not null then
    create index if not exists bank_transactions_business_date_id_idx
      on public.bank_transactions (business_id, date desc, id);
  end if;
end $$;

create or replace function public.get_tax_deduction_transaction_drilldown(
  p_business_id uuid,
  p_tax_year integer,
  p_as_of_date date default null,
  p_tax_category text default null,
  p_month text default null,
  p_deductibility_status text default null,
  p_classification_status text default null,
  p_confidence_level text default null,
  p_qbo_account_id text default null,
  p_merchant text default null,
  p_search text default null,
  p_min_amount numeric default null,
  p_max_amount numeric default null,
  p_sort text default 'date_desc',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
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
$$;
