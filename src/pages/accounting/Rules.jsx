import React, { useCallback, useEffect, useState } from "react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { useBusiness } from "../../context/BusinessContext.jsx";
import {
  getQboCoaCreations,
  createQboCoaAccount,
  getQboVendorCreations,
} from "../../services/bookkeeping/bookkeepingClient.js";

function QboCoaChangesPanel({ businessId }) {
  if (!businessId) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/60">
        Connect QuickBooks to view COA changes.
      </div>
    );
  }
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchRows = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const res = await getQboCoaCreations(businessId, { limit: 50 });
      if (res?.ok === false) {
        setError("Unable to load COA changes.");
        setRows([]);
      } else {
        setError("");
        setRows(res?.rows || []);
      }
    } catch (e) {
      setError("Unable to load COA changes.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const showDevCreate = process.env.NODE_ENV !== "production";

  const handleDevCreate = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      await createQboCoaAccount(businessId, { name: "Transportation", intent: "transportation" });
      await fetchRows();
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [businessId, fetchRows]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-white/90">COA Changes</p>
          <p className="text-[11px] text-white/60">Bizzi creates clean, standard accounts only when needed.</p>
        </div>
        <div className="flex items-center gap-2">
          {showDevCreate ? (
            <GhostButton onClick={handleDevCreate} disabled={loading} className="text-xs">
              Create test account
            </GhostButton>
          ) : null}
          <GhostButton onClick={fetchRows} disabled={loading} className="text-xs">
            {loading ? "Refreshing…" : "Refresh"}
          </GhostButton>
        </div>
      </div>
      {error ? <p className="mt-1 text-[11px] text-amber-200/80">{error}</p> : null}
      <div className="mt-2 space-y-2">
        {loading && rows.length === 0 ? (
          <p className="text-xs text-white/60">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-white/60">No COA accounts created yet.</p>
        ) : (
          rows.map((r) => (
            <div key={r.id || r.qbo_account_id} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="text-sm text-white/90">{r.qbo_account_name}</span>
                  <span className="text-[11px] text-white/60">{r.account_type}</span>
                </div>
                <span className="text-[11px] text-white/50">
                  {r.created_at ? new Date(r.created_at).toLocaleDateString() : ""}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-white/60">
                <span>
                  {r.meta?.reason || r.meta?.intent || r.meta?.canonical_vendor || "—"}
                </span>
                <span className="inline-flex items-center rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-white/70">
                  {r.created_by || "bizzi"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function QboVendorChangesPanel({ businessId }) {
  if (!businessId) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/60">
        Connect QuickBooks to view vendor changes.
      </div>
    );
  }
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchRows = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const res = await getQboVendorCreations(businessId, { limit: 50 });
      if (res?.ok === false) {
        setError("Unable to load vendor changes.");
        setRows([]);
      } else {
        setError("");
        setRows(res?.rows || []);
      }
    } catch (e) {
      setError("Unable to load vendor changes.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-white/90">Vendors added by Bizzi</p>
          <p className="text-[11px] text-white/60">Bizzi creates vendors only when needed for clean posting.</p>
        </div>
        <div className="flex items-center gap-2">
          <GhostButton onClick={fetchRows} disabled={loading} className="text-xs">
            {loading ? "Refreshing…" : "Refresh"}
          </GhostButton>
        </div>
      </div>
      {error ? <p className="mt-1 text-[11px] text-amber-200/80">{error}</p> : null}
      <div className="mt-2 space-y-2">
        {loading && rows.length === 0 ? (
          <p className="text-xs text-white/60">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-white/60">No vendors created yet.</p>
        ) : (
          rows.map((r) => (
            <div key={r.id || r.qbo_entity_id} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="text-sm text-white/90">{r.vendor_name}</span>
                  <span className="text-[11px] text-white/60">{r.qbo_entity_type || "vendor"}</span>
                </div>
                <span className="text-[11px] text-white/50">
                  {r.created_at ? new Date(r.created_at).toLocaleDateString() : ""}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-white/60">
                <span>{r.meta?.reason || r.meta?.intent || "—"}</span>
                <span className="inline-flex items-center rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-white/70">
                  {r.created_by || "bizzi"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
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
