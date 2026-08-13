# Production Storage Security Verification Harness

Status: **NOT EXECUTED**

This report file is created as the static companion for `scripts/runProductionStorageSecurityVerification.js`. The script will overwrite this report with real results when it is intentionally run against production.

No production connection was made while creating this harness.

## Static Verification

The applied Storage migration/configuration artifact targets exactly these buckets:

- `bizzy-docs`
- `financial-reports`
- `bid-attachments`

The migration configures all three buckets as private and authorizes `storage.objects` access through:

```text
public.bizzi_current_user_is_business_member(
  public.bizzi_storage_object_business_id(name)
)
```

Object paths must begin with:

```text
<business_id>/...
```

The production-safe verification harness uses a stricter disposable test path:

```text
<business_id>/__security_test__/<run-id>/...
```

## Production Safety Controls

The harness refuses to run unless:

- `PRODUCTION_STORAGE_SECURITY_TEST_ENABLED=true`
- two synthetic user emails/passwords are explicitly configured
- two synthetic auth user IDs are explicitly configured
- two synthetic business IDs are explicitly configured
- the users and businesses are distinct
- each synthetic user is authorized for only its configured business

The harness never creates or deletes users or business rows.

The service-role client is used only for:

- verifying synthetic business/membership setup
- seeding generated test objects under the run marker
- cleanup of generated test objects

Attacker actions use ordinary anon/authenticated Supabase Storage clients.

Cleanup refuses to delete any object path that does not include the generated `__security_test__/<run-id>` marker.

## Required Environment Variables

Use production values only when intentionally running this verification:

```text
PRODUCTION_STORAGE_SECURITY_TEST_ENABLED=true
PRODUCTION_STORAGE_TEST_SUPABASE_URL=<PRODUCTION_SUPABASE_PROJECT_URL>
PRODUCTION_STORAGE_TEST_SUPABASE_ANON_KEY=<PRODUCTION_ANON_OR_PUBLISHABLE_KEY_COMPATIBLE_WITH_CURRENT_CLIENT>
PRODUCTION_STORAGE_TEST_SUPABASE_SERVICE_ROLE_KEY=<PRODUCTION_SERVICE_ROLE_OR_SECRET_KEY_COMPATIBLE_WITH_CURRENT_CLIENT>
PRODUCTION_STORAGE_TEST_USER_A_EMAIL=<SYNTHETIC_USER_A_EMAIL>
PRODUCTION_STORAGE_TEST_USER_A_PASSWORD=<SYNTHETIC_USER_A_PASSWORD>
PRODUCTION_STORAGE_TEST_USER_A_ID=<SYNTHETIC_USER_A_AUTH_UUID>
PRODUCTION_STORAGE_TEST_BUSINESS_A_ID=<SYNTHETIC_BUSINESS_A_UUID>
PRODUCTION_STORAGE_TEST_USER_B_EMAIL=<SYNTHETIC_USER_B_EMAIL>
PRODUCTION_STORAGE_TEST_USER_B_PASSWORD=<SYNTHETIC_USER_B_PASSWORD>
PRODUCTION_STORAGE_TEST_USER_B_ID=<SYNTHETIC_USER_B_AUTH_UUID>
PRODUCTION_STORAGE_TEST_BUSINESS_B_ID=<SYNTHETIC_BUSINESS_B_UUID>
```

Do not use customer users or customer businesses for this test.

## Test Coverage

For each bucket, the harness verifies:

- User A own-business required operations
- User A cannot list/download/sign/upload/overwrite/delete Business B objects
- User B own-business required operations
- User B cannot list/download/sign/upload/overwrite/delete Business A objects
- anonymous clients cannot list/download/sign/upload/overwrite/delete private objects

Expected own-business direct upload behavior:

| Bucket | Direct browser upload expected |
| --- | --- |
| `bizzy-docs` | Allowed |
| `financial-reports` | Denied |
| `bid-attachments` | Denied |

Own-business download/list/signed URL behavior is expected to work for generated test objects in all three private buckets.

## Command

After configuring dedicated synthetic production test identities:

```text
PRODUCTION_STORAGE_SECURITY_TEST_ENABLED=true node scripts/runProductionStorageSecurityVerification.js
```

If using an env file:

```text
DOTENV_CONFIG_PATH=.env.production.storage-security.local PRODUCTION_STORAGE_SECURITY_TEST_ENABLED=true node scripts/runProductionStorageSecurityVerification.js
```

## Required Answers

Can User A list Business B objects? Harness built to verify no.

Can User A download Business B objects? Harness built to verify no.

Can User A upload into Business B's path? Harness built to verify no.

Can User A overwrite Business B objects? Harness built to verify no.

Can User A delete Business B objects? Harness built to verify no.

Can anonymous clients access private objects? Harness built to verify no.

Can User A create a signed URL for Business B objects? Harness built to verify no.

Can own-business signed URL behavior work where required? Harness built to verify yes.

## Current Verdict

The harness is ready, but production Storage isolation is not runtime-certified until the script is intentionally run with dedicated synthetic production test tenants.
