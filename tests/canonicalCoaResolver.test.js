import test from "node:test";
import assert from "node:assert/strict";

import {
  approveExistingQboAccountForCanonical,
  createPreferredQboAccountForCanonical,
  fetchCanonicalAccountMappingsForBusiness,
  resolveCanonicalQboAccount,
} from "../src/services/bookkeeping/canonicalQboAccountResolver.js";
import { getCanonicalAccountForIntent } from "../src/services/bookkeeping/canonicalCoaRegistry.js";
import { mapAnswerToCoa } from "../src/services/bookkeeping/clarificationService.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const REALM_ID = "realm-1";

function makeQbo(accounts = [], options = {}) {
  const state = {
    accounts: [...accounts],
    createCount: 0,
    findCount: 0,
    failCreateAfterInsert: options.failCreateAfterInsert === true,
  };
  const qbo = {
    findAccounts(_query, cb) {
      state.findCount += 1;
      if (typeof options.beforeFind === "function") {
        options.beforeFind(state);
      }
      cb(null, {
        QueryResponse: {
          Account: state.accounts.map((account) => ({
            Id: account.id,
            Name: account.name,
            AccountType: account.type || "Expense",
            AccountSubType: account.subType || null,
            Active: account.active !== false,
            SyncToken: account.syncToken || "0",
          })),
        },
      });
    },
    account: {
      create(payload, cb) {
        state.createCount += 1;
        const created = {
          id: `created-${state.createCount}`,
          name: payload.Name,
          type: payload.AccountType,
          subType: payload.AccountSubType || null,
          syncToken: "0",
        };
        state.accounts.push(created);
        if (state.failCreateAfterInsert) {
          cb(new Error("qbo_timeout_after_success"));
          return;
        }
        cb(null, {
          Account: {
            Id: created.id,
            Name: created.name,
            AccountType: created.type,
            AccountSubType: created.subType,
            SyncToken: created.syncToken,
          },
        });
      },
    },
  };
  return { qbo, state };
}

function makeSupabase() {
  const db = {
    business_canonical_qbo_account_mappings: [],
    qbo_account_creation_intents: [],
    qbo_account_mapping_events: [],
    qbo_accounts_cache: [],
    qbo_coa_creations: [],
    transaction_categorizations: [],
    bank_transactions: [],
    business_profiles: [],
  };
  return {
    db,
    from(table) {
      return new Query(db, table);
    },
    async rpc(name, params) {
      assert.equal(name, "claim_qbo_account_creation_intent");
      const key = [
        params.p_business_id,
        params.p_qbo_env || "production",
        params.p_realm_id,
        params.p_canonical_account_key,
      ].join("|");
      let row = db.qbo_account_creation_intents.find((item) => item._key === key);
      if (!row) {
        row = {
          _key: key,
          business_id: params.p_business_id,
          qbo_env: params.p_qbo_env || "production",
          realm_id: params.p_realm_id,
          canonical_account_key: params.p_canonical_account_key,
          request_id: params.p_request_id,
          status: "processing",
          attempt_count: 1,
        };
        db.qbo_account_creation_intents.push(row);
        return { data: { claimed: true, already_resolved: false, intent: row }, error: null };
      }
      if (row.status === "created" || row.status === "mapped_existing") {
        return { data: { claimed: false, already_resolved: true, intent: row }, error: null };
      }
      return { data: { claimed: false, already_resolved: false, intent: row }, error: null };
    },
  };
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.inFilters = [];
    this.patch = null;
    this.upsertRows = null;
    this.insertRows = null;
  }
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  eq(column, value) {
    this.filters.push({ column, value });
    return this;
  }
  in(column, values) {
    this.inFilters.push({ column, values });
    return this;
  }
  gte() { return this; }
  lt() { return this; }
  update(patch) {
    this.patch = patch;
    return this;
  }
  insert(rows) {
    const list = Array.isArray(rows) ? rows : [rows];
    this.db[this.table].push(...list);
    return Promise.resolve({ data: list, error: null });
  }
  upsert(rows) {
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    const keyFor = (row) => {
      if (this.table === "business_canonical_qbo_account_mappings") {
        return `${row.business_id}|${row.qbo_env}|${row.realm_id}|${row.canonical_account_key}`;
      }
      if (this.table === "qbo_accounts_cache") {
        return `${row.business_id}|${row.qbo_env}|${row.realm_id}|${row.qbo_account_id}`;
      }
      if (this.table === "qbo_coa_creations") {
        return `${row.business_id}|${row.qbo_account_id}`;
      }
      if (this.table === "transaction_categorizations") {
        return `${row.business_id}|${row.transaction_id}`;
      }
      return JSON.stringify(row);
    };
    for (const row of this.upsertRows) {
      const key = keyFor(row);
      const existing = this.db[this.table].find((item) => keyFor(item) === key);
      if (existing) Object.assign(existing, row);
      else this.db[this.table].push({ ...row });
    }
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows()[0] || null, error: null });
  }
  then(resolve, reject) {
    try {
      if (this.patch) {
        const rows = this.rows();
        rows.forEach((row) => Object.assign(row, this.patch));
        resolve({ data: rows, error: null });
        return;
      }
      resolve({ data: this.rows(), error: null });
    } catch (error) {
      if (reject) reject(error);
    }
  }
  rows() {
    return (this.db[this.table] || []).filter((row) => {
      const eqOk = this.filters.every((filter) => row[filter.column] === filter.value);
      const inOk = this.inFilters.every((filter) => filter.values.includes(row[filter.column]));
      return eqOk && inOk;
    });
  }
}

