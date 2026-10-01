# One business per subscription

## Authority model

`business_billing.business_id` is the entitlement boundary. Only `active` and `trialing` in the configured Stripe environment grant paid compute, financial writes, provider synchronization, and new provider connections. All other, missing, and unknown states fail closed to historical reads. Only the primary owner in `business_profiles.user_id` may manage billing, connect/reconnect/disconnect providers, or access future company-replacement tooling. Membership roles never grant owner authority.

Stripe subscription IDs are unique per environment. Runtime authority reads only the canonical live or test fields selected by `STRIPE_MODE`; legacy billing fields are ignored after migration. Stripe customer IDs are intentionally not unique because one customer may purchase separate subscriptions for separate businesses.

QuickBooks permits one immutable realm for a Bizzi business. The same realm may reconnect; a different realm is rejected and recorded. The existing active `(realm_id, qbo_env)` uniqueness prevents the same company from serving multiple Bizzi businesses. Company replacement is intentionally unavailable in self-service. A future support replacement operation must require recent owner reauthentication, an explicit reason, an audit row, verification that the new realm is unused, and a transaction that archives old provider state before changing the realm.

Plaid permits multiple Items and accounts in a business. Active Item identity is globally unique per Plaid environment, and accounts must reference an Item belonging to the same business and environment. Bizzi uses polling; no Plaid webhook URL is advertised until a verified Item-to-business webhook handler exists.

## Deployment order

1. Put paid writes, provider sync workers, and OAuth starts into maintenance mode.
2. Run `scripts/preflight/one_business_per_subscription.sql` read-only and archive the result.
3. Resolve every duplicate subscription, duplicate membership, cross-business Plaid Item, null Plaid environment, and orphan Plaid account manually. Confirm the deployed `PLAID_ENV` before labeling legacy Items; the database/project being production does not prove that Plaid itself used the production environment. Do not guess ownership or provider environment.
4. Apply `20261101090000_business_entitlement_authority.sql`.
5. Deploy the backend entitlement middleware and webhook ordering changes.
6. Apply `20261101091000_provider_business_integrity.sql`.
7. Deploy OAuth/provider and worker changes, then the frontend.
8. Run two-tenant authorization, simultaneous OAuth, duplicate webhook, canceled-subscription, same-realm reconnect, and cross-business provider tests.
9. Re-enable schedulers and monitor denials by correlation ID, Stripe event ordering, QBO replacement rejections, and provider-sync skips.

The migrations abort on ambiguous data and are transactional. Application rollback is safe before schema rollback because the new columns and indexes are additive. Do not remove uniqueness or immutability controls while new code is accepting requests. A schema rollback requires first stopping writes and proving no duplicate entitlement/provider identities were created.

## Founder/support: wrong QuickBooks company

For launch, a Bizzi business is permanently bound to its first established QuickBooks realm. The primary owner may reconnect that same realm. A different realm is rejected even if the client asks to force a switch, and any newly issued rejected token is revoked on a best-effort basis.

Do not repair a wrong-company connection with ad hoc SQL, token-row deletion, or direct `realm_id` updates. Keep the connection blocked, record the customer and business ID, and defer the case until the controlled replacement workflow exists. That future workflow must verify primary-owner identity, ensure the proposed realm is unused, archive prior provider state, and record the reason in one transaction.

## Disposable/staging migration verification

The repository does not assume a permanently running local database. Before rollout, use a disposable Supabase stack or a restored staging copy:

```sh
npx supabase start
npx supabase db reset
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/preflight/one_business_per_subscription.sql
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261101090000_business_entitlement_authority.sql
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261101091000_provider_business_integrity.sql
```

Run the preflight against a staging restore before either migration. In a separate disposable database, seed and verify: an unambiguous legacy billing row backfills to the live columns; legacy/live and legacy/test cross-business subscription reuse aborts with no partial changes; duplicate membership aborts; clean multiple Plaid Items for one business succeed; an active Item shared across businesses aborts; and a Plaid account without a same-business/environment Item is rejected. Finally exercise the application Item upsert with conflict target `(business_id, plaid_env, plaid_item_id)`. Do not point these fixture commands at production.
