create or replace function public.handle_confirmed_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  first_name_text text;
  last_name_text text;
  full_name_text text;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;

  first_name_text := nullif(trim(coalesce(new.raw_user_meta_data->>'first_name', '')), '');
  last_name_text := nullif(trim(coalesce(new.raw_user_meta_data->>'last_name', '')), '');
  full_name_text := nullif(
    trim(coalesce(new.raw_user_meta_data->>'full_name', concat_ws(' ', first_name_text, last_name_text))),
    ''
  );

  insert into public.user_profiles (
    id,
    email,
    role,
    first_name,
    last_name,
    full_name
  )
  values (
    new.id,
    new.email,
    'owner',
    first_name_text,
    last_name_text,
    full_name_text
  )
  on conflict (id) do update
  set
    email = excluded.email,
    first_name = coalesce(public.user_profiles.first_name, excluded.first_name),
    last_name = coalesce(public.user_profiles.last_name, excluded.last_name),
    full_name = coalesce(public.user_profiles.full_name, excluded.full_name),
    role = coalesce(public.user_profiles.role, excluded.role);

  return new;
end;
$$;

drop trigger if exists trg_create_user_profile_on_email_confirm on auth.users;

create trigger trg_create_user_profile_on_email_confirm
after insert or update of email_confirmed_at, email, raw_user_meta_data
on auth.users
for each row
execute function public.handle_confirmed_auth_user_profile();

insert into public.user_profiles (
  id,
  email,
  role,
  first_name,
  last_name,
  full_name
)
select
  u.id,
  u.email,
  'owner',
  nullif(trim(coalesce(u.raw_user_meta_data->>'first_name', '')), ''),
  nullif(trim(coalesce(u.raw_user_meta_data->>'last_name', '')), ''),
  nullif(
    trim(
      coalesce(
        u.raw_user_meta_data->>'full_name',
        concat_ws(
          ' ',
          nullif(trim(coalesce(u.raw_user_meta_data->>'first_name', '')), ''),
          nullif(trim(coalesce(u.raw_user_meta_data->>'last_name', '')), '')
        )
      )
    ),
    ''
  )
from auth.users u
where u.email_confirmed_at is not null
on conflict (id) do update
set
  email = excluded.email,
  first_name = coalesce(public.user_profiles.first_name, excluded.first_name),
  last_name = coalesce(public.user_profiles.last_name, excluded.last_name),
  full_name = coalesce(public.user_profiles.full_name, excluded.full_name),
  role = coalesce(public.user_profiles.role, excluded.role);

alter table public.user_profiles enable row level security;

drop policy if exists user_profiles_insert_own on public.user_profiles;
create policy user_profiles_insert_own
on public.user_profiles
for insert
to authenticated
with check (id = auth.uid());
