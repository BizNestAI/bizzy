import React, { useState, useEffect, useMemo } from "react";
import { Dialog, Listbox } from "@headlessui/react";
import { FileText, Loader2 } from "lucide-react";
import { ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { motion as Motion } from "framer-motion";
import useCurrentBusiness from "../../hooks/useCurrentBusiness";
import AskBizzyInsightButton from "../Bizzy/AskBizzyInsightButton";
import { getMonthName } from "../../utils/dateUtils";
import { apiFetch } from "../../utils/apiBase.js";
import { useAdminView } from "../../context/AdminViewContext.jsx";

const MONTHS = [
  "All Months",
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatReportPublishedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function archiveReportStateLabel(status) {
  if (status === "published_current") return "Current published report";
  if (status === "published_outdated") return "Published report · newer source available";
  if (status === "published_legacy_unverified") return "Legacy report · freshness not yet verified";
  if (status === "superseded") return "Superseded published report";
  return "Published report";
}

export default function PNLArchiveViewer() {
  const { currentBusiness } = useCurrentBusiness();
  const adminView = useAdminView();
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
    try {
      const res = await apiFetch("/api/accounting/pnl/archive", {
        headers: { "x-business-id": currentBusiness.id },
        cache: "no-store",
      });
      if (!res.ok) {
        setReports([]);
        return;
      }
      const data = await res.json();
      setReports(Array.isArray(data?.reports) ? data.reports : []);
    } catch {
      setReports([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setReports([]);
    setPdfUrl(null);
    setSelectedReport(null);
    if (!currentBusiness?.id) {
      setLoading(false);
      return;
    }
    fetchReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminView.active, currentBusiness?.id]);

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

  async function getReportViewUrl(report) {
    if (!currentBusiness?.id || !report?.id) return null;
    const res = await apiFetch(`/api/accounting/pnl/archive/${encodeURIComponent(report.id)}/view`, {
      headers: { "x-business-id": currentBusiness.id },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const payload = await res.json();
    return payload?.signed_url || null;
  }

  async function openPdf(report) {
    const reportKey = `${report.year}-${report.month}`;
    setLoadingReportKey(reportKey);
    try {
      const signedUrl = await getReportViewUrl(report);
      if (!signedUrl) {
        alert("This archived report is unavailable.");
        return;
      }

      setPdfUrl(signedUrl);
      setSelectedReport(report);
      setPdfSource("bizzi");
    } finally {
      setLoadingReportKey(null);
    }
  }
  function closeModal() {
    setPdfUrl(null);
    setSelectedReport(null);
    setPdfSource("bizzi");
  }

  return (
    <div className="bizzy-page-width bizzy-page-width--workspace pt-0 pb-8">
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
              <Motion.div
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
                    <p className="mt-1 text-xs text-white/50">Cash basis</p>
                    {report.monthly_review_published_at ? (
                      <p className="mt-1 text-xs text-white/55">Published {formatReportPublishedAt(report.monthly_review_published_at)}</p>
                    ) : null}
                    <p className={`mt-1 text-[11px] font-medium ${report.report_state === "published_outdated" ? "text-amber-200/80" : "text-emerald-100/65"}`}>
                      {archiveReportStateLabel(report.report_state)}
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
              </Motion.div>
            );
          })}
        </div>
      )}

      <Dialog open={Boolean(pdfUrl)} onClose={closeModal} className="relative z-50">
        <div className="bizzy-modal-main-backdrop fixed inset-0" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4 md:left-[var(--nav-w,0px)]">
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
