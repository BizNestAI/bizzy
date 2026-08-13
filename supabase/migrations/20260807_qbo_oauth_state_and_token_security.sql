create table if not exists public.oauth_connection_states (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  state_hash text not null unique,
  user_id uuid not null,
  business_id uuid not null references public.business_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists oauth_connection_states_provider_state_idx
  on public.oauth_connection_states (provider, state_hash);

create index if not exists oauth_connection_states_expiry_idx
  on public.oauth_connection_states (provider, expires_at)
  where used_at is null;

create index if not exists quickbooks_tokens_realm_env_idx
  on public.quickbooks_tokens (realm_id, qbo_env)
  where is_active = true and status = 'active' and realm_id is not null;

create unique index if not exists quickbooks_tokens_active_realm_env_uidx
  on public.quickbooks_tokens (realm_id, qbo_env)
  where is_active = true and status = 'active' and realm_id is not null;
