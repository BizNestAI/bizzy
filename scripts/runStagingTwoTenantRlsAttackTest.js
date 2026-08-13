import { config as loadDotenv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

loadDotenv({ path: ".env.staging.local" });

const PROD_REFS = new Set([
  "vhvivxqwinxywnutdrqz",
]);

const RUN_ID = `rls_${Date.now()}_${randomUUID().slice(0, 8)}`;
const PASSWORD = `RlsTest!${randomUUID()}aA1`;

function env(name) {
  return (process.env[name] || "").trim();
}

function projectRef(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : "";
  } catch {
    return "";
  }
}

function assertStagingEnv() {
  const url = firstUsableUrl(["TEST_SUPABASE_URL", "SUPABASE_URL", "VITE_SUPABASE_URL"]);
  const anonKey = firstUsableValue(["TEST_SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY"]);
  const serviceKey = firstUsableValue(["TEST_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
  const ref = projectRef(url);

  if (!url || !anonKey || !serviceKey) {
    throw new Error("Missing staging Supabase test env. Expected TEST_SUPABASE_URL/ANON/SERVICE_ROLE or staging SUPABASE/VITE values.");
  }
  if (!/supabase\.co\/?$/i.test(url)) {
    throw new Error("Supabase URL must resolve to a project origin ending in supabase.co.");
  }
  if (!/staging|preview|branch/i.test(url) && PROD_REFS.has(ref)) {
    throw new Error("Refusing to run: Supabase URL matches a known production project ref.");
  }
  if (PROD_REFS.has(ref)) {
    throw new Error("Refusing to run: Supabase project ref is listed as production.");
  }
  const productionUrl = readEnvFileValue(".env", "SUPABASE_URL");
  if (productionUrl && productionUrl.replace(/\/+$/, "") === url.replace(/\/+$/, "")) {
    throw new Error("Refusing to run: staging Supabase URL matches .env production SUPABASE_URL.");
  }

  return { url: url.replace(/\/+$/, ""), anonKey, serviceKey, ref };
}

function firstUsableValue(names) {
  for (const name of names) {
    const value = env(name);
    if (!value || /^YOUR[_<]|^<.*>$/.test(value)) continue;
    return value;
  }
  return "";
}

function firstUsableUrl(names) {
  for (const name of names) {
    const value = normalizeSupabaseUrl(env(name));
    if (!value || /^YOUR[_<]|^<.*>$/.test(value)) continue;
    try {
      new URL(value);
      return value;
    } catch {}
  }
  return "";
}

function normalizeSupabaseUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    if (/\/(?:rest|auth)\/v1$/i.test(normalizedPath)) {
      parsed.pathname = normalizedPath.replace(/\/(?:rest|auth)\/v1$/i, "") || "/";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/+$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

function readEnvFileValue(path, key) {
  try {
    const source = readFileSync(path, "utf8");
    const line = source.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}=`));
    return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

const cfg = assertStagingEnv();
const admin = createClient(cfg.url, cfg.serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function userClient(accessToken) {
  return createClient(cfg.url, cfg.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function anonClient() {
  return createClient(cfg.url, cfg.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const results = [];
const created = {
  authUsers: [],
  businesses: [],
  rows: [],
  storageObjects: [],
};

const STORAGE_BUCKETS = [
  {
    id: "bizzy-docs",
    directUploadAllowed: true,
    reason: "Bizzy Docs browser upload/download workflow",
  },
  {
    id: "financial-reports",
    directUploadAllowed: false,
    reason: "financial report writes remain backend/service-role; browser receives tenant-authorized signed reads",
  },
  {
    id: "bid-attachments",
    directUploadAllowed: false,
    reason: "bid attachment writes remain backend/service-role; browser receives tenant-authorized signed reads",
  },
];

function safeId(id) {
  if (!id) return null;
  return `${String(id).slice(0, 8)}...${String(id).slice(-4)}`;
}

function record({
  table,
  operation,
  actor,
  targetTenant,
  expected,
  actual,
  pass,
  severity = pass ? "PASS" : "FAIL",
  reason = "",
  policy = "",
}) {
  results.push({
    table,
    operation,
    actor,
    targetTenant,
    expected,
    actual,
    status: pass ? "PASS" : "FAIL",
    severity,
    reason,
    policy,
  });
}

async function createTestUser(label) {
  const email = `bizzi-rls-${RUN_ID}-${label}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: {
      first_name: `RLS ${label}`,
      last_name: "Tenant",
      full_name: `RLS ${label} Tenant`,
    },
  });
  if (error) throw new Error(`Failed creating ${label} auth user: ${error.message}`);
  const user = data.user;
  created.authUsers.push(user.id);

  const { error: profileError } = await admin
    .from("user_profiles")
    .upsert({
      id: user.id,
      email,
      role: "owner",
      first_name: `RLS ${label}`,
      last_name: "Tenant",
      full_name: `RLS ${label} Tenant`,
    }, { onConflict: "id" });
  if (profileError) throw new Error(`Failed creating ${label} profile: ${profileError.message}`);

  const { data: sessionData, error: signInError } = await createClient(cfg.url, cfg.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError || !sessionData?.session?.access_token) {
    throw new Error(`Failed signing in ${label}: ${signInError?.message || "no session"}`);
  }

  return {
    label,
    id: user.id,
    email,
    accessToken: sessionData.session.access_token,
    client: userClient(sessionData.session.access_token),
  };
}

async function createBusiness(user, label) {
  const { data, error } = await admin
    .from("business_profiles")
    .insert({
      user_id: user.id,
      business_name: `Bizzi RLS ${RUN_ID} ${label}`,
      industry: "Security Testing",
      team_size: 1,
      state: "NC",
      services_offered: "RLS runtime testing",
      annual_revenue: "test",
      billing_model: "test",
      founded_year: 2026,
      top_challenge: "runtime isolation",
    })
    .select("id, user_id, business_name")
    .single();
  if (error) throw new Error(`Failed creating business ${label}: ${error.message}`);
  created.businesses.push(data.id);

  const { error: linkError } = await admin
    .from("user_business_link")
    .insert({ user_id: user.id, business_id: data.id, role: "owner" });
  if (linkError) throw new Error(`Failed creating membership ${label}: ${linkError.message}`);

  return data;
}

async function insertSeed(table, row) {
  const { data, error } = await admin.from(table).insert(row).select("*").single();
  if (error) {
    record({
      table,
      operation: "SEED",
      actor: "service_role",
      targetTenant: "synthetic",
      expected: "seed row created",
      actual: `seed failed: ${error.code || ""} ${error.message}`,
      pass: false,
      reason: error.details || "",
    });
    return null;
  }
  const filter = data.id
    ? { id: data.id }
    : data.user_id
      ? { user_id: data.user_id }
      : data.state
        ? { state: data.state }
        : null;
  created.rows.push({ table, id: data.id, business_id: data.business_id, user_id: data.user_id, filter });
  return data;
}

async function setupTenantRows(user, business, label) {
  const suffix = `${RUN_ID}_${label}`;
  return {
    bank_transactions: await insertSeed("bank_transactions", {
      business_id: business.id,
      plaid_item_id: `item_${suffix}`,
      plaid_account_id: `acct_${suffix}`,
      plaid_transaction_id: `txn_${suffix}`,
      date: "2026-08-09",
      name: `RLS Transaction ${label}`,
      amount: 42,
      iso_currency_code: "USD",
    }),
    ar_open_items: await insertSeed("ar_open_items", {
      business_id: business.id,
      user_id: user.id,
      source: "qbo",
      qbo_env: "sandbox",
      qbo_invoice_id: `inv_${suffix}`,
      client_name: `RLS Client ${label}`,
      balance: 42,
      total_amount: 42,
    }),
    invoices: await insertSeed("invoices", {
      stripe_invoice_id: `stripe_inv_${suffix}`,
      business_id: business.id,
      amount_due: 4200,
      amount_paid: 0,
      status: "open",
      customer_name: `RLS Customer ${label}`,
    }),
    financial_metrics: await insertSeed("financial_metrics", {
      business_id: business.id,
      month: `2099-${label === "A" ? "01" : "02"}`,
      total_revenue: 100,
      total_expenses: 40,
      net_profit: 60,
    }),
    tax_snapshots: await insertSeed("tax_snapshots", {
      business_id: business.id,
      month: `2099-${label === "A" ? "01" : "02"}`,
      payload: { runId: RUN_ID, tenant: label },
      tax_year: 2099,
      snapshot_type: "runtime_rls_test",
    }),
    bizzy_memory: await insertSeed("bizzy_memory", {
      user_id: user.id,
      input_text: `RLS memory ${label}`,
      bizzy_response: `RLS response ${label}`,
      tags: ["rls-runtime-test"],
      kpis: { runId: RUN_ID },
    }),
    gpt_usage: await insertSeed("gpt_usage", {
      user_id: user.id,
      month: `2099-${label}`,
      query_count: 1,
    }),
    plaid_items: await insertSeed("plaid_items", {
      business_id: business.id,
      user_id: user.id,
      plaid_item_id: `plaid_item_${suffix}`,
      plaid_access_token: `enc:v1:test-token-${suffix}`,
      institution_id: `ins_${label}`,
      institution_name: `RLS Bank ${label}`,
      status: "connected",
    }),
    linked_financial_items: await insertSeed("linked_financial_items", {
      user_id: user.id,
      provider: "plaid",
      item_id: `linked_item_${suffix}`,
      access_token_enc: "\\x746573742d746f6b656e",
      institution_name: `RLS Linked ${label}`,
    }),
    oauth_connection_states: await insertSeed("oauth_connection_states", {
      provider: "quickbooks",
      state_hash: `state_hash_${suffix}`,
      user_id: user.id,
      business_id: business.id,
      expires_at: "2099-01-01T00:00:00Z",
      metadata: { runId: RUN_ID },
    }),
    email_accounts: await insertSeed("email_accounts", {
      user_id: user.id,
      business_id: business.id,
      provider: "gmail",
      google_email: `rls-${suffix}@example.test`,
      scopes: ["gmail.readonly"],
    }),
    quickbooks_tokens: await insertSeed("quickbooks_tokens", {
      business_id: business.id,
      access_token: `enc:v1:access-${suffix}`,
      refresh_token: `enc:v1:refresh-${suffix}`,
      realm_id: `realm_${suffix}`,
      qbo_env: "sandbox",
      status: "active",
      is_active: true,
    }),
  };
}

async function setupUncertifiedTableRows(user, business, label, baseRows = {}) {
  const suffix = `${RUN_ID}_${label}`;
  const investmentAccount = await insertSeed("investment_accounts", {
    user_id: user.id,
    provider: "runtime_rls",
    external_account_id: `ia_${suffix}`,
    name: `RLS Investment ${label}`,
    type: "brokerage",
  });
  const security = await insertSeed("securities", {
    ticker: `RLS${label}${RUN_ID.slice(-4)}`,
    name: `RLS Security ${label}`,
    asset_class: "equity",
  });

  return {
    account_breakdown: await insertSeed("account_breakdown", {
      business_id: business.id,
      month: `2099-${label === "A" ? "03" : "04"}`,
      account_name: `RLS Account ${label}`,
      account_type: "expense",
      balance: 10,
    }),
    affordability_assessments: await insertSeed("affordability_assessments", {
      business_id: business.id,
      user_id: user.id,
      expense_name: `RLS Expense ${label}`,
      amount: 10,
      verdict: "test",
    }),
    balance_sheet_history: await insertSeed("balance_sheet_history", {
      business_id: business.id,
      month: `2099-${label === "A" ? "03" : "04"}-01`,
      cash: 10,
    }),
    billing_customers: await insertSeed("billing_customers", {
      user_id: user.id,
      stripe_customer_id: `cus_rls_${suffix}`,
    }),
    bizzy_deadlines: await insertSeed("bizzy_deadlines", {
      business_id: business.id,
      user_id: user.id,
      source: "runtime_rls",
      title: `RLS Deadline ${label}`,
      due_date: "2099-01-01",
    }),
    bizzy_headlines: await insertSeed("bizzy_headlines", {
      business_id: business.id,
      user_id: user.id,
      headline: `RLS Headline ${label}`,
      valid_for: `2099-${label === "A" ? "03" : "04"}-01`,
    }),
    bookkeeping_health: await insertSeed("bookkeeping_health", {
      business_id: business.id,
      status: "healthy",
    }),
    calendar_events: await insertSeed("calendar_events", {
      business_id: business.id,
      user_id: user.id,
      module: "ops",
      type: "task",
      title: `RLS Calendar ${label}`,
      start_ts: "2099-01-01T10:00:00Z",
      end_ts: "2099-01-01T11:00:00Z",
    }),
    categorization_rules: await insertSeed("categorization_rules", {
      business_id: business.id,
      match_type: "contains",
      match_value: `RLS ${label}`,
      qbo_account_id: `qbo_acct_${suffix}`,
      qbo_account_name: "RLS Expense",
    }),
    expense_totals_monthly: await insertSeed("expense_totals_monthly", {
      business_id: business.id,
      month: `2099-${label === "A" ? "03" : "04"}-01`,
      category: `RLS Category ${label}`,
      amount: 10,
    }),
    gpt_messages_backup: await insertSeed("gpt_messages_backup", {
      id: randomUUID(),
      user_id: user.id,
      role: "user",
      content: `RLS backup ${label}`,
    }),
    insight_preferences: await insertSeed("insight_preferences", {
      user_id: user.id,
      show_alerts_right_rail: true,
    }),
    insights: await insertSeed("insights", {
      user_id: user.id,
      business_id: business.id,
      module: "financials",
      type: "insight",
      severity: "low",
      title: `RLS Insight ${label}`,
    }),
    insight_reads: await insertSeed("insight_reads", {
      user_id: user.id,
    }),
    integration_connections: await insertSeed("integration_connections", {
      business_id: business.id,
      provider: `runtime_rls_${label}`,
      status: "connected",
    }),
    investment_accounts: investmentAccount,
    investment_balances: await insertSeed("investment_balances", {
      user_id: user.id,
      account_id: `acct_${suffix}`,
      institution: `RLS Institution ${label}`,
      account_name: `RLS Balance ${label}`,
      account_type: "brokerage",
      balance_usd: 10,
      last_updated: "2099-01-01T00:00:00Z",
    }),
    monthly_forecast: await insertSeed("monthly_forecast", {
      user_id: user.id,
      business_id: business.id,
      month: `2099-${label === "A" ? "03" : "04"}-01`,
      revenue: 10,
    }),
    notifications: await insertSeed("notifications", {
      user_id: user.id,
      business_id: business.id,
      type: "runtime_rls",
      message: `RLS Notification ${label}`,
    }),
    plaid_accounts: await insertSeed("plaid_accounts", {
      business_id: business.id,
      plaid_item_id: `pa_item_${suffix}`,
      plaid_account_id: `pa_acct_${suffix}`,
      name: `RLS Plaid Account ${label}`,
    }),
    plaid_qbo_account_mappings: await insertSeed("plaid_qbo_account_mappings", {
      business_id: business.id,
      plaid_account_id: `map_plaid_${suffix}`,
      qbo_account_id: `map_qbo_${suffix}`,
      qbo_account_name: "RLS QBO",
      qbo_account_type: "Bank",
    }),
    positions: investmentAccount?.id && security?.id ? await insertSeed("positions", {
      user_id: user.id,
      account_id: investmentAccount.id,
      security_id: security.id,
      quantity: 1,
    }) : null,
    profiles: await insertSeed("profiles", {
      id: user.id,
      name: `RLS Profile ${label}`,
    }),
    qbo_posted_transactions: await insertSeed("qbo_posted_transactions", {
      business_id: business.id,
      transaction_id: baseRows.bank_transactions?.id || randomUUID(),
      qbo_env: "sandbox",
      qbo_txn_type: "JournalEntry",
      status: "posted",
    }),
    review_sources: await insertSeed("review_sources", {
      business_id: business.id,
      provider: "google",
      external_id: `review_${suffix}`,
      connected: true,
    }),
    subscriptions: await insertSeed("subscriptions", {
      user_id: user.id,
      business_id: business.id,
      stripe_customer_id: `sub_cus_${suffix}`,
      status: "active",
    }),
    transaction_categorizations: await insertSeed("transaction_categorizations", {
      business_id: business.id,
      transaction_id: baseRows.bank_transactions?.id || randomUUID(),
      status: "needs_review",
    }),
    vendor_rules: await insertSeed("vendor_rules", {
      business_id: business.id,
      match_type: "memo_prefix",
      match_value: `RLS Vendor ${label}`,
      counterparty_name: `RLS Vendor ${label}`,
    }),
    cashflow_forecast: await insertSeed("cashflow_forecast", {
      user_id: user.id,
      business_id: business.id,
      month: `2099-${label === "A" ? "03" : "04"}-01`,
      revenue: 10,
    }),
    gpt_messages: await insertSeed("gpt_messages", {
      user_id: user.id,
      business_id: business.id,
      role: "user",
      content: `RLS GPT message ${label}`,
    }),
    tax_deadlines: await insertSeed("tax_deadlines", {
      business_id: business.id,
      label: `RLS Tax Deadline ${label}`,
      due_date: "2099-01-15",
    }),
    tax_state_rates: await insertSeed("tax_state_rates", {
      state: `R${label}${RUN_ID.slice(-2)}`,
      kind: "flat",
      rate: 0.01,
    }),
    securities: security,
  };
}

async function attemptSelect({ client, actor, table, filters, expectAllowed, targetTenant, reason }) {
  const q = client.from(table).select("*").match(filters).limit(10);
  const { data, error } = await q;
  const allowed = !error && Array.isArray(data) && data.length > 0;
  record({
    table,
    operation: "SELECT",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed rows" : "denied/no rows",
    actual: error ? `error ${error.code || ""}: ${error.message}` : `${data?.length || 0} row(s)`,
    pass: expectAllowed ? allowed : !allowed,
    reason,
    policy: error?.details || "",
  });
  return data || [];
}

async function attemptInsert({ client, actor, table, row, expectAllowed, targetTenant, reason }) {
  const { data, error } = await client.from(table).insert(row).select("*");
  const allowed = !error && Array.isArray(data) && data.length > 0;
  if (allowed) {
    for (const item of data) created.rows.push({ table, id: item.id, business_id: item.business_id, user_id: item.user_id });
  }
  record({
    table,
    operation: "INSERT",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed insert" : "denied insert",
    actual: error ? `error ${error.code || ""}: ${error.message}` : `${data?.length || 0} row(s) inserted`,
    pass: expectAllowed ? allowed : !allowed,
    reason,
    policy: error?.details || "",
  });
  return data || [];
}

async function attemptUpdate({ client, actor, table, filters, patch, expectAllowed, targetTenant, reason }) {
  const before = await admin.from(table).select("*").match(filters).limit(1);
  const { data, error } = await client.from(table).update(patch).match(filters).select("*");
  const allowed = !error && Array.isArray(data) && data.length > 0;
  record({
    table,
    operation: "UPDATE",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed update" : "denied/no mutation",
    actual: error ? `error ${error.code || ""}: ${error.message}` : `${data?.length || 0} row(s) updated`,
    pass: expectAllowed ? allowed : !allowed,
    reason,
    policy: error?.details || "",
  });
  if (allowed && before.data?.[0]?.id) {
    const original = before.data[0];
    const restore = { ...original };
    delete restore.id;
    await admin.from(table).update(restore).eq("id", original.id);
  }
  return data || [];
}

async function attemptDelete({ client, actor, table, filters, expectAllowed, targetTenant, reason }) {
  const { data: before } = await admin.from(table).select("*").match(filters).limit(1);
  const { data, error } = await client.from(table).delete().match(filters).select("*");
  const allowed = !error && Array.isArray(data) && data.length > 0;
  record({
    table,
    operation: "DELETE",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed delete" : "denied/no mutation",
    actual: error ? `error ${error.code || ""}: ${error.message}` : `${data?.length || 0} row(s) deleted`,
    pass: expectAllowed ? allowed : !allowed,
    reason,
    policy: error?.details || "",
  });
  if (allowed && before?.[0]) {
    const original = before[0];
    await admin.from(table).insert(original);
  }
  return data || [];
}

async function attemptRpc({ client, actor, fn, args = {}, expectAllowed, expectedValue, targetTenant, reason }) {
  const { data, error } = await client.rpc(fn, args);
  const allowed = !error;
  let valueMatches = true;
  if (Object.prototype.hasOwnProperty.call(arguments[0], "expectedValue")) {
    valueMatches = data === expectedValue;
  }
  if (allowed && fn === "create_initial_business_for_user") {
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    for (const item of rows) {
      if (item?.id) created.businesses.push(item.id);
    }
  }
  record({
    table: `rpc:${fn}`,
    operation: "RPC",
    actor,
    targetTenant,
    expected: expectAllowed
      ? Object.prototype.hasOwnProperty.call(arguments[0], "expectedValue")
        ? `allowed result ${expectedValue}`
        : "allowed execution"
      : "denied execution",
    actual: error ? `error ${error.code || ""}: ${error.message}` : `result ${JSON.stringify(data)}`,
    pass: expectAllowed ? allowed && valueMatches : !allowed,
    reason,
    policy: error?.details || "",
  });
  return data;
}

function storageObjectPath(businessId, bucket, label) {
  return `${businessId}/${RUN_ID}/${bucket}/${label}.txt`;
}

async function seedStorageObject(bucket, businessId, label) {
  const path = storageObjectPath(businessId, bucket, label);
  const { error } = await admin.storage
    .from(bucket)
    .upload(path, Buffer.from(`bizzi storage rls ${RUN_ID} ${bucket} ${label}`), {
      contentType: "text/plain",
      upsert: true,
    });
  if (error) {
    record({
      table: `storage:${bucket}`,
      operation: "SEED",
      actor: "service_role",
      targetTenant: "synthetic storage",
      expected: "seed object created",
      actual: `seed failed: ${error.statusCode || ""} ${error.message}`,
      pass: false,
      reason: "storage object seed",
    });
    return null;
  }
  created.storageObjects.push({ bucket, path });
  return { bucket, path };
}

async function attemptStorageUpload({ client, actor, bucket, path, expectAllowed, targetTenant, reason }) {
  const { data, error } = await client.storage
    .from(bucket)
    .upload(path, Buffer.from(`upload ${RUN_ID} ${actor}`), {
      contentType: "text/plain",
      upsert: false,
    });
  const allowed = !error && Boolean(data?.path);
  if (allowed) created.storageObjects.push({ bucket, path: data.path || path });
  record({
    table: `storage:${bucket}`,
    operation: "UPLOAD",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed upload" : "denied upload",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : `uploaded ${safeId(data?.path || path)}`,
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function attemptStorageDownload({ client, actor, bucket, path, expectAllowed, targetTenant, reason }) {
  const { data, error } = await client.storage.from(bucket).download(path);
  const allowed = !error && Boolean(data);
  record({
    table: `storage:${bucket}`,
    operation: "DOWNLOAD",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed download" : "denied download",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : "downloaded object",
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function attemptStorageList({ client, actor, bucket, prefix, expectAllowed, targetTenant, reason }) {
  const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 10 });
  const allowed = !error && Array.isArray(data);
  record({
    table: `storage:${bucket}`,
    operation: "LIST",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed list" : "denied list",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : `${data?.length || 0} object(s) visible`,
    pass: expectAllowed ? allowed : !allowed || (Array.isArray(data) && data.length === 0),
    reason,
  });
}

async function attemptStorageOverwrite({ client, actor, bucket, path, expectAllowed, targetTenant, reason }) {
  const { data, error } = await client.storage
    .from(bucket)
    .upload(path, Buffer.from(`overwrite ${RUN_ID} ${actor}`), {
      contentType: "text/plain",
      upsert: true,
    });
  const allowed = !error && Boolean(data?.path);
  record({
    table: `storage:${bucket}`,
    operation: "OVERWRITE",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed overwrite" : "denied overwrite",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : `overwrote ${safeId(data?.path || path)}`,
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function attemptStorageDelete({ client, actor, bucket, path, expectAllowed, targetTenant, reason }) {
  const { data, error } = await client.storage.from(bucket).remove([path]);
  const allowed = !error && Array.isArray(data) && data.length > 0;
  record({
    table: `storage:${bucket}`,
    operation: "DELETE",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed delete" : "denied delete",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : `${data?.length || 0} delete result(s)`,
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

async function attemptStorageSignedUrl({ client, actor, bucket, path, expectAllowed, targetTenant, reason }) {
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 60);
  const allowed = !error && Boolean(data?.signedUrl);
  record({
    table: `storage:${bucket}`,
    operation: "SIGNED_URL",
    actor,
    targetTenant,
    expected: expectAllowed ? "allowed signed URL" : "denied signed URL",
    actual: error ? `error ${error.statusCode || ""}: ${error.message}` : "signed URL issued",
    pass: expectAllowed ? allowed : !allowed,
    reason,
  });
}

function syntheticPayload(table, user, business, suffix) {
  const x = `${RUN_ID}_${suffix}`;
  const base = {
    bank_transactions: {
      business_id: business.id, plaid_item_id: `insert_item_${x}`, plaid_account_id: `insert_acct_${x}`, plaid_transaction_id: `insert_txn_${x}`, date: "2026-08-09", name: "RLS insert txn", amount: 1,
    },
    ar_open_items: {
      business_id: business.id, user_id: user.id, source: "qbo", qbo_env: "sandbox", qbo_invoice_id: `insert_inv_${x}`, client_name: "RLS insert client", balance: 1,
    },
    invoices: {
      business_id: business.id, stripe_invoice_id: `insert_stripe_${x}`, amount_due: 1, status: "open",
    },
    financial_metrics: {
      business_id: business.id, month: `2099-${suffix}`, total_revenue: 1,
    },
    tax_snapshots: {
      business_id: business.id, month: `2099-${suffix}`, payload: { inserted: true, runId: RUN_ID }, tax_year: 2099, snapshot_type: "runtime_rls_insert_test",
    },
    bizzy_memory: {
      user_id: user.id, input_text: `insert memory ${x}`, bizzy_response: "insert response",
    },
    gpt_usage: {
      user_id: user.id, month: `2099-insert-${suffix}`, query_count: 1,
    },
    quickbooks_tokens: {
      business_id: business.id, access_token: `enc:v1:insert-access-${x}`, refresh_token: `enc:v1:insert-refresh-${x}`, realm_id: `insert_realm_${x}`, qbo_env: "sandbox",
    },
    plaid_items: {
      business_id: business.id, user_id: user.id, plaid_item_id: `insert_plaid_${x}`, plaid_access_token: `enc:v1:insert-plaid-${x}`, status: "connected",
    },
    linked_financial_items: {
      user_id: user.id, provider: "plaid", item_id: `insert_linked_${x}`, access_token_enc: "\\x696e736572742d746f6b656e",
    },
    oauth_connection_states: {
      provider: "quickbooks", state_hash: `insert_state_${x}`, user_id: user.id, business_id: business.id, expires_at: "2099-01-01T00:00:00Z", metadata: { runId: RUN_ID },
    },
    email_accounts: {
      user_id: user.id, business_id: business.id, provider: "gmail", google_email: `insert-${x}@example.test`,
    },
    account_breakdown: {
      business_id: business.id, month: "2099-09", account_name: `insert account ${x}`, account_type: "expense", balance: 1,
    },
    expense_totals_monthly: {
      business_id: business.id, month: "2099-09-01", category: `insert category ${x}`, amount: 1,
    },
    notifications: {
      user_id: user.id, business_id: business.id, type: "runtime_rls", message: `insert notification ${x}`,
    },
    profiles: {
      id: user.id, name: `insert profile ${x}`,
    },
    insight_preferences: {
      user_id: user.id, show_alerts_right_rail: false,
    },
    insights: {
      user_id: user.id, business_id: business.id, module: "financials", type: "insight", severity: "low", title: `insert insight ${x}`,
    },
    tax_deadlines: {
      business_id: business.id, label: `insert tax deadline ${x}`, due_date: "2099-01-15",
    },
    tax_state_rates: {
      state: `IX${RUN_ID.slice(-4)}`, kind: "flat", rate: 0.01,
    },
    affordability_assessments: {
      business_id: business.id, user_id: user.id, expense_name: `insert affordability ${x}`, amount: 1,
    },
    balance_sheet_history: {
      business_id: business.id, month: "2099-09-01", cash: 1,
    },
    billing_customers: {
      user_id: user.id, stripe_customer_id: `insert_cus_${x}`,
    },
    bizzy_deadlines: {
      business_id: business.id, user_id: user.id, source: "runtime_rls", title: `insert deadline ${x}`, due_date: "2099-01-01",
    },
    bizzy_headlines: {
      business_id: business.id, user_id: user.id, headline: `insert headline ${x}`, valid_for: "2099-09-01",
    },
    bookkeeping_health: {
      business_id: business.id, status: "healthy",
    },
    calendar_events: {
      business_id: business.id, user_id: user.id, module: "ops", type: "task", title: `insert event ${x}`, start_ts: "2099-01-01T10:00:00Z", end_ts: "2099-01-01T11:00:00Z",
    },
    categorization_rules: {
      business_id: business.id, match_type: "contains", match_value: `insert ${x}`, qbo_account_id: `qbo_${x}`,
    },
    gpt_messages_backup: {
      id: randomUUID(), user_id: user.id, role: "user", content: `insert backup ${x}`,
    },
    insight_reads: {
      user_id: user.id,
    },
    integration_connections: {
      business_id: business.id, provider: `insert_provider_${x}`, status: "connected",
    },
    investment_accounts: {
      user_id: user.id, provider: "runtime_rls", external_account_id: `insert_ia_${x}`, name: `insert investment ${x}`,
    },
    investment_balances: {
      user_id: user.id, account_id: `insert_balance_${x}`, balance_usd: 1, last_updated: "2099-01-01T00:00:00Z",
    },
    monthly_forecast: {
      user_id: user.id, business_id: business.id, month: "2099-09-01", revenue: 1,
    },
    plaid_accounts: {
      business_id: business.id, plaid_item_id: `insert_pa_item_${x}`, plaid_account_id: `insert_pa_acct_${x}`, name: "insert plaid account",
    },
    plaid_qbo_account_mappings: {
      business_id: business.id, plaid_account_id: `insert_map_plaid_${x}`, qbo_account_id: `insert_map_qbo_${x}`, qbo_account_name: "insert qbo", qbo_account_type: "Bank",
    },
    positions: {
      user_id: user.id, account_id: randomUUID(), security_id: randomUUID(), quantity: 1,
    },
    qbo_posted_transactions: {
      business_id: business.id, transaction_id: randomUUID(), qbo_env: "sandbox", qbo_txn_type: "JournalEntry", status: "posted",
    },
    review_sources: {
      business_id: business.id, provider: "google", external_id: `insert_review_${x}`, connected: true,
    },
    subscriptions: {
      user_id: user.id, business_id: business.id, stripe_customer_id: `insert_sub_${x}`, status: "active",
    },
    transaction_categorizations: {
      business_id: business.id, transaction_id: randomUUID(), status: "needs_review",
    },
    vendor_rules: {
      business_id: business.id, match_type: "memo_prefix", match_value: `insert vendor ${x}`, counterparty_name: `insert vendor ${x}`,
    },
    cashflow_forecast: {
      user_id: user.id, business_id: business.id, month: "2099-09-01", revenue: 1,
    },
    gpt_messages: {
      user_id: user.id, business_id: business.id, role: "user", content: `insert gpt ${x}`,
    },
  };
  return base[table];
}

function mutationPatchFor(table) {
  const patches = {
    bank_transactions: { name: `RLS mutated ${RUN_ID}` },
    ar_open_items: { client_name: `RLS mutated ${RUN_ID}` },
    invoices: { customer_name: `RLS mutated ${RUN_ID}` },
    financial_metrics: { total_revenue: 999 },
    tax_snapshots: { payload: { mutated: true, runId: RUN_ID } },
    bizzy_memory: { input_text: `RLS mutated ${RUN_ID}` },
    gpt_usage: { query_count: 999 },
    quickbooks_tokens: { status: "inactive" },
    plaid_items: { status: "error" },
    linked_financial_items: { institution_name: `RLS mutated ${RUN_ID}` },
    oauth_connection_states: { metadata: { mutated: true, runId: RUN_ID } },
    email_accounts: { scopes: ["gmail.metadata"] },
    expense_totals_monthly: { amount: 999 },
    notifications: { read: true },
    profiles: { name: `RLS mutated ${RUN_ID}` },
    insight_preferences: { show_alerts_right_rail: false },
    insights: { title: `RLS mutated ${RUN_ID}` },
    tax_deadlines: { label: `RLS mutated ${RUN_ID}` },
    tax_state_rates: { rate: 0.02 },
  };
  return patches[table] || { updated_at: new Date().toISOString() };
}

async function runFoundationTests(userA, bizA, userB, bizB) {
  const pairs = [
    { attacker: userA, attackerBiz: bizA, victim: userB, victimBiz: bizB, label: "User A", target: "Business B" },
    { attacker: userB, attackerBiz: bizB, victim: userA, victimBiz: bizA, label: "User B", target: "Business A" },
  ];

  for (const p of pairs) {
    await attemptSelect({ client: p.attacker.client, actor: p.label, table: "user_profiles", filters: { id: p.attacker.id }, expectAllowed: true, targetTenant: "own user", reason: "own profile read" });
    await attemptSelect({ client: p.attacker.client, actor: p.label, table: "user_profiles", filters: { id: p.victim.id }, expectAllowed: false, targetTenant: "other user", reason: "cross-user profile read" });
    await attemptSelect({ client: p.attacker.client, actor: p.label, table: "business_profiles", filters: { id: p.attackerBiz.id }, expectAllowed: true, targetTenant: "own business", reason: "own business read" });
    await attemptSelect({ client: p.attacker.client, actor: p.label, table: "business_profiles", filters: { id: p.victimBiz.id }, expectAllowed: false, targetTenant: p.target, reason: "cross-business read" });
    await attemptUpdate({ client: p.attacker.client, actor: p.label, table: "business_profiles", filters: { id: p.victimBiz.id }, patch: { business_name: `ATTACKED ${RUN_ID}` }, expectAllowed: false, targetTenant: p.target, reason: "cross-business update" });
    await attemptUpdate({ client: p.attacker.client, actor: p.label, table: "business_profiles", filters: { id: p.attackerBiz.id }, patch: { user_id: p.victim.id }, expectAllowed: false, targetTenant: "own business -> other owner", reason: "ownership field reassignment" });
    await attemptInsert({ client: p.attacker.client, actor: p.label, table: "user_business_link", row: { user_id: p.attacker.id, business_id: p.victimBiz.id, role: "owner" }, expectAllowed: false, targetTenant: p.target, reason: "self-add to foreign business as owner" });
    await attemptInsert({ client: p.attacker.client, actor: p.label, table: "user_business_link", row: { user_id: p.victim.id, business_id: p.attackerBiz.id, role: "owner" }, expectAllowed: false, targetTenant: "own business", reason: "create membership for other user" });
    await attemptUpdate({ client: p.attacker.client, actor: p.label, table: "user_business_link", filters: { user_id: p.victim.id, business_id: p.victimBiz.id }, patch: { role: "admin" }, expectAllowed: false, targetTenant: p.target, reason: "change foreign membership role" });
    await attemptDelete({ client: p.attacker.client, actor: p.label, table: "user_business_link", filters: { user_id: p.victim.id, business_id: p.victimBiz.id }, expectAllowed: false, targetTenant: p.target, reason: "delete foreign membership" });
  }
}

async function runAnonTests(bizA, userA) {
  const anon = anonClient();
  await attemptSelect({ client: anon, actor: "Anonymous", table: "user_profiles", filters: { id: userA.id }, expectAllowed: false, targetTenant: "private user", reason: "anon profile read" });
  await attemptSelect({ client: anon, actor: "Anonymous", table: "business_profiles", filters: { id: bizA.id }, expectAllowed: false, targetTenant: "private business", reason: "anon business read" });
  await attemptSelect({ client: anon, actor: "Anonymous", table: "user_business_link", filters: { business_id: bizA.id }, expectAllowed: false, targetTenant: "private membership", reason: "anon membership read" });
  await attemptInsert({ client: anon, actor: "Anonymous", table: "business_profiles", row: { user_id: userA.id, business_name: `Anon ${RUN_ID}`, industry: "Attack", team_size: 1, state: "NC", services_offered: "attack" }, expectAllowed: false, targetTenant: "private business", reason: "anon business insert" });
}

async function runTenantTableTests(userA, bizA, rowsA, userB, bizB, rowsB) {
  const tenantTables = ["bank_transactions", "ar_open_items", "invoices", "financial_metrics", "tax_snapshots", "bizzy_memory", "gpt_usage"];
  const pairs = [
    { actor: "User A", user: userA, ownBiz: bizA, ownRows: rowsA, victimUser: userB, victimBiz: bizB, victimRows: rowsB, target: "Business B" },
    { actor: "User B", user: userB, ownBiz: bizB, ownRows: rowsB, victimUser: userA, victimBiz: bizA, victimRows: rowsA, target: "Business A" },
  ];

  for (const p of pairs) {
    for (const table of tenantTables) {
      const ownRow = p.ownRows[table];
      const victimRow = p.victimRows[table];
      if (!ownRow || !victimRow) continue;
      const ownFilter = table === "bizzy_memory" || table === "gpt_usage" ? { user_id: p.user.id } : { business_id: p.ownBiz.id };
      const victimFilter = table === "bizzy_memory" || table === "gpt_usage" ? { user_id: p.victimUser.id } : { business_id: p.victimBiz.id };
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: ownFilter, expectAllowed: true, targetTenant: "own tenant", reason: "own row read" });
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: victimFilter, expectAllowed: false, targetTenant: p.target, reason: "cross-tenant row read" });
      await attemptInsert({ client: p.user.client, actor: p.actor, table, row: syntheticPayload(table, p.victimUser, p.victimBiz, `${p.actor.replace(/\s/g, "")}_foreign_${table}`), expectAllowed: false, targetTenant: p.target, reason: "insert row assigned to foreign tenant" });
      const updateFilter = victimRow.id ? { id: victimRow.id } : victimFilter;
      await attemptUpdate({ client: p.user.client, actor: p.actor, table, filters: updateFilter, patch: mutationPatchFor(table), expectAllowed: false, targetTenant: p.target, reason: "cross-tenant update by row identity" });
      if (victimRow.id) {
        await attemptDelete({ client: p.user.client, actor: p.actor, table, filters: { id: victimRow.id }, expectAllowed: false, targetTenant: p.target, reason: "cross-tenant delete by row identity" });
      }
    }
  }
}

async function runCredentialTableTests(userA, bizA, rowsA, userB, bizB, rowsB) {
  const credentialTables = ["quickbooks_tokens", "plaid_items", "linked_financial_items", "oauth_connection_states", "email_accounts"];
  const pairs = [
    { actor: "User A", user: userA, ownBiz: bizA, ownRows: rowsA, victimUser: userB, victimBiz: bizB, victimRows: rowsB, target: "Business B" },
    { actor: "User B", user: userB, ownBiz: bizB, ownRows: rowsB, victimUser: userA, victimBiz: bizA, victimRows: rowsA, target: "Business A" },
  ];
  for (const p of pairs) {
    for (const table of credentialTables) {
      const ownRow = p.ownRows[table];
      const victimRow = p.victimRows[table];
      if (!ownRow || !victimRow) continue;
      const ownFilter = table === "linked_financial_items" ? { user_id: p.user.id } : { business_id: p.ownBiz.id };
      const victimFilter = table === "linked_financial_items" ? { user_id: p.victimUser.id } : { business_id: p.victimBiz.id };
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: ownFilter, expectAllowed: false, targetTenant: "own tenant credential table", reason: "ordinary user should not directly read server-only credential table" });
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: victimFilter, expectAllowed: false, targetTenant: p.target, reason: "ordinary user should not directly read foreign credential table" });
      await attemptInsert({ client: p.user.client, actor: p.actor, table, row: syntheticPayload(table, p.victimUser, p.victimBiz, `${p.actor.replace(/\s/g, "")}_foreign_${table}`), expectAllowed: false, targetTenant: p.target, reason: "ordinary user should not insert credential rows" });
      if (victimRow.id) {
        await attemptUpdate({ client: p.user.client, actor: p.actor, table, filters: { id: victimRow.id }, patch: mutationPatchFor(table), expectAllowed: false, targetTenant: p.target, reason: "ordinary user should not update credential rows" });
        await attemptDelete({ client: p.user.client, actor: p.actor, table, filters: { id: victimRow.id }, expectAllowed: false, targetTenant: p.target, reason: "ordinary user should not delete credential rows" });
      }
    }
  }
}

async function runUncertifiedTableTests(userA, bizA, rowsA, userB, bizB, rowsB) {
  const serverOnlyTables = [
    "account_breakdown",
    "affordability_assessments",
    "balance_sheet_history",
    "billing_customers",
    "bizzy_deadlines",
    "bizzy_headlines",
    "bookkeeping_health",
    "calendar_events",
    "categorization_rules",
    "gpt_messages_backup",
    "insight_reads",
    "integration_connections",
    "investment_accounts",
    "investment_balances",
    "monthly_forecast",
    "plaid_accounts",
    "plaid_qbo_account_mappings",
    "positions",
    "qbo_posted_transactions",
    "review_sources",
    "subscriptions",
    "transaction_categorizations",
    "vendor_rules",
    "cashflow_forecast",
    "gpt_messages",
  ];
  const businessReadableTables = ["expense_totals_monthly", "insights", "tax_deadlines"];
  const userPrivateWritableTables = ["notifications", "profiles", "insight_preferences"];
  const referenceTables = ["tax_state_rates"];
  const pairs = [
    { actor: "User A", user: userA, ownBiz: bizA, ownRows: rowsA, victimUser: userB, victimBiz: bizB, victimRows: rowsB, target: "Business B" },
    { actor: "User B", user: userB, ownBiz: bizB, ownRows: rowsB, victimUser: userA, victimBiz: bizA, victimRows: rowsA, target: "Business A" },
  ];

  for (const p of pairs) {
    for (const table of serverOnlyTables) {
      const ownRow = p.ownRows[table];
      const victimRow = p.victimRows[table];
      if (!ownRow || !victimRow) continue;
      const ownFilter = ownRow.id ? { id: ownRow.id } : table === "billing_customers" ? { user_id: p.user.id } : { business_id: p.ownBiz.id };
      const victimFilter = victimRow.id ? { id: victimRow.id } : table === "billing_customers" ? { user_id: p.victimUser.id } : { business_id: p.victimBiz.id };
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: ownFilter, expectAllowed: false, targetTenant: "own server-only table", reason: "ordinary user should not directly read server-only table" });
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: victimFilter, expectAllowed: false, targetTenant: p.target, reason: "ordinary user should not directly read foreign server-only table" });
      await attemptInsert({ client: p.user.client, actor: p.actor, table, row: syntheticPayload(table, p.victimUser, p.victimBiz, `${p.actor.replace(/\s/g, "")}_foreign_${table}`), expectAllowed: false, targetTenant: p.target, reason: "ordinary user should not insert server-only rows" });
      await attemptUpdate({ client: p.user.client, actor: p.actor, table, filters: victimFilter, patch: mutationPatchFor(table), expectAllowed: false, targetTenant: p.target, reason: "ordinary user should not update server-only rows" });
      await attemptDelete({ client: p.user.client, actor: p.actor, table, filters: victimFilter, expectAllowed: false, targetTenant: p.target, reason: "ordinary user should not delete server-only rows" });
    }

    for (const table of businessReadableTables) {
      const ownRow = p.ownRows[table];
      const victimRow = p.victimRows[table];
      if (!ownRow || !victimRow) continue;
      const ownFilter = ownRow.id ? { id: ownRow.id } : { business_id: p.ownBiz.id };
      const victimFilter = victimRow.id ? { id: victimRow.id } : { business_id: p.victimBiz.id };
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: ownFilter, expectAllowed: true, targetTenant: "own tenant", reason: "own tenant read-only row" });
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: victimFilter, expectAllowed: false, targetTenant: p.target, reason: "cross-tenant read-only row" });
      await attemptInsert({ client: p.user.client, actor: p.actor, table, row: syntheticPayload(table, p.victimUser, p.victimBiz, `${p.actor.replace(/\s/g, "")}_foreign_${table}`), expectAllowed: false, targetTenant: p.target, reason: "read-only table should deny browser insert" });
      await attemptUpdate({ client: p.user.client, actor: p.actor, table, filters: victimFilter, patch: mutationPatchFor(table), expectAllowed: false, targetTenant: p.target, reason: "read-only table should deny browser update" });
      await attemptDelete({ client: p.user.client, actor: p.actor, table, filters: victimFilter, expectAllowed: false, targetTenant: p.target, reason: "read-only table should deny browser delete" });
    }

    for (const table of userPrivateWritableTables) {
      const ownRow = p.ownRows[table];
      const victimRow = p.victimRows[table];
      if (!ownRow || !victimRow) continue;
      const ownFilter = table === "profiles" ? { id: p.user.id } : { user_id: p.user.id };
      const victimFilter = table === "profiles" ? { id: p.victimUser.id } : { user_id: p.victimUser.id };
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: ownFilter, expectAllowed: true, targetTenant: "own user", reason: "own user-private row read" });
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: victimFilter, expectAllowed: false, targetTenant: "other user", reason: "cross-user private row read" });
      await attemptInsert({ client: p.user.client, actor: p.actor, table, row: syntheticPayload(table, p.victimUser, p.victimBiz, `${p.actor.replace(/\s/g, "")}_foreign_${table}`), expectAllowed: false, targetTenant: "other user", reason: "insert row assigned to foreign user" });
      await attemptUpdate({ client: p.user.client, actor: p.actor, table, filters: ownFilter, patch: mutationPatchFor(table), expectAllowed: true, targetTenant: "own user", reason: "own user-private update" });
      await attemptUpdate({ client: p.user.client, actor: p.actor, table, filters: victimFilter, patch: mutationPatchFor(table), expectAllowed: false, targetTenant: "other user", reason: "cross-user private update" });
      await attemptDelete({ client: p.user.client, actor: p.actor, table, filters: victimFilter, expectAllowed: false, targetTenant: "other user", reason: "cross-user private delete" });
    }

    for (const table of referenceTables) {
      const ownRow = p.ownRows[table];
      if (!ownRow) continue;
      await attemptSelect({ client: p.user.client, actor: p.actor, table, filters: { state: ownRow.state }, expectAllowed: true, targetTenant: "global reference", reason: "authenticated reference read" });
      await attemptInsert({ client: p.user.client, actor: p.actor, table, row: syntheticPayload(table, p.user, p.ownBiz, `${p.actor.replace(/\s/g, "")}_reference_${table}`), expectAllowed: false, targetTenant: "global reference", reason: "reference table should deny browser insert" });
      await attemptUpdate({ client: p.user.client, actor: p.actor, table, filters: { state: ownRow.state }, patch: mutationPatchFor(table), expectAllowed: false, targetTenant: "global reference", reason: "reference table should deny browser update" });
      await attemptDelete({ client: p.user.client, actor: p.actor, table, filters: { state: ownRow.state }, expectAllowed: false, targetTenant: "global reference", reason: "reference table should deny browser delete" });
    }
  }

  const anon = anonClient();
  for (const table of [...serverOnlyTables, ...businessReadableTables, ...userPrivateWritableTables, ...referenceTables]) {
    const row = rowsA[table];
    if (!row) continue;
    const filter = row.id ? { id: row.id } : row.state ? { state: row.state } : table === "profiles" ? { id: userA.id } : row.user_id ? { user_id: row.user_id } : { business_id: bizA.id };
    await attemptSelect({ client: anon, actor: "Anonymous", table, filters: filter, expectAllowed: false, targetTenant: "private or authenticated-only data", reason: "anonymous access denied" });
  }
}

