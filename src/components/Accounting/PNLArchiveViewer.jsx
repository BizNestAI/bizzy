import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "../../services/supabaseClient";
import { useUser } from "@supabase/auth-helpers-react";
import { Dialog, Listbox } from "@headlessui/react";
import { Download, FileText, Loader2 } from "lucide-react";
import { ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { motion } from "framer-motion";
import useCurrentBusiness from "../../hooks/useCurrentBusiness";
import AskBizzyInsightButton from "../Bizzy/AskBizzyInsightButton";
import { getMonthName } from "../../utils/dateUtils";
import { apiFetch, getApiBase } from "../../utils/apiBase.js";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

const SYNC_ENDPOINT = "/api/accounting/reports-sync";

const MONTHS = [
  "All Months",
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function PNLArchiveViewer() {
  const user = useUser();
  const { currentBusiness } = useCurrentBusiness();
  const usingDemo = shouldUseDemoData(currentBusiness);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filteredYear, setFilteredYear] = useState(null);
  const [filteredMonth, setFilteredMonth] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);
  const [pdfSource, setPdfSource] = useState("bizzi");
  const [loadingReportKey, setLoadingReportKey] = useState(null);

  const dynamicYears = useMemo(
    () => Array.from(new Set((reports || []).map((r) => r.year))).sort((a, b) => b - a),
    [reports]
  );
  const combinedYears = useMemo(() => {
    const now = new Date().getFullYear();
    const fixed = [now, now - 1];
    return Array.from(new Set([...fixed, ...dynamicYears])).sort((a, b) => b - a);
  }, [dynamicYears]);

  async function fetchReports() {
    if (!currentBusiness?.id) return;
    setLoading(true);
    let query = supabase
      .from("report_metadata")
      .select("*")
      .eq("business_id", currentBusiness.id)
      .order("year", { ascending: false })
      .order("month", { ascending: false });

    if (!usingDemo) {
      query = query.not("monthly_review_published_at", "is", null);
    }

    const { data, error } = await query;
    if (error) {
      console.error("[PNLArchiveViewer] fetch error:", error);
      setReports([]);
    } else {
      setReports(data || []);
    }
    setLoading(false);
  }

  async function maybeSeedMockOnce() {
    if (!usingDemo) return;
    if (!currentBusiness?.id) return;
    const key = `pnl_mock_seeded_${currentBusiness.id}`;
    const { data } = await supabase
      .from("report_metadata")
      .select("id", { count: "exact" })
      .eq("business_id", currentBusiness.id)
      .limit(1);
    const isEmpty = !data || data.length === 0;
    if (!isEmpty) {
      localStorage.setItem(key, "1");
      return;
    }
    try {
      await apiFetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user?.id || "demo-user",
          business_id: currentBusiness.id,
          window: 12,
          forceMock: true,
        }),
      });
      localStorage.setItem(key, "1");
      await fetchReports();
    } catch (e) {
      console.warn("[PNLArchiveViewer] mock seed failed:", e?.message || e);
    }
  }

  useEffect(() => {
    if (!currentBusiness?.id) return;
    (async () => {
      await fetchReports();
      await maybeSeedMockOnce();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBusiness?.id]);

  useEffect(() => {
    const cls = "pdf-modal-open";
    if (pdfUrl) {
      document.body.classList.add(cls);
    } else {
      document.body.classList.remove(cls);
    }
    return () => document.body.classList.remove(cls);
  }, [pdfUrl]);

  const filteredReports = useMemo(() => {
    return (reports || []).filter((r) => {
      const y = filteredYear ? Number(r.year) === Number(filteredYear) : true;
      const m = filteredMonth ? Number(r.month) === MONTHS.indexOf(filteredMonth) : true;
      return y && m;
    });
  }, [reports, filteredYear, filteredMonth]);

  function isCanonicalPnlKey(path) {
    if (!path || !currentBusiness?.id) return false;
    const bizId = currentBusiness.id;
    const escapedBiz = bizId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const stripped = String(path).replace(/^financial-reports\//, "");
    if (stripped.startsWith("backfill/")) return false;
    const exact = new RegExp(`^${escapedBiz}/\\d{4}-\\d{2}-pnl\\.pdf$`);
    return exact.test(stripped);
  }

  async function generatePdfOnDemand(report, { forceRefresh = false } = {}) {
    if (!currentBusiness?.id) return { error: "missing_business" };
    try {
      const payload = {
        user_id: user?.id || null,
        business_id: currentBusiness.id,
        year: report.year,
        month: report.month,
        forceRefresh,
        forceMock: usingDemo,
      };
      console.log("[PNLArchiveViewer] generatePdfOnDemand", payload, { apiBase: getApiBase() });
      const res = await apiFetch("/api/accounting/pnl/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const raw = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { /* ignore */ }
        console.error("[PNLArchiveViewer] generate PDF failed", res.status, res.url || "", raw);
        return { error: "backend_failed", status: res.status, raw, parsed };
      }
      const json = await res.json();
      console.log("[PNLArchiveViewer] generatePdfOnDemand response", { url: res.url, json });
      await fetchReports();
      return json;
    } catch (err) {
      console.error("[PNLArchiveViewer] generatePdfOnDemand error", err?.message || err);
      alert(err?.message || "Failed to generate PDF");
      return { error: err?.message || "Failed to generate PDF" };
    }
  }

  async function openPdf(report) {
    const reportKey = `${report.year}-${report.month}`;
    setLoadingReportKey(reportKey);
    console.log("[PNLArchiveViewer] openPdf start", {
      userId: user?.id,
      businessId: currentBusiness?.id,
      year: report.year,
      month: report.month,
      storage_path: report.storage_path,
    });

    const storagePath = report.storage_path ? String(report.storage_path).replace(/^financial-reports\//, "") : "";
    const isLegacy = storagePath.startsWith("backfill/");
    const trySign = isCanonicalPnlKey(storagePath) && !isLegacy;

    const shouldSkipSign = !usingDemo;

    try {
      let signedUrl = null;
      let source = "bizzi";

      if (trySign && storagePath && !shouldSkipSign) {
        try {
          const { data, error } = await supabase.storage
            .from("financial-reports")
            .createSignedUrl(storagePath, 60 * 5);
          if (!error && data?.signedUrl) {
            signedUrl = data.signedUrl;
          } else {
            const msg = error?.message || "";
            const isNotFound = msg.toLowerCase().includes("not found") || error?.statusCode === 400;
            if (!isNotFound) {
              console.warn("[PNLArchiveViewer] canonical path but sign failed; falling back to generate", { error, data });
            }
          }
        } catch (err) {
          console.warn("[PNLArchiveViewer] signed url attempt failed", err?.message || err);
        }
      }

      if (!signedUrl) {
        const generated = await generatePdfOnDemand(report, { forceRefresh: !usingDemo });
        if (generated?.signed_url) {
          signedUrl = generated.signed_url;
          await fetchReports(); // refresh storage_path to canonical
        } else {
          console.error("[PNLArchiveViewer] generatePdfOnDemand result", generated);
          const msgParts = [];
          if (generated?.error) msgParts.push(generated.error);
          if (generated?.status) msgParts.push(`status ${generated.status}`);
          if (generated?.raw) msgParts.push(generated.raw);
          const msg = msgParts.length ? msgParts.join(" | ") : "Unable to load PDF";
          alert(msg);
          return;
        }
      }

      setPdfUrl(signedUrl);
      setSelectedReport(report);
      setPdfSource(source);
    } finally {
      setLoadingReportKey(null);
    }
  }
  function closeModal() {
    setPdfUrl(null);
    setSelectedReport(null);
    setPdfSource("bizzi");
  }

  async function downloadPdf(report) {
    console.log("[PNLArchiveViewer] downloadPdf start", {
      userId: user?.id,
      businessId: currentBusiness?.id,
      year: report.year,
      month: report.month,
      storage_path: report.storage_path,
    });
    const generated = await generatePdfOnDemand(report, { forceRefresh: false });
    if (generated?.signed_url) {
      const a = document.createElement("a");
      a.href = generated.signed_url;
      a.download = `${report.year}-${String(report.month).padStart(2, "0")}-pnl.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] pt-0 pb-8">
      <div className="mb-8">
        <h1 className="text-[20px] sm:text-[22px] font-semibold tracking-[0.2em] text-white leading-tight">
          P&L Report Archive
        </h1>
        <p className="mt-3 text-sm text-white/70">
          Your Profit &amp; Loss reports, ready for download or quick review.
        </p>
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-5 mb-7 flex-wrap">
        <div className="flex flex-wrap gap-4 items-start">
          <div>
            <label className="text-xs font-medium text-white/62 mb-1 block">Year</label>
            <Listbox value={filteredYear} onChange={setFilteredYear}>
              <div className="relative w-36">
                <Listbox.Button className="bg-[#0f1115] text-sm text-white px-3 py-1 rounded-md border border-white/12 w-full min-h-[34px] flex justify-between items-center hover:border-[rgba(var(--accent-rgb),0.4)] focus:outline-none focus:ring-0 focus-visible:ring-0 transition shadow-[0_10px_24px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.045)]">
                  <span className="truncate">{filteredYear || "All Years"}</span>
                  <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-white/58" />
                </Listbox.Button>
                <Listbox.Options className="absolute mt-1 z-10 bg-[#0b0d11] text-white border border-white/10 rounded-lg w-full shadow-lg backdrop-blur focus:outline-none focus:ring-0 focus-visible:ring-0">
                  <Listbox.Option value={null} className="px-3 py-1.5 text-sm hover:bg-[rgba(var(--accent-rgb),0.12)] cursor-pointer">
                    All Years
                  </Listbox.Option>
                  {combinedYears.map((y) => (
                    <Listbox.Option key={y} value={y} className="px-3 py-1.5 text-sm hover:bg-[rgba(var(--accent-rgb),0.12)] cursor-pointer">
                      {y}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </div>
            </Listbox>
          </div>

          <div>
            <label className="text-xs font-medium text-white/62 mb-1 block">Month</label>
            <Listbox value={filteredMonth} onChange={setFilteredMonth}>
              <div className="relative w-40">
                <Listbox.Button className="bg-[#0f1115] text-sm text-white px-3 py-1 rounded-md border border-white/12 w-full min-h-[34px] flex justify-between items-center hover:border-[rgba(var(--accent-rgb),0.4)] focus:outline-none focus:ring-0 focus-visible:ring-0 transition shadow-[0_10px_24px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.045)]">
                  <span className="truncate">{filteredMonth || "All Months"}</span>
                  <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-white/58" />
                </Listbox.Button>
                <Listbox.Options className="absolute mt-1 z-10 bg-[#0b0d11] text-white border border-white/10 rounded-lg w-full shadow-lg backdrop-blur focus:outline-none focus:ring-0 focus-visible:ring-0">
                  <Listbox.Option value={null} className="px-3 py-1.5 text-sm hover:bg-[rgba(var(--accent-rgb),0.12)] cursor-pointer">
                    All Months
                  </Listbox.Option>
                  {MONTHS.slice(1).map((m) => (
                    <Listbox.Option key={m} value={m} className="px-3 py-1.5 text-sm hover:bg-[rgba(var(--accent-rgb),0.12)] cursor-pointer">
                      {m}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </div>
            </Listbox>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="mt-10 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-white/5 border border-white/10 rounded-2xl p-4 animate-pulse">
              <div className="h-4 w-40 bg-white/10 rounded mb-2" />
              <div className="h-3 w-3/5 bg-white/10 rounded" />
            </div>
          ))}
        </div>
      ) : filteredReports.length === 0 ? (
        <div className="mt-16 text-center text-gray-400 space-y-3">
          <p className="text-lg font-medium">No reports found.</p>
          <p className="text-sm text-gray-500">
            Final monthly Profit &amp; Loss reports appear here after Bizzi completes the monthly review.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredReports.map((report) => {
            const monthName = getMonthName(report.month);
            return (
              <motion.div
                key={`${report.year}-${report.month}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="relative flex min-h-[92px] rounded-3xl border border-white/10 bg-white/4 backdrop-blur-sm p-4 shadow-[0_18px_60px_rgba(0,0,0,0.35)]"
                style={{
                  boxShadow: "0 18px 60px rgba(0,0,0,0.35), 0 0 0 1px rgba(var(--accent-rgb),0.05)",
                }}
              >
                <div className="flex w-full items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold leading-tight text-white">
                      {monthName} {report.year}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <button
                      onClick={() => openPdf(report)}
                      disabled={loadingReportKey === `${report.year}-${report.month}`}
                      className="inline-flex h-9 w-[126px] items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 text-sm font-semibold text-white shadow-sm hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loadingReportKey === `${report.year}-${report.month}` ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <FileText size={14} />
                      )}
                      {loadingReportKey === `${report.year}-${report.month}` ? "Loading..." : "View PDF"}
                    </button>
                  </div>
                </div>
                {loadingReportKey === `${report.year}-${report.month}` && (
                  <div className="absolute inset-0 rounded-3xl bg-black/65 backdrop-blur-[2px] border border-white/10 flex flex-col items-center justify-center gap-2 text-white text-sm">
                    <Loader2 className="h-5 w-5 animate-spin text-emerald-300" />
                    <span className="text-white/80">Loading report…</span>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}

      <Dialog open={Boolean(pdfUrl)} onClose={closeModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="bg-zinc-900 rounded-lg border border-zinc-700 w-full max-w-4xl max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
              <Dialog.Title className="text-lg font-semibold text-white">
                {selectedReport ? `${getMonthName(selectedReport.month)} ${selectedReport.year}` : "Report"}
                <span className="ml-3 text-xs font-medium text-gray-400">
                  {pdfSource === "qbo" ? "QuickBooks P&L" : "Bizzi PDF"}
                </span>
              </Dialog.Title>
              <button onClick={closeModal} className="text-gray-400 hover:text-white">Close</button>
            </div>
            <div className="bg-black/60 h-[80vh]">
              {pdfUrl ? (
                <iframe
                  title="P&L PDF"
                  src={pdfUrl}
                  className="w-full h-full"
                  frameBorder="0"
                />
              ) : (
                <div className="p-6 text-gray-400">Loading PDF...</div>
              )}
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>
    </div>
  );
}
