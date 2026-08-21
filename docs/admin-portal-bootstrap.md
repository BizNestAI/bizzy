# Bizzi Admin Portal Bootstrap

The production admin portal authorizes staff through `public.internal_staff_users`.
The table is keyed to the authenticated Supabase `auth.users.id` and is not
writable by ordinary browser clients.

To bootstrap the first owner:

1. Create or identify the owner account in Supabase Auth.
2. Copy that auth user's UUID.
3. Run this SQL from a privileged Supabase SQL session:

```sql
insert into public.internal_staff_users (user_id, role, active)
values ('00000000-0000-0000-0000-000000000000', 'owner_admin', true)
on conflict (user_id) do update
set role = excluded.role,
    active = excluded.active;
```

Replace the UUID with the owner's real `auth.users.id`.

Do not expose a public bootstrap route. Future staff changes should be made
through a controlled internal admin process or privileged database operation.
