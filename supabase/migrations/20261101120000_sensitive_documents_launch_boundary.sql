-- Launch boundary for Accounting Documents and published financial reports.
-- Sensitive metadata and object access are server-only; service-role API routes
-- perform canonical tenant authorization before accessing either table/bucket.

begin;

alter table public.bizzy_docs enable row level security;
alter table public.report_metadata enable row level security;

drop policy if exists "Users can view their own business reports" on public.report_metadata;

drop policy if exists "docs_select" on public.bizzy_docs;
drop policy if exists "docs_insert" on public.bizzy_docs;
drop policy if exists "docs_update" on public.bizzy_docs;
drop policy if exists "docs_delete" on public.bizzy_docs;
drop policy if exists "select_docs_if_owner" on public.bizzy_docs;
drop policy if exists "insert_docs_if_owner" on public.bizzy_docs;
drop policy if exists "update_docs_if_owner" on public.bizzy_docs;
drop policy if exists "delete_docs_if_owner" on public.bizzy_docs;

revoke all privileges on table public.bizzy_docs from public, anon, authenticated;
revoke all privileges on table public.report_metadata from public, anon, authenticated;
revoke all privileges on table public.bizzy_docs from service_role;
revoke all privileges on table public.report_metadata from service_role;
grant select, insert, update, delete on table public.bizzy_docs to service_role;
grant select, insert, update, delete on table public.report_metadata to service_role;

-- Browser Storage access is removed. The backend uses the service role only
-- after validating the canonical business, fixed bucket, metadata row, and path.
drop policy if exists bizzy_docs_member_select on storage.objects;
drop policy if exists bizzy_docs_member_insert on storage.objects;
drop policy if exists financial_reports_member_select on storage.objects;

commit;
