// File: /src/components/BizzyDocs/UploadDocModal.jsx
import React, { useMemo, useRef, useState } from "react";
import { Loader2, UploadCloud, X } from "lucide-react";

import {
  validateAccountingDocumentFile,
} from "../../services/bizzyDocs/accountingDocuments";
import { uploadAccountingDocuments } from "../../services/bizzyDocs/docsService";

const ACCOUNTING_DOCUMENT_TYPES = [
  { key: "bank_statement", label: "Bank statement", requiresAccount: true },
  { key: "credit_card_statement", label: "Credit-card statement", requiresAccount: true },
  { key: "loan_statement", label: "Loan statement", requiresAccount: true },
  { key: "payroll_report", label: "Payroll report", requiresAccount: false },
  { key: "receipt_support", label: "Receipt or supporting document", requiresAccount: false },
  { key: "other_accounting_document", label: "Other accounting document", requiresAccount: false },
];

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.csv,.xls,.xlsx,application/pdf,image/png,image/jpeg,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function monthName(month) {
  const date = new Date(2026, Number(month || 1) - 1, 1);
  return new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
}

function fileSummary(files) {
  if (!files.length) return "Choose files";
  if (files.length === 1) return files[0].name;
  return `${files.length} files selected`;
}

export default function AccountingDocumentUploadModal({
  open,
  onClose,
  onCreated,
  businessId,
  year,
  month,
  accounts = [],
}) {
  const inputRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [documentType, setDocumentType] = useState("bank_statement");
  const [financialAccountId, setFinancialAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState("");

  const selectedType = useMemo(
    () => ACCOUNTING_DOCUMENT_TYPES.find((type) => type.key === documentType) || ACCOUNTING_DOCUMENT_TYPES[0],
    [documentType]
  );

  if (!open) return null;

  function chooseFiles(event) {
    const nextFiles = Array.from(event.target.files || []);
    const validationError = nextFiles.map(validateAccountingDocumentFile).find(Boolean);
    setError(validationError || "");
    setFiles(validationError ? [] : nextFiles);
  }

  async function submit(event) {
    event.preventDefault();
    if (!businessId) return setError("Missing business context.");
    if (!year || !month) return setError("Choose a month before uploading.");
    if (!files.length) return setError("Choose at least one file.");
    const validationError = files.map(validateAccountingDocumentFile).find(Boolean);
    if (validationError) return setError(validationError);

    setBusy(true);
    setError("");
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setProgressText(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
        await uploadAccountingDocuments({
          business_id: businessId,
          year,
          month,
          document_type: documentType,
          financial_account_id: selectedType.requiresAccount ? financialAccountId || null : financialAccountId || null,
          file,
        });
      }
      setBusy(false);
      setFiles([]);
      onCreated?.();
    } catch (err) {
      setBusy(false);
      setError(err?.message || "Upload failed.");
    }
  }

  return (
    <div className="bizzy-modal-main-backdrop fixed inset-0 z-[999] grid place-items-center">
      <div className="w-[92vw] max-w-xl rounded-2xl border border-white/10 bg-[#0B0E13] p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Upload accounting document</h3>
            <p className="mt-1 text-sm text-white/55">{monthName(month)} {year}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-white/10" disabled={busy}>
            <X className="h-5 w-5 text-white/70" />
          </button>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-200">{error}</div>
        ) : null}

        <form className="mt-4 space-y-4" onSubmit={submit}>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="w-full rounded-lg border border-white/10 bg-white/5 p-4 text-left transition hover:border-[var(--accent)] disabled:opacity-60"
          >
            <div className="text-sm font-semibold text-white/85">{fileSummary(files)}</div>
            <div className="mt-2 text-xs text-white/50">PDF, PNG, JPG, CSV, XLS, or XLSX. Up to 25 MB per file.</div>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            accept={ACCEPT}
            onChange={chooseFiles}
            disabled={busy}
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <div className="mb-1 text-xs text-white/60">Document type</div>
              <select
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/90 outline-none focus:border-[var(--accent)]"
                disabled={busy}
              >
                {ACCOUNTING_DOCUMENT_TYPES.map((type) => (
                  <option key={type.key} value={type.key} className="bg-[#101418] text-white">
                    {type.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <div className="mb-1 text-xs text-white/60">Financial account</div>
              <select
                value={financialAccountId}
                onChange={(event) => setFinancialAccountId(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/90 outline-none focus:border-[var(--accent)]"
                disabled={busy}
              >
                <option value="" className="bg-[#101418] text-white">
                  {selectedType.requiresAccount ? "Select account" : "No account"}
                </option>
                {accounts.map((account) => (
                  <option key={account.id || account.plaid_account_id} value={account.id || account.plaid_account_id} className="bg-[#101418] text-white">
                    {[account.name || account.official_name || "Financial account", account.mask ? `••••${account.mask}` : ""].filter(Boolean).join(" ")}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {busy ? (
            <div className="flex items-center gap-3 text-sm text-white/70">
              <Loader2 className="h-4 w-4 animate-spin" />
              {progressText || "Uploading..."}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 px-3 py-2 text-white/80 transition hover:border-[var(--accent)] hover:text-white"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--accent)]/50 px-3 py-2 text-[var(--accent)] transition hover:bg-[var(--accent)]/10 disabled:opacity-60"
              disabled={busy || !files.length}
            >
              <UploadCloud className="h-4 w-4" />
              Upload
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
