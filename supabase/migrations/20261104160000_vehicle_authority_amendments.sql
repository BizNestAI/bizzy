begin;

-- No bookkeeping/outbox objects are dependencies of these commands.
create unique index if not exists tax_vehicles_scoped_identity_idx on public.tax_vehicles(business_id,id);
create unique index if not exists tax_vehicle_classification_identity_idx on public.transaction_tax_classifications(business_id,tax_year,transaction_id,id);
create table if not exists public.tax_vehicle_transaction_assignments (
 business_id uuid not null references public.business_profiles(id),
 tax_year integer not null check(tax_year between 2000 and 2100),
 transaction_id uuid not null,
 classification_id uuid not null references public.transaction_tax_classifications(id) on delete cascade,
 vehicle_id uuid not null references public.tax_vehicles(id),
 assigned_by uuid, assigned_at timestamptz not null default now(),
 primary key(business_id,tax_year,transaction_id)
);
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.tax_vehicle_transaction_assignments'::regclass and conname='vehicle_assignment_business_fk') then
  alter table public.tax_vehicle_transaction_assignments add constraint vehicle_assignment_business_fk foreign key(business_id,vehicle_id) references public.tax_vehicles(business_id,id);
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.tax_vehicle_transaction_assignments'::regclass and conname='vehicle_assignment_classification_scope_fk') then
  alter table public.tax_vehicle_transaction_assignments add constraint vehicle_assignment_classification_scope_fk foreign key(business_id,tax_year,transaction_id,classification_id) references public.transaction_tax_classifications(business_id,tax_year,transaction_id,id) on delete cascade;
 end if;
end $$;
create index if not exists tax_vehicle_assignments_scope_idx on public.tax_vehicle_transaction_assignments(business_id,tax_year,vehicle_id);
create table if not exists public.tax_vehicle_command_previews (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.business_profiles(id),
 tax_year integer not null, actor_user_id uuid not null, choices jsonb not null,
 before_state jsonb not null, plan jsonb not null, after_state jsonb,
 expires_at timestamptz not null default now()+interval '15 minutes',
 created_at timestamptz not null default now(), consumed_at timestamptz,
 idempotency_key text, result jsonb,
 check(tax_year between 2000 and 2100)
);
create unique index if not exists tax_vehicle_command_key_idx on public.tax_vehicle_command_previews(business_id,idempotency_key) where idempotency_key is not null;
alter table public.tax_vehicle_transaction_assignments enable row level security;
alter table public.tax_vehicle_transaction_assignments force row level security;
alter table public.tax_vehicle_command_previews enable row level security;
alter table public.tax_vehicle_command_previews force row level security;
drop policy if exists vehicle_assignments_service on public.tax_vehicle_transaction_assignments;
create policy vehicle_assignments_service on public.tax_vehicle_transaction_assignments for all to service_role using(true) with check(true);
drop policy if exists vehicle_commands_service on public.tax_vehicle_command_previews;
create policy vehicle_commands_service on public.tax_vehicle_command_previews for all to service_role using(true) with check(true);
revoke all on public.tax_vehicle_transaction_assignments,public.tax_vehicle_command_previews from public,anon,authenticated;
grant select,insert,update,delete on public.tax_vehicle_transaction_assignments to service_role;
grant select,insert,update on public.tax_vehicle_command_previews to service_role;

-- Protection prevents bulk automation from changing a manual row. It is not
-- a claim that the current tax treatment is final, nor a ban on explicit edits.
create or replace function public.tax_vehicle_protect_manual_authority() returns trigger language plpgsql set search_path=public as $$
begin
 if new.source not in ('user','cpa','admin','bizzi_operator','operator') then
  if coalesce(new.user_override,false) and (tg_op='INSERT' or not coalesce(old.user_override,false))
    or coalesce(new.cpa_override,false) and (tg_op='INSERT' or not coalesce(old.cpa_override,false))
    or new.classification_status in ('user_confirmed','cpa_confirmed','bizzi_operator_confirmed') then
   raise exception 'manual_provenance_forbidden' using errcode='42501';
  end if;
  if tg_op='UPDATE' and (old.user_override or old.cpa_override or old.classification_status in ('user_confirmed','cpa_confirmed','bizzi_operator_confirmed')) and new is distinct from old then
   raise exception 'protected_manual_automation_write' using errcode='42501';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists tax_vehicle_protect_manual_authority on public.transaction_tax_classifications;
create trigger tax_vehicle_protect_manual_authority before insert or update on public.transaction_tax_classifications for each row execute function public.tax_vehicle_protect_manual_authority();

-- Exact approved v4 vehicle aliases, matching taxGlAliasRules.js. Natural gas
-- utilities, equipment fuel and reimbursements are not vehicle deductions.
create or replace function public.tax_vehicle_is_expense_scope(category text,account_name text,treatment jsonb) returns boolean language sql immutable set search_path=public as $$
 select coalesce(category like '%vehicle%' or category='auto',false)
  or coalesce(coalesce(treatment->>'type',trim(both '"' from treatment::text)) like 'vehicle_%',false)
  or trim(regexp_replace(lower(replace(coalesce(account_name,''),'&',' and ')),'[^a-z0-9]+',' ','g'))=any(array['fuel','gas','vehicle fuel','auto fuel','fuel expense','gas and fuel','automobile expense','auto expense','vehicle maintenance','auto maintenance','vehicle repairs','auto repairs','truck repairs','truck maintenance','fleet maintenance','vehicle repairs and maintenance']);
