# Supabase Privileges, Sequences, and Storage Hardening

Scope: Security Prompt 6L. This review treats the latest staging runtime result, `570 passed / 0 failed`, as the protected baseline and only addresses deferred privilege, sequence, schema, future-object, and Storage surfaces.

No production connection was made. No migration was executed.

## Default Privileges

The public-schema snapshot contains default privileges for objects created by role `postgres` in schema `public`:

| Future object | Current inherited browser access | Target model |
| --- | --- | --- |
| Tables | `anon` and `authenticated` receive `ALL` | No browser grant by default; grant per table after RLS review |
| Functions | `anon` and `authenticated` receive `ALL`/execute | No browser execution by default; grant per reviewed RPC only |
| Sequences | `anon` and `authenticated` receive `ALL` | No browser sequence access by default; grant only when browser insert truly requires it |

Migration created: `supabase/migrations/20260816_harden_default_privileges_sequences_schema.sql`.

## Existing Grants

The post-6F through 6K intended state already locks down the tested table, view, and function surfaces. One remaining grant mismatch was found during sequence review:

| Object | Issue | Target |
| --- | --- | --- |
| `expense_category_map` | Snapshot grants `ALL` to `anon` and `authenticated`; no confirmed frontend dependency | Enable RLS with no browser policies, revoke browser grants, service-role only |

No broad table-grant rewrite was added because previous phases intentionally assigned per-table browser grants.

## Sequences

The public snapshot exposes three identity sequences to browser roles:

| Sequence | Owning table | Browser insert requirement | Target |
| --- | --- | --- | --- |
| `expense_category_map_id_seq` | `expense_category_map.id` | None found | service-role only |
| `expense_totals_monthly_id_seq` | `expense_totals_monthly.id` | Browser has SELECT only after 6J | service-role only |
| `tax_snapshots_id_seq` | `tax_snapshots.id` | Browser has SELECT only after 6H | service-role only |

The migration revokes sequence privileges from `PUBLIC`, `anon`, and `authenticated`, and grants `ALL` to `service_role`.

## Schema Privileges

The snapshot grants `USAGE` on schema `public` to browser roles. That is required for normal PostgREST access to explicitly granted objects.

The migration additionally revokes `CREATE` on schema `public` from `PUBLIC`, `anon`, and `authenticated`, while preserving `USAGE`.

## Storage Usage

The authoritative snapshot was generated for `--schema public`, so it does not include `storage.buckets`, `storage.objects`, or Storage RLS policies. Storage cannot be certified from this dump alone.

Code-discovered buckets:

| Bucket | Access path | Classification | Notes |
| --- | --- | --- | --- |
| `bizzy-docs` or `VITE_STORAGE_DOCS_BUCKET` | Browser upload/download under `<business_id>/<hash>.<ext>` | `PRIVATE_BUSINESS` | Must enforce business path ownership in Storage policies |
| `financial-reports` | Backend upload/list/sign; frontend signs canonical demo paths | `PRIVATE_BUSINESS` | Prefer backend-signed access; browser direct signing should be reviewed against Storage policy |
| `bid-attachments` or `BID_ATTACHMENTS_BUCKET` | Backend upload/delete; returns public URL via `getPublicUrl` | `UNKNOWN_REQUIRES_DECISION` | If bucket is public, attachments may be anonymously retrievable by URL; decide whether that is intended |

Read-only audit helper created: `scripts/auditStagingPrivilegesAndStorage.sql`.

## Runtime Testing

The current Supabase JS runtime harness cannot create temporary database objects or directly query sequence state through PostgREST without a dedicated SQL/RPC helper, so default-privilege runtime validation remains a staging SQL audit task.

Storage runtime tests were not added because the public schema snapshot does not prove bucket names, bucket public/private flags, or Storage policies. Use the read-only audit SQL first, then add bucket-specific cross-tenant upload/list/download/remove tests once policies are known.

## Answers

- Can creation of a new table accidentally expose it to anon or authenticated? **Currently yes; after this migration, no for objects created by `postgres` in `public`.**
- Can creation of a new function accidentally expose RPC execution to browser roles? **Currently yes; after this migration, no for objects created by `postgres` in `public`.**
- Can creation of a new sequence automatically grant browser usage? **Currently yes; after this migration, no for objects created by `postgres` in `public`.**
- Does `PUBLIC` retain unnecessary access to database objects? **The migration removes public schema `CREATE` and sequence/table access for the identified remaining objects. Existing object-level `PUBLIC` grants still require the staging catalog audit to confirm final state.**
- Do any existing table grants exceed the intended RLS classification? **Yes: `expense_category_map`; remediated in the migration.**
- Can authenticated users use sequences belonging to server-only tables? **Currently yes for the three public identity sequences in the snapshot; after this migration, no.**
- Can browser roles create arbitrary objects in the public schema? **After this migration, no.**
- What Storage buckets exist and how is each classified? **Code indicates `bizzy-docs` (`PRIVATE_BUSINESS`), `financial-reports` (`PRIVATE_BUSINESS`), and `bid-attachments` (`UNKNOWN_REQUIRES_DECISION`). Actual staging bucket state must be confirmed from `storage.buckets`.**
- Can User A access User B's private Storage objects? **Unknown from the public-schema snapshot; requires Storage policy audit/runtime tests.**
- Can anonymous users access any Storage object that should be private? **Unknown from the public-schema snapshot; `bid-attachments` public URL behavior is a follow-up risk.**
- Which runtime security tests were added? **Static regression tests were added. Runtime Storage/default privilege tests are blocked pending staging Storage catalog audit and a safe SQL execution mechanism.**
- Is the proposed migration safe to apply to staging? **Yes, for database privilege/sequence hardening. Storage remains a follow-up audit surface, not changed by this migration.**

