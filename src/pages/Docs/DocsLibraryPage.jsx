// File: /src/pages/Docs/DocsLibraryPage.jsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, Download, FileText, Folder, Loader2, Trash2, UploadCloud } from "lucide-react";

import AccountingDocumentUploadModal from "../../components/BizzyDocs/UploadDocModal";
import {
  ACCOUNTING_DOCUMENT_MONTHS as MONTHS,
  ACCOUNTING_DOCUMENT_START_YEAR as START_YEAR,
  buildAccountingMonthFolders,
  getAccountingDocumentYears,
} from "../../services/bizzyDocs/accountingDocuments";
import {
  deleteAccountingDocument,
  getAccountingDocumentDownloadUrl,
  listAccountingDocuments,
} from "../../services/bizzyDocs/docsService";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { useAdminView } from "../../context/AdminViewContext.jsx";
import { useCurrentBusiness } from "../../context/BusinessContext";

const DOC_TYPE_LABELS = {
  bank_statement: "Bank statement",
  credit_card_statement: "Credit-card statement",
  loan_statement: "Loan statement",
  payroll_report: "Payroll report",
  receipt_support: "Receipt or supporting document",
  other_accounting_document: "Other accounting document",
  legacy_upload: "Unfiled document",
};

function getStoredBusinessId() {
  try {
    return localStorage.getItem("currentBusinessId") || localStorage.getItem("business_id") || "";
  } catch {
    return "";
  }
}

function getStoredUserId() {
  try {
    return localStorage.getItem("user_id") || "";
  } catch {
    return "";
  }
}

function idHeaders(businessId) {
  return {
    "x-business-id": businessId || getStoredBusinessId(),
    "x-user-id": getStoredUserId(),
  };
}

function formatBytes(n) {
  if (!Number.isFinite(Number(n))) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, Number(n));
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 && index ? 1 : 0)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function normalizeDoc(row = {}) {
  const meta = row?.content?.accounting_document || {};
  return {
    ...row,
    year: Number(row.year || row.accounting_year || meta.year || new Date(row.created_at || Date.now()).getFullYear()),
    month: Number(row.month || row.accounting_month || meta.month || new Date(row.created_at || Date.now()).getMonth() + 1),
    document_type: row.document_type || meta.document_type || "legacy_upload",
    financial_account_id: row.financial_account_id || meta.financial_account_id || null,
    financial_account_name: row.financial_account_name || meta.financial_account_name || null,
    uploaded_by_label: row.uploaded_by_name || row.uploaded_by_label || row.author || "Bizzi user",
  };
}

