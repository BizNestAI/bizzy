import { normalizeChartOfAccount, fetchChartOfAccounts } from "./qboAccounts.js";
import { qboEnvName } from "../../utils/qboEnv.js";

const unavailable = () => Object.assign(new Error("QuickBooks Chart of Accounts could not be loaded. Please retry."), { status: 503, code: "coa_unavailable" });

// Read connection metadata only. Never decrypt tokens, refresh OAuth or contact QBO.
export async function readBookkeepingChartOfAccounts({ db, businessId, environment = qboEnvName, cacheOnly = false, forceRefresh = false, provider = fetchChartOfAccounts }) {
  const { data: connection, error } = await db.from("quickbooks_tokens")
    .select("realm_id,qbo_env").eq("business_id", businessId).eq("qbo_env", environment)
    .eq("is_active", true).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !connection?.realm_id || connection.qbo_env !== environment) throw unavailable();
  const realmId = String(connection.realm_id);
  const rows = [];
  if (!forceRefresh || cacheOnly) {
    for (let offset = 0; ; offset += 1000) {
      const result = await db.from("qbo_accounts_cache")
        .select("qbo_account_id,name,fully_qualified_name,account_type,account_subtype,active,raw,last_synced_at")
        .eq("business_id", businessId).eq("realm_id", realmId).eq("qbo_env", environment).eq("active", true)
        .order("qbo_account_id").range(offset, offset + 999);
      if (result.error) throw unavailable();
      rows.push(...(result.data || []));
      if ((result.data || []).length < 1000) break;
    }
  }
  let accounts = rows.map(row => normalizeChartOfAccount({ ...row.raw, ...row,
    Id: row.qbo_account_id, Name: row.name, FullyQualifiedName: row.fully_qualified_name || row.name,
    AccountType: row.account_type, AccountSubType: row.account_subtype, Active: row.active, businessId,
  })).filter(account => account?.active && account.postable)
    .sort((a, b) => a.fullyQualifiedName.localeCompare(b.fullyQualifiedName));
  if (!accounts.length) {
    if (cacheOnly) throw unavailable();
    accounts = await provider(businessId, { forceRefresh });
    if (!accounts?.length) throw unavailable();
  }
  return { accounts, meta: { source: "quickbooks_chart_of_accounts", business_id: businessId,
    realm_id: realmId, qbo_env: environment, includes_subaccounts: true, refreshed: forceRefresh && !cacheOnly } };
}
