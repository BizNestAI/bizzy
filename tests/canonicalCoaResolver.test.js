import test from "node:test";
import assert from "node:assert/strict";

import { resolveCanonicalQboAccount } from "../src/services/bookkeeping/canonicalQboAccountResolver.js";
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