function deps({ supabase, qbo }) {
  return {
    supabase,
    getQBOClient: async () => qbo,
    getLatestQuickBooksTokenRow: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
  };
}

test("Spotify resolves to canonical Software and reuses exact QBO Software", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([{ id: "software", name: "Software", type: "Expense" }]);
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(getCanonicalAccountForIntent("software").preferred_account_name, "Software");
  assert.equal(result.account.name, "Software");
  assert.equal(result.status, "existing_exact");
  assert.equal(state.createCount, 0);
});

test("Software absent safely creates Software instead of using unrelated Subscriptions", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([{ id: "subs", name: "Subscriptions", type: "Expense" }]);
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.account.name, "Software");
  assert.equal(result.status, "created_by_bizzi");
  assert.equal(state.createCount, 1);
  assert.equal(state.accounts.some((account) => account.name === "Subscriptions"), true);
});

test("approved equivalent maps without duplicate creation", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([{ id: "soft-exp", name: "Software Expense", type: "Expense" }]);
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.account.id, "soft-exp");
  assert.equal(result.status, "existing_approved_equivalent");
  assert.equal(state.createCount, 0);
});

test("Duke Energy intent resolves Electric and does not silently substitute Utilities", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([{ id: "utilities", name: "Utilities", type: "Expense" }]);
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "electric",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.account.name, "Electric");
  assert.equal(result.status, "created_by_bizzi");
  assert.equal(state.createCount, 1);
});

test("Target business supplies resolves Supplies & Materials", async () => {
  const supabase = makeSupabase();
  const { qbo } = makeQbo([{ id: "materials", name: "Supplies & Materials", type: "Expense" }]);
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.canonical.canonical_account_key, "materials_supplies");
  assert.equal(result.account.name, "Supplies & Materials");
});

test("ambiguous Supplies account blocks auto-create of Supplies & Materials", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "ambiguous_candidate_requires_review");
  assert.equal(result.account.name, "Supplies");
  assert.equal(state.createCount, 0);
  assert.equal(
    supabase.db.business_canonical_qbo_account_mappings[0].metadata.candidate_name,
    "Supplies"
  );
});

test("ambiguous Supplies appearing during final pre-create refresh blocks QBO create", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([], {
    beforeFind(s) {
      if (s.findCount === 2 && !s.accounts.some((account) => account.name === "Supplies")) {
        s.accounts.push({ id: "supplies", name: "Supplies", type: "Expense" });
      }
    },
  });
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "ambiguous_candidate_requires_review");
  assert.equal(result.account.name, "Supplies");
  assert.equal(state.createCount, 0);
  assert.equal(supabase.db.qbo_account_creation_intents[0].status, "needs_review");
  assert.equal(
    supabase.db.business_canonical_qbo_account_mappings[0].metadata.candidate_name,
    "Supplies"
  );
});

test("exact canonical account appearing during final pre-create refresh is reused", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([], {
    beforeFind(s) {
      if (s.findCount === 2 && !s.accounts.some((account) => account.name === "Supplies & Materials")) {
        s.accounts.push({ id: "materials", name: "Supplies & Materials", type: "Expense" });
      }
    },
  });
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "existing_exact");
  assert.equal(result.account.id, "materials");
  assert.equal(state.createCount, 0);
  assert.equal(supabase.db.qbo_account_creation_intents[0].status, "mapped_existing");
});