$$;
revoke all on function public.tax_vehicle_is_expense_scope(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.tax_vehicle_is_expense_scope(text,text,jsonb) to service_role;

-- Enforce the tax invariant even for older API instances during rollout.
create or replace function public.tax_vehicle_prevent_conflicting_deductions() returns trigger language plpgsql set search_path=public as $$
declare v uuid;e public.tax_vehicle_method_elections%rowtype;is_vehicle boolean;begin
 is_vehicle:=public.tax_vehicle_is_expense_scope(new.tax_category,new.source_qbo_account_name,new.tax_treatment);
 if not is_vehicle or coalesce(new.metadata->>'vehicle_scope_released','false')='true' then return new;end if;
 v:=nullif(new.metadata->>'vehicle_id','')::uuid;
 if v is null then select vehicle_id into v from public.tax_vehicle_transaction_assignments where business_id=new.business_id and tax_year=new.tax_year and transaction_id=new.transaction_id;end if;
 select * into e from public.tax_vehicle_method_elections where business_id=new.business_id and tax_year=new.tax_year and vehicle_id=v and status in('active','finalized');
 if e.id is null and new.source in ('system','rule_engine','imported') then
  new.classification_status:='needs_review';new.requires_review:=true;
  new.deductible_amount:=0;new.deductible_percent:=0;new.nondeductible_amount:=0;
  new.tax_category:='vehicle_expense';new.tax_treatment:='{"type":"vehicle_expense","business_use_required":true}';
  return new;
 end if;
 if e.id is null and (new.deductible_amount>0 or (new.classification_status in('user_confirmed','cpa_confirmed') and coalesce(new.tax_treatment::text,'')~'(standard_mileage|actual_expense)')) then raise exception 'vehicle_method_election_required' using errcode='22023';end if;
 if e.method='standard_mileage' and new.deductible_amount<>0 then raise exception 'standard_mileage_separate_gas_forbidden' using errcode='22023';end if;
 if e.method='actual_expenses' and new.deductible_amount>0 and not coalesce(new.cpa_override,false) then
  if new.deductible_percent is distinct from e.business_use_percent or new.deductible_amount<>round(abs(new.book_amount)*e.business_use_percent/100,2) then raise exception 'vehicle_business_use_conflicts_with_election' using errcode='22023';end if;
 end if;
 return new;
end $$;
drop trigger if exists tax_vehicle_prevent_conflicting_deductions on public.transaction_tax_classifications;
create trigger tax_vehicle_prevent_conflicting_deductions before insert or update on public.transaction_tax_classifications for each row execute function public.tax_vehicle_prevent_conflicting_deductions();

create or replace function public.tax_vehicle_election_history_guard() returns trigger language plpgsql set search_path=public as $$
declare v public.tax_vehicles%rowtype;begin
 select * into v from public.tax_vehicles where id=new.vehicle_id and business_id=new.business_id;
 if not found then raise exception 'vehicle_scope_invalid' using errcode='42501';end if;
 if new.effective_start<make_date(new.tax_year,1,1) or new.effective_end>make_date(new.tax_year,12,31) then raise exception 'vehicle_election_period_invalid' using errcode='22023';end if;
 if new.status in ('active','finalized') and exists(select 1 from public.tax_vehicle_method_elections prior_e where prior_e.vehicle_id=new.vehicle_id and prior_e.business_id=new.business_id and prior_e.id<>new.id and prior_e.method<>new.method and prior_e.status in('active','finalized','superseded')) then
  if v.ownership_type is null or v.ownership_type='leased' then raise exception 'vehicle_method_eligibility_unknown_or_leased' using errcode='22023';end if;
 end if;
 return new;
end $$;
drop trigger if exists tax_vehicle_election_history_guard on public.tax_vehicle_method_elections;
create trigger tax_vehicle_election_history_guard before insert or update of status,method on public.tax_vehicle_method_elections for each row execute function public.tax_vehicle_election_history_guard();

-- Serializes changes to a business's command evidence, including phantom new
-- transactions. Reads remain concurrent. Uses the grouped-election lock key.
create or replace function public.tax_vehicle_serialize_evidence() returns trigger language plpgsql set search_path=public as $$
declare b uuid;
begin
 if tg_op='DELETE' then b:=old.business_id; else b:=new.business_id;end if;
 if tg_op='UPDATE' and old.business_id is distinct from new.business_id then raise exception 'business_scope_immutable' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(b::text||':vehicle-election',0));
 if tg_op='DELETE' then return old;end if;return new;
end $$;
do $$ declare t text;begin
 foreach t in array array['bank_transactions','transaction_tax_classifications','tax_vehicles','tax_vehicle_method_elections','tax_vehicle_mileage_inputs','tax_vehicle_transaction_assignments','tax_workspace_projections'] loop
  execute format('drop trigger if exists tax_vehicle_serialize_evidence on public.%I',t);
  execute format('create trigger tax_vehicle_serialize_evidence before insert or update or delete on public.%I for each row execute function public.tax_vehicle_serialize_evidence()',t);
 end loop;
end $$;

create or replace function public.tax_vehicle_sync_assignment() returns trigger language plpgsql set search_path=public as $$
declare v uuid;
begin
 v:=nullif(new.metadata->>'vehicle_id','')::uuid;
 if v is null or coalesce((new.metadata->>'vehicle_scope_released')::boolean,false) then
  delete from public.tax_vehicle_transaction_assignments where business_id=new.business_id and tax_year=new.tax_year and transaction_id=new.transaction_id;
 else
  if not exists(select 1 from public.tax_vehicles where id=v and business_id=new.business_id) then raise exception 'vehicle_scope_invalid' using errcode='42501';end if;
  insert into public.tax_vehicle_transaction_assignments(business_id,tax_year,transaction_id,classification_id,vehicle_id,assigned_by)
   values(new.business_id,new.tax_year,new.transaction_id,new.id,v,nullif(new.metadata->>'decision_actor_id','')::uuid)
   on conflict(business_id,tax_year,transaction_id) do update set vehicle_id=excluded.vehicle_id,assigned_by=excluded.assigned_by,assigned_at=now();
 end if;
 return new;
end $$;
drop trigger if exists tax_vehicle_sync_assignment on public.transaction_tax_classifications;
create trigger tax_vehicle_sync_assignment after insert or update of metadata on public.transaction_tax_classifications for each row execute function public.tax_vehicle_sync_assignment();
-- Backfill only already-explicit, same-business metadata. No inferred vehicle,
-- treatment, status, amount or provenance is changed, including the six rows.
insert into public.tax_vehicle_transaction_assignments(business_id,tax_year,transaction_id,classification_id,vehicle_id)
 select c.business_id,c.tax_year,c.transaction_id,c.id,v.id from public.transaction_tax_classifications c
 join public.tax_vehicles v on v.business_id=c.business_id and v.id::text=c.metadata->>'vehicle_id'
 where coalesce(c.metadata->>'vehicle_scope_released','false')<>'true'
 on conflict(business_id,tax_year,transaction_id) do nothing;

