export function projectMonthlyReportState({ report = null, currentSnapshot = null } = {}) {
  if (!report) return { status: "not_published", report: null, source_current: false };
  if (report.publication_status === "publishing") return { status: "publishing", report, source_current: false };
  if (report.publication_status === "failed") return { status: "publication_failed", report, source_current: false };
  if (report.publication_status === "superseded" && report.monthly_review_published_at && report.storage_path) return { status: "superseded", report, source_current: false };
  if (!report.monthly_review_published_at || !report.storage_path) return { status: "not_published", report, source_current: false };
  const hasPersistedIdentity = Boolean(report.monthly_review_source_snapshot_id && report.monthly_review_source_fingerprint);
  const hasCurrentIdentity = Boolean(currentSnapshot?.id && currentSnapshot?.raw_hash);
  if (!hasPersistedIdentity || !hasCurrentIdentity) {
    return { status: "published_legacy_unverified", report, source_current: false };
  }
  const sourceCurrent = String(report.monthly_review_source_snapshot_id) === String(currentSnapshot.id) &&
    report.monthly_review_source_fingerprint === currentSnapshot.raw_hash;
  return { status: sourceCurrent ? "published_current" : "published_outdated", report, source_current: sourceCurrent };
}

export async function getMonthlyReportState({ db, businessId, year, month, accountingMethod = "Cash" }) {
  const [{ data: report, error: reportError }, { data: snapshot, error: snapshotError }] = await Promise.all([
    db.from("report_metadata")
      .select("id,business_id,year,month,storage_path,monthly_review_published_at,monthly_review_published_by,monthly_review_run_id,monthly_review_source,generated_at,qbo_report_hash,source_start_date,source_end_date,accounting_method,publication_status,publication_request_id,publication_failure_code,monthly_review_source_snapshot_id,monthly_review_source_fingerprint")
      .eq("business_id", businessId).eq("year", Number(year)).eq("month", Number(month)).eq("accounting_method", accountingMethod).maybeSingle(),
    db.from("monthly_review_qbo_pnl_snapshots")
      .select("id,business_id,review_year,review_month,accounting_method,raw_hash,snapshot_version,pulled_at,status,is_current")
      .eq("business_id", businessId).eq("review_year", Number(year)).eq("review_month", Number(month)).eq("accounting_method", accountingMethod).eq("is_current", true).maybeSingle(),
  ]);
  if (reportError) throw reportError;
  if (snapshotError) throw snapshotError;
  return { ...projectMonthlyReportState({ report, currentSnapshot: snapshot }), current_snapshot: snapshot || null, accounting_method: accountingMethod };
}