async function runViewRpcFunctionTests(userA, bizA, userB, bizB) {
  const serverOnlyViews = [
    "ar_aging",
    "ar_aging_v2",
    "billing_customer_overview",
    "expense_categories",
    "insights_history",
    "jobs_profitability",
    "positions_view",
  ];
  const pairs = [
    { actor: "User A", user: userA, ownBiz: bizA, victimUser: userB, victimBiz: bizB, target: "Business B" },
    { actor: "User B", user: userB, ownBiz: bizB, victimUser: userA, victimBiz: bizA, target: "Business A" },
  ];

  for (const p of pairs) {
    for (const view of serverOnlyViews) {
      const ownFilter = view === "positions_view" ? { user_id: p.user.id } : { business_id: p.ownBiz.id };
      const victimFilter = view === "positions_view" ? { user_id: p.victimUser.id } : { business_id: p.victimBiz.id };
      await attemptSelect({ client: p.user.client, actor: p.actor, table: view, filters: ownFilter, expectAllowed: false, targetTenant: "own server-only view", reason: "ordinary users should not directly query server-only aggregate views" });
      await attemptSelect({ client: p.user.client, actor: p.actor, table: view, filters: victimFilter, expectAllowed: false, targetTenant: p.target, reason: "ordinary users should not query cross-tenant aggregate views" });
    }

    await attemptRpc({
      client: p.user.client,
      actor: p.actor,
      fn: "bizzi_current_user_is_business_member",
      args: { p_business_id: p.ownBiz.id },
      expectAllowed: true,
      expectedValue: true,
      targetTenant: "own tenant",
      reason: "reviewed RLS helper should identify own membership",
    });
    await attemptRpc({
      client: p.user.client,
      actor: p.actor,
      fn: "bizzi_current_user_is_business_member",
      args: { p_business_id: p.victimBiz.id },
      expectAllowed: true,
      expectedValue: false,
      targetTenant: p.target,
      reason: "reviewed RLS helper must not authorize foreign membership",
    });
    await attemptRpc({
      client: p.user.client,
      actor: p.actor,
      fn: "bizzi_current_user_can_manage_business",
      args: { p_business_id: p.ownBiz.id },
      expectAllowed: true,
      expectedValue: true,
      targetTenant: "own tenant",
      reason: "reviewed RLS helper should identify own manager access",
    });
    await attemptRpc({
      client: p.user.client,
      actor: p.actor,
      fn: "bizzi_current_user_can_manage_business",
      args: { p_business_id: p.victimBiz.id },
      expectAllowed: true,
      expectedValue: false,
      targetTenant: p.target,
      reason: "reviewed RLS helper must not authorize foreign manager access",
    });
    await attemptRpc({
      client: p.user.client,
      actor: p.actor,
      fn: "tax_user_owns_business",
      args: { p_business_id: p.ownBiz.id },
      expectAllowed: true,
      expectedValue: true,
      targetTenant: "own tenant",
      reason: "legacy tax helper should only affirm ownership for the caller",
    });
    await attemptRpc({
      client: p.user.client,
      actor: p.actor,
      fn: "tax_user_owns_business",
      args: { p_business_id: p.victimBiz.id },
      expectAllowed: true,
      expectedValue: false,
      targetTenant: p.target,
      reason: "legacy tax helper must not authorize foreign businesses",
    });
  }

  const backendOnlyRpcCalls = [
    {
      fn: "acquire_posting_lock",
      args: {
        p_business_id: bizB.id,
        p_transaction_id: randomUUID(),
        p_now_iso: new Date().toISOString(),
        p_lock_stale_seconds: 600,
        p_idempotency_key: `rls-${RUN_ID}`,
      },
    },
    {
      fn: "claim_contractor_cfo_insight_run",
      args: {
        p_run_key: "",
        p_scheduled_for: new Date().toISOString(),
        p_lock_owner: `rls-${RUN_ID}`,
        p_lock_ttl_seconds: 60,
      },
    },
    {
      fn: "claim_scheduled_job_lock",
      args: {
        p_job_key: "",
        p_scheduled_for: new Date().toISOString(),
        p_locked_by: `rls-${RUN_ID}`,
        p_lock_ttl_seconds: 60,
        p_metadata: { runId: RUN_ID },
      },
    },
    {
      fn: "refresh_billing_identity_summary",
      args: { p_business_id: bizB.id },
    },
    {
      fn: "get_tax_deduction_transaction_drilldown",
      args: {
        p_business_id: bizB.id,
        p_tax_year: 2099,
        p_as_of_date: "2099-12-31",
        p_tax_category: null,
        p_month: null,
        p_deductibility_status: null,
        p_classification_status: null,
        p_confidence_level: null,
        p_qbo_account_id: null,
        p_merchant: null,
        p_search: null,
        p_min_amount: null,
        p_max_amount: null,
        p_sort: "date_desc",
        p_limit: 1,
        p_offset: 0,
      },
    },
    {
      fn: "is_member",
      args: { p_user: userB.id, p_business: bizB.id },
    },
    {
      fn: "recalc_thread_last_message",
      args: { p_thread: randomUUID() },
    },
    {
      fn: "create_initial_business_for_user",
      args: {
        p_user_id: userB.id,
        p_email: userB.email,
        p_business_name: `RLS forbidden RPC ${RUN_ID}`,
        p_industry: "Security Testing",
        p_team_size: 1,
        p_state: "NC",
        p_services_offered: "RLS",
        p_annual_revenue: "test",
        p_billing_model: "test",
        p_founded_year: 2026,
        p_top_challenge: "forbidden rpc",
      },
    },
  ];

  for (const p of pairs) {
    for (const rpcCall of backendOnlyRpcCalls) {
      await attemptRpc({
        client: p.user.client,
        actor: p.actor,
        fn: rpcCall.fn,
        args: rpcCall.args,
        expectAllowed: false,
        targetTenant: p.target,
        reason: "backend-only RPC should not be executable by ordinary authenticated users",
      });
    }
  }

  const anon = anonClient();
  for (const view of serverOnlyViews) {
    await attemptSelect({ client: anon, actor: "Anonymous", table: view, filters: {}, expectAllowed: false, targetTenant: "server-only view", reason: "anonymous users should not query aggregate views" });
  }
  await attemptRpc({
    client: anon,
    actor: "Anonymous",
    fn: "bizzi_current_user_is_business_member",
    args: { p_business_id: bizA.id },
    expectAllowed: false,
    targetTenant: "RLS helper",
    reason: "anonymous users should not execute RLS helper functions",
  });
  for (const rpcCall of backendOnlyRpcCalls) {
    await attemptRpc({
      client: anon,
      actor: "Anonymous",
      fn: rpcCall.fn,
      args: rpcCall.args,
      expectAllowed: false,
      targetTenant: "backend-only RPC",
      reason: "anonymous users should not execute backend-only RPCs",
    });
  }
}

