import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "../../services/supabaseClient";
import { useUser } from "@supabase/auth-helpers-react";
import { Dialog, Listbox } from "@headlessui/react";
import { Download, FileText } from "lucide-react";
import { ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { motion } from "framer-motion";
import useCurrentBusiness from "../../hooks/useCurrentBusiness";
import AskBizzyInsightButton from "../Bizzy/AskBizzyInsightButton";
import { getMonthName } from "../../utils/dateUtils";

const SYNC_ENDPOINT = "/api/accounting/reports-sync"; // backend wrapper that calls pullPnlPdfsForYear

const MONTHS = [
  "All Months",
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export default function PNLArchiveViewer() {
  const user = useUser();
  const { currentBusiness } = useCurrentBusiness();

  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filteredYear, setFilteredYear] = useState(null);
  const [filteredMonth, setFilteredMonth] = useState(null);

  const [pdfUrl, setPdfUrl] = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);

  // List of years (merge dynamic + current/prior)
  const dynamicYears = useMemo(
    () => Array.from(new Set((reports || []).map((r) => r.year))).sort((a, b) => b - a),
    [reports]
  );
  const combinedYears = useMemo(() => {
    const now = new Date().getFullYear();
    const fixed = [now, now - 1];
    return Array.from(new Set([...fixed, ...dynamicYears])).sort((a, b) => b - a);
  }, [dynamicYears]);

  // fetch reports
  async function fetchReports() {
    if (!currentBusiness?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("report_metadata")
      .select("*")
      .eq("business_id", currentBusiness.id)
      .order("year", { ascending: false })
      .order("month", { ascending: false });
    if (error) {
      console.error("[PNLArchiveViewer] fetch error:", error);
      setReports([]);
    } else {
      setReports(data || []);
    }
    setLoading(false);
  }

  // auto-seed mock ONCE if empty (dev/demo only)
  async function maybeSeedMockOnce() {
    if (!user?.id || !currentBusiness?.id) return;
    const key = `pnl_mock_seeded_${currentBusiness.id}`;
    if (localStorage.getItem(key)) return;        // already seeded once

    // only seed if truly empty
    const { data } = await supabase
      .from("report_metadata")
      .select("id", { count: "exact" })
      .eq("business_id", currentBusiness.id)
      .limit(1);
    const isEmpty = !data || data.length === 0;
    if (!isEmpty) return;

    try {
      await fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user.id,
          business_id: currentBusiness.id,
          window: 12,
          forceMock: true, // <- backend will upload mock PDFs + metadata
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
      // silently seed mock reports if none exist (only once per business)
      await maybeSeedMockOnce();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBusiness?.id]);

  // filtered list
  const filteredReports = useMemo(() => {
    return (reports || []).filter((r) => {
      const y = filteredYear ? Number(r.year) === Number(filteredYear) : true;
      const m = filteredMonth ? Number(r.month) === MONTHS.indexOf(filteredMonth) : true;
      return y && m;
    });
  }, [reports, filteredYear, filteredMonth]);

  // signed URL view
  async function openPdf(report) {
    const { data, error } = await supabase.storage
      .from("financial-reports")
      .createSignedUrl(report.storage_path, 60 * 5);
    if (error) {
      console.error("[PNLArchiveViewer] signed url error:", error);
      return;
    }
    setPdfUrl(data.signedUrl);
    setSelectedReport(report);
  }
  function closeModal() {
    setPdfUrl(null);
    setSelectedReport(null);
  }

  // signed URL download
  async function downloadPdf(report) {
    const { data, error } = await supabase.storage
      .from("financial-reports")
      .createSignedUrl(report.storage_path, 60 * 2, { download: true });
    if (error) {
      console.error("[PNLArchiveViewer] download url error:", error);
      return;
    }
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = `${report.year}-${String(report.month).padStart(2, "0")}-pnl.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="p-4 md:p-8">
      <h1 className="text-2xl font-semibold mb-1 text-neon-green">P&L Report Archive</h1>
      <p className="text-sm text-gray-400 mb-6">
        Every month, your Profit &amp; Loss reports are archived here—ready for tax season, strategic reviews, and Bizzy insights.
      </p>

      {/* Filters (no sync buttons here) */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-6 flex-wrap">
        <div className="flex flex-wrap gap-6 items-start">
          {/* Year */}
          <div>
            <label className="text-sm font-medium text-gray-400 mb-1 block">Year:</label>
            <Listbox value={filteredYear} onChange={setFilteredYear}>
              <div className="relative w-40">
                <Listbox.Button className="bg-zinc-900 text-white px-4 py-2 rounded border border-zinc-700 w-full flex justify-between items-center hover:border-neon-green focus:outline-none">
                  <span>{filteredYear || "All Years"}</span>
                  <ChevronUpDownIcon className="h-5 w-5 text-gray-400" />
                </Listbox.Button>
                <Listbox.Options className="absolute mt-1 z-10 bg-zinc-800 text-white border border-zinc-700 rounded-md w-full shadow-md">
                  <Listbox.Option value={null} className="px-4 py-2 hover:bg-neon-green hover:text-black cursor-pointer">
                    All Years
                  </Listbox.Option>
                  {combinedYears.map((y) => (
                    <Listbox.Option key={y} value={y} className="px-4 py-2 hover:bg-neon-green hover:text-black cursor-pointer">
                      {y}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </div>
            </Listbox>
          </div>

          {/* Month */}
          <div>
            <label className="text-sm font-medium text-gray-400 mb-1 block">Month:</label>
            <Listbox value={filteredMonth} onChange={setFilteredMonth}>
              <div className="relative w-44">
                <Listbox.Button className="bg-zinc-900 text-white px-4 py-2 rounded border border-zinc-700 w-full flex justify-between items-center hover:border-neon-green focus:outline-none">
                  <span>{filteredMonth || "All Months"}</span>
                  <ChevronUpDownIcon className="h-5 w-5 text-gray-400" />
                </Listbox.Button>
                <Listbox.Options className="absolute mt-1 z-10 bg-zinc-800 text-white border border-zinc-700 rounded-md w-full shadow-md">
                  <Listbox.Option value={null} className="px-4 py-2 hover:bg-neon-green hover:text-black cursor-pointer">
                    All Months
                  </Listbox.Option>
                  {MONTHS.slice(1).map((m) => (
                    <Listbox.Option key={m} value={m} className="px-4 py-2 hover:bg-neon-green hover:text-black cursor-pointer">
                      {m}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </div>
            </Listbox>
          </div>
        </div>
      </div>

      {/* List / empty state */}
      {loading ? (
        <div className="mt-10 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 animate-pulse">
              <div className="h-4 w-40 bg-white/10 rounded mb-2" />
              <div className="h-3 w-3/5 bg-white/10 rounded" />
            </div>
          ))}
        </div>
      ) : filteredReports.length === 0 ? (
        <div className="mt-16 text-center text-gray-400 space-y-3">
          <p className="text-lg font-medium">No reports found.</p>
          <p className="text-sm text-gray-500">
            Once synced in Settings, your Profit &amp; Loss PDFs will appear here with summaries and GPT analysis.
          </p>
        </div>
      ) : (
        <>
          <h2 className="text-lg font-medium text-white mt-8 mb-2 border-b border-zinc-700 pb-1">
            Synced Reports
          </h2>

          <div className="space-y-4">
            {filteredReports.map((report) => {
              const monthName = getMonthName(report.month);
              const customPrompt = `Review the Profit & Loss report for ${monthName} ${report.year}. Revenue was $${report.revenue?.toLocaleString() || "N/A"} and Net Profit was $${report.net_profit?.toLocaleString() || "N/A"}. Are there any strategic insights or areas of concern?`;

              return (
                <motion.div
                  key={`${report.year}-${report.month}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-lg font-semibold text-white">
                      {monthName} {report.year}
                    </p>
                    <p className="text-sm text-gray-400">
                      Revenue: ${report.revenue?.toLocaleString() || "N/A"} | Net Profit: ${report.net_profit?.toLocaleString() || "N/A"}
                    </p>
                    <p className="text-xs text-gray-500 italic">
                      Includes Forecast: {report.includes_forecast ? "Yes" : "No"}
                    </p>
                  </div>

                  <div className="flex items-center flex-wrap gap-3">
                    <button
                      onClick={() => openPdf(report)}
                      className="bg-neon-green hover:bg-green-400 text-black font-semibold py-1 px-3 rounded-md flex items-center gap-1"
                    >
                      <FileText size={16} /> View PDF
                    </button>

                    <button
                      onClick={() => downloadPdf(report)}
                      className="bg-zinc-800 hover:bg-zinc-700 text-white px-2 py-1 rounded-md flex items-center gap-1"
                    >
                      <Download size={16} /> Export
                    </button>

                    <AskBizzyInsightButton
                      buttonText="Ask Bizzi"
                      customPrompt={customPrompt}
                      iconSize={16}
                      additionalContext={{
                        year: report.year,
                        month: report.month,
                        revenue: report.revenue,
                        net_profit: report.net_profit,
                        includes_forecast: report.includes_forecast,
                        storage_path: report.storage_path,
                      }}
                    />
                  </div>
                </motion.div>
              );
            })}
          </div>
        </>
      )}

      {/* PDF Modal */}
      <Dialog open={!!pdfUrl} onClose={closeModal} className="relative z-50">
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4">
          <Dialog.Panel
            as={motion.div}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2 }}
            className="bg-white w-full max-w-3xl h-[90vh] rounded-lg shadow-xl overflow-hidden relative"
          >
            <div className="absolute top-2 right-2">
              <button onClick={closeModal} className="text-black text-sm px-2 py-1 hover:bg-gray-200 rounded">
                Close
              </button>
            </div>
            <iframe src={pdfUrl || ""} className="w-full h-full" title="P&L PDF" />
          </Dialog.Panel>
        </div>
      </Dialog>
    </div>
  );
}
