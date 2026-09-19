insert into public.bizzi_canonical_accounts (
  canonical_account_key,
  preferred_account_name,
  qbo_account_type,
  qbo_account_subtype,
  is_active,
  auto_create_policy,
  review_required,
  purpose,
  sort_order
) values (
  'credit_card_interest',
  'Credit Card Interest',
  'Expense',
  'InterestPaid',
  true,
  'AUTO_CREATE_ALLOWED',
  false,
  'Credit-card interest and finance charges.',
  165
)
on conflict (canonical_account_key) do update set
  preferred_account_name = excluded.preferred_account_name,
  qbo_account_type = excluded.qbo_account_type,
  qbo_account_subtype = excluded.qbo_account_subtype,
  is_active = excluded.is_active,
  auto_create_policy = excluded.auto_create_policy,
  review_required = excluded.review_required,
  purpose = excluded.purpose,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.bizzi_canonical_intent_mappings (intent_key, canonical_account_key) values
  ('credit_card_interest', 'credit_card_interest'),
  ('interest_expense', 'credit_card_interest')
on conflict (intent_key) do update set
  canonical_account_key = excluded.canonical_account_key,
  is_active = true,
  updated_at = now();

insert into public.bizzi_canonical_account_aliases (canonical_account_key, alias_name, alias_kind, is_approved_equivalent) values
  ('credit_card_interest', 'Credit Card Interest', 'approved_equivalent', true),
  ('credit_card_interest', 'Interest Expense', 'approved_equivalent', true),
  ('credit_card_interest', 'Finance Charges', 'approved_equivalent', true)
on conflict do nothing;