-- A narrowly scoped lock avoids granting rate-configuration writes to service_role.
create or replace function public.tax_vehicle_lock_rates() returns void language plpgsql security definer set search_path=public as $$begin lock table public.tax_vehicle_mileage_rates in share mode;end $$;
revoke all on function public.tax_vehicle_lock_rates() from public,anon,authenticated;
grant execute on function public.tax_vehicle_lock_rates() to service_role;

create or replace function public.tax_vehicle_command_state(b uuid,y integer) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object(
  'classifications',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.transaction_tax_classifications c where c.business_id=b and c.tax_year=y),'[]'::jsonb),
  'sourceTransactions',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'signedAmount',t.signed_amount,'amount',t.amount,'direction',t.direction,'date',t.date,'pending',t.pending,'archived',t.is_archived) order by t.id) from public.bank_transactions t where t.business_id=b and exists(select 1 from public.transaction_tax_classifications c where c.transaction_id=t.id and c.business_id=b and c.tax_year=y)),'[]'::jsonb),
  'vehicles',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from public.tax_vehicles v where v.business_id=b),'[]'::jsonb),
  'elections',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.tax_vehicle_method_elections e where e.business_id=b and e.tax_year=y and e.status in ('active','finalized')),'[]'::jsonb),
  'mileage',coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.tax_vehicle_mileage_inputs m where m.business_id=b and m.tax_year=y and m.status in ('active','finalized','inactive') and m.superseded_by is null),'[]'::jsonb),
  'assignments',coalesce((select jsonb_agg(to_jsonb(a) order by a.transaction_id) from public.tax_vehicle_transaction_assignments a where a.business_id=b and a.tax_year=y),'[]'::jsonb),
  'rates',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.tax_vehicle_mileage_rates r where r.status='active' and r.purpose='business' and r.effective_start<=make_date(y,12,31) and r.effective_end>=make_date(y,1,1)),'[]'::jsonb),
  'projection',(select jsonb_build_object('id',p.id,'sourceFingerprint',p.source_fingerprint) from public.tax_workspace_projections p where p.business_id=b and p.tax_year=y and p.projection_version='tax-workspace-v2' and p.status='complete' order by p.generated_at desc,p.created_at desc limit 1)
 );
$$;

create or replace function public.tax_vehicle_command_plan(b uuid,y integer,u uuid,i jsonb) returns jsonb language plpgsql set search_path=public as $$
declare
 a text:=i->>'action';v public.tax_vehicles%rowtype;e public.tax_vehicle_method_elections%rowtype;
 c public.transaction_tax_classifications%rowtype;r public.tax_vehicle_mileage_rates%rowtype;bank_row public.bank_transactions%rowtype;matrix_ids jsonb;
 x jsonb;rows jsonb:='[]';skipped jsonb:='[]';entries jsonb:='[]';new_vehicle jsonb;
 method text;percent numeric;amount numeric;before_total numeric:=0;after_total numeric:=0;mileage_total numeric:=0;
 nextrow jsonb;md jsonb;before_mileage numeric:=0;after_mileage numeric:=0;label text;is_manual boolean;selected integer;ownership text;new_election jsonb;
