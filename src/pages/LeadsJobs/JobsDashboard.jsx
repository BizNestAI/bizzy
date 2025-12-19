import React, { useEffect, useMemo, useState } from "react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { getJobsSummary, getJobsPipeline, getJobsTopUnpaid, getJobsActivity } from "../../services/jobs/jobs";
import KPIRow from "../../components/Jobs/KPIRow.jsx";
import Pipeline from "../../components/Jobs/Pipeline.jsx";
import TopUnpaidTable from "../../components/Jobs/TopUnpaidTable.jsx";
import NextActionsPanel from "../../components/Jobs/NextActionsPanel.jsx";
import SyncButton from "../../components/Integrations/SyncButton.jsx";
import { getDemoJobsSummary, getDemoJobsPipeline, getDemoJobsTopUnpaid } from "./jobsMockData.js";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";
import { useBusiness } from "../../context/BusinessContext.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";

const glass = "rounded-[28px] border border-white/12 bg-[rgba(12,14,18,0.82)] backdrop-blur-2xl shadow-[0_35px_70px_rgba(0,0,0,0.55)]";

export default function JobsDashboard() {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId") || "";
  if (!shouldUseDemoData(currentBusiness)) {
    return <LiveModePlaceholder title="Connect your job management tools to view pipeline data" />;
  }

  const [summary, setSummary] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [topUnpaid, setTopUnpaid] = useState([]);
  const [activity, setActivity] = useState([]);

  const integrationManager = useIntegrationManager({ businessId });
  const { getStatus, markStatus } = integrationManager;

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!businessId) return;
      const [s, p, u, a] = await Promise.allSettled([
        getJobsSummary(businessId),
        getJobsPipeline(businessId),
        getJobsTopUnpaid(businessId),
        getJobsActivity(businessId),
      ]);
      if (!alive) return;
      setSummary(s.value ?? null);
      setPipeline(p.value ?? null);
      setTopUnpaid(u.value ?? []);
      setActivity(a.value ?? []);
    }
    load();
    return () => { alive = false; };
  }, [businessId]);

  const hasSummaryData = useMemo(
    () =>
      summary &&
      [
        summary.leads_7d,
        summary.scheduled_next_14d,
        summary.win_rate_30d,
        summary.outstanding_ar,
      ].some((v) => v && Number(v) !== 0),
    [summary]
  );
  const hasPipelineData = useMemo(
    () =>
      pipeline &&
      ["scheduled", "in_progress", "completed"].some(
        (key) => Array.isArray(pipeline?.[key]) && pipeline[key].length > 0
      ),
    [pipeline]
  );
  const hasUnpaidData = useMemo(() => Array.isArray(topUnpaid) && topUnpaid.length > 0, [topUnpaid]);
  const usingDemo = shouldUseDemoData(currentBusiness || businessId);
  const usingMock = useMemo(
    () => usingDemo || !businessId || (!hasSummaryData && !hasPipelineData && !hasUnpaidData),
    [usingDemo, businessId, hasSummaryData, hasPipelineData, hasUnpaidData]
  );

  // If we fall back to sample data, clear any stale "connected" badges for ops providers
  useEffect(() => {
    if (!usingMock) return;
    ["jobber", "housecall"].forEach((provider) => {
      const status = getStatus(provider);
      if (status?.status === "connected") {
        markStatus(provider, "disconnected");
      }
    });
  }, [getStatus, markStatus, usingMock]);

  const summaryData = usingMock ? getDemoJobsSummary() : summary;
  const pipelineData = usingMock ? getDemoJobsPipeline() : pipeline;
  const topUnpaidData = usingMock ? getDemoJobsTopUnpaid() : topUnpaid;
  const hasQbo = useMemo(
    () => (summaryData?.outstanding_ar ?? null) !== null,
    [summaryData]
  );

  return (
    <div className="w-full px-4 pt-2 pb-4">
      <ModuleHeader
        module="jobs"
        subtitle="Manage your job flow from new leads to paid projects."
        right={<SyncButton label="Sync Jobs" providers={["jobber", "housecall"]} forceDisconnected={usingMock} />}
      />

      <div className="grid gap-4 mt-4">
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
          <KPIRow
            leads7={summaryData?.leads_7d ?? 0}
            scheduled14={summaryData?.scheduled_next_14d ?? 0}
            winRate30={summaryData?.win_rate_30d}
            outstandingAR={summaryData?.outstanding_ar}
          />
        </section>

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
            <Pipeline columns={pipelineData} />
          </div>

          <div className="space-y-4">
            <div className={`${glass} p-4 sm:p-5`}>
              <NextActionsPanel topUnpaid={topUnpaidData} pipeline={pipelineData} hasQbo={hasQbo} />
            </div>
          </div>
        </section>

        <section className={`${glass} p-4 sm:p-6`} aria-label="Payments">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Top unpaid jobs</h3>
              <p className="text-sm text-white/55">Proactively follow up on outstanding invoices.</p>
            </div>
            <button className="px-3 py-1.5 text-sm rounded-full border border-white/15 text-white/85 bg-white/[0.05] hover:bg-white/[0.12] transition shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
              Export list
            </button>
          </div>
          <TopUnpaidTable rows={topUnpaidData} />
        </section>
      </div>
    </div>
  );
}