test("approved equivalent appearing during final pre-create refresh is reused", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([], {
    beforeFind(s) {
      if (s.findCount === 2 && !s.accounts.some((account) => account.name === "Software Expense")) {
        s.accounts.push({ id: "soft-exp", name: "Software Expense", type: "Expense" });
      }
    },
  });
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "existing_approved_equivalent");
  assert.equal(result.account.id, "soft-exp");
  assert.equal(state.createCount, 0);
  assert.equal(supabase.db.qbo_account_creation_intents[0].status, "mapped_existing");
});

test("no candidate after final pre-create refresh still creates exactly once", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([]);
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "created_by_bizzi");
  assert.equal(result.account.name, "Software");
  assert.equal(state.createCount, 1);
});

test("two simultaneous Software requirements create at most one QBO account", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([]);
  const [first, second] = await Promise.all([
    resolveCanonicalQboAccount({ businessId: BUSINESS_ID, intent: "software", dependencies: deps({ supabase, qbo }) }),
    resolveCanonicalQboAccount({ businessId: BUSINESS_ID, intent: "software", dependencies: deps({ supabase, qbo }) }),
  ]);
  assert.equal(state.createCount, 1);
  assert.equal([first.ok, second.ok].filter(Boolean).length >= 1, true);
});

test("QBO success plus local timeout/crash reconciles existing account without duplicate", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([], { failCreateAfterInsert: true });
  const first = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(first.ok, true);
  assert.equal(first.account.name, "Software");
  assert.equal(state.createCount, 1);
  const second = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(second.account.name, "Software");
  assert.equal(state.createCount, 1);
});

test("sensitive equity/liability account requires review and is not auto-created", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([]);
  const result = await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "owner_contribution",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_review");
  assert.equal(state.createCount, 0);
});

