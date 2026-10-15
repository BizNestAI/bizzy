import { buildMonthlyPnlContentFingerprint } from "./monthlyPnlContentFingerprint.js";

export function projectMonthlyReportState({ report = null, currentSnapshot = null, sourceSnapshot = null, sourceFingerprint = null, currentFingerprint = null } = {}) {
  if (!report) return { status: "not_published", report: null, source_current: false };
  if (report.publication_status === "publishing") return { status: "publishing", report, source_current: false };
  if (report.publication_status === "failed") return { status: "publication_failed", report, source_current: false };
  if (report.publication_status === "superseded" && report.monthly_review_published_at && report.storage_path) return { status: "superseded", report, source_current: false };
  if (!report.monthly_review_published_at || !report.storage_path) return { status: "not_published", report, source_current: false };
  const reportFingerprint = sourceFingerprint || report.monthly_review_source_fingerprint;
  const liveFingerprint = currentFingerprint || currentSnapshot?.metadata?.financial_content?.fingerprint;
  const hasPersistedIdentity = Boolean(report.monthly_review_source_snapshot_id && sourceSnapshot && reportFingerprint);
  const hasCurrentIdentity = Boolean(currentSnapshot?.id && liveFingerprint);
  if (!hasPersistedIdentity || !hasCurrentIdentity) {
    return { status: "published_legacy_unverified", report, source_current: false };
  }
  const sourceCurrent = reportFingerprint === liveFingerprint;
  return { status: sourceCurrent ? "published_current" : "published_outdated", report, source_current: sourceCurrent };
}

export async function getMonthlyReportState({ db, businessId, year, month, accountingMethod = "Cash" }) {
  const [{ data: report, error: reportError }, { data: snapshot, error: snapshotError }] = await Promise.all([
    db.from("report_metadata")
      .select("id,business_id,year,month,storage_path,monthly_review_published_at,monthly_review_published_by,monthly_review_run_id,monthly_review_source,generated_at,qbo_report_hash,source_start_date,source_end_date,accounting_method,publication_status,publication_request_id,publication_failure_code,monthly_review_source_snapshot_id,monthly_review_source_fingerprint")
      .eq("business_id", businessId).eq("year", Number(year)).eq("month", Number(month)).eq("accounting_method", accountingMethod).maybeSingle(),
    db.from("monthly_review_qbo_pnl_snapshots")
      .select("id,business_id,review_year,review_month,qbo_realm_id,accounting_method,source_start_date,source_end_date,revenue,cogs,expenses,net_profit,raw_hash,metadata,snapshot_version,pulled_at,status,is_current")
      .eq("business_id", businessId).eq("review_year", Number(year)).eq("review_month", Number(month)).eq("accounting_method", accountingMethod).eq("is_current", true).maybeSingle(),
  ]);
  if (reportError) throw reportError;
  if (snapshotError) throw snapshotError;
  let sourceSnapshot = null;
  if (report?.monthly_review_source_snapshot_id) {
    const { data, error } = await db.from("monthly_review_qbo_pnl_snapshots")
      .select("id,business_id,review_year,review_month,qbo_realm_id,accounting_method,source_start_date,source_end_date,revenue,cogs,expenses,net_profit,raw_hash,metadata,snapshot_version,pulled_at,status,is_current")
      .eq("business_id", businessId).eq("id", report.monthly_review_source_snapshot_id).maybeSingle();
    if (error) throw error;
    sourceSnapshot = data || null;
  }
  const fingerprints = await Promise.all([
    loadSnapshotFingerprint({ db, businessId, snapshot: sourceSnapshot }),
    sourceSnapshot?.id === snapshot?.id
      ? loadSnapshotFingerprint({ db, businessId, snapshot: sourceSnapshot })
      : loadSnapshotFingerprint({ db, businessId, snapshot }),
  ]);
  return {
    ...projectMonthlyReportState({ report, currentSnapshot: snapshot, sourceSnapshot, sourceFingerprint: fingerprints[0], currentFingerprint: fingerprints[1] }),
    current_snapshot: snapshot || null,
    accounting_method: accountingMethod,
  };
}

async function loadSnapshotFingerprint({ db, businessId, snapshot }) {
  if (!snapshot?.id) return null;
  const persisted = snapshot.metadata?.financial_content?.fingerprint;
  if (persisted) return persisted;
  const { data: accounts, error: accountsError } = await db.from("monthly_review_qbo_pnl_accounts")
    .select("qbo_account_id,account_name,account_path,account_type,account_subtype,total_amount")
    .eq("business_id", businessId).eq("snapshot_id", snapshot.id);
  if (accountsError) throw accountsError;
  return buildMonthlyPnlContentFingerprint({ snapshot, accounts: accounts || [] })?.fingerprint || null;
}