begin
 if a not in ('amend','assign','exclude','recategorize','correct_mileage') or a is null or length(trim(coalesce(i->>'reason','')))<3 then raise exception 'vehicle_command_invalid' using errcode='22023';end if;
 if jsonb_typeof(i->'transactionIds')='array' then
  selected:=jsonb_array_length(i->'transactionIds');
  if selected<>(select count(distinct value) from jsonb_array_elements_text(i->'transactionIds')) then raise exception 'vehicle_scope_invalid' using errcode='22023';end if;
 else selected:=0;end if;
 if a in ('assign','exclude','recategorize') then
  if selected<1 or selected>1000 or selected<>(select count(*) from public.transaction_tax_classifications where business_id=b and tax_year=y and transaction_id::text in(select value from jsonb_array_elements_text(i->'transactionIds'))) then raise exception 'vehicle_scope_invalid' using errcode='42501';end if;
 end if;
 if nullif(i->>'vehicleId','') is not null then
  select * into v from public.tax_vehicles where id=(i->>'vehicleId')::uuid and business_id=b and status='active';
  if not found then raise exception 'vehicle_scope_invalid' using errcode='42501';end if;
 elsif a in ('assign','amend') then
  if coalesce((i->>'primaryVehicle')::boolean,false) then
   if (select count(*) from public.tax_vehicles where business_id=b and status='active')>1 then raise exception 'vehicle_attribution_required' using errcode='22023';end if;
   select * into v from public.tax_vehicles where business_id=b and status='active' limit 1;
  elsif not coalesce((i->>'newVehicle')::boolean,false) then raise exception 'vehicle_attribution_required' using errcode='22023';end if;
  if v.id is null then
   v.id:=(i->>'_newVehicleId')::uuid;
   if v.id is null then raise exception 'vehicle_scope_invalid' using errcode='22023';end if;
   new_vehicle:=jsonb_build_object('id',v.id,'display_name',coalesce(nullif(trim(i->>'displayName'),''),case when coalesce((i->>'primaryVehicle')::boolean,false) then 'Primary vehicle' else 'Additional vehicle' end),'placeholder_key',case when coalesce((i->>'primaryVehicle')::boolean,false) then 'primary' else null end);
  end if;
 end if;
 if v.id is not null then select * into e from public.tax_vehicle_method_elections where business_id=b and tax_year=y and vehicle_id=v.id and status in('active','finalized');end if;
 method:=e.method;percent:=e.business_use_percent;
 if a='amend' then
  method:=i->>'method';
  if method not in ('standard_mileage','actual_expenses') or method is null then raise exception 'vehicle_method_invalid' using errcode='22023';end if;
  if v.ownership_type is not null and nullif(i->>'ownershipType','') is not null and v.ownership_type<>i->>'ownershipType' then raise exception 'vehicle_ownership_history_conflict' using errcode='22023';end if;
  ownership:=coalesce(v.ownership_type,nullif(i->>'ownershipType','')); 
  if e.id is not null and e.method<>method then
   if ownership is null or ownership<>'owned' then raise exception 'vehicle_method_eligibility_unknown_or_leased' using errcode='22023';end if;
   if coalesce((i->>'confirmYearRecalculation')::boolean,false) is false then raise exception 'vehicle_year_recalculation_confirmation_required' using errcode='22023';end if;
  end if;
  if method='standard_mileage' then
   if not(coalesce((i->'eligibility'->>'ownedOrLeased')::boolean,false) and coalesce((i->'eligibility'->>'firstYearAvailable')::boolean,false) and coalesce((i->'eligibility'->>'fleetUnderFive')::boolean,false) and coalesce((i->'eligibility'->>'noDisallowedDepreciation')::boolean,false)) then raise exception 'standard_mileage_eligibility_unconfirmed' using errcode='22023';end if;
   percent:=0;
  else
   if coalesce(i->>'businessUsePercent','') !~ '^\d{1,3}(\.\d{1,2})?$' then raise exception 'vehicle_business_use_invalid' using errcode='22023';end if;
   percent:=(i->>'businessUsePercent')::numeric;
   if percent<=0 or percent>100 or (percent=100 and not coalesce((i->>'allBusinessConfirmed')::boolean,false)) then raise exception 'vehicle_business_use_invalid' using errcode='22023';end if;
  end if;
  new_election:=jsonb_build_object('vehicle_id',v.id,'method',method,'business_use_percent',percent,'ownership_type',ownership,'eligibility',coalesce(i->'eligibility','{}'));
 end if;
 if a='recategorize' and coalesce(i->>'taxCategory','') not in ('office_expense','materials_supplies','travel_transportation','other_business_expense') then raise exception 'nonvehicle_category_required' using errcode='22023';end if;
 select projection_data->'identityEvidence'->'matrixIncluded' into matrix_ids from public.tax_workspace_projections where id=(i->>'projectionId')::uuid and business_id=b and tax_year=y;
 for c in select t.* from public.transaction_tax_classifications t
  left join public.tax_vehicle_transaction_assignments ta on ta.business_id=t.business_id and ta.tax_year=t.tax_year and ta.transaction_id=t.transaction_id
  where t.business_id=b and t.tax_year=y and (
   (a in ('assign','exclude','recategorize') and t.transaction_id::text in(select value from jsonb_array_elements_text(i->'transactionIds')))
   or (a='amend' and coalesce(ta.vehicle_id::text,t.metadata->>'vehicle_id')=v.id::text and coalesce(t.metadata->>'vehicle_scope_released','false')<>'true'))
  order by t.id
 loop
  if coalesce(matrix_ids,'[]'::jsonb) @> to_jsonb(c.transaction_id::text) is not true then raise exception 'vehicle_scope_outside_matrix' using errcode='42501';end if;
  select * into bank_row from public.bank_transactions where id=c.transaction_id and business_id=b;
  if not found or bank_row.pending or bank_row.is_archived or bank_row.date<make_date(y,1,1) or bank_row.date>make_date(y,12,31) or round(coalesce(bank_row.signed_amount,case when bank_row.direction='INFLOW' then abs(bank_row.amount) else -abs(bank_row.amount) end)*100) is distinct from round(c.book_amount*100) then raise exception 'vehicle_source_evidence_changed' using errcode='40001';end if;
  if not(public.tax_vehicle_is_expense_scope(c.tax_category,c.source_qbo_account_name,c.tax_treatment) or c.metadata ? 'vehicle_id') then raise exception 'vehicle_scope_invalid' using errcode='42501';end if;
  if c.cpa_override or c.classification_status in ('cpa_confirmed','accountant_reviewed','bizzi_operator_confirmed') then
   if a<>'amend' then raise exception 'cpa_authority_protected' using errcode='42501';end if;
   skipped:=skipped||jsonb_build_array(jsonb_build_object('transactionId',c.transaction_id,'reason','CPA/manual authority'));continue;
  end if;
  is_manual:=(coalesce(c.user_override,false) or c.classification_status='user_confirmed') and ((c.metadata->>'decision_authority') is distinct from 'vehicle_method' or coalesce((c.metadata->>'manual_vehicle_correction')::boolean,false));
  if a='amend' and is_manual and not coalesce((i->>'supersedeManual')::boolean,false) then
   -- A deductible manual exception cannot survive a switch to Standard Mileage.
   if method='standard_mileage' and coalesce(c.deductible_amount,0)>0 then raise exception 'manual_deduction_conflicts_with_mileage' using errcode='22023';end if;
   skipped:=skipped||jsonb_build_array(jsonb_build_object('transactionId',c.transaction_id,'reason','Explicit user override'));continue;
  end if;
  md:=coalesce(c.metadata,'{}')||jsonb_build_object('decision_actor_id',u,'decision_reason',i->>'reason','decision_at',i->>'_at','vehicle_tax_year',y);
  if a='exclude' then
   amount:=0;nextrow:=to_jsonb(c)||jsonb_build_object('tax_treatment','vehicle_manual_excluded','deductibility_status','nondeductible','deductible_percent',0,'deductible_amount',0,'nondeductible_amount',abs(c.book_amount),'classification_status','user_confirmed','requires_review',false,'user_override',true,'source','user','metadata',md||'{"manual_vehicle_correction":true,"decision_authority":"user"}'::jsonb);
  elsif a='recategorize' then
   amount:=abs(c.book_amount);md:=(md-'vehicle_id'-'vehicle_election_id'-'vehicle_method')||'{"vehicle_scope_released":true,"manual_vehicle_correction":true,"decision_authority":"user"}'::jsonb;
   nextrow:=to_jsonb(c)||jsonb_build_object('tax_category',i->>'taxCategory','tax_treatment','manual_non_vehicle_expense','deductibility_status','fully_deductible','deductible_percent',100,'deductible_amount',amount,'nondeductible_amount',0,'classification_status','user_confirmed','requires_review',false,'user_override',true,'source','user','metadata',md);
  else
   md:=(md-'vehicle_scope_released')||jsonb_build_object('vehicle_id',v.id,'vehicle_method',method,'decision_authority','vehicle_method','manual_vehicle_correction',false);
   if method is null then
    amount:=0;md:=md-'vehicle_election_id';
    nextrow:=to_jsonb(c)||jsonb_build_object('tax_category','vehicle_expense','tax_treatment','vehicle_expense','deductibility_status','needs_review','deductible_percent',0,'deductible_amount',0,'nondeductible_amount',0,'classification_status','needs_review','requires_review',true,'user_override',false,'source','user','metadata',md);
   else
    amount:=case when method='standard_mileage' then 0 else round(abs(c.book_amount)*percent/100,2) end;
    nextrow:=to_jsonb(c)||jsonb_build_object('tax_category','vehicle_expense','tax_treatment',case when method='standard_mileage' then 'vehicle_standard_mileage_no_separate_gas' else 'vehicle_actual_expense_business_use' end,'deductibility_status',case when percent=0 then 'nondeductible' when percent=100 then 'fully_deductible' else 'partially_deductible' end,'deductible_percent',percent,'deductible_amount',amount,'nondeductible_amount',abs(c.book_amount)-amount,'classification_status','user_confirmed','requires_review',false,'user_override',false,'source','user','metadata',md);
   end if;
  end if;
  before_total:=before_total+case when c.book_amount>0 then -1 else 1 end*coalesce(c.deductible_amount,0);
  after_total:=after_total+case when c.book_amount>0 then -1 else 1 end*amount;
  rows:=rows||jsonb_build_array(nextrow||jsonb_build_object('previousDeductibleAmount',c.deductible_amount));
 end loop;
 if a='correct_mileage' then
  if not coalesce((i->>'recordsConfirmed')::boolean,false) then raise exception 'mileage_records_confirmation_required' using errcode='22023';end if;
  if e.id is null or e.method<>'standard_mileage' then raise exception 'standard_mileage_inactive' using errcode='22023';end if;
  if jsonb_typeof(i->'entries') is distinct from 'array' or jsonb_array_length(i->'entries')=0 then raise exception 'mileage_entries_required' using errcode='22023';end if;
  for x in select value from jsonb_array_elements(i->'entries') loop
   if coalesce(x->>'businessMiles','') !~ '^\d+(\.\d{1,2})?$' or (x->>'businessMiles')::numeric>1000000
     or (x->>'periodStart')::date<make_date(y,1,1) or (x->>'periodEnd')::date>make_date(y,12,31) or (x->>'periodStart')::date>(x->>'periodEnd')::date then raise exception 'invalid_mileage_period_or_miles' using errcode='22023';end if;
   select * into r from public.tax_vehicle_mileage_rates where purpose='business' and status='active' and (x->>'periodStart')::date>=effective_start and (x->>'periodEnd')::date<=effective_end;
   if not found then raise exception 'mileage_period_requires_rate_allocation' using errcode='22023';end if;
   if exists(select 1 from jsonb_array_elements(entries) p where daterange((p->>'period_start')::date,(p->>'period_end')::date,'[]')&&daterange((x->>'periodStart')::date,(x->>'periodEnd')::date,'[]')) then raise exception 'duplicate_or_overlapping_mileage' using errcode='22023';end if;
   entries:=entries||jsonb_build_array(jsonb_build_object('period_start',x->>'periodStart','period_end',x->>'periodEnd','business_miles',(x->>'businessMiles')::numeric,'mileage_basis','records','substantiation_status','supported','finalize',e.status='finalized'));
   mileage_total:=mileage_total+round((x->>'businessMiles')::numeric*r.amount_per_mile,2);
  end loop;
 end if;
 -- CPA exceptions are preserved, but cannot coexist with a conflicting new method.
 if a='amend' and method='standard_mileage' and exists(select 1 from public.transaction_tax_classifications t join public.tax_vehicle_transaction_assignments z on z.classification_id=t.id where z.business_id=b and z.tax_year=y and z.vehicle_id=v.id and (t.cpa_override or t.classification_status in('cpa_confirmed','bizzi_operator_confirmed')) and coalesce(t.deductible_amount,0)>0) then raise exception 'cpa_deduction_conflicts_with_mileage' using errcode='22023';end if;
 select coalesce(sum(deduction_amount),0) into before_mileage from public.tax_vehicle_mileage_inputs where business_id=b and tax_year=y and vehicle_id=v.id and status in('active','finalized') and superseded_by is null;
 after_mileage:=before_mileage;
 if a='amend' then
  if method='actual_expenses' then after_mileage:=0;
  else select coalesce(sum(deduction_amount),0) into after_mileage from public.tax_vehicle_mileage_inputs where business_id=b and tax_year=y and vehicle_id=v.id and status in('active','finalized','inactive') and superseded_by is null;end if;
 end if;
 label:=case when exists(select 1 from jsonb_array_elements(rows) z where coalesce(z->>'source_qbo_account_name','')!~* '\m(gas|fuel)\M') then 'Estimated deductible vehicle expense' else 'Estimated deductible gas expense' end;
 if a='amend' and method='standard_mileage' then label:='Separate vehicle-expense deduction';end if;
 if a='correct_mileage' then before_total:=before_mileage;after_total:=mileage_total;after_mileage:=mileage_total;label:='Mileage Deduction';end if;
 return jsonb_build_object('rows',rows,'skipped',skipped,'newVehicle',new_vehicle,'vehicleId',v.id,'previousElectionId',e.id,'newElection',new_election,'entries',entries,'beforeDeduction',before_total,'afterDeduction',after_total,'mileageDeduction',after_mileage,'beforeMileageDeduction',before_mileage,'afterMileageDeduction',after_mileage,'finalizedCorrection',e.status='finalized','affectedCount',jsonb_array_length(rows),'label',label);