export default function DocsLibraryPage(props) {
  const adminView = useAdminView();
  const readOnly = adminView.active && adminView.readOnly;
  const ctx = useCurrentBusiness() || {};
  const effectiveBusinessId = adminView.active
    ? adminView.businessId
    : props?.businessId || ctx?.businessId || getStoredBusinessId();

  const years = useMemo(() => getAccountingDocumentYears(), []);
  const [selectedYear, setSelectedYear] = useState(() => Math.max(START_YEAR, new Date().getFullYear()));
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [docs, setDocs] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [busyDocId, setBusyDocId] = useState("");

  const loadDocs = useCallback(async () => {
    if (!effectiveBusinessId) return;
    setLoading(true);
    setError("");
    try {
      const out = await listAccountingDocuments({ business_id: effectiveBusinessId, year: selectedYear });
      setDocs((out?.data || []).map(normalizeDoc));
    } catch (err) {
      setError(err?.message || "Failed to load accounting documents.");
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [effectiveBusinessId, selectedYear]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  useEffect(() => {
    let alive = true;
    async function loadAccounts() {
      if (!effectiveBusinessId) {
        setAccounts([]);
        return;
      }
      try {
        const res = await safeFetch(apiUrl(`/api/bookkeeping/accounts?business_id=${encodeURIComponent(effectiveBusinessId)}`), {
          headers: idHeaders(effectiveBusinessId),
          cache: "no-store",
        });
        if (!alive) return;
        setAccounts(Array.isArray(res?.accounts) ? res.accounts : []);
      } catch {
        if (alive) setAccounts([]);
      }
    }
    loadAccounts();
    return () => {
      alive = false;
    };
  }, [effectiveBusinessId]);

  const monthFolders = useMemo(() => buildAccountingMonthFolders(docs), [docs]);
  const currentMonthDocs = useMemo(() => {
    if (!selectedMonth) return [];
    return docs
      .filter((doc) => Number(doc.month) === Number(selectedMonth))
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }, [docs, selectedMonth]);

  const selectedMonthName = selectedMonth ? MONTHS[selectedMonth - 1] : "";

  async function openDocument(doc) {
    if (!doc?.id) return;
    setBusyDocId(doc.id);
    setError("");
    try {
      const out = await getAccountingDocumentDownloadUrl({ id: doc.id, business_id: effectiveBusinessId });
      if (!out?.signed_url) throw new Error("Download link could not be created.");
      window.open(out.signed_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err?.message || "Download failed.");
    } finally {
      setBusyDocId("");
    }
  }

  async function deleteDocument(doc) {
    if (!doc?.id) return;
    const ok = window.confirm(`Delete ${doc.original_filename || doc.filename || doc.title || "this document"}?`);
    if (!ok) return;
    setBusyDocId(doc.id);
    setError("");
    try {
      await deleteAccountingDocument({ id: doc.id, business_id: effectiveBusinessId });
      setNotice("Document deleted.");
      await loadDocs();
    } catch (err) {
      setError(err?.message || "Delete failed.");
    } finally {
      setBusyDocId("");
    }
  }

  const selectedAccountName = useCallback((doc) => {
    if (doc.financial_account_name) return doc.financial_account_name;
    const hit = accounts.find((account) => account.id === doc.financial_account_id || account.plaid_account_id === doc.financial_account_id);
    if (!hit) return "";
    return [hit.name, hit.mask ? `••••${hit.mask}` : ""].filter(Boolean).join(" ");
  }, [accounts]);

  return (
    <div className="w-full min-h-screen bg-app pb-28 pt-2 text-primary">
      <div className="bizzy-page-width bizzy-page-width--workspace">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-left text-[20px] font-semibold leading-tight tracking-[0.2em] text-[color:var(--text)] sm:text-[22px]">
              Accounting Documents
            </h1>
            <p className="mt-3 max-w-3xl text-left text-sm text-white/70">
              Upload monthly bank statements and supporting accounting documents so Bizzi can complete your bookkeeping and reconciliations.
            </p>
          </div>
          <label className="min-w-[160px]">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-white/45">Year</span>
            <select
              value={selectedYear}
              onChange={(event) => {
                setSelectedYear(Number(event.target.value));
                setSelectedMonth(null);
              }}
              className="w-full rounded-lg border border-white/10 bg-[#101418] px-3 py-2 text-sm text-white outline-none focus:border-[var(--accent)]"
            >
              {years.map((year) => (
                <option key={year} value={year} className="bg-[#101418] text-white">
                  {year}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!effectiveBusinessId ? (
          <div className="rounded-2xl border border-white/10 bg-[var(--panel)] p-5 text-sm text-white/65">
            No business selected. Choose a business to see its accounting documents.
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div>
        ) : null}
        {notice ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-[rgba(var(--accent-rgb),0.28)] bg-[rgba(var(--accent-rgb),0.10)] px-4 py-3 text-sm text-white/85">
            <span>{notice}</span>
            <button type="button" className="text-white/55 hover:text-white" onClick={() => setNotice("")}>Dismiss</button>
          </div>
        ) : null}

        {effectiveBusinessId && !selectedMonth ? (
          <div className="rounded-2xl border border-white/10 bg-[var(--panel)] p-4 shadow-bizzi sm:p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="text-sm text-white/55">{selectedYear} document folders</div>
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-white/45" /> : null}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {monthFolders.map((folder) => (
                <button
                  key={folder.month}
                  type="button"
                  onClick={() => setSelectedMonth(folder.month)}
                  className="group rounded-xl border border-white/10 bg-white/[0.025] p-4 text-left transition hover:border-[rgba(var(--accent-rgb),0.45)] hover:bg-[rgba(var(--accent-rgb),0.08)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-base font-semibold text-white">
                        <Folder className="h-4 w-4 text-[var(--accent)]" />
                        {folder.name}
                      </div>
                      <div className="mt-2 text-sm text-white/55">
                        {folder.count ? `${folder.count} ${folder.count === 1 ? "file" : "files"}` : "No documents"}
                      </div>
                    </div>
                    <span className="rounded-full border border-white/10 px-2 py-1 text-xs text-white/55">{folder.count}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {effectiveBusinessId && selectedMonth ? (
          <div className="rounded-2xl border border-white/10 bg-[var(--panel)] p-4 shadow-bizzi sm:p-5">
            <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <button
                  type="button"
                  onClick={() => setSelectedMonth(null)}
                  className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-[var(--accent)] hover:text-white"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Accounting Documents / {selectedYear}
                </button>
                <h2 className="text-2xl font-semibold text-white">{selectedMonthName} {selectedYear}</h2>
                <p className="mt-2 text-sm text-white/60">
                  Upload bank, credit-card, loan, and other accounting documents for {selectedMonthName} {selectedYear}.
                </p>
              </div>
              {!readOnly ? (
                <button
                  type="button"
                  onClick={() => setShowUpload(true)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-[rgba(var(--accent-rgb),0.42)] bg-[rgba(var(--accent-rgb),0.12)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[rgba(var(--accent-rgb),0.20)]"
                >
                  <UploadCloud className="h-4 w-4" />
                  Upload
                </button>
              ) : null}
            </div>

            {loading ? (
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading documents...
              </div>
            ) : currentMonthDocs.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-8 text-center">
                <FileText className="mx-auto h-8 w-8 text-white/35" />
                <div className="mt-3 font-semibold text-white">No documents</div>
                <div className="mt-1 text-sm text-white/55">Upload statements and supporting files for this month.</div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-white/10">
                {currentMonthDocs.map((doc) => {
                  const filename = doc.original_filename || doc.filename || doc.title || "Document";
                  const typeLabel = DOC_TYPE_LABELS[doc.document_type] || doc.document_type || "Accounting document";
                  const accountName = selectedAccountName(doc);
                  return (
                    <div key={doc.id} className="grid gap-3 border-b border-white/10 p-4 last:border-b-0 lg:grid-cols-[minmax(0,1.3fr)_180px_170px_150px_120px] lg:items-center">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-white">{filename}</div>
                        <div className="mt-1 text-xs text-white/45">Uploaded by {doc.uploaded_by_label}</div>
                      </div>
                      <div className="text-sm text-white/65">{typeLabel}</div>
                      <div className="truncate text-sm text-white/55">{accountName || "No account selected"}</div>
                      <div className="text-sm text-white/55">{formatBytes(doc.file_size || doc.size)}{doc.created_at ? ` • ${formatDate(doc.created_at)}` : ""}</div>
                      <div className="flex items-center gap-2 lg:justify-end">
                        <button
                          type="button"
                          onClick={() => openDocument(doc)}
                          disabled={busyDocId === doc.id}
                          className="rounded-lg border border-white/10 p-2 text-white/70 transition hover:border-[var(--accent)] hover:text-white disabled:opacity-50"
                          aria-label={`Open ${filename}`}
                        >
                          <Download className="h-4 w-4" />
                        </button>
                        {!readOnly ? (
                          <button
                            type="button"
                            onClick={() => deleteDocument(doc)}
                            disabled={busyDocId === doc.id}
                            className="rounded-lg border border-white/10 p-2 text-white/55 transition hover:border-rose-400/50 hover:text-rose-200 disabled:opacity-50"
                            aria-label={`Delete ${filename}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <AccountingDocumentUploadModal
        open={showUpload}
        onClose={() => setShowUpload(false)}
        businessId={effectiveBusinessId}
        year={selectedYear}
        month={selectedMonth}
        accounts={accounts}
        onCreated={async () => {
          setShowUpload(false);
          setNotice("Document uploaded.");
          await loadDocs();
        }}
      />
    </div>
  );
}