async function runStorageTests(userA, bizA, userB, bizB) {
  const pairs = [
    { actor: "User A", user: userA, ownBiz: bizA, victimBiz: bizB, target: "Business B" },
    { actor: "User B", user: userB, ownBiz: bizB, victimBiz: bizA, target: "Business A" },
  ];
  const seeded = {};

  for (const bucket of STORAGE_BUCKETS) {
    seeded[bucket.id] = {
      [bizA.id]: await seedStorageObject(bucket.id, bizA.id, "business-a-seed"),
      [bizB.id]: await seedStorageObject(bucket.id, bizB.id, "business-b-seed"),
    };
  }

  for (const bucket of STORAGE_BUCKETS) {
    for (const p of pairs) {
      const ownObject = seeded[bucket.id]?.[p.ownBiz.id];
      const victimObject = seeded[bucket.id]?.[p.victimBiz.id];
      if (!ownObject || !victimObject) continue;

      await attemptStorageList({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        prefix: `${p.ownBiz.id}/${RUN_ID}`,
        expectAllowed: true,
        targetTenant: "own storage",
        reason: `${bucket.id}: authorized business prefix list`,
      });
      await attemptStorageDownload({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        path: ownObject.path,
        expectAllowed: true,
        targetTenant: "own storage",
        reason: `${bucket.id}: authorized business object download`,
      });
      await attemptStorageSignedUrl({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        path: ownObject.path,
        expectAllowed: true,
        targetTenant: "own storage",
        reason: `${bucket.id}: authorized signed URL issuance`,
      });

      const ownUploadPath = storageObjectPath(p.ownBiz.id, bucket.id, `${p.actor.replace(/\s/g, "").toLowerCase()}-own-upload`);
      await attemptStorageUpload({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        path: ownUploadPath,
        expectAllowed: bucket.directUploadAllowed,
        targetTenant: "own storage",
        reason: `${bucket.id}: ${bucket.reason}`,
      });

      await attemptStorageList({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        prefix: `${p.victimBiz.id}/${RUN_ID}`,
        expectAllowed: false,
        targetTenant: p.target,
        reason: `${bucket.id}: foreign business prefix list must be denied`,
      });
      await attemptStorageDownload({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        path: victimObject.path,
        expectAllowed: false,
        targetTenant: p.target,
        reason: `${bucket.id}: foreign business object download must be denied`,
      });
      await attemptStorageSignedUrl({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        path: victimObject.path,
        expectAllowed: false,
        targetTenant: p.target,
        reason: `${bucket.id}: foreign signed URL issuance must be denied`,
      });
      await attemptStorageUpload({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        path: storageObjectPath(p.victimBiz.id, bucket.id, `${p.actor.replace(/\s/g, "").toLowerCase()}-foreign-upload`),
        expectAllowed: false,
        targetTenant: p.target,
        reason: `${bucket.id}: upload into foreign business path must be denied`,
      });
      await attemptStorageOverwrite({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        path: victimObject.path,
        expectAllowed: false,
        targetTenant: p.target,
        reason: `${bucket.id}: overwrite of foreign business object must be denied`,
      });
      await attemptStorageDelete({
        client: p.user.client,
        actor: p.actor,
        bucket: bucket.id,
        path: victimObject.path,
        expectAllowed: false,
        targetTenant: p.target,
        reason: `${bucket.id}: delete of foreign business object must be denied`,
      });
    }

    const anon = anonClient();
    const anonObject = seeded[bucket.id]?.[bizA.id];
    if (!anonObject) continue;
    await attemptStorageList({
      client: anon,
      actor: "Anonymous",
      bucket: bucket.id,
      prefix: `${bizA.id}/${RUN_ID}`,
      expectAllowed: false,
      targetTenant: "private storage",
      reason: `${bucket.id}: anonymous list denied`,
    });
    await attemptStorageDownload({
      client: anon,
      actor: "Anonymous",
      bucket: bucket.id,
      path: anonObject.path,
      expectAllowed: false,
      targetTenant: "private storage",
      reason: `${bucket.id}: anonymous download denied`,
    });
    await attemptStorageSignedUrl({
      client: anon,
      actor: "Anonymous",
      bucket: bucket.id,
      path: anonObject.path,
      expectAllowed: false,
      targetTenant: "private storage",
      reason: `${bucket.id}: anonymous signed URL denied`,
    });
    await attemptStorageUpload({
      client: anon,
      actor: "Anonymous",
      bucket: bucket.id,
      path: storageObjectPath(bizA.id, bucket.id, "anonymous-upload"),
      expectAllowed: false,
      targetTenant: "private storage",
      reason: `${bucket.id}: anonymous upload denied`,
    });
    await attemptStorageOverwrite({
      client: anon,
      actor: "Anonymous",
      bucket: bucket.id,
      path: anonObject.path,
      expectAllowed: false,
      targetTenant: "private storage",
      reason: `${bucket.id}: anonymous overwrite denied`,
    });
    await attemptStorageDelete({
      client: anon,
      actor: "Anonymous",
      bucket: bucket.id,
      path: anonObject.path,
      expectAllowed: false,
      targetTenant: "private storage",
      reason: `${bucket.id}: anonymous delete denied`,
    });
  }
}

