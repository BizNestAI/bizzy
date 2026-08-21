create table if not exists public.internal_staff_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint internal_staff_users_role_check
    check (role in ('owner_admin', 'accountant', 'operator'))
);

create index if not exists internal_staff_users_active_role_idx
  on public.internal_staff_users (active, role);

create or replace function public.set_internal_staff_users_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_internal_staff_users_updated_at on public.internal_staff_users;
create trigger trg_internal_staff_users_updated_at
  before update on public.internal_staff_users
  for each row
  execute function public.set_internal_staff_users_updated_at();

alter table public.internal_staff_users enable row level security;

revoke all on table public.internal_staff_users from public, anon, authenticated;
revoke all on function public.set_internal_staff_users_updated_at() from public, anon, authenticated;

grant all on table public.internal_staff_users to service_role;
grant execute on function public.set_internal_staff_users_updated_at() to service_role;

comment on table public.internal_staff_users is
  'Durable server-authoritative Bizzi internal staff authorization. Managed only by service-role/manual admin operations.';
