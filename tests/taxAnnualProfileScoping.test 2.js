import test from "node:test";
import assert from "node:assert/strict";

/* global process */

import { generateMonthlyTaxSnapshot } from "../src/services/tax/generateMonthlyTaxSnapshot.js";
import { generateTaxInsights } from "../src/services/tax/generateTaxInsights.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

test("a 2026 snapshot uses the 2026 profile even when a 2027 profile exists", async () => {
  const supabase = makeSupabase({
    tax_profiles: [
      profile("profile-2027", 2027, "s_corp"),
      profile("profile-2026", 2026, "sole_proprietor"),
    ],
    monthly_metrics: [metric("2026-03-01")],
  });

  await withMockTaxDisabled(() =>
    generateMonthlyTaxSnapshot({
      supabase,
      businessId: BUSINESS_ID,
      month: "2026-03",
      archive: false,
      openaiApiKey: null,
    })
  );

  const read = supabase.profileReads[0];
  assert.deepEqual(read.filters, { business_id: BUSINESS_ID, tax_year: 2026 });
  assert.equal(read.selected?.id, "profile-2026");
});

test("missing 2026 snapshot profile does not fall back to 2027", async () => {
  const supabase = makeSupabase({
    tax_profiles: [profile("profile-2027", 2027, "s_corp")],
    monthly_metrics: [metric("2026-05-01")],
  });

  await withMockTaxDisabled(() =>
    generateMonthlyTaxSnapshot({
      supabase,
      businessId: BUSINESS_ID,
      year: 2026,
      month: "2026-05",
      archive: false,
      openaiApiKey: null,
    })
  );

  const read = supabase.profileReads[0];
  assert.deepEqual(read.filters, { business_id: BUSINESS_ID, tax_year: 2026 });
  assert.equal(read.selected, null);
});

test("tax insights for one year do not load profile assumptions from another year", async () => {
  const supabase = makeSupabase({
    tax_profiles: [
      profile("profile-2027", 2027, "s_corp"),
      profile("profile-2026", 2026, "single_member_llc"),
    ],
    monthly_metrics: [metric("2026-01-01")],
  });

  await withMockTaxDisabled(() =>
    generateTaxInsights({
      supabase,
      businessId: BUSINESS_ID,
      year: 2026,
      openaiApiKey: null,
    })
  );

  const read = supabase.profileReads[0];
  assert.deepEqual(read.filters, { business_id: BUSINESS_ID, tax_year: 2026 });
  assert.equal(read.selected?.id, "profile-2026");
});

function profile(id, taxYear, entityType) {
  return {
    id,
    business_id: BUSINESS_ID,
    tax_year: taxYear,
    entity_type: entityType,
    filing_status: "single",
    primary_tax_state: "NC",
    safe_harbor_method: "current_year_90",
    metadata: {},
  };
}

function metric(month) {
  return {
    business_id: BUSINESS_ID,
    month,
    revenue: 100000,
    expenses: 40000,
    profit: 60000,
    deductions_total: 40000,
    vehicle_expenses: 1000,
    tools_equipment: 2000,
    meals_entertainment: 300,
    payroll: 10000,
    contractors: 12000,
  };
}

async function withMockTaxDisabled(fn) {
  const previous = process.env.MOCK_TAX;
  delete process.env.MOCK_TAX;
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.MOCK_TAX;
    else process.env.MOCK_TAX = previous;
  }
}

function makeSupabase(tables) {
  const profileReads = [];
  return {
    profileReads,
    from(table) {
      return new Query(table, tables[table] || [], profileReads);
    },
  };
}

class Query {
  constructor(table, rows, profileReads) {
    this.table = table;
    this.rows = [...rows];
    this.filters = {};
    this.profileReads = profileReads;
  }

  select() {
    return this;
  }

  eq(field, value) {
    this.filters[field] = value;
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }

  gte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") >= String(value));
    return this;
  }

  lte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") <= String(value));
    return this;
  }

  order() {
    return this;
  }

  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }

  maybeSingle() {
    const selected = this.rows[0] || null;
    if (this.table === "tax_profiles") {
      this.profileReads.push({ filters: { ...this.filters }, selected });
    }
    return Promise.resolve({ data: selected, error: null });
  }

  then(resolve) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}
