# Plaid token encryption key rotation

This runbook rotates database encryption only. It must not invoke Plaid, disconnect Items, change account identity, reset cursors, or modify bookkeeping data.

## Environment and deployment order

1. Generate a new 32-byte key outside the repository. Do not print or log it.
2. Keep the existing `PLAID_TOKEN_ENCRYPTION_KEY` unchanged; the application treats it as legacy key `k1`.
3. Add the new value as `PLAID_TOKEN_ENCRYPTION_KEY_K2`.
4. Set `PLAID_TOKEN_ACTIVE_KEY_ID=k2`.
5. Deploy the dual-read release. Production startup must pass before migration begins.
6. Run the bounded dry-run:

   ```sh
   npm run plaid:rotate-token-key -- --dry-run --limit=25
   ```

7. Require exactly six `V1_K1` rows, one `PLAINTEXT_LEGACY` row, no invalid rows, no conflicts, and no unexpected investment rows.
8. Capture the invariant snapshot below.
9. Apply one bounded batch:

   ```sh
   npm run plaid:rotate-token-key -- --apply --limit=25
   ```

10. If any row reports `conflict`, rerun dry-run and apply. Never overwrite the concurrent value manually.
11. Verify authenticated decryption and the expected active count:

   ```sh
   npm run plaid:rotate-token-key -- --verify --expected-active=7 --limit=25
   ```

12. Repeat the invariant snapshot and require an exact match.

The command output is restricted to row IDs, format/status categories, configured limits, and aggregate counts.

## Read-only verification queries

Credential-format counts (never returns a credential):

```sql
select
  count(*) filter (where is_active is true and status in ('active','connected')) as active_items,
  count(*) filter (where is_active is true and status in ('active','connected') and plaid_access_token like 'enc:v2:k2:%') as active_v2_k2,
  count(*) filter (where is_active is true and status in ('active','connected') and plaid_access_token like 'enc:v1:%') as active_v1,
  count(*) filter (where is_active is true and status in ('active','connected') and plaid_access_token like 'access-%') as active_plaintext,
  count(*) filter (where is_active is false and plaid_access_token is not null) as inactive_with_credentials
from public.plaid_items;

select count(*) as investment_credentials
from public.linked_financial_items
where provider = 'plaid' and access_token_enc is not null;
```

Capture this state-only snapshot immediately before and after apply. It hashes values inside PostgreSQL and returns no row data. The two result sets must be identical:

```sql
select 'plaid_items_state' as scope, count(*) as row_count,
       md5(coalesce(string_agg(md5((to_jsonb(t) - 'plaid_access_token' - 'updated_at')::text), '' order by id::text), '')) as state_hash
from public.plaid_items t
union all
select 'plaid_accounts', count(*),
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by id::text), ''))
from public.plaid_accounts t
union all
select 'bank_transactions', count(*),
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by id::text), ''))
from public.bank_transactions t
union all
select 'transaction_categorizations', count(*),
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by id::text), ''))
from public.transaction_categorizations t
union all
select 'plaid_qbo_account_mappings', count(*),
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by id::text), ''))
from public.plaid_qbo_account_mappings t
union all
select 'bank_sync_runs', count(*),
       md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by id::text), ''))
from public.bank_sync_runs t;
```

The application verifier supplies the authenticated-decryption proof that SQL prefix counts cannot provide.

## Rollback and conflict behavior

- Before apply, a failed deployment may be rolled back only if no `v2` write occurred. Check the format-count query first.
- After any `v2` write, do not deploy code that lacks `v2`/`k2` support. Roll forward with the keyring code and keep both keys configured.
- A compare-and-set conflict leaves the row untouched. Re-run dry-run, investigate the category, then replay the bounded apply command.
- If `k2` is misconfigured, restore the correct `k2`; do not change the active writer back to `k1`.
- Database point-in-time recovery remains the emergency data rollback. Both keys must remain available throughout recovery.

## Removing k1

Remove `PLAID_TOKEN_ENCRYPTION_KEY` only after all of the following hold:

- Verification reports seven active Items and seven authenticated `V2_K2` credentials.
- SQL reports zero active `v1`, zero active plaintext, zero inactive credentials, and zero legacy investment credentials.
- Dry-run reports only `already_current` rows.
- No conflicts or invalid credentials remain.
- The pre/post invariant snapshots match.
- A normal observation window has completed with successful sync and update-link operations.
- No deployed or rollback-capable release still writes or requires `v1`.

Removing `k1` requires a follow-up code release that no longer validates it at startup. Do not remove the variable while this transitional release is deployed.
