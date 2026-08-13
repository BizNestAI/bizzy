# Supabase Storage Final Hardening

Date: 2026-08-11

Scope: `bizzy-docs`, `financial-reports`, and `bid-attachments`.

No production connection was made and no migration was executed.

## Summary

Storage was the remaining pre-launch blocker because staging previously had zero Storage buckets and zero Storage policies. This phase adds a staging-review migration that creates/configures the expected buckets as private and adds tenant-scoped `storage.objects` policies based on the canonical Bizzi business membership model.

Object ownership is encoded by path:

```text
<business_id>/...
```

The first path segment must be a UUID and must pass `public.bizzi_current_user_is_business_member(...)` for the authenticated caller. Possession of a path or business UUID is not authorization.

## Artifacts

- Migration: `supabase/migrations/20260818_harden_storage_tenant_isolation.sql`
- Runtime harness extension: `scripts/runStagingTwoTenantRlsAttackTest.js`
- Static tests: `tests/supabaseStorageTenantIsolation.security.test.js`
- Bid attachment backend change: `src/api/jobCosting/routes/jobCosting.bidBuilder.routes.js`
- P&L viewer change: `src/components/Accounting/PNLArchiveViewer.jsx`

## Bucket Model

| Bucket | Public | Path model | Browser actions | Backend/service-role actions | Notes |
| --- | --- | --- | --- | --- | --- |
| `bizzy-docs` | No | `<business_id>/...` | SELECT, INSERT for authorized business members | Full backend/service-role access | Existing browser doc upload/download workflow is preserved. |
| `financial-reports` | No | `<business_id>/...` | SELECT/sign own-business objects only | Upload/list/sign via backend/service-role | Browser direct signing fallback was removed from the P&L viewer in favor of `/api/accounting/pnl/pdf`. |
| `bid-attachments` | No | `<business_id>/...` | SELECT/sign own-business objects only | Upload/delete/sign via backend/service-role | Public URL generation was removed; backend returns short-lived signed URLs only for the authorized business prefix. |

## Policy Design

The migration creates `public.bizzi_storage_object_business_id(text)` to parse the first path segment into a UUID, then applies policies on `storage.objects`:

- `bizzy_docs_member_select`
- `bizzy_docs_member_insert`
- `financial_reports_member_select`
- `bid_attachments_member_select`

There are no `USING (true)` or `WITH CHECK (true)` policies. No anonymous policies are created.

## Application Changes

`financial-reports`: `PNLArchiveViewer` no longer calls browser Supabase Storage `createSignedUrl` directly. It uses the authenticated backend report endpoint, which already derives tenant authority server-side.

`bid-attachments`: uploaded attachments no longer store or return Supabase public object URLs. The backend stores `storage_bucket` and `storage_path`, then returns a short-lived signed URL only when:

- `storage_bucket === "bid-attachments"`
- `storage_path` starts with the authorized `businessId` prefix
- the route has already resolved the request business through authenticated backend middleware

User-supplied external attachment metadata is not signed by the service-role client.

## Runtime Harness Coverage Added

The staging two-tenant attack harness now seeds synthetic objects in all three buckets for Business A and Business B, then tests:

- own-business list/download/signed URL
- own-business upload where browser upload is expected (`bizzy-docs`)
- foreign-business list/download/signed URL denial
- foreign-business upload/overwrite/delete denial
- anonymous list/download/signed URL/upload/overwrite/delete denial

The harness uses service role only for setup/cleanup and normal anon/authenticated clients for attacker actions.

## Staging Requirements

Before runtime testing Storage, apply the staging-review migration to the staging Supabase branch:

```text
supabase/migrations/20260818_harden_storage_tenant_isolation.sql
```

Then rerun:

```text
DOTENV_CONFIG_PATH=.env.staging.local node scripts/runStagingTwoTenantRlsAttackTest.js
```

## Required Answers

Can User A list Business B objects? Expected no after the migration; runtime harness now tests this for all three buckets.

Can User A download Business B objects? Expected no after the migration; runtime harness now tests this for all three buckets.

Can User A upload into Business B's path? Expected no after the migration; runtime harness now tests this for all three buckets.

Can User A overwrite Business B files? Expected no after the migration; runtime harness now tests this for all three buckets.

Can User A delete Business B files? Expected no after the migration; runtime harness now tests this for all three buckets.

Can anonymous users access private files? Expected no after the migration; runtime harness now tests list, download, signed URL, upload, overwrite, and delete.

Are all three buckets private? Yes in the proposed migration.

Does `bid-attachments` still use a public URL? No. The backend no longer calls `getPublicUrl` for uploaded bid attachments.

Can a user request a signed URL for another tenant's object? Expected no. Backend signing validates the authorized business prefix for bid attachments, and Storage RLS denies direct signed URL issuance for foreign paths.

Are legitimate own-business file workflows preserved? Yes by design: Bizzy Docs browser uploads remain direct for authorized members; financial report viewing uses the backend signed URL path; bid attachment upload/delete/list remains backend-mediated with signed URL responses.

What migrations/configuration must be applied to staging before runtime testing? Apply `20260818_harden_storage_tenant_isolation.sql` to staging so the private buckets and `storage.objects` policies exist.

## Status

Storage hardening is ready for staging review and runtime validation. It should not be considered production-certified until the migration is applied to staging and the expanded runtime harness passes against real Storage buckets.