test("clarification for Software resolves through canonical policy and reuses exact account", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([{ id: "software", name: "Software", type: "Expense" }]);
  const result = await mapAnswerToCoa({
    businessId: BUSINESS_ID,
    txn: { id: "22222222-2222-4222-8222-222222222222" },
    answerText: "This is software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.account.id, "software");
  assert.equal(result.canonical_account_key, "software");
  assert.equal(result.canonical_resolution_status, "existing_exact");
  assert.equal(state.createCount, 0);
  assert.equal(supabase.db.qbo_account_mapping_events[0].source, "clarification");
});

test("clarification cannot fuzzy-map Software to Subscriptions and safely creates Software", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([{ id: "subs", name: "Subscriptions", type: "Expense" }]);
  const result = await mapAnswerToCoa({
    businessId: BUSINESS_ID,
    txn: { id: "22222222-2222-4222-8222-222222222222" },
    answerText: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.account.name, "Software");
  assert.equal(result.canonical_account_key, "software");
  assert.equal(result.created, true);
  assert.equal(state.createCount, 1);
});

test("clarification with ambiguous Supplies candidate remains review-required", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  const result = await mapAnswerToCoa({
    businessId: BUSINESS_ID,
    txn: { id: "22222222-2222-4222-8222-222222222222" },
    answerText: "supplies",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.account, null);
  assert.equal(result.review_required, true);
  assert.equal(result.canonical_account_key, "materials_supplies");
  assert.equal(result.match_reason, "ambiguous_candidate_requires_review");
  assert.equal(state.createCount, 0);
});

test("clarification-created canonical mapping is auditable", async () => {
  const supabase = makeSupabase();
  const { qbo } = makeQbo([]);
  const txnId = "22222222-2222-4222-8222-222222222222";
  const result = await mapAnswerToCoa({
    businessId: BUSINESS_ID,
    txn: { id: txnId },
    answerText: "software",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.account.name, "Software");
  const mapping = supabase.db.business_canonical_qbo_account_mappings[0];
  const event = supabase.db.qbo_account_mapping_events.find((row) => row.event_type === "created_by_bizzi");
  assert.equal(mapping.canonical_account_key, "software");
  assert.equal(mapping.qbo_account_name, "Software");
  assert.equal(mapping.mapping_source, "creation_intent");
  assert.equal(mapping.first_transaction_id, txnId);
  assert.equal(event.source, "creation_intent");
});

test("repeated materials_supplies review events aggregate into one current decision", async () => {
  const supabase = makeSupabase();
  const { qbo } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  for (let i = 0; i < 6; i += 1) {
    const txnId = `${String(i + 1).padStart(8, "0")}-2222-4222-8222-222222222222`;
    await resolveCanonicalQboAccount({
      businessId: BUSINESS_ID,
      intent: "materials",
      transactionId: txnId,
      dependencies: deps({ supabase, qbo }),
    });
  }
  assert.equal(supabase.db.qbo_account_mapping_events.length, 6);
  const result = await fetchCanonicalAccountMappingsForBusiness({
    businessId: BUSINESS_ID,
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].canonical_account_key, "materials_supplies");
  assert.equal(result.decisions[0].bizzi_account_name, "Supplies & Materials");
  assert.equal(result.decisions[0].candidate_qbo_account_name, "Supplies");
  assert.equal(result.decisions[0].affected_transaction_count, 6);
  assert.equal(result.history.length, 6);
});

test("existing candidate usage metrics are returned with decisions", async () => {
  const supabase = makeSupabase();
  supabase.db.transaction_categorizations.push(
    { business_id: BUSINESS_ID, transaction_id: "aaaaaaaa-2222-4222-8222-222222222222", final_qbo_account_id: "supplies", final_qbo_account_name: "Supplies" },
    { business_id: BUSINESS_ID, transaction_id: "bbbbbbbb-2222-4222-8222-222222222222", suggested_qbo_account_id: "supplies", suggested_qbo_account_name: "Supplies" }
  );
  supabase.db.bank_transactions.push(
    { business_id: BUSINESS_ID, id: "aaaaaaaa-2222-4222-8222-222222222222", date: "2026-07-03" },
    { business_id: BUSINESS_ID, id: "bbbbbbbb-2222-4222-8222-222222222222", date: "2026-08-09" }
  );
  const { qbo } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    transactionId: "cccccccc-2222-4222-8222-222222222222",
    dependencies: deps({ supabase, qbo }),
  });
  const result = await fetchCanonicalAccountMappingsForBusiness({
    businessId: BUSINESS_ID,
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.decisions[0].candidate_usage.transaction_count, 2);
  assert.equal(result.decisions[0].candidate_usage.earliest_transaction_date, "2026-07-03");
  assert.equal(result.decisions[0].candidate_usage.latest_transaction_date, "2026-08-09");
  assert.equal(result.decisions[0].recommendation.action, "use_existing");
});

test("Use Existing maps materials_supplies to QBO Supplies only for that business and records audit", async () => {
  const supabase = makeSupabase();
  const { qbo } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    transactionId: "dddddddd-2222-4222-8222-222222222222",
    dependencies: deps({ supabase, qbo }),
  });
  const result = await approveExistingQboAccountForCanonical({
    businessId: BUSINESS_ID,
    canonicalAccountKey: "materials_supplies",
    qboAccountId: "supplies",
    actor: "admin-1",
    source: "monthly_review",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mapping.status, "existing_approved_equivalent");
  assert.equal(result.mapping.qbo_account_id, "supplies");
  assert.equal(result.mapping.business_id, BUSINESS_ID);
  assert.equal(result.mapping.metadata.actor, "admin-1");
  const event = supabase.db.qbo_account_mapping_events.find((row) => row.event_type === "existing_approved_equivalent");
  assert.equal(event.metadata.action, "use_existing");
});

test("Create Bizzi Preferred uses resolver path and reconsiders affected transactions", async () => {
  const supabase = makeSupabase();
  supabase.db.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "eeeeeeee-2222-4222-8222-222222222222",
    status: "needs_review",
    suggested_canonical_account_key: "materials_supplies",
    confidence: "high",
    meta: { suggestion_source: "universal_hint", safe_to_auto_handle: true },
  });
  supabase.db.bank_transactions.push({
    business_id: BUSINESS_ID,
    id: "eeeeeeee-2222-4222-8222-222222222222",
    date: "2026-08-18",
    pending: false,
    name: "Target",
  });
  const { qbo, state } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    transactionId: "eeeeeeee-2222-4222-8222-222222222222",
    dependencies: deps({ supabase, qbo }),
  });
  const result = await createPreferredQboAccountForCanonical({
    businessId: BUSINESS_ID,
    canonicalAccountKey: "materials_supplies",
    reviewedCandidateQboAccountId: "supplies",
    actor: "admin-1",
    source: "monthly_review",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.account.name, "Supplies & Materials");
  assert.equal(result.status, "created_by_bizzi");
  assert.equal(state.createCount, 1);
  assert.equal(result.reconsideration.count, 1);
  assert.equal(supabase.db.transaction_categorizations[0].suggested_qbo_account_name, "Supplies & Materials");
  assert.equal(supabase.db.transaction_categorizations[0].status, "auto_approved");
  assert.equal(supabase.db.transaction_categorizations[0].final_qbo_account_name, "Supplies & Materials");
  assert.equal(supabase.db.transaction_categorizations[0].post_after, null);
  assert.equal(supabase.db.transaction_categorizations[0].meta.canonical_reconsideration_requested, false);
  assert.equal(supabase.db.transaction_categorizations[0].meta.canonical_reconsideration_result.status, "auto_approved");
});