async function cleanup() {
  for (const object of [...created.storageObjects].reverse()) {
    if (!object?.bucket || !object?.path) continue;
    await admin.storage.from(object.bucket).remove([object.path]);
  }
  for (const row of [...created.rows].reverse()) {
    if (!row?.table) continue;
    const filter = row.filter || (row.id ? { id: row.id } : null);
    if (!filter) continue;
    let query = admin.from(row.table).delete();
    for (const [key, value] of Object.entries(filter)) {
      query = query.eq(key, value);
    }
    await query;
  }
  for (const businessId of created.businesses.reverse()) {
    await admin.from("user_business_link").delete().eq("business_id", businessId);
    await admin.from("business_profiles").delete().eq("id", businessId);
  }
  for (const userId of created.authUsers.reverse()) {
    await admin.from("user_profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
  }
}

function summarize() {
  const failed = results.filter((r) => r.status === "FAIL");
  const byTable = {};
  for (const result of results) {
    byTable[result.table] ||= { pass: 0, fail: 0 };
    byTable[result.table][result.status.toLowerCase()] += 1;
  }
  return {
    runId: RUN_ID,
    projectRef: cfg.ref ? `${cfg.ref.slice(0, 4)}...${cfg.ref.slice(-4)}` : null,
    executedAt: new Date().toISOString(),
    totalTests: results.length,
    pass: results.length - failed.length,
    fail: failed.length,
    verdict: failed.length ? "FAIL — CROSS-TENANT ACCESS CONFIRMED" : "PASS — TWO-TENANT ISOLATION VERIFIED",
    byTable,
  };
}

function matrixRows() {
  const groups = [
    ["user_profiles", "user_profiles"],
    ["business_profiles", "business_profiles"],
    ["user_business_link", "user_business_link"],
    ["representative financial tables", ["bank_transactions", "ar_open_items", "invoices", "financial_metrics", "tax_snapshots", "bizzy_memory", "gpt_usage"]],
    ["credential tables", ["quickbooks_tokens", "plaid_items", "linked_financial_items", "oauth_connection_states", "email_accounts"]],
    ["remaining uncertified tables", [
      "account_breakdown",
      "affordability_assessments",
      "balance_sheet_history",
      "billing_customers",
      "bizzy_deadlines",
      "bizzy_headlines",
      "bookkeeping_health",
      "calendar_events",
      "categorization_rules",
      "expense_totals_monthly",
      "gpt_messages_backup",
      "insight_preferences",
      "insight_reads",
      "integration_connections",
      "investment_accounts",
      "investment_balances",
      "monthly_forecast",
      "notifications",
      "plaid_accounts",
      "plaid_qbo_account_mappings",
      "positions",
      "profiles",
      "qbo_posted_transactions",
      "review_sources",
      "subscriptions",
      "tax_deadlines",
      "tax_state_rates",
      "transaction_categorizations",
      "vendor_rules",
      "cashflow_forecast",
      "gpt_messages",
      "insights",
    ]],
    ["views and RPCs", [
      "ar_aging",
      "ar_aging_v2",
      "billing_customer_overview",
      "expense_categories",
      "insights_history",
      "jobs_profitability",
      "positions_view",
      "rpc:bizzi_current_user_is_business_member",
      "rpc:bizzi_current_user_can_manage_business",
      "rpc:tax_user_owns_business",
      "rpc:acquire_posting_lock",
      "rpc:claim_contractor_cfo_insight_run",
      "rpc:claim_scheduled_job_lock",
      "rpc:refresh_billing_identity_summary",
      "rpc:get_tax_deduction_transaction_drilldown",
      "rpc:is_member",
      "rpc:recalc_thread_last_message",
      "rpc:create_initial_business_for_user",
    ]],
    ["storage buckets", [
      "storage:bizzy-docs",
      "storage:financial-reports",
      "storage:bid-attachments",
    ]],
  ];
  return groups.map(([label, tables]) => {
    const tableList = Array.isArray(tables) ? tables : [tables];
    const relevant = results.filter((r) => tableList.includes(r.table));
    const cell = (actor, target) => {
      const subset = relevant.filter((r) => r.actor === actor && r.targetTenant.includes(target));
      if (!subset.length) return "n/a";
      return subset.some((r) => r.status === "FAIL") ? "FAIL" : "PASS";
    };
    const anon = relevant.filter((r) => r.actor === "Anonymous");
    return {
      surface: label,
      userAToA: cell("User A", "own"),
      userAToB: cell("User A", "Business B"),
      userBToB: cell("User B", "own"),
      userBToA: cell("User B", "Business A"),
      anonymous: anon.length ? (anon.some((r) => r.status === "FAIL") ? "FAIL" : "PASS") : "n/a",
    };
  });
}

async function writeReports(summary, tenants) {
  await mkdir("reports", { recursive: true });
  const report = {
    summary,
    tenants: {
      userA: { userId: safeId(tenants.userA.id), businessId: safeId(tenants.bizA.id) },
      userB: { userId: safeId(tenants.userB.id), businessId: safeId(tenants.bizB.id) },
    },
    matrix: matrixRows(),
    results,
    explicitAnswers: explicitAnswers(),
  };
  await writeFile(join("reports", "supabase-two-tenant-runtime-security-test.json"), JSON.stringify(report, null, 2));

  const lines = [];
  lines.push("# Supabase Two-Tenant Runtime Security Test");
  lines.push("");
  lines.push(`Executed: ${summary.executedAt}`);
  lines.push(`Run ID: \`${summary.runId}\``);
  lines.push(`Project ref: \`${summary.projectRef || "unknown"}\``);
  lines.push(`Verdict: **${summary.verdict}**`);
  lines.push("");
  lines.push("No JWTs, API keys, service-role credentials, access tokens, or refresh tokens are included in this report.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total tests: ${summary.totalTests}`);
  lines.push(`- Passed: ${summary.pass}`);
  lines.push(`- Failed: ${summary.fail}`);
  lines.push("");
  lines.push("## Matrix");
  lines.push("");
  lines.push("| Surface | User A -> A | User A -> B | User B -> B | User B -> A | Anonymous |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of report.matrix) {
    lines.push(`| ${row.surface} | ${row.userAToA} | ${row.userAToB} | ${row.userBToB} | ${row.userBToA} | ${row.anonymous} |`);
  }
  lines.push("");
  lines.push("## Failed Tests");
  lines.push("");
  const failures = results.filter((r) => r.status === "FAIL");
  if (!failures.length) {
    lines.push("None.");
  } else {
    lines.push("| Table | Operation | Actor | Target | Expected | Actual | Reason |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const r of failures) {
      lines.push(`| ${r.table} | ${r.operation} | ${r.actor} | ${r.targetTenant} | ${r.expected} | ${r.actual.replaceAll("|", "\\|")} | ${r.reason.replaceAll("|", "\\|")} |`);
    }
  }
  lines.push("");
  lines.push("## All Test Results");
  lines.push("");
  lines.push("| Status | Table | Operation | Actor | Target | Expected | Actual |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    lines.push(`| ${r.status} | ${r.table} | ${r.operation} | ${r.actor} | ${r.targetTenant} | ${r.expected} | ${r.actual.replaceAll("|", "\\|")} |`);
  }
  lines.push("");
  lines.push("## Explicit Answers");
  lines.push("");
  for (const [question, answer] of Object.entries(report.explicitAnswers)) {
    lines.push(`- ${question}: **${answer}**`);
  }
  await writeFile(join("reports", "supabase-two-tenant-runtime-security-test.md"), `${lines.join("\n")}\n`);
}

function anyFail(table, operation, actor, targetIncludes) {
  return results.some((r) =>
    r.table === table &&
    (!operation || r.operation === operation) &&
    (!actor || r.actor === actor) &&
    (!targetIncludes || r.targetTenant.includes(targetIncludes)) &&
    r.status === "FAIL"
  );
}

function explicitAnswers() {
  const financialTables = new Set([
    "bank_transactions",
    "ar_open_items",
    "invoices",
    "financial_metrics",
    "tax_snapshots",
    "bizzy_memory",
    "gpt_usage",
    "account_breakdown",
    "affordability_assessments",
    "balance_sheet_history",
    "bookkeeping_health",
    "expense_totals_monthly",
    "monthly_forecast",
    "plaid_accounts",
    "plaid_qbo_account_mappings",
    "qbo_posted_transactions",
    "subscriptions",
    "transaction_categorizations",
    "vendor_rules",
    "cashflow_forecast",
    "insights",
  ]);
  const credentialTables = new Set(["quickbooks_tokens", "plaid_items", "linked_financial_items", "oauth_connection_states", "email_accounts"]);
  const failedFinancialRead = results.some((r) => financialTables.has(r.table) && r.operation === "SELECT" && /Business [AB]|other/.test(r.targetTenant) && r.status === "FAIL");
  const failedFinancialMutation = results.some((r) => financialTables.has(r.table) && ["INSERT", "UPDATE", "DELETE"].includes(r.operation) && /Business [AB]|other|foreign/.test(r.targetTenant) && r.status === "FAIL");
  const failedCredentialRead = results.some((r) => credentialTables.has(r.table) && r.operation === "SELECT" && r.status === "FAIL");
  const anonPrivate = results.some((r) => r.actor === "Anonymous" && r.status === "FAIL");
  const anyCrossTenant = results.some((r) => /Business [AB]|other|foreign/.test(r.targetTenant) && r.status === "FAIL");
  const storageFailures = results.some((r) => r.table.startsWith("storage:") && r.status === "FAIL");
  return {
    "Can User A SELECT User B's profile?": anyFail("user_profiles", "SELECT", "User A", "other user") ? "YES" : "NO",
    "Can User A SELECT Business B?": anyFail("business_profiles", "SELECT", "User A", "Business B") ? "YES" : "NO",
    "Can User A UPDATE Business B?": anyFail("business_profiles", "UPDATE", "User A", "Business B") ? "YES" : "NO",
    "Can User A attach themselves to Business B?": anyFail("user_business_link", "INSERT", "User A", "Business B") ? "YES" : "NO",
    "Can User A elevate themselves to owner/admin for Business B?": anyFail("user_business_link", "INSERT", "User A", "Business B") || anyFail("user_business_link", "UPDATE", "User A", "Business B") ? "YES" : "NO",
    "Can User A alter ownership fields on Business B?": anyFail("business_profiles", "UPDATE", "User A", "Business B") ? "YES" : "NO",
    "Can User A directly read another tenant's financial records?": failedFinancialRead ? "YES" : "NO",
    "Can User A directly mutate another tenant's financial records?": failedFinancialMutation ? "YES" : "NO",
    "Can authenticated users directly read QBO/Plaid/OAuth credential tables?": failedCredentialRead ? "YES" : "NO",
    "Can anonymous users read any private customer data?": anonPrivate ? "YES" : "NO",
    "Does RLS actually isolate the two businesses at runtime?": anyCrossTenant ? "NO" : "YES",
    "Can User A list Business B Storage objects?": anyFail("storage:bizzy-docs", "LIST", "User A", "Business B") || anyFail("storage:financial-reports", "LIST", "User A", "Business B") || anyFail("storage:bid-attachments", "LIST", "User A", "Business B") ? "YES" : "NO",
    "Can User A download Business B Storage objects?": anyFail("storage:bizzy-docs", "DOWNLOAD", "User A", "Business B") || anyFail("storage:financial-reports", "DOWNLOAD", "User A", "Business B") || anyFail("storage:bid-attachments", "DOWNLOAD", "User A", "Business B") ? "YES" : "NO",
    "Can User A request a signed URL for Business B Storage objects?": anyFail("storage:bizzy-docs", "SIGNED_URL", "User A", "Business B") || anyFail("storage:financial-reports", "SIGNED_URL", "User A", "Business B") || anyFail("storage:bid-attachments", "SIGNED_URL", "User A", "Business B") ? "YES" : "NO",
    "Do Storage policies isolate private buckets at runtime?": storageFailures ? "NO" : "YES",
    "Which exact policies/settings must be fixed next?": "See failed tests; likely business_profiles USING true, user_business_link WITH CHECK true, RLS-disabled tables with anon/authenticated ALL grants, and credential table browser grants.",
    "Is the authorization foundation safe enough to build the rest of the RLS model upon?": anyCrossTenant ? "NO" : "YES",
  };
}

async function main() {
  let tenants;
  try {
    const userA = await createTestUser("A");
    const userB = await createTestUser("B");
    const bizA = await createBusiness(userA, "A");
    const bizB = await createBusiness(userB, "B");
    const rowsA = await setupTenantRows(userA, bizA, "A");
    const rowsB = await setupTenantRows(userB, bizB, "B");
    const uncertifiedRowsA = await setupUncertifiedTableRows(userA, bizA, "A", rowsA);
    const uncertifiedRowsB = await setupUncertifiedTableRows(userB, bizB, "B", rowsB);
    tenants = { userA, userB, bizA, bizB };

    if (userA.id === userB.id || bizA.id === bizB.id) {
      throw new Error("Test tenants are not distinct.");
    }

    await runFoundationTests(userA, bizA, userB, bizB);
    await runAnonTests(bizA, userA);
    await runTenantTableTests(userA, bizA, rowsA, userB, bizB, rowsB);
    await runCredentialTableTests(userA, bizA, rowsA, userB, bizB, rowsB);
    await runUncertifiedTableTests(userA, bizA, uncertifiedRowsA, userB, bizB, uncertifiedRowsB);
    await runViewRpcFunctionTests(userA, bizA, userB, bizB);
    await runStorageTests(userA, bizA, userB, bizB);
  } finally {
    await cleanup();
  }

  const summary = summarize();
  await writeReports(summary, tenants || {});
  console.log(JSON.stringify({
    verdict: summary.verdict,
    totalTests: summary.totalTests,
    pass: summary.pass,
    fail: summary.fail,
    report: "reports/supabase-two-tenant-runtime-security-test.md",
    json: "reports/supabase-two-tenant-runtime-security-test.json",
  }, null, 2));
  if (summary.fail) process.exitCode = 2;
}

main().catch(async (err) => {
  console.error("[two-tenant-rls] aborted", {
    message: err?.message || String(err),
    code: err?.code || null,
  });
  try { await cleanup(); } catch {}
  process.exitCode = 1;
});
