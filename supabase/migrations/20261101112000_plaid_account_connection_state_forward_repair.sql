-- Forward repair for the already-applied per-account Plaid connection-state contract.
--
-- Production verification classified exactly 24 legacy rows, all belonging to
-- one business and two Tartan Bank Items. Every listed row was inactive, had a
-- durable 2026-03-29 disconnect timestamp, retained the migration default
-- connection_state='connected'/version=0, and had no connection-state audit.
-- The explicit manifest plus the compare-and-set predicates prevents this
-- repair from changing a later operator transition or any newly-created row.

alter function public.set_plaid_account_connection_state(uuid, text, text, uuid, text, text, bigint)
  set search_path = pg_catalog, public;
alter function public.set_plaid_account_connection_state(uuid, text, text, uuid, text, text, bigint)
  owner to postgres;
revoke all on function public.set_plaid_account_connection_state(uuid, text, text, uuid, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.set_plaid_account_connection_state(uuid, text, text, uuid, text, text, bigint)
  to service_role;

do $repair$
declare
  v_row public.plaid_accounts%rowtype;
begin
  for v_row in
    select pa.*
    from public.plaid_accounts pa
    join (values
      ('3lPD8Wd4ZvfR6LJ43MJmTyqPRlkKEouZpabyg', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('4q6gE3GNAVsEy4nNXznxIyA7obX3z8uJexVyQ', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('6PGG6oaK6KFNVJmJMK78HpeDgBdeD8i86BKKJ', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('6PGG6oaK6KFNVJmJMK78HpeDvrrXw3t86BKKr', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('7zPWGJl7gVfE6V974j9ZIknREwXpxeHdWGykZ', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('9emm7GPB7Bhd68v8xBXqsWkVn9EkVlH4rpyyr', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('axkLnE9vR3fvR13zVM3etap8gAkEWvcZq9Jmm', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('BewgVq9Eo5UErpxyDexKIWmGQXgrM4T4PG5ox', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('d4gAyl8vRJtW71axVQa8spvy7lBeP6iJw3z1E', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('DWkkqxgQqQIykd9doQgPUnlWGZRlWNf315RRM', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('jQpKDePBRgSARLpDvlp5H87P1MjbWzF653mg5', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('Nkq34egvLnU58XlPbjlKSgvDWMXx4Luyv1pJ1', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('PnrdPyovLEu5Lz9Myk9JSr8jMBXwPWFoD45lM', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('RPppMRzbMbFgWVvVnMyrhX7EnLL34Mia9gkk7', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('RPppMRzbMbFgWVvVnMyrhX7ER6o7EJfa9gkkl', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('vLooDpxKDKiLal5lG867I6Wz7KZWzafqpMeeK', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('VQEELldKLKTEJa1a3lznIxMGl4vMGBt9aByyv', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('VRp7MXrvzgt5oGdDqmdvSNPvXpmvplf94JyMd', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('wn3e4zJM65uVDLE5vXEBToMAKk5AkgCPv6RXm', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('wpkklgdrlriNPR9Rne8QHenDgQAnDjfPGbRRy', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('xbxZNd516XfPBNpLZKpjSpNmv7ZjDEi6oEPaP', 'MWlBa1ovnZf5gqMNwlM6SjdAmZrnN3fDmzvg5'),
      ('XMAAGz4kGkUyeQzQa15mUnwPk77Mv5cbQmjjd', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('XMAAGz4kGkUyeQzQa15mUnwPZxEwPBfbQmjjZ', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV'),
      ('ygEEKA4BKBulV6a6boJptyK376DK3lT4Gznn9', 'mNjjDrmEDEFPmLGL1gebFdW66kEE64t7wkgmV')
    ) as manifest(plaid_account_id, plaid_item_id)
      on manifest.plaid_account_id = pa.plaid_account_id
     and manifest.plaid_item_id = pa.plaid_item_id
    where pa.business_id = '353c9baa-c202-469d-9f4f-90742de6b13a'::uuid
      and pa.plaid_env = 'production'
      and pa.connection_state = 'connected'
      and pa.connection_state_version = 0
      and pa.is_active is false
      and pa.disconnected_at = '2026-03-29T02:09:07.679+00:00'::timestamptz
    for update of pa
  loop
    insert into public.plaid_account_connection_audit (
      business_id,
      plaid_account_id,
      plaid_item_id,
      plaid_env,
      previous_state,
      next_state,
      actor_user_id,
      action_type,
      source,
      request_id
    ) values (
      v_row.business_id,
      v_row.plaid_account_id,
      v_row.plaid_item_id,
      v_row.plaid_env,
      jsonb_build_object(
        'connection_state', v_row.connection_state,
        'is_active', v_row.is_active,
        'disconnected_at', v_row.disconnected_at,
        'connection_state_version', v_row.connection_state_version
      ),
      'disconnected',
      null,
      'legacy_connection_state_repair',
      '20261101112000_forward_repair',
      '20261101112000:' || v_row.plaid_account_id
    )
    on conflict (business_id, plaid_account_id, request_id) do nothing;

    update public.plaid_accounts
       set connection_state = 'disconnected',
           connection_state_version = connection_state_version + 1,
           disconnect_metadata = coalesce(disconnect_metadata, '{}'::jsonb) || jsonb_build_object(
             'source', '20261101112000_forward_repair',
             'reason', 'legacy_inactive_row_with_durable_disconnect_evidence',
             'previous_connection_state', v_row.connection_state,
             'previous_connection_state_version', v_row.connection_state_version
           ),
           updated_at = now()
     where business_id = v_row.business_id
       and plaid_account_id = v_row.plaid_account_id
       and plaid_item_id = v_row.plaid_item_id
       and plaid_env = v_row.plaid_env
       and connection_state = 'connected'
       and connection_state_version = 0
       and is_active is false
       and disconnected_at = v_row.disconnected_at;
  end loop;
end
$repair$;

-- Reassert the existing audit boundary without adding browser access.
alter table public.plaid_account_connection_audit enable row level security;
alter table public.plaid_account_connection_audit owner to postgres;
revoke all on table public.plaid_account_connection_audit from public, anon, authenticated;
grant select, insert on table public.plaid_account_connection_audit to service_role;
