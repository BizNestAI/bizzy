/* global process, Buffer */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import express from "express";
import { SignJWT } from "jose";
import { localPostgrestProxy } from "./localPostgrest.js";
import { admissionNotice } from "../../src/utils/autoPostAdmissionView.js";

export async function testAdmissionRoutes({sql,businessId,transactionId,foreignBusinessId,foreignId,container,network}) {
  const secret="synthetic-admission-route-secret-at-least-32-characters";
  const apiName=`${container}-api`;
  const launched=spawnSync("docker",["run","--pull=never","--name",apiName,"--network",network,
    "-e",`PGRST_DB_URI=postgres://postgres:local-only@${container}:5432/postgres`,"-e","PGRST_DB_SCHEMAS=public",
    "-e","PGRST_DB_ANON_ROLE=anon","-e",`PGRST_JWT_SECRET=${secret}`,"-d","public.ecr.aws/supabase/postgrest:v16.4"],{encoding:"utf8"});
  assert.equal(launched.status,0,launched.stderr);
  const proxy=await localPostgrestProxy({container,apiName});
  let server;
  const originalFetch=globalThis.fetch;
  const origins=new Set([proxy.url]);
  globalThis.fetch=(input,...args)=>{
    const target=new URL(typeof input==="string"||input instanceof URL?input:input.url);
    assert.ok(origins.has(target.origin),"Only disposable database and local route HTTP are permitted");
    if(target.origin===proxy.url)target.pathname=target.pathname.replace(/^\/rest\/v1(?=\/|$)/,"");
    return originalFetch(input instanceof Request?new Request(target,input):target,...args);
  };
  try {
    for(let i=0;i<100;i++){try{if((await fetch(proxy.url)).ok)break;}catch{/* startup */}await new Promise(r=>setTimeout(r,100));}
    process.env.SUPABASE_URL=proxy.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY=await new SignJWT({role:"service_role"}).setProtectedHeader({alg:"HS256"}).setExpirationTime("1h").sign(Buffer.from(secret));
    Object.assign(process.env,{NODE_ENV:"test",DISABLE_BACKGROUND_WORKERS:"true",QB_ENVIRONMENT:"production",QB_PROD_CLIENT_ID:"synthetic",QB_PROD_CLIENT_SECRET:"synthetic",QB_PROD_REDIRECT_URI:"http://localhost/synthetic",STRIPE_MODE:"test"});
    const customer=randomUUID(),staff=randomUUID(),inactive=randomUUID();
    sql(`insert into auth.users(id) values('${customer}'),('${staff}'),('${inactive}');
      update public.business_profiles set user_id='${customer}' where id='${businessId}';
      insert into public.internal_staff_users(user_id,role,active) values('${staff}','operator',true),('${inactive}','operator',false);
      insert into public.business_billing(business_id,subscription_status_test) values('${businessId}','active');`);
    const {requireAuth,__setRequireAuthTestDeps}=await import("../../src/api/gpt/middlewares/requireAuth.js");
    __setRequireAuthTestDeps({verifyToken:async()=>({userId:customer})});
    const {requireBusinessAccess,rejectAdminViewWrites}=await import("../../src/api/_shared/tenantAuth.js");
    const {requirePaidMutation}=await import("../../src/api/_shared/entitlementAuth.js");
    const {default:router}=await import("../../src/api/bookkeeping/routes/bookkeeping.posting.routes.js");
    const app=express();app.use(express.json());
    // Session authentication is a fixture boundary. All route, staff, tenant,
    // entitlement and database admission checks below use production code.
    app.use((req,res,next)=>{
      const session=req.headers["x-test-session"];
      if(["admin","inactive","readonly"].includes(session)) {
        const actor=session==="inactive"?inactive:staff;
        req.auth={userId:actor};req.user={id:actor};
        req.tenantContext={mode:"admin_view",businessId,staffUserId:actor,capabilities:session==="readonly"?[]:["admin_bookkeeping_write"]};
        if(req.headers["x-business-id"]!==businessId || (req.body?.business_id && req.body.business_id!==businessId))return res.status(403).json({ok:false,error:"admin_view_business_mismatch"});
        req.business={id:businessId};return next();
      }
      return requireAuth(req,res,()=>requireBusinessAccess()(req,res,next));
    });
    app.use("/api/bookkeeping",rejectAdminViewWrites(),requirePaidMutation(),router);
    server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
    const origin=`http://127.0.0.1:${server.address().port}`;origins.add(origin);
    let session="customer";
    const safeFetch=async(path,options={})=>{
      const response=await fetch(origin+path,{...options,headers:{...options.headers,authorization:"Bearer synthetic","x-test-session":session}});
      const body=await response.json();if(!response.ok)throw {status:response.status,body};return body;
    };
    const source=fs.readFileSync("src/services/bookkeeping/bookkeepingClient.js","utf8");
    const snippet=source.slice(source.indexOf("export async function getAutoPostStatus"),source.indexOf("export async function previewAutoPostBacklogScope")).replaceAll("export ","");
    const client=new Function("safeFetch","apiUrl","withBizHeaders",`${snippet};return {previewAutoPostAdmissionScope,updateAutoPostStatus,getAutoPostStatus};`)(safeFetch,x=>x,(id,h={})=>({...h,"x-business-id":id}));
    await assert.rejects(client.updateAutoPostStatus(businessId,{enabled:true,handledAdmissionVersion:2}),error=>error.requiresConfirmation && error.handledBacklogCount===1);
    const options={enabled:true,confirmBacklog:true,scopeMode:"effective_date",effectiveDate:"2026-10-01",previewAcknowledged:true,handledAdmissionVersion:2};
    const preview=await client.previewAutoPostAdmissionScope(businessId,{effectiveDate:options.effectiveDate});assert.equal(preview.state,"preview");assert.equal(preview.eligible,1);
    const before=sql(`select auto_post_to_quickbooks from public.business_profiles where id='${businessId}'`);assert.equal(before,"f");
    const manifest={preview_hash:preview.preview_hash,preview_at:preview.preview_at,transaction_ids:null};
    const stale=await client.updateAutoPostStatus(businessId,{...options,admissionPreview:{...manifest,preview_at:"2026-01-01"}});
    assert.equal(stale.error,"stale_or_changed_admission_preview");assert.equal(stale.auto_post_to_quickbooks,false);assert.match(admissionNotice(stale),/Preview again/);
    sql(`update public.bank_transactions set amount=-11 where id='${transactionId}';`);
    const changed=await client.updateAutoPostStatus(businessId,{...options,admissionPreview:manifest});assert.equal(changed.error,"stale_or_changed_admission_preview");
    assert.equal(sql(`select auto_post_to_quickbooks from public.business_profiles where id='${businessId}'`),"f");
    const fresh=await client.previewAutoPostAdmissionScope(businessId,{effectiveDate:options.effectiveDate});
    const result=await client.updateAutoPostStatus(businessId,{...options,admissionPreview:{preview_hash:fresh.preview_hash,preview_at:fresh.preview_at,transaction_ids:null}});
    assert.equal(result.ok,true);assert.equal(result.scheduled,1);assert.equal(result.worker_wakeup.queued,false);
    assert.equal(sql(`select auto_post_effective_date from public.business_profiles where id='${businessId}'`),"2026-10-01");
    assert.ok(sql(`select post_after from public.transaction_categorizations where transaction_id='${transactionId}'`));
    // Transient atomic admission failure returns actual On policy all the way to
    // the client/UI, with no synthetic successful toggle or separate scope save.
    sql("alter function public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamptz,text,timestamptz,uuid,date,text) rename to temporarily_unavailable_admission;");
    const retry=await client.updateAutoPostStatus(businessId,{enabled:true,confirmBacklog:true,handledAdmissionVersion:2});
    assert.equal(retry.state,"retry");assert.equal(retry.auto_post_to_quickbooks,true);assert.equal(admissionNotice(retry),"Scheduling needs retry");
    sql("alter function public.temporarily_unavailable_admission(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamptz,text,timestamptz,uuid,date,text) rename to admit_handled_auto_post;");
    const adminRequest=(endpoint,body)=>safeFetch(`/api/bookkeeping/posting/auto-post/${endpoint}`,{method:"POST",headers:{"Content-Type":"application/json","x-business-id":businessId},body:JSON.stringify(body)});
    const ids=[transactionId];const anchor=new Date().toISOString();
    session="customer";await assert.rejects(adminRequest("admission-preview",{transaction_ids:ids,repair_anchor:anchor}),e=>e.status===403);
    session="inactive";await assert.rejects(adminRequest("admission-preview",{transaction_ids:ids,repair_anchor:anchor}),e=>e.status===403);
    session="readonly";const adminPreview=await adminRequest("admission-preview",{transaction_ids:ids,repair_anchor:anchor});assert.equal(adminPreview.state,"preview");
    await assert.rejects(adminRequest("admission-repair",{approved:true,transaction_ids:ids,repair_anchor:anchor,preview_hash:adminPreview.preview_hash,preview_at:adminPreview.preview_at}),e=>e.status===403);
    session="admin";
    const mixed=await adminRequest("admission-preview",{transaction_ids:[transactionId,foreignId],repair_anchor:anchor});assert.equal(mixed.error,"cross_business_or_unknown_ids");
    await assert.rejects(adminRequest("admission-preview",{business_id:foreignBusinessId,transaction_ids:[foreignId],repair_anchor:anchor}),e=>e.status===403);
    await assert.rejects(adminRequest("admission-preview",{transaction_ids:Array(201).fill(transactionId),repair_anchor:anchor}),e=>e.status===400);
    await assert.rejects(adminRequest("admission-repair",{transaction_ids:ids}),e=>e.status===400);
    // Repair an expired historical unscheduled row, then retry exactly.
    sql(`update public.transaction_categorizations set post_after=null where transaction_id='${transactionId}';update public.business_profiles set auto_post_enabled_at='2026-01-01' where id='${businessId}';`);
    const repairPreview=await adminRequest("admission-preview",{transaction_ids:ids,repair_anchor:anchor});
    const repair={approved:true,transaction_ids:ids,repair_anchor:anchor,preview_hash:repairPreview.preview_hash,preview_at:repairPreview.preview_at};
    const repaired=await adminRequest("admission-repair",repair);assert.equal(repaired.scheduled,1);assert.equal(Date.parse(repaired.post_after)-Date.parse(anchor),86400000);
    const deadline=sql(`select post_after from public.transaction_categorizations where transaction_id='${transactionId}'`);
    assert.equal((await adminRequest("admission-repair",repair)).already_scheduled,1);
    assert.equal(sql(`select post_after from public.transaction_categorizations where transaction_id='${transactionId}'`),deadline);
    assert.equal(sql(`select count(*) from public.qbo_posted_transactions where business_id='${businessId}'`),"0");
    // Exercise the canonical Plaid merge, not merely a direct pending UPDATE.
    // The provider is a supplied synthetic client; only local PostgREST runs.
    const pendingId=randomUUID();
    const bank=JSON.parse(sql(`select to_jsonb(b) from public.bank_transactions b where id='${transactionId}'`));
    sql(`insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,plaid_transaction_id,plaid_env,name,date,amount,direction,pending)
      values('${pendingId}','${businessId}','${bank.plaid_item_id}','${bank.plaid_account_id}','${pendingId}','production','Synthetic pending','2026-11-01',-10,'OUTFLOW',true);
      insert into public.transaction_categorizations(business_id,transaction_id,status,final_qbo_account_id,meta) values('${businessId}','${pendingId}','auto_approved','destination','{"safe_to_auto_post":false}');`);
    const plaidItem=JSON.parse(sql(`select to_jsonb(i) from public.plaid_items i where business_id='${businessId}' and plaid_item_id='${bank.plaid_item_id}'`));
    const {supabase}=await import("../../src/services/supabaseAdmin.js");
    const {runSyncForItem}=await import("../../src/services/plaid/plaidSyncService.js");
    const {admitHandledAutoPost}=await import("../../src/services/bookkeeping/autoPostAdmission.js");
    const plaid={transactionsSync:async()=>({data:{added:[{transaction_id:`settled-${pendingId}`,pending_transaction_id:pendingId,account_id:bank.plaid_account_id,date:'2026-11-01',name:'Synthetic pending',amount:10,pending:false}],modified:[],removed:[{transaction_id:pendingId}],next_cursor:'synthetic-settled',has_more:false}})};
    await runSyncForItem(plaid,businessId,plaidItem,{db:supabase,resolveToken:async()=>"synthetic-no-provider"});
    const settled=JSON.parse(sql(`select to_jsonb(c) from public.transaction_categorizations c where transaction_id='${pendingId}'`));
    assert.equal(settled.meta.auto_post_admission.state,'pending');assert.equal(settled.post_after,null);
    assert.equal(sql(`select pending from public.bank_transactions where id='${pendingId}'`),"f");
    assert.equal((await admitHandledAutoPost({db:supabase,businessId,transactionIds:[pendingId],source:'settled'})).scheduled,1);
    const settledDeadline=sql(`select post_after from public.transaction_categorizations where transaction_id='${pendingId}'`);
    const replayItem=JSON.parse(sql(`select to_jsonb(i) from public.plaid_items i where id='${plaidItem.id}'`));
    await runSyncForItem(plaid,businessId,replayItem,{db:supabase,resolveToken:async()=>"synthetic-no-provider"});
    assert.equal(sql(`select post_after from public.transaction_categorizations where transaction_id='${pendingId}'`),settledDeadline);
    assert.equal(sql(`select count(*) from public.bank_transactions where business_id='${businessId}' and plaid_transaction_id='settled-${pendingId}'`),"1");
    __setRequireAuthTestDeps(null);
  } finally {
    globalThis.fetch=originalFetch;
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await proxy.close();
  }
}
