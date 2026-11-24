/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL='http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-test-only';
const {approveBookkeepingTransactions}=await import('../src/services/bookkeeping/bookkeepingApprovalService.js');
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const transaction = { id: "expense", business_id: A, date: "2026-10-27", name: "745 LUCKY STRIKE MIAMIAMI", amount: -28,
  direction: "OUTFLOW", pending: false, is_archived: false, plaid_account_id: "card" };
const account = { id: "expense", name: "Entertainment", type: "Expense", active: true };

function fixture({ type = "Bank", bank = {}, category = {}, accounts = [account] } = {}) {
  const state = {
    business_profiles: [{ id: A, user_id: "owner", auto_post_to_quickbooks: false, bookkeeping_start_date: "2026-01-01" }],
    user_business_link: [],
    bank_transactions: [{ ...transaction, ...bank }],
    transaction_categorizations: [{ business_id: A, transaction_id: "expense", status: "needs_review", meta: {protected_review_required:true,protected_review_reason:"personal_or_owner_review"}, ...category }],
    plaid_qbo_account_mappings: [{ business_id: A, plaid_account_id: "card", qbo_account_type: type }],
    bookkeeping_approval_events: [], vendor_rules: [],
  };
  const calls = [];
  const db = {
    state, calls,
    from(table) {
      assert.ok(table in state, `Unexpected database access: ${table}`);
      const filters = [];
      let patch = null;
      const result = () => state[table].filter(row => filters.every(fn => fn(row)));
      const execute = () => {
        const rows = result();
        if (patch) rows.forEach(row => Object.assign(row, structuredClone(patch)));
        return structuredClone(rows);
      };
      const query = {
        select() { return query; },
        update(value) { patch = value; return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        not(key, _op, value) { filters.push(row => row[key] !== value); return query; },
        limit() { return query; }, order() { return query; },
        maybeSingle: async () => ({ data: execute()[0] || null, error: null }),
        then(resolve, reject) { return Promise.resolve({ data: execute(), error: null }).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push(name);
      if (name === "approve_bookkeeping_with_admission") {
        const rows = structuredClone(args.p_approvals);
        for (const row of rows) {
          Object.assign(state.transaction_categorizations.find(cat => cat.transaction_id === row.transaction_id), row);
          state.bookkeeping_approval_events.push({ business_id: A, transaction_id: row.transaction_id, idempotency_key: row.approval_idempotency_key });
        }
        return { data: rows, error: null };
      }
      assert.ok(["admit_handled_auto_post", "refresh_operator_request_summary"].includes(name), name);
      return { data: { scheduled: 0, state: "blocked" }, error: null };
    },
  };
  const options = {
    db, businessId: A, actorId: "owner", actorType: "user", requireNeedsReview: true,
    items: [{ txnId: "expense", resolution: "categorize_new", newAccountId: account.id, newAccountName: account.name,
      only_this_transaction: true }],
    validateSelectedAccountsFn: async () => new Map(accounts.map(a => [a.id, a])),
    evaluateIncomingDepositPostingGuard: async () => ({ allowed: true }),
  };
  return { db, options };
}


for(const actorType of ['user','admin'])test(`${actorType} manual approval resolves only stored generic personal review, audits and replays idempotently`,async()=>{
 const {db,options}=fixture();const result=await approveBookkeepingTransactions({...options,actorType});const row=result.rows[0];
 assert.equal(row.meta.protected_review_required,undefined);assert.equal(row.meta.protected_review_reason,undefined);
 const audit=row.meta.manual_protection_resolution;assert.equal(audit.actor_type,actorType);assert.equal(audit.actor_id,'owner');assert.equal(audit.business_id,A);assert.equal(audit.transaction_id,'expense');assert.equal(audit.selected_qbo_account_id,'expense');assert.equal(audit.reason,'personal_or_owner_review');assert.ok(Date.parse(audit.resolved_at));assert.equal(audit.approval_idempotency_key,db.state.bookkeeping_approval_events[0].idempotency_key);
 const repeated=await approveBookkeepingTransactions({...options,actorType});assert.equal(repeated.idempotent,true);assert.equal(db.state.bookkeeping_approval_events.length,1);assert.deepEqual(repeated.rows[0].meta.manual_protection_resolution,audit);
});
test('automatic actor cannot clear generic review',async()=>{const {options}=fixture();const r=await approveBookkeepingTransactions({...options,actorType:'system'});assert.equal(r.rows[0].meta.protected_review_required,true);assert.equal(r.rows[0].meta.manual_protection_resolution,undefined);});
test('other reasons, explicit holds, and structural workflows are preserved',async()=>{
 for(const patch of [{protected_review_reason:'tax_professional_review'},{posting_hold:true},{transfer_pair_id:'pair'},{taxonomy_type:'owner_draw'},{posting_hold_batch_id:'hold'}]){
  const category=patch.posting_hold_batch_id?patch:{meta:{protected_review_required:true,protected_review_reason:'personal_or_owner_review',...patch}};
  const {options}=fixture({category});const r=await approveBookkeepingTransactions(options);assert.equal(r.rows[0].meta.protected_review_required,true);assert.equal(r.rows[0].meta.manual_protection_resolution,undefined);
 }
});
test('missing actor and cross-business transaction cannot clear protection',async()=>{
 for(const change of [{actorId:null},{businessId:B}]){const {db,options}=fixture();await assert.rejects(()=>approveBookkeepingTransactions({...options,...change}));assert.equal(db.state.transaction_categorizations[0].meta.protected_review_required,true);assert.equal(db.state.bookkeeping_approval_events.length,0);}
});
test('browser protection metadata cannot create a server-authoritative resolution',async()=>{
 const {options}=fixture({category:{meta:{protected_review_required:true,protected_review_reason:'tax_professional_review'}}});options.items[0].meta={protected_review_required:false,protected_review_reason:'personal_or_owner_review'};options.items[0].clear_protection=true;
 const r=await approveBookkeepingTransactions(options);assert.equal(r.rows[0].meta.protected_review_reason,'tax_professional_review');assert.equal(r.rows[0].meta.manual_protection_resolution,undefined);
});

test('automatic final-categorization persistence never resolves generic protection',async()=>{
 const {buildAuthoritativeFinalCategorization,FINAL_CATEGORIZATION_SOURCES}=await import('../src/services/bookkeeping/finalCategorizationPersistenceService.js');
 const value=buildAuthoritativeFinalCategorization({businessId:A,row:{transaction_id:'expense',status:'auto_approved',final_qbo_account_id:'expense',final_qbo_account_name:'Entertainment',meta:{protected_review_required:true,protected_review_reason:'personal_or_owner_review'}},approvalSource:FINAL_CATEGORIZATION_SOURCES.AUTOMATIC});
 assert.equal(value.meta.protected_review_required,true);assert.equal(value.meta.manual_protection_resolution,undefined);
});
test('a new independent protection cannot be cleared by resolving the stored generic reason',async()=>{
 const {options}=fixture();options.extraMetaByTransactionId={expense:{protected_review_required:true,protected_review_reason:'independent_explicit_hold'}};const r=await approveBookkeepingTransactions(options);assert.equal(r.rows[0].meta.protected_review_reason,'independent_explicit_hold');assert.equal(r.rows[0].meta.manual_protection_resolution,undefined);
});