test("Use Existing reprocesses only affected unresolved transactions and is idempotent", async () => {
  const supabase = makeSupabase();
  supabase.db.transaction_categorizations.push(
    {
      business_id: BUSINESS_ID,
      transaction_id: "11111111-2222-4222-8222-222222222222",
      status: "needs_review",
      confidence: "high",
      suggested_canonical_account_key: "materials_supplies",
      meta: { suggestion_source: "universal_hint", safe_to_auto_handle: true },
    },
    {
      business_id: BUSINESS_ID,
      transaction_id: "22222222-3333-4333-8333-333333333333",
      status: "needs_review",
      confidence: "high",
      suggested_canonical_account_key: "software",
      meta: { suggestion_source: "universal_hint", safe_to_auto_handle: true },
    }
  );
  supabase.db.bank_transactions.push(
    { business_id: BUSINESS_ID, id: "11111111-2222-4222-8222-222222222222", date: "2026-08-18", name: "Target" },
    { business_id: BUSINESS_ID, id: "22222222-3333-4333-8333-333333333333", date: "2026-08-18", name: "Spotify" }
  );
  const { qbo } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    transactionId: "11111111-2222-4222-8222-222222222222",
    dependencies: deps({ supabase, qbo }),
  });
  const first = await approveExistingQboAccountForCanonical({
    businessId: BUSINESS_ID,
    canonicalAccountKey: "materials_supplies",
    qboAccountId: "supplies",
    dependencies: deps({ supabase, qbo }),
  });
  const second = await approveExistingQboAccountForCanonical({
    businessId: BUSINESS_ID,
    canonicalAccountKey: "materials_supplies",
    qboAccountId: "supplies",
    dependencies: deps({ supabase, qbo }),
  });
  const affected = supabase.db.transaction_categorizations.find((row) => row.transaction_id === "11111111-2222-4222-8222-222222222222");
  const unaffected = supabase.db.transaction_categorizations.find((row) => row.transaction_id === "22222222-3333-4333-8333-333333333333");
  assert.equal(first.reconsideration.count, 1);
  assert.equal(second.reconsideration.count, 0);
  assert.equal(affected.status, "auto_approved");
  assert.equal(affected.final_qbo_account_id, "supplies");
  assert.equal(unaffected.status, "needs_review");
  assert.equal(unaffected.final_qbo_account_id, undefined);
});

