import React, { useCallback, useEffect, useState } from "react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { useBusiness } from "../../context/BusinessContext.jsx";
import {
  createBizziCanonicalQboVendor,
  getCanonicalQboCoa,
  getCanonicalQboVendors,
  useExistingCanonicalQboVendor,
} from "../../services/bookkeeping/bookkeepingClient.js";

function QboCoaChangesPanel({ businessId }) {
  const [rows, setRows] = useState([]);
  const [history, setHistory] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchRows = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const res = await getCanonicalQboCoa(businessId);
      if (res?.ok === false) {
        setError("Unable to load COA changes.");
        setRows([]);
        setHistory([]);
      } else {
        setError("");
        setRows(res?.rows || []);
        setHistory(res?.history || []);
        setDecisions(res?.decisions || []);
      }
    } catch (e) {
      setError("Unable to load COA changes.");
      setRows([]);
      setHistory([]);
      setDecisions([]);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const mappedRows = rows.filter((row) => row.status !== "needs_review");

  if (!businessId) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/60">
        Connect QuickBooks to view COA changes.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-white/90">Chart of Accounts</p>
          <p className="text-[11px] text-white/60">Canonical Bizzi accounts mapped to QuickBooks accounts.</p>
        </div>
        <GhostButton onClick={fetchRows} disabled={loading} className="text-xs">
          {loading ? "Refreshing…" : "Refresh"}
        </GhostButton>
      </div>
      {error ? <p className="mt-1 text-[11px] text-amber-200/80">{error}</p> : null}
      {decisions.length ? (
        <div className="mt-3 space-y-2">
          {decisions.map((decision) => {
            const usage = decision.candidate_usage || {};
            return (
              <div key={`${decision.realm_id || "realm"}-${decision.canonical_account_key}`} className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white/90">{decision.bizzi_account_name}</p>
                    <p className="mt-0.5 text-[11px] text-white/60">
                      Possible existing QuickBooks account: {decision.candidate_qbo_account_name || "None"} · {decision.candidate_qbo_account_type || "Account"}
                    </p>
                    <p className="mt-1 text-[11px] text-white/55">
                      {Number(decision.affected_transaction_count || 0)} transaction{Number(decision.affected_transaction_count || 0) === 1 ? "" : "s"} affected
                      {Number(usage.transaction_count || 0) ? ` · ${usage.transaction_count} prior use${Number(usage.transaction_count || 0) === 1 ? "" : "s"}` : " · no prior usage found"}
                    </p>
                    <p className="mt-1 text-[11px] text-amber-100/80">
                      {decision.recommendation?.label || "Review Required"}: {decision.recommendation?.reason || decision.review_reason || "Human decision required."}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-amber-200/25 px-2 py-0.5 text-[11px] text-amber-100">Needs Review</span>
                </div>
                <div className="mt-2 rounded-md border border-amber-200/15 bg-black/20 px-3 py-2 text-[11px] text-amber-100/80">
                  Account setup needed. Bizzi will review this during your monthly close.
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="mt-2 space-y-2">
        {loading && mappedRows.length === 0 ? (
          <p className="text-xs text-white/60">Loading…</p>
        ) : mappedRows.length === 0 ? (
          <p className="text-xs text-white/60">No canonical account mappings yet.</p>
        ) : (
          mappedRows.map((r) => (
            <div key={r.canonical_account_key || r.qbo_account_id} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="text-sm text-white/90">{r.bizzi_account_name}</span>
                  <span className="text-[11px] text-white/60">{r.qbo_account_name || "Needs review"} · {r.account_type || "Account"}</span>
                </div>
                <span className="text-[11px] text-white/50">
                  {r.date ? new Date(r.date).toLocaleDateString() : ""}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-white/60">
                <span>
                  {r.review_reason || `${Number(r.usage_count || 0)} transaction${Number(r.usage_count || 0) === 1 ? "" : "s"}`}
                </span>
                <span className="inline-flex items-center rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-white/70">
                  {r.status_label || r.status || "Mapped"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
      {history.length ? (
        <div className="mt-4 border-t border-white/10 pt-3">
          <p className="text-xs font-semibold text-white/75">History</p>
          <div className="mt-2 space-y-1.5">
            {history.slice(0, 8).map((event) => (
              <div key={event.id} className="flex items-center justify-between gap-2 text-[11px] text-white/55">
                <span className="truncate">{event.qbo_account_name || event.canonical_account_key || "Account"} · {event.status_label || event.event_type}</span>
                <span className="shrink-0">{event.created_at ? new Date(event.created_at).toLocaleDateString() : ""}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QboVendorChangesPanel({ businessId }) {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [busyDecision, setBusyDecision] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchRows = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const res = await getCanonicalQboVendors(businessId, { limit: 50 });
      if (res?.ok === false) {
        setError("Unable to load vendor changes.");
        setRows([]);
        setSummary({});
      } else {
        setError("");
        setRows(res?.rows || []);
        setSummary(res?.summary || {});
      }
    } catch (e) {
      setError("Unable to load vendor changes.");
      setRows([]);
      setSummary({});
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const resolveVendorDecision = useCallback(async (row, action) => {
    if (!businessId || !row?.canonical_vendor_id) return;
    setBusyDecision(`${row.canonical_vendor_id}:${action}`);
    setError("");
    try {
      if (action === "use_existing") {
        await useExistingCanonicalQboVendor(businessId, row.canonical_vendor_id, {
          qbo_vendor_id: row.candidate_qbo_vendor_id || row.qbo_vendor_id,
        });
      } else {
        await createBizziCanonicalQboVendor(businessId, row.canonical_vendor_id, {
          transaction_id: row.transaction_id || null,
        });
      }
      await fetchRows();
    } catch (e) {
      setError(e?.body?.message || e?.message || "Unable to resolve vendor decision.");
    } finally {
      setBusyDecision("");
    }
  }, [businessId, fetchRows]);

  if (!businessId) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/60">
        Connect QuickBooks to view vendor changes.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-white/90">Vendor Activity</p>
          <p className="text-[11px] text-white/60">Canonical vendors, QBO mappings, and review items.</p>
        </div>
        <div className="flex items-center gap-2">
          <GhostButton onClick={fetchRows} disabled={loading} className="text-xs">
            {loading ? "Refreshing…" : "Refresh"}
          </GhostButton>
        </div>
      </div>
      {error ? <p className="mt-1 text-[11px] text-amber-200/80">{error}</p> : null}
      <div className="mt-3 grid grid-cols-2 gap-2 text-center text-[11px] text-white/65 md:grid-cols-4">
        <MiniStat label="Created" value={summary.created_by_bizzi_count || 0} />
        <MiniStat label="Mapped" value={summary.mapped_existing_count || 0} />
        <MiniStat label="Aliases" value={summary.new_aliases_learned_count || 0} />
        <MiniStat label="Review" value={summary.needs_review_count || 0} />
      </div>
      <div className="mt-2 space-y-2">
        {loading && rows.length === 0 ? (
          <p className="text-xs text-white/60">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-white/60">No canonical vendor activity yet.</p>
        ) : (
          rows.map((r) => (
            <div key={r.canonical_vendor_id || r.qbo_vendor_id} className={`rounded-lg border px-3 py-2 ${r.status === "needs_review" ? "border-amber-300/20 bg-amber-300/[0.06]" : "border-white/10 bg-black/30"}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="text-sm text-white/90">{r.display_name}</span>
                  <span className="text-[11px] text-white/60">{r.qbo_display_name ? `QBO Vendor: ${r.qbo_display_name}` : r.candidate_qbo_vendor_name ? `Possible QBO Vendor: ${r.candidate_qbo_vendor_name}` : r.primary_evidence_type || "Canonical vendor"}</span>
                </div>
                <span className="text-[11px] text-white/50">
                  {r.updated_at ? new Date(r.updated_at).toLocaleDateString() : ""}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-white/60">
                <span>{r.review_reason || `${Number(r.alias_count || 0)} alias${Number(r.alias_count || 0) === 1 ? "" : "es"} · ${Number(r.strong_alias_count || 0)} strong`}</span>
                <span className="inline-flex items-center rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-white/70">
                  {r.status_label || r.status || "Mapped"}
                </span>
              </div>
              {r.status === "needs_review" ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.candidate_qbo_vendor_id ? (
                    <GhostButton onClick={() => resolveVendorDecision(r, "use_existing")} disabled={loading || !!busyDecision} className="text-xs">
                      {busyDecision === `${r.canonical_vendor_id}:use_existing` ? "Saving..." : "Use Existing"}
                    </GhostButton>
                  ) : null}
                  <GhostButton onClick={() => resolveVendorDecision(r, "create_bizzi")} disabled={loading || !!busyDecision} className="text-xs">
                    {busyDecision === `${r.canonical_vendor_id}:create_bizzi` ? "Creating..." : "Create Bizzi Vendor"}
                  </GhostButton>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/40">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-white/85">{value}</div>
    </div>
  );
}

function GhostButton({ children, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`px-3 py-2 rounded-lg text-sm transition border bg-transparent hover:bg-white/5 hover:border-white/40 disabled:opacity-60 ${className}`}
      style={{ color: "var(--text)", borderColor: "rgba(165,167,169,0.18)" }}
    >
      {children}
    </button>
  );
}

export default function AccountingRules() {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");

  return (
    <div className="px-3 md:px-4 pt-0 pb-8 text-slate-100 min-h-screen">
      <ModuleHeader
        module="financials"
        title="Rules"
        subtitle="Vendor and chart of accounts changes created by Bizzi."
        className="mb-4"
      />
      <div className="space-y-4">
        <QboVendorChangesPanel businessId={businessId} />
        <QboCoaChangesPanel businessId={businessId} />
      </div>
    </div>
  );
}
