import React from "react";
import { Settings2 } from "lucide-react";

export default function TaxProfileCard({ profile, completeness, onEdit }) {
  const normalized = normalizeProfile(profile);
  const complete = completeness?.isCompleteForEstimate === true || completeness?.percent === 100 || completeness?.score === 100;
  const percent = completeness?.percent ?? completeness?.score ?? null;
  const missing = completeness?.missingRequired || completeness?.missing_required || [];
  return (
    <section className="rounded-[20px] border border-white/10 bg-white/[0.05] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Tax profile</div>
          <h2 className="mt-1 text-lg font-semibold text-white">{complete ? "Business tax identity" : "Finish tax setup"}</h2>
          <p className="mt-1 text-sm text-white/54">
            {percent == null ? "Profile completeness is unavailable." : `${Math.round(percent)}% complete`}
          </p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/20 px-3 py-2 text-sm font-semibold text-white/76 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40"
        >
          <Settings2 className="h-4 w-4" />
          Edit
        </button>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <ProfileItem label="State" value={normalized.state} />
        <ProfileItem label="Entity" value={labelize(normalized.entityType)} />
        {normalized.taxElection ? <ProfileItem label="Election" value={labelize(normalized.taxElection)} /> : null}
        <ProfileItem label="Filing status" value={labelize(normalized.filingStatus)} />
        <ProfileItem label="Accounting" value={labelize(normalized.accountingMethod)} />
        <ProfileItem label="Last reviewed" value={formatDate(normalized.lastReviewedAt)} />
      </div>
      {!complete && missing.length ? (
        <div className="mt-4 rounded-2xl border border-amber-300/18 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-50/82">
          Missing: {missing.map(labelize).join(", ")}
        </div>
      ) : null}
    </section>
  );
}

function ProfileItem({ label, value }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white/84">{value || "Missing"}</div>
    </div>
  );
}

function labelize(value) {
  if (!value || value === "unknown") return "Missing";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeProfile(profile) {
  const source = profile || {};
  const entityType = source.entityType ?? source.entity_type;
  const taxElection = source.taxElection ?? source.tax_election;
  return {
    entityType,
    taxElection: taxElection && taxElection !== "none" ? taxElection : entityType === "s_corp" ? "s_corp" : null,
    filingStatus: source.filingStatus ?? source.filing_status,
    state: source.primaryState ?? source.primary_tax_state ?? source.state,
    accountingMethod: source.accountingMethod ?? source.accounting_method,
    lastReviewedAt: source.lastReviewedAt ?? source.last_reviewed_at ?? source.updatedAt ?? source.updated_at,
  };
}

function formatDate(value) {
  if (!value) return "Not reviewed";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not reviewed";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