test("post-decision reconsideration keeps risky affected transactions in Needs Review", async () => {
  const supabase = makeSupabase();
  supabase.db.business_profiles.push({ id: BUSINESS_ID, bookkeeping_start_date: "2026-08-01", auto_post_to_quickbooks: true });
  const blockedRows = [
    ["pending", { pending: true }, {}],
    ["duplicate", { accounting_review_required: true }, {}],
    ["check", { name: "Check #1001" }, {}],
    ["transfer", { name: "Online transfer" }, { taxonomy_type: "transfer_internal" }],
    ["owner", { name: "Owner draw" }, { taxonomy_type: "owner_draw" }],
    ["refund", { name: "Vendor refund" }, { taxonomy_type: "refund" }],
    ["clarify", { name: "Target" }, { requires_clarification: true }],
    ["old", { date: "2026-07-31", name: "Target" }, { safe_to_auto_handle: true }],
  ];
  for (const [id, txnPatch, metaPatch] of blockedRows) {
    const txnId = `${id.padEnd(8, "0")}-2222-4222-8222-222222222222`;
    supabase.db.transaction_categorizations.push({
      business_id: BUSINESS_ID,
      transaction_id: txnId,
      status: "needs_review",
      confidence: "high",
      suggested_canonical_account_key: "materials_supplies",
      meta: { suggestion_source: "universal_hint", safe_to_auto_handle: true, ...metaPatch },
    });
    supabase.db.bank_transactions.push({
      business_id: BUSINESS_ID,
      id: txnId,
      date: txnPatch.date || "2026-08-18",
      ...txnPatch,
    });
  }
  const { qbo } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  for (const row of supabase.db.transaction_categorizations) {
    await resolveCanonicalQboAccount({
      businessId: BUSINESS_ID,
      intent: "materials",
      transactionId: row.transaction_id,
      dependencies: deps({ supabase, qbo }),
    });
  }
  const result = await approveExistingQboAccountForCanonical({
    businessId: BUSINESS_ID,
    canonicalAccountKey: "materials_supplies",
    qboAccountId: "supplies",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.reconsideration.count, blockedRows.length);
  for (const row of supabase.db.transaction_categorizations) {
    assert.equal(row.status, "needs_review");
    assert.equal(row.final_qbo_account_id, null);
    assert.equal(row.meta.canonical_reconsideration_requested, false);
    assert.match(row.meta.canonical_reconsideration_result.reason, /pending|plaid|check|transfer|owner|refund|clarification|bookkeeping/);
  }
});

test("post-decision reconsideration keeps review-account mappings in Needs Review", async () => {
  const supabase = makeSupabase();
  supabase.db.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "44444444-2222-4222-8222-222222222222",
    status: "needs_review",
    confidence: "high",
    suggested_canonical_account_key: "materials_supplies",
    meta: { suggestion_source: "universal_hint", safe_to_auto_handle: true },
  });
  supabase.db.bank_transactions.push({
    business_id: BUSINESS_ID,
    id: "44444444-2222-4222-8222-222222222222",
    date: "2026-08-18",
    name: "Target",
  });
  const { qbo } = makeQbo([
    { id: "supplies", name: "Supplies", type: "Expense" },
    { id: "ama", name: "Ask My Accountant", type: "Expense" },
  ]);
  await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    transactionId: "44444444-2222-4222-8222-222222222222",
    dependencies: deps({ supabase, qbo }),
  });
  await approveExistingQboAccountForCanonical({
    businessId: BUSINESS_ID,
    canonicalAccountKey: "materials_supplies",
    qboAccountId: "ama",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(supabase.db.transaction_categorizations[0].status, "needs_review");
  assert.equal(supabase.db.transaction_categorizations[0].meta.canonical_reconsideration_result.reason, "review_or_suspense_account");
});

test("Auto-post on schedules post_after only after safe post-decision auto-handling", async () => {
  const supabase = makeSupabase();
  supabase.db.business_profiles.push({ id: BUSINESS_ID, auto_post_to_quickbooks: true });
  supabase.db.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "33333333-2222-4222-8222-222222222222",
    status: "needs_review",
    confidence: "high",
    suggested_canonical_account_key: "materials_supplies",
    meta: { suggestion_source: "universal_hint", safe_to_auto_handle: true },
  });
  supabase.db.bank_transactions.push({
    business_id: BUSINESS_ID,
    id: "33333333-2222-4222-8222-222222222222",
    date: "2026-08-18",
    name: "Target",
  });
  const { qbo } = makeQbo([{ id: "supplies", name: "Supplies", type: "Expense" }]);
  await resolveCanonicalQboAccount({
    businessId: BUSINESS_ID,
    intent: "materials",
    transactionId: "33333333-2222-4222-8222-222222222222",
    dependencies: deps({ supabase, qbo }),
  });
  await approveExistingQboAccountForCanonical({
    businessId: BUSINESS_ID,
    canonicalAccountKey: "materials_supplies",
    qboAccountId: "supplies",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(supabase.db.transaction_categorizations[0].status, "auto_approved");
  assert.ok(supabase.db.transaction_categorizations[0].post_after);
});

test("Create Bizzi Preferred fails closed when a new ambiguous candidate appears", async () => {
  const supabase = makeSupabase();
  const { qbo, state } = makeQbo([
    { id: "supplies", name: "Supplies", type: "Expense" },
    { id: "materials-and-supplies", name: "Materials and Supplies", type: "Expense" },
  ]);
  const result = await createPreferredQboAccountForCanonical({
    businessId: BUSINESS_ID,
    canonicalAccountKey: "materials_supplies",
    reviewedCandidateQboAccountId: "supplies",
    actor: "admin-1",
    source: "monthly_review",
    dependencies: deps({ supabase, qbo }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_review");
  assert.equal(result.account.id, "materials-and-supplies");
  assert.equal(state.createCount, 0);
});