end $$;

create or replace function public.preview_tax_vehicle_command(b uuid,y integer,u uuid,i jsonb) returns jsonb language plpgsql set search_path=public as $$
declare s jsonb;p jsonb;v_id uuid:=gen_random_uuid();begin
 if u is null or not exists(select 1 from public.business_profiles where id=b and user_id=u) and not exists(select 1 from public.user_business_link where business_id=b and user_id=u) then raise exception 'vehicle_command_unauthorized' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(b::text||':vehicle-election',0));
 perform public.tax_vehicle_lock_rates();
 s:=public.tax_vehicle_command_state(b,y);
 if coalesce(s->'projection'->>'id','') is distinct from coalesce(i->>'projectionId','') or coalesce(s->'projection'->>'sourceFingerprint','') is distinct from coalesce(i->>'sourceFingerprint','') or s->'projection'='null'::jsonb then raise exception 'vehicle_projection_stale' using errcode='40001';end if;
 i:=(i-'_newVehicleId'-'_at')||jsonb_build_object('_newVehicleId',gen_random_uuid(),'_at',now());
 if octet_length(s::text)>16777216 then raise exception 'vehicle_scope_too_large' using errcode='22023';end if;
 p:=public.tax_vehicle_command_plan(b,y,u,i);
 insert into public.tax_vehicle_command_previews(id,business_id,tax_year,actor_user_id,choices,before_state,plan) values(v_id,b,y,u,i,s,p);
 return jsonb_build_object('previewId',v_id,'plan',p,'expiresInSeconds',900);
