/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

function makeSupabaseStub(seed = {}) {
  const tables = {
    insights: [],
    insights_history: [],
    insight_feedback: [],
    insight_reads: [],
    financial_metrics: [],
    ...seed,
  };

  let idCounter = 1;

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this._limit = null;
      this._order = null;
      this._mutation = null;
    }

    select() { return this; }
    limit(n) { this._limit = n; return this; }
    order(column, options = {}) { this._order = { column, ascending: options.ascending !== false }; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    gte(column, value) { this.filters.push((row) => String(row[column] || '') >= String(value)); return this; }
    lt(column, value) { this.filters.push((row) => String(row[column] || '') < String(value)); return this; }
    is(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values = []) { const set = new Set(values); this.filters.push((row) => set.has(row[column])); return this; }

    insert(payload) {
      this._mutation = { type: 'insert', payload };
      return this;
    }

    update(payload) {
      this._mutation = { type: 'update', payload };
      return this;
    }

    then(resolve) {
      return Promise.resolve(this.exec()).then(resolve);
    }

    exec() {
      if (!Object.hasOwn(tables, this.table)) {
        return { data: null, error: { code: '42P01', message: `relation "${this.table}" does not exist` } };
      }

      if (this._mutation?.type === 'insert') {
        const rows = Array.isArray(this._mutation.payload) ? this._mutation.payload : [this._mutation.payload];
        const inserted = rows.map((row) => ({
          id: row.id || `insight-${idCounter++}`,
          ...row,
          created_at: row.created_at || new Date().toISOString(),
        }));
        tables[this.table].push(...inserted);
        return { data: inserted, error: null };
      }

      let rows = tables[this.table].filter((row) => this.filters.every((fn) => fn(row)));

      if (this._mutation?.type === 'update') {
        rows.forEach((row) => Object.assign(row, this._mutation.payload));
        return { data: rows, error: null };
      }

      if (this._order) {
        const { column, ascending } = this._order;
        rows = [...rows].sort((a, b) => {
          const av = a[column] || '';
          const bv = b[column] || '';
          return ascending ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
        });
      }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      return { data: rows, error: null };
    }
  }

  return {
    tables,
    from(table) {
      return new Query(table);
    },
  };
}

function makeReq(query = {}, headers = {}) {
  return {
    query,
    header(name) {
      return headers[name.toLowerCase()] || headers[name] || null;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('Contractor CFO insight engine inserts, dedupes, snoozes, lists, and returns CTA fields', async () => {
  const {
    __setContractorCfoEngineTestDeps,
    runContractorCfoInsightsForBusiness,
  } = await import('../src/services/insights/contractorCfoEngine.js');
  const { __setInsightDedupeServiceTestDeps } = await import('../src/services/insights/insightDedupeService.js');
  const listModule = await import('../src/api/insights/list.js');
  const listHandler = listModule.default;
  const { __setInsightsListTestDeps } = listModule;

  const businessId = '00000000-0000-0000-0000-000000000123';
  const supabase = makeSupabaseStub({
    tax_calculation_runs: [
      {
        business_id: businessId,
        tax_year: 2026,
        status: 'completed',
        completed_at: new Date().toISOString(),
        estimated_total_tax: 30000,
        summary: { projectedTotalTax: 30000 },
        reserve: { reserveGap: 6000, currentReserve: 1000 },
        confidence: { level: 'medium', score: 80, estimateReady: true, reserveReady: true },
      },
    ],
  });

  __setContractorCfoEngineTestDeps({ supabase });
  __setInsightDedupeServiceTestDeps({ supabase });
  __setInsightsListTestDeps({ supabase });

  const first = await runContractorCfoInsightsForBusiness(businessId, {
    trigger: 'manual',
    limit: 5,
  });
  assert.equal(first.ok, true);
  assert.equal(first.inserted, 1);
  assert.equal(supabase.tables.insights.length, 1);
  assert.equal(supabase.tables.insights[0].module, 'contractor_cfo');
  assert.equal(supabase.tables.insights[0].category, 'tax_reserve_gap');
  assert.equal(supabase.tables.insights[0].primary_cta_label, 'View reserve plan');
  assert.equal(supabase.tables.insights[0].primary_cta_payload.route, '/dashboard/tax?section=planning');

  const listRes = makeRes();
  await listHandler(
    makeReq({ businessId, module: 'contractor_cfo', voice: 'none', limit: '10' }),
    listRes
  );
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.items.length, 1);
  assert.equal(listRes.body.items[0].primary_cta_label, 'View reserve plan');

  const second = await runContractorCfoInsightsForBusiness(businessId, {
    trigger: 'manual',
    limit: 5,
  });
  assert.equal(second.ok, true);
  assert.equal(second.inserted, 0);
  assert.equal(supabase.tables.insights.length, 1);

  supabase.tables.insights[0].snoozed_until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const forcedWhileSnoozed = await runContractorCfoInsightsForBusiness(businessId, {
    trigger: 'manual',
    force: true,
    limit: 5,
  });
  assert.equal(forcedWhileSnoozed.inserted, 0);
  assert.equal(supabase.tables.insights.length, 1);

  const snoozedListRes = makeRes();
  await listHandler(
    makeReq({ businessId, module: 'contractor_cfo', voice: 'none', limit: '10' }),
    snoozedListRes
  );
  assert.equal(snoozedListRes.statusCode, 200);
  assert.equal(snoozedListRes.body.items.length, 0);
});
