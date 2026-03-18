import React, { useEffect, useMemo, useState } from "react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { getJobsSummary, getJobsPipeline, getJobsTopUnpaid, getJobsActivity } from "../../services/jobs/jobs";
import KPIRow from "../../components/Jobs/KPIRow.jsx";
import Pipeline from "../../components/Jobs/Pipeline.jsx";
import TopUnpaidTable from "../../components/Jobs/TopUnpaidTable.jsx";
import NextActionsPanel from "../../components/Jobs/NextActionsPanel.jsx";
import { getDemoJobsSummary, getDemoJobsPipeline, getDemoJobsTopUnpaid } from "./jobsMockData.js";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";
import { useBusiness } from "../../context/BusinessContext.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { apiUrl, safeFetch } from "../../utils/safeFetch.js";
import { getArStatus } from "../../services/jobs/jobs.js";

const glass =
  "rounded-[28px] bg-white/[0.04] border-0 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl";

function SkeletonCard({ className = "", lines = 3 }) {
  return (
    <div
      className={`rounded-[22px] bg-white/[0.05] p-4 sm:p-5 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl animate-pulse ${className}`}
    >
      <div className="space-y-3">
        <div className="h-3 w-24 bg-white/15 rounded-full" />
        <div className="h-5 w-32 bg-white/18 rounded-md" />
        {Array.from({ length: lines }).map((_, idx) => (
          <div
            key={idx}
            className="h-3 w-full bg-white/10 rounded-full"
            style={{ opacity: 0.8 - idx * 0.15 }}
          />
        ))}
      </div>
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return "";
  const now = Date.now();
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = now - then;
  const mins = Math.floor(diffMs / (1000 * 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function JobsDashboard() {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";

  const [summary, setSummary] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [topUnpaid, setTopUnpaid] = useState([]);
  const [activity, setActivity] = useState([]);
  const [hero, setHero] = useState(null);
  const [loading, setLoading] = useState(true);
  const [arStatus, setArStatus] = useState({ last_synced_at: null, open_count: null });
  const [syncingAr, setSyncingAr] = useState(false);

  const integrationManager = useIntegrationManager({ businessId });
  const { getStatus, markStatus } = integrationManager;
  const qbStatus = getStatus("quickbooks")?.status;
  const jobberStatus = getStatus("jobber")?.status;

  const usingDemo = useMemo(
    () => shouldUseDemoData(currentBusiness || businessId),
    [businessId, currentBusiness]
  );
  const canView = usingDemo || qbStatus === "connected" || jobberStatus === "connected";

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!businessId || !canView) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const [s, p, u, a] = await Promise.allSettled([
        getJobsSummary(businessId),
        getJobsPipeline(businessId),
        getJobsTopUnpaid(businessId),
        getJobsActivity(businessId),
      ]);
      if (!alive) return;
      setSummary(s.status === "fulfilled" ? s.value : null);
      setPipeline(p.status === "fulfilled" ? p.value : null);
      setTopUnpaid(u.status === "fulfilled" ? (u.value || []) : []);
      setActivity(a.status === "fulfilled" ? (a.value || []) : []);
      if (!usingDemo) {
        try {
          const status = await getArStatus(businessId);
          if (alive && status) setArStatus(status);
        } catch {
          if (alive) setArStatus((prev) => prev);
        }
      }
      if (alive) setLoading(false);
    }
    load();
    return () => { alive = false; };
  }, [businessId, canView]);

  // Only show mock data when the user is in Demo/Mock mode
  const usingMock = usingDemo;

  // Mock hero insight (jobs)
  useEffect(() => {
    if (usingMock) {
      setHero({
        id: "mock-jobs-hero",
        title: "Lock dates on your hottest leads this week",
        summary:
          "Three referral leads are idle. Slot them and assign crews to lift your win rate above 30% and pull cash forward.",
        metric: "+12% win rate",
        severity: "good",
        dismissible: true,
      });
    } else {
      setHero(null);
    }
  }, [usingMock]);

  // If we fall back to sample data, clear any stale "connected" badges for ops providers
  useEffect(() => {
    if (!usingDemo) return;
    ["jobber"].forEach((provider) => {
      const status = getStatus(provider);
      if (status?.status === "connected") {
        markStatus(provider, "disconnected");
      }
    });
  }, [getStatus, markStatus, usingDemo]);

  const summaryData = usingMock ? getDemoJobsSummary() : summary || {};
  const pipelineData = usingMock ? getDemoJobsPipeline() : pipeline || {};
  const topUnpaidData = usingMock ? getDemoJobsTopUnpaid() : topUnpaid || [];
  const hasQbo = useMemo(
    () => usingDemo || qbStatus === "connected" || (Array.isArray(topUnpaidData) && topUnpaidData.length > 0),
    [usingDemo, qbStatus, topUnpaidData]
  );

  if (!canView) {
    return (
      <LiveModePlaceholder
        title="Connect QuickBooks or Jobber to view Jobs"
        message="You won't see the Jobs dashboard until you connect QuickBooks or Jobber. Open Settings/Sync to link your tools and bring in pipeline data."
      />
    );
  }

  return (
    <div className="w-full px-3 md:px-4 pt-0 pb-4">
      <div className="max-w-[1100px] mx-auto space-y-4">
        <ModuleHeader
          module="jobs"
          subtitle="Manage your job flow from new leads to paid projects."
          hero={hero}
          onDismissHero={() => setHero(null)}
        />

        {/* KPIs */}
        <section className={`${glass} p-4 sm:p-6`} aria-label="KPIs">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/50">Job Flow</p>
              <h2 className="text-xl font-semibold text-white">Pipeline pulse</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-white/70">
              <button className="px-3 py-1.5 rounded-full border border-white/20 bg-white/[0.05] hover:bg-white/[0.12] transition shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                Import CSV
              </button>
            </div>
          </div>
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
              {[1, 2, 3, 4].map((i) => (
                <SkeletonCard key={i} lines={3} />
              ))}
            </div>
          ) : (
            <KPIRow
              leads7={summaryData?.leads_7d ?? 0}
              scheduled14={summaryData?.scheduled_next_14d ?? 0}
              winRate30={summaryData?.win_rate_30d}
              outstandingAR={summaryData?.outstanding_ar}
            />
          )}
        </section>

        {/* Pipeline + actions */}
        <section className="grid gap-4 xl:grid-cols-[2fr,1fr]" aria-label="Pipeline">
          <div className={`${glass} p-4 sm:p-6`}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">Current pipeline</h3>
                <p className="text-sm text-white/55">See what’s scheduled, in progress, and ready for wrap-up.</p>
              </div>
              <button className="px-3 py-1.5 text-sm rounded-full border border-white/15 text-white/85 bg-white/[0.05] hover:bg-white/[0.12] transition shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                Add job
              </button>
            </div>
            {loading ? (
              <SkeletonCard lines={4} />
            ) : (
              <Pipeline columns={pipelineData} />
            )}
          </div>

          <div className={`${glass} p-4 sm:p-5`}>
            {loading ? (
              <SkeletonCard lines={4} />
            ) : (
              <NextActionsPanel topUnpaid={topUnpaidData} pipeline={pipelineData} hasQbo={hasQbo} />
            )}
          </div>
        </section>

        {/* Top unpaid */}
        <section className={`${glass} p-4 sm:p-6`} aria-label="Payments">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Top unpaid jobs</h3>
              <p className="text-sm text-white/55">Proactively follow up on outstanding invoices.</p>
              {arStatus?.last_synced_at ? (
                <p className="text-[11px] text-white/45">
                  QuickBooks AR Synced • Updated {timeAgo(arStatus.last_synced_at)}
                  {typeof arStatus.open_count === "number" ? ` • ${arStatus.open_count} open` : ""}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button className="px-3 py-1.5 text-sm rounded-full border border-white/15 text-white/85 bg-white/[0.05] hover:bg-white/[0.12] transition shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
                Export list
              </button>
              {!usingDemo && (
                <button
                  className="px-3 py-1.5 text-sm rounded-full border border-white/25 text-white bg-white/[0.08] hover:bg-white/[0.15] transition shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                  disabled={syncingAr}
                  onClick={async () => {
                    if (!businessId) return;
                    setSyncingAr(true);
                    try {
                      const res = await safeFetch(apiUrl("/api/ar/sync/open-items"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ business_id: businessId }),
                      });
                      console.log("[JobsDashboard] sync result", res);
                      const refreshed = await getJobsTopUnpaid(businessId);
                      setTopUnpaid(refreshed || []);
                      const status = await getArStatus(businessId);
                      if (status) setArStatus(status);
                    } catch (e) {
                      console.warn("[JobsDashboard] AR sync failed", e?.message || e);
                    } finally {
                      setSyncingAr(false);
                    }
                  }}
                >
                  {syncingAr ? "Refreshing..." : "Sync AR"}
                </button>
              )}
            </div>
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="rounded-[14px] bg-white/[0.05] px-4 py-3 shadow-[0_10px_24px_rgba(0,0,0,0.25)] backdrop-blur-xl animate-pulse"
                >
                  <div className="h-4 w-40 bg-white/18 rounded-full mb-2" />
                  <div className="h-3 w-24 bg-white/12 rounded-full mb-1" />
                  <div className="h-3 w-32 bg-white/10 rounded-full" />
                </div>
              ))}
            </div>
          ) : (
            <TopUnpaidTable rows={topUnpaidData} hasQbo={hasQbo} />
          )}
        </section>
      </div>
    </div>
  );
}