end $$;

create or replace function public.apply_tax_vehicle_command(b uuid,y integer,u uuid,p_id uuid,k text) returns jsonb language plpgsql set search_path=public as $$
declare p public.tax_vehicle_command_previews%rowtype;s jsonb;plan jsonb;x jsonb;c public.transaction_tax_classifications%rowtype;
 v_id uuid;e_id uuid;new_e_id uuid;v_method text;outcome jsonb;m jsonb;begin
 if u is null or not exists(select 1 from public.business_profiles where id=b and user_id=u) and not exists(select 1 from public.user_business_link where business_id=b and user_id=u) then raise exception 'vehicle_command_unauthorized' using errcode='42501';end if;
 if length(coalesce(k,'')) not between 16 and 200 then raise exception 'vehicle_command_key_invalid' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(b::text||':vehicle-election',0));
 select * into p from public.tax_vehicle_command_previews where id=p_id and business_id=b and tax_year=y and actor_user_id=u for update;
 if not found then raise exception 'vehicle_command_unauthorized' using errcode='42501';end if;
 if p.consumed_at is not null then
  if p.idempotency_key=k then return p.result;end if;
  raise exception 'vehicle_command_already_consumed' using errcode='40001';
 end if;
 if exists(select 1 from public.tax_vehicle_command_previews where business_id=b and idempotency_key=k) then raise exception 'vehicle_command_key_conflict' using errcode='40001';end if;
 if p.expires_at<=now() then raise exception 'vehicle_command_expired' using errcode='40001';end if;
 perform public.tax_vehicle_lock_rates();
 s:=public.tax_vehicle_command_state(b,y);
 if s is distinct from p.before_state then raise exception 'vehicle_command_evidence_changed' using errcode='40001';end if;
 plan:=public.tax_vehicle_command_plan(b,y,u,p.choices);
 if plan is distinct from p.plan then raise exception 'vehicle_command_evidence_changed' using errcode='40001';end if;
 v_id:=nullif(plan->>'vehicleId','')::uuid;e_id:=nullif(plan->>'previousElectionId','')::uuid;
 if plan->'newVehicle'<>'null'::jsonb then
  insert into public.tax_vehicles(id,business_id,display_name,placeholder_key,created_by)
   values(v_id,b,plan->'newVehicle'->>'display_name',plan->'newVehicle'->>'placeholder_key',u);
 end if;
 if plan->'newElection'<>'null'::jsonb then
  new_e_id:=gen_random_uuid();v_method:=plan->'newElection'->>'method';
  update public.tax_vehicles set ownership_type=coalesce(plan->'newElection'->>'ownership_type',ownership_type),updated_at=now() where id=v_id and business_id=b;
  insert into public.tax_vehicle_method_elections(id,business_id,vehicle_id,tax_year,method,status,effective_start,effective_end,source,authority,eligibility,business_use_percent,contract_version,elected_by,metadata)
   values(new_e_id,b,v_id,y,v_method,'draft',make_date(y,1,1),make_date(y,12,31),'vehicle_year_amendment','customer',plan->'newElection'->'eligibility',(plan->'newElection'->>'business_use_percent')::numeric,'vehicle-authority-v2',u,jsonb_build_object('command_preview_id',p.id,'reason',p.choices->>'reason'));
  if e_id is not null then update public.tax_vehicle_method_elections set status='superseded',superseded_by=new_e_id where id=e_id;end if;
  update public.tax_vehicle_method_elections set status='active' where id=new_e_id;
  update public.tax_vehicles set ownership_type=coalesce(plan->'newElection'->>'ownership_type',ownership_type),updated_at=now() where id=v_id and business_id=b;
  update public.tax_vehicle_mileage_inputs set status=case when v_method='actual_expenses' then 'inactive' else 'active' end,updated_at=now()
   where business_id=b and tax_year=y and vehicle_id=v_id and superseded_by is null and status in ('active','finalized','inactive');
 else new_e_id:=e_id;end if;
 for x in select value from jsonb_array_elements(plan->'rows') loop
  select * into c from public.transaction_tax_classifications where id=(x->>'id')::uuid and business_id=b and tax_year=y for update;
  x:=jsonb_set(x,'{metadata,decision_at}',to_jsonb(now()),true);
  if (x->'metadata'->>'decision_authority')='vehicle_method' and new_e_id is not null then x:=jsonb_set(x,'{metadata,vehicle_election_id}',to_jsonb(new_e_id::text),true);end if;
  insert into public.tax_classification_overrides(business_id,tax_year,transaction_id,classification_id,previous_values,new_values,override_source,override_reason,overridden_by,created_at)
   values(b,y,c.transaction_id,c.id,to_jsonb(c),x,'user',p.choices->>'reason',u,now());
  update public.transaction_tax_classifications set tax_category=x->>'tax_category',tax_treatment=x->'tax_treatment',
   deductibility_status=x->>'deductibility_status',deductible_percent=(x->>'deductible_percent')::numeric,deductible_amount=(x->>'deductible_amount')::numeric,
   nondeductible_amount=(x->>'nondeductible_amount')::numeric,capitalizable_amount=0,classification_status=x->>'classification_status',requires_review=(x->>'requires_review')::boolean,
   user_override=(x->>'user_override')::boolean,source='user',metadata=x->'metadata',reason=p.choices->>'reason',updated_at=now()
   where id=c.id;
 end loop;
 if p.choices->>'action'='correct_mileage' then
  update public.tax_vehicle_method_elections set status='active',finalized_at=null where id=e_id;
  update public.tax_vehicle_mileage_inputs set status='active' where business_id=b and tax_year=y and vehicle_id=v_id and status='finalized' and superseded_by is null;
  m:=public.replace_tax_vehicle_mileage_entries(b,y,v_id,u,e_id,plan->'entries');
  if coalesce((plan->>'finalizedCorrection')::boolean,false) then
   update public.tax_vehicle_method_elections set status='finalized',finalized_at=now() where id=e_id;
   update public.tax_vehicle_mileage_inputs set status='finalized',finalized_at=coalesce(finalized_at,now()) where business_id=b and tax_year=y and vehicle_id=v_id and status='active' and superseded_by is null;
  end if;
 end if;
 outcome:=jsonb_build_object('action',p.choices->>'action','previewId',p.id,'appliedCount',plan->'affectedCount','vehicleId',v_id,'electionId',new_e_id,'deductibleAmount',plan->'afterDeduction','mileage',m,'skipped',plan->'skipped');
 update public.tax_vehicle_command_previews set consumed_at=now(),idempotency_key=k,result=outcome,after_state=public.tax_vehicle_command_state(b,y) where id=p.id;
 return outcome;
