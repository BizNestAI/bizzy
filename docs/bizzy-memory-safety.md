# Bizzi conversational memory safety

## Current thread sharing

Chat threads are scoped to a business, not to their creator. Any authenticated member who can access that business can list, open, and continue its threads. Admin View can read the selected business's threads. This remediation intentionally does not change that behavior.

Small future access-control options are:

1. Creator-private: require `gpt_threads.user_id = auth.uid()` in routes and policies.
2. Explicit sharing: add visibility (`private` or `business`) plus a thread-member table for named sharing.
3. Role-controlled: add visibility plus role checks so owners/admins can inspect business threads while ordinary members see private or explicitly shared threads only.

## Future privacy controls

A later privacy task should add authenticated endpoints for thread deletion and semantic-memory listing/deletion. Thread deletion should cascade messages, while semantic memories linked through `source_thread_id` need an explicit product decision: delete them, retain de-identified durable preferences, or ask the user. The task should also cover audit events, confirmation UI, account/business erasure, orphaned null-thread messages, and tests for cascade and authorization behavior.

## Production verification

Apply the ordered memory migrations through `20261031120000_bizzy_memory_post_review_corrections.sql`, then run `scripts/verifyBizzyMemorySchema.sql` manually against the intended environment. The verification script is catalog-read-only and returns one PASS/FAIL row per invariant plus a final verdict. Do not treat the checked-in schema snapshot as current until the repository's normal Supabase schema-pull workflow refreshes it.

## Migration version compatibility

This repository contains these duplicate date-only migration prefixes: `20260606`, `20260612`, `20260714`, `20260716`, `20260717`, `20260724`, `20260729`, `20260922`, `20260925`, `20261010`, `20261011`, `20261012`, `20261013`, and `20261028`. The correction migration uses the unique 14-digit version `20261031120000`; do not rename migrations that might already exist in remote history.

Before deployment, compare histories read-only with `npx supabase migration list --local` and, only after authorization for the intended linked project, `npx supabase migration list`. If duplicate migrations have never been applied, assign unique timestamp versions before first deployment. If a duplicate is already represented remotely, preserve it and use the Supabase-supported migration-history repair workflow only after reconciling the exact applied SQL. For local/remote divergence, do not push further migrations until each remote version is mapped to its local file and missing or incorrectly recorded versions are resolved deliberately.
