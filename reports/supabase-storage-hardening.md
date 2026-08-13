# Supabase Storage Hardening

Scope: Security Prompt 6L-A.

Source of truth supplied after running the staging audit:

- `SELECT ... FROM storage.buckets` returned **0 rows**.
- `SELECT ... FROM pg_policies WHERE schemaname = 'storage' ...` returned **0 rows**.

No production connection was made. No Storage policy migration was created or executed.

## Verdict

Staging Storage must be deferred until buckets are created or copied into the staging Preview Branch.

There is currently no staging bucket state to harden or runtime-test. Because there are no buckets, direct anonymous or authenticated Storage access to Bizzi objects is not currently possible in staging, but Storage-backed application features are also not fully represented in staging.

## Current Staging Storage State

| Surface | Current staging state | Certification result |
| --- | --- | --- |
| `storage.buckets` | 0 rows | No bucket public/private state exists to certify |
| `storage.objects` policies | 0 policies | No path isolation policy exists to certify |
| `bizzy-docs` bucket | Missing | Runtime Storage tests cannot run |
| `financial-reports` bucket | Missing | Runtime Storage tests cannot run |
| `bid-attachments` bucket | Missing | Runtime Storage tests cannot run |

## Code-Derived Required Bucket Model

These are derived only from current application code paths.

| Bucket | Required classification | Public? | Path tenant encoding | Current callers |
| --- | --- | --- | --- | --- |
| `bizzy-docs` / `VITE_STORAGE_DOCS_BUCKET` | `PRIVATE_BUSINESS` | No | `<business_id>/<sha256>.<ext>` | Browser upload/download in Bizzy Docs |
| `financial-reports` | `PRIVATE_BUSINESS` | No | `<business_id>/<year-month>-pnl.pdf` | Backend upload/list/sign; frontend signed-url fallback for canonical paths |
| `bid-attachments` / `BID_ATTACHMENTS_BUCKET` | `PRIVATE_BUSINESS` preferred, but app currently assumes public URLs | Not safe as public unless intentionally accepted | `<business_id>/<bid_estimate_id>/<timestamp>-<file>` | Backend upload/delete/list metadata; returns `getPublicUrl` today |

## Required Storage Policies

Before Storage runtime validation, staging needs explicit buckets and policies.

### `bizzy-docs`

Required behavior:

- `authenticated` can upload only into a path whose first segment is a business UUID they are authorized to access.
- `authenticated` can download only objects whose first path segment is an authorized business.
- `authenticated` can list only authorized business prefixes.
- `authenticated` can update/overwrite only authorized business paths if overwrite is supported; current upload uses `upsert: false`, so overwrite does not need to be granted broadly.
- `authenticated` can delete only authorized business paths if the UI supports deleting stored files; current direct doc deletion deletes metadata but does not remove Storage objects.
- `anon` gets no access.

Policy shape needed:

- `bucket_id = 'bizzy-docs'`
- first path segment parsed as `business_id`
- authorization through `public.bizzi_current_user_is_business_member(<path_business_id>)`

### `financial-reports`

Required behavior:

- Prefer server-only upload/list/sign through backend service role.
- If browser signed-url creation remains, `authenticated` can create signed URLs only for objects whose first path segment is an authorized business.
- `authenticated` should not upload, update, overwrite, delete, or list arbitrary report paths unless a current feature requires it.
- `anon` gets no access.

Policy shape needed:

- `bucket_id = 'financial-reports'`
- first path segment parsed as `business_id`
- authorization through `public.bizzi_current_user_is_business_member(<path_business_id>)`

### `bid-attachments`

Current code issue:

- `src/api/jobCosting/routes/jobCosting.bidBuilder.routes.js` uploads through the backend but returns `getPublicUrl`.
- `docs/bid-builder-ops.md` explicitly says the bucket should be public unless the flow changes to signed URLs.

Required secure behavior:

- Make bucket private.
- Keep upload/delete behind the existing authenticated backend route.
- Replace returned permanent public URLs with short-lived signed URLs issued only after backend tenant authorization.
- `authenticated` browser clients should not directly list/upload/update/delete this bucket.
- `anon` gets no access.

Policy shape needed after the app change:

- service-role backend access for upload/delete/sign.
- no direct browser policies, unless a future direct-browser upload feature is deliberately designed and path-scoped.

## `getPublicUrl` Safety

| Bucket | `getPublicUrl` safe? | Reason |
| --- | --- | --- |
| `bizzy-docs` | No | Business documents are private. |
| `financial-reports` | No | Financial reports are private. |
| `bid-attachments` | No by default | Site photos/files can be customer/job-specific. Public access requires an explicit product/security decision. |

## Signed URL Issuance

| Path | Tenant authorization |
| --- | --- |
| Backend P&L generation/signing | Tenant-scoped by backend business context before service-role Storage access. |
| Frontend `PNLArchiveViewer` signed-url fallback | Depends on Storage policy path enforcement; should preferably move behind backend signing. |
| Bid attachments | Not yet safe for private bucket because the route returns public URLs; needs backend signed-url replacement. |
| Bizzy Docs browser download | Depends on Storage policy path enforcement. |

## Runtime Harness Status

Storage runtime attack tests should be added only after staging has the buckets and policies installed. Meaningful tests should cover:

- User A listing Business B prefixes.
- User A downloading Business B objects.
- User A uploading into Business B paths.
- User A overwriting Business B objects.
- User A deleting Business B objects.
- Anonymous list/download/upload attempts.
- Backend signed URL issuance only after tenant authorization.

Because staging currently has no buckets, adding these tests now would only test missing-bucket errors, not Storage isolation.

## Required Final Answers

- Can User A list Business B files? **NO CURRENT BUCKETS TO LIST; NOT CERTIFIED.**
- Can User A download Business B files? **NO CURRENT BUCKETS TO DOWNLOAD FROM; NOT CERTIFIED.**
- Can User A upload into Business B's path? **NO CURRENT BUCKETS TO UPLOAD TO; NOT CERTIFIED.**
- Can User A overwrite Business B files? **NO CURRENT BUCKETS TO OVERWRITE; NOT CERTIFIED.**
- Can User A delete Business B files? **NO CURRENT BUCKETS TO DELETE FROM; NOT CERTIFIED.**
- Can anonymous users access private files? **NO CURRENT BUCKETS; NOT CERTIFIED.**
- Is `bid-attachments` intentionally public? **NOT SAFELY CERTIFIED. Current docs/code assume public URLs, but from a security standpoint it should become private with backend signed URLs unless the product explicitly accepts public attachment access.**
- Are signed URL issuance paths tenant-authorized? **PARTIAL. Backend P&L paths are tenant-scoped; browser direct signing paths depend on Storage policies; bid attachments currently use public URLs.**
- Is Storage safe for staging runtime validation? **NO. Create/copy staging buckets and policies first.**