end $$;

create or replace function public.tax_vehicle_command_manifest_immutable() returns trigger language plpgsql as $$begin
 if old.choices is distinct from new.choices or old.before_state is distinct from new.before_state or old.plan is distinct from new.plan or old.actor_user_id is distinct from new.actor_user_id or old.business_id is distinct from new.business_id or old.tax_year is distinct from new.tax_year or (old.consumed_at is not null and new is distinct from old) then raise exception 'vehicle_manifest_immutable' using errcode='42501';end if;return new;end $$;
drop trigger if exists tax_vehicle_command_manifest_immutable on public.tax_vehicle_command_previews;
create trigger tax_vehicle_command_manifest_immutable before update on public.tax_vehicle_command_previews for each row execute function public.tax_vehicle_command_manifest_immutable();

revoke all on function public.tax_vehicle_command_state(uuid,integer), public.tax_vehicle_command_plan(uuid,integer,uuid,jsonb),public.preview_tax_vehicle_command(uuid,integer,uuid,jsonb),public.apply_tax_vehicle_command(uuid,integer,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.tax_vehicle_command_state(uuid,integer), public.tax_vehicle_command_plan(uuid,integer,uuid,jsonb),public.preview_tax_vehicle_command(uuid,integer,uuid,jsonb),public.apply_tax_vehicle_command(uuid,integer,uuid,uuid,text) to service_role;

-- Keep the original 76/70/six grouped contract while enforcing the new DB guards.
create or replace function public.apply_grouped_tax_vehicle_decision_from_preview(
  p_preview_id uuid, p_business_id uuid, p_tax_year integer, p_actor_user_id uuid,
  p_override_source text, p_override_reason text, p_idempotency_key text,
  p_confirmation_fingerprint text, p_scope jsonb, p_scope_fingerprint text,
  p_target_transaction_ids jsonb, p_expected_population_transaction_ids jsonb,
  p_items jsonb, p_rule jsonb, p_vehicle_election jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_vehicle public.tax_vehicles%rowtype;
  v_current public.tax_vehicle_method_elections%rowtype;
  v_new_id uuid := gen_random_uuid();
  v_method text;
  v_result jsonb;
  v_active_vehicle_count integer;
begin
  -- Serializes placeholder creation and elections for this business; all writes
  -- roll back if preview membership, authorization or fingerprints fail later.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':vehicle-election', 0));
  if coalesce(p_vehicle_election->>'vehicle_scope','') = 'multiple' then
    raise exception 'vehicle_allocation_required' using errcode='22023';
  end if;
  if nullif(p_vehicle_election->>'vehicle_id','') is null then
    if p_vehicle_election->>'vehicle_scope' is distinct from 'one' then
      raise exception 'vehicle_attribution_required' using errcode='22023';
    end if;
    select count(*) into v_active_vehicle_count from public.tax_vehicles
      where business_id=p_business_id and status='active';
    if v_active_vehicle_count > 1 then
      raise exception 'vehicle_attribution_required' using errcode='22023';
    end if;
    select * into v_vehicle from public.tax_vehicles
      where business_id=p_business_id and status='active' limit 1 for update;
    if not found then
      insert into public.tax_vehicles(business_id,display_name,placeholder_key,created_by)
      values(p_business_id,'Primary vehicle','primary',p_actor_user_id)
      on conflict (business_id,placeholder_key) where placeholder_key is not null
      do update set status='active',updated_at=now()
      returning * into v_vehicle;
    end if;
    p_vehicle_election := p_vehicle_election || jsonb_build_object('vehicle_id',v_vehicle.id);
  end if;
  select * into v_vehicle from public.tax_vehicles
  where id = nullif(p_vehicle_election->>'vehicle_id','')::uuid
    and business_id = p_business_id and status = 'active'
  for update;
  if not found then raise exception 'vehicle_not_found' using errcode = '42501'; end if;

  v_method := case p_vehicle_election->>'method'
    when 'standard_mileage' then 'standard_mileage'
    when 'actual_expense' then 'actual_expenses'
    when 'actual_expenses' then 'actual_expenses'
    else null end;
  if v_method is null then raise exception 'invalid_vehicle_method' using errcode = '22023'; end if;
  select count(*) into v_active_vehicle_count from public.tax_vehicles
  where business_id = p_business_id and status = 'active';
  if v_active_vehicle_count > 1 and not coalesce((p_vehicle_election->'eligibility'->>'allTransactionsAttributed')::boolean,false) then
    raise exception 'vehicle_attribution_required' using errcode = '22023';
  end if;
  if v_method = 'standard_mileage' and not (
    coalesce((p_vehicle_election->'eligibility'->>'ownedOrLeased')::boolean,false)
    and coalesce((p_vehicle_election->'eligibility'->>'firstYearAvailable')::boolean,false)
    and coalesce((p_vehicle_election->'eligibility'->>'fleetUnderFive')::boolean,false)
    and coalesce((p_vehicle_election->'eligibility'->>'noDisallowedDepreciation')::boolean,false)
  ) then
    raise exception 'standard_mileage_eligibility_unconfirmed' using errcode = '22023';
  end if;

  select * into v_current from public.tax_vehicle_method_elections
  where business_id=p_business_id and vehicle_id=v_vehicle.id and tax_year=p_tax_year
    and status in ('active','finalized') for update;
  if found and v_current.status='finalized' then
    raise exception 'vehicle_election_finalized' using errcode = '40001';
  end if;
  if v_current.id is not null
     and v_current.metadata->>'idempotency_key' = p_idempotency_key then
    p_rule := p_rule || jsonb_build_object('requires_review',true,'default_deductible_percent',0,
    'deductibility_status','needs_review','treatment',jsonb_build_object('type','vehicle_expense'),
    'effective_to',make_date(p_tax_year,12,31));
  v_result := public.apply_grouped_tax_deduction_decision_from_preview(
      p_preview_id,p_business_id,p_tax_year,p_actor_user_id,p_override_source,p_override_reason,
      p_idempotency_key,p_confirmation_fingerprint,p_scope,p_scope_fingerprint,
      p_target_transaction_ids,p_expected_population_transaction_ids,p_items,p_rule
    );
    return v_result || jsonb_build_object('vehicle_election_id',v_current.id,'vehicle_id',v_vehicle.id,'vehicle_method',v_current.method);
  end if;
  if coalesce(p_vehicle_election->>'expected_active_election_id','') <> coalesce(v_current.id::text,'') then
    raise exception 'vehicle_election_changed' using errcode = '40001';
  end if;

  if v_current.id is not null and (
    v_current.method <> v_method or
    coalesce(v_current.business_use_percent,-1) <> coalesce(nullif(p_vehicle_election->>'business_use_percent','')::numeric,-1)
  ) then
    raise exception 'vehicle_method_change_requires_year_recalculation' using errcode='40001';
  end if;
  if v_method='actual_expenses' and (
    nullif(p_vehicle_election->>'business_use_percent','') is null or
    (p_vehicle_election->>'business_use_percent')::numeric not between 0 and 100
  ) then raise exception 'invalid_vehicle_business_use_percent' using errcode='22023'; end if;

  -- Establish the election before guarded classification writes. Any stale
  -- preview or membership error rolls this back in the same transaction.
  if v_current.id is null then
  insert into public.tax_vehicle_method_elections
    (id,business_id,vehicle_id,tax_year,method,status,effective_start,effective_end,source,authority,
     eligibility,business_use_percent,contract_version,elected_by,metadata)
  values
    (v_new_id,p_business_id,v_vehicle.id,p_tax_year,v_method,'active',make_date(p_tax_year,1,1),make_date(p_tax_year,12,31),
     'tax_workspace_question','customer',coalesce(p_vehicle_election->'eligibility','{}'::jsonb),
     nullif(p_vehicle_election->>'business_use_percent','')::numeric,'vehicle-election-v1',p_actor_user_id,
     jsonb_build_object(
       'question_group_id',p_scope->>'semantic_fingerprint',
       'idempotency_key',p_idempotency_key,
       'scope_fingerprint',p_scope_fingerprint,
       'confirmation_fingerprint',p_confirmation_fingerprint
     ));

    select * into v_current from public.tax_vehicle_method_elections where id=v_new_id;
  end if;

  -- Persist vehicle attribution with the exact authoritative changed members.
  -- Protected members never enter p_items and remain byte-for-byte unchanged.
  select jsonb_agg(item || jsonb_build_object('metadata',coalesce(item->'metadata','{}'::jsonb) ||
    jsonb_build_object('vehicle_id',v_vehicle.id,'vehicle_election_id',coalesce(v_current.id,v_new_id),
      'vehicle_method',v_method,'vehicle_tax_year',p_tax_year,'decision_authority','vehicle_method')))
    into p_items from jsonb_array_elements(p_items) item;
  p_rule := p_rule || jsonb_build_object('requires_review',true,'default_deductible_percent',0,
    'deductibility_status','needs_review','treatment',jsonb_build_object('type','vehicle_expense'),
    'effective_to',make_date(p_tax_year,12,31));
  v_result := public.apply_grouped_tax_deduction_decision_from_preview(
    p_preview_id,p_business_id,p_tax_year,p_actor_user_id,p_override_source,p_override_reason,
    p_idempotency_key,p_confirmation_fingerprint,p_scope,p_scope_fingerprint,
    p_target_transaction_ids,p_expected_population_transaction_ids,p_items,p_rule
  );

  return v_result || jsonb_build_object('vehicle_election_id',v_current.id,'vehicle_id',v_vehicle.id,'vehicle_method',v_method);
end;
$$;

revoke all on function public.apply_grouped_tax_vehicle_decision_from_preview(uuid,uuid,integer,uuid,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.apply_grouped_tax_vehicle_decision_from_preview(uuid,uuid,integer,uuid,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;


commit;
