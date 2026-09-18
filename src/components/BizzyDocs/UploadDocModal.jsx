// File: /src/components/BizzyDocs/UploadDocModal.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, UploadCloud, X } from "lucide-react";

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

function DarkSelect({ label, value, options, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative block">
      <div className="mb-1 text-xs text-white/60">{label}</div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#070A0D] px-3 py-2 text-left text-sm text-white/90 outline-none transition hover:border-[var(--accent)] focus:border-[var(--accent)] disabled:opacity-60"
      >
        <span className="truncate">{selected?.label || "Select"}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-white/45 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-[10001] overflow-hidden rounded-lg border border-[var(--accent)]/35 bg-[#0B0E13] p-1 shadow-2xl shadow-black/50">
          {options.map((option) => (
            <button
              key={option.value || "__empty"}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm text-white/85 transition hover:bg-white/10"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value ? <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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
  const closeTimerRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [documentType, setDocumentType] = useState("bank_statement");
  const [financialAccountId, setFinancialAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  const selectedType = useMemo(
    () => ACCOUNTING_DOCUMENT_TYPES.find((type) => type.key === documentType) || ACCOUNTING_DOCUMENT_TYPES[0],
    [documentType]
  );

  const documentTypeOptions = useMemo(
    () => ACCOUNTING_DOCUMENT_TYPES.map((type) => ({ value: type.key, label: type.label })),
    []
  );

  const financialAccountOptions = useMemo(
    () => [
      {
        value: "",
        label: selectedType.requiresAccount ? "Select account" : "No account",
      },
      ...accounts.map((account) => ({
        value: account.id || account.plaid_account_id,
        label: [
          account.name || account.official_name || "Financial account",
          account.mask ? `••••${account.mask}` : "",
        ].filter(Boolean).join(" "),
      })),
    ],
    [accounts, selectedType.requiresAccount]
  );

  useEffect(() => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    if (open) {
      setMounted(true);
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setVisible(false);
    closeTimerRef.current = window.setTimeout(() => setMounted(false), 180);
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, [open]);

  const requestClose = useCallback(() => {
    if (busy) return;
    setVisible(false);
    closeTimerRef.current = window.setTimeout(() => onClose?.(), 180);
  }, [busy, onClose]);

  const openFilePicker = useCallback(() => {
    if (!busy) inputRef.current?.click();
  }, [busy]);

  if (!mounted) return null;

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
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
      aria-modal="true"
      role="dialog"
    >
      <button
        type="button"
        aria-label="Close upload modal"
        className="absolute inset-0 bg-black/72 backdrop-blur-sm"
        onClick={requestClose}
        disabled={busy}
      />
      <div
        className={`relative max-h-[calc(100vh-2rem)] w-[92vw] max-w-xl overflow-visible rounded-2xl border border-white/10 bg-[#0B0E13] p-5 shadow-2xl shadow-black/50 transition duration-200 ease-out ${visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-3 scale-95 opacity-0"}`}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Upload accounting document</h3>
            <p className="mt-1 text-sm text-white/55">{monthName(month)} {year}</p>
          </div>
          <button type="button" onClick={requestClose} className="rounded p-1 hover:bg-white/10" disabled={busy}>
            <X className="h-5 w-5 text-white/70" />
          </button>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-200">{error}</div>
        ) : null}

        <form className="mt-4 space-y-4" onSubmit={submit}>
          <button
            type="button"
            onClick={openFilePicker}
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
            <DarkSelect
              label="Document type"
              value={documentType}
              options={documentTypeOptions}
              onChange={setDocumentType}
              disabled={busy}
            />

            <DarkSelect
              label="Financial account"
              value={financialAccountId}
              options={financialAccountOptions}
              onChange={setFinancialAccountId}
              disabled={busy}
            />
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
              onClick={requestClose}
              className="rounded-lg border border-white/10 px-3 py-2 text-white/80 transition hover:border-[var(--accent)] hover:text-white"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type={files.length ? "submit" : "button"}
              onClick={files.length ? undefined : openFilePicker}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--accent)]/50 px-3 py-2 text-[var(--accent)] transition hover:bg-[var(--accent)]/10 disabled:opacity-60"
              disabled={busy}
            >
              <UploadCloud className="h-4 w-4" />
              {files.length ? "Upload" : "Choose files"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
