import React from "react";
import ReactDOM from "react-dom";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, CheckCircle2, ChevronDown, Loader2, Plus, RotateCcw, UploadCloud } from "lucide-react";
import CreateQuickBooksAccountModal from "./CreateQuickBooksAccountModal.jsx";
import SplitTransactionModal, { buildInitialSplitTransactionDraft, buildInitialLoanSplitDraft } from "./SplitTransactionModal.jsx";
import {
  deriveCreditCardPaymentOrientation,
  deriveResolutionAwareCreditCardPaymentStatus,
  isQboBankAccount,
  isQboCreditCardAccount,
} from "../../services/bookkeeping/creditCardPaymentStatus.js";
import { formatQboPostingSchedule } from "../../services/bookkeeping/qboPostingLifecycle.js";
import { detectProcessorSettlementActivity } from "../../services/bookkeeping/processorSettlementProfiles.js";
import { formatNumericCalendarDate } from "../../utils/dateUtils.js";
import { effectiveTransactionResolution, suggestedTransactionResolution } from "../../services/bookkeeping/transactionResolutionService.js";

const ENABLE_QBO_ADD_STUB = false;
const ROW_HOVER_BG = "#1A1D1C";
const DIVIDER_COLOR = "rgba(255,255,255,0.06)";
const BASE_COL_WIDTHS = [36, 90, 220, 160, 245, 105, 150];
const BASE_MIN_COL_WIDTHS = [36, 90, 190, 160, 245, 105, 150];
const QBO_COL_WIDTH = 120;
const QBO_MIN_COL_WIDTH = 105;

const QBO_SCHEDULE_TONE_CLASSES = {
  good: "border-emerald-400/25 bg-emerald-500/10 text-emerald-100",
  danger: "border-rose-400/30 bg-rose-500/10 text-rose-100",
  warning: "border-amber-300/30 bg-amber-400/10 text-amber-100",
  neutral: "border-slate-500/35 bg-white/[0.04] text-slate-200",
};

function dropdownBucketType(value = "") {
  const normalized = String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized === "income" || normalized === "otherincome") return "income";
  if (normalized === "expense" || normalized === "costofgoodssold" || normalized === "cogs") return "expense";
  if (normalized === "equity") return "equity";
  return "other";
}

function isEditableKeyboardTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [data-qbo-account-modal="true"]'
    )
  );
}

export function CoaDropdown({
  value,
  suggestedId,
  suggestedName,
  accounts,
  onChange,
  onCreateAccount,
  onCreatedAccountSelect,
  accountTypes,
  creationContext,
  status,
  disabled,
  resolution,
  onResolutionChange,
}) {
  const [open, setOpen] = React.useState(false);
  const [renderMenu, setRenderMenu] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const ref = React.useRef(null);
  const buttonRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const [menuPos, setMenuPos] = React.useState(null);
  const [search, setSearch] = React.useState("");

  React.useEffect(() => {
    function onClick(e) {
      if (!ref.current) return;
      const target = e.target;
      if (ref.current.contains(target)) return;
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const sections = React.useMemo(() => {
    const term = (search || "").toLowerCase().trim();
    const filtered = term
      ? accounts.filter(
          (a) =>
            a.name?.toLowerCase().includes(term) ||
            a.shortName?.toLowerCase().includes(term) ||
            a.fullyQualifiedName?.toLowerCase().includes(term) ||
            a.parentRef?.name?.toLowerCase().includes(term) ||
            a.searchText?.includes(term) ||
            a.type?.toLowerCase().includes(term)
        )
      : accounts;
    const buckets = {
      income: [],
      expense: [],
      equity: [],
      other: [],
    };
    filtered.forEach((a) => {
      buckets[dropdownBucketType(a.type)].push(a);
    });
    return [
      { label: "Revenue", items: buckets.income },
      { label: "Expenses", items: buckets.expense },
      { label: "Equity", items: buckets.equity },
      { label: "Other", items: buckets.other },
    ].filter((s) => s.items.length);
  }, [accounts, search]);

  const displayValue = value || suggestedId || "";
  const currentAccount = accounts.find((a) => a.id === displayValue);
  const currentLabel =
    currentAccount?.name ||
    (displayValue && displayValue === suggestedId ? suggestedName : null) ||
    suggestedName ||
    displayValue ||
    "Select account";
  const isSuggested = suggestedId && (!value || value === suggestedId) && ["needs_review", "uncategorized"].includes(status);

  const syncMenuPosition = React.useCallback(() => {
    const btn = ref.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const padding = 12;
    let maxHeight = viewportHeight - rect.bottom - padding;
    if (maxHeight < 220) {
      maxHeight = Math.max(220, viewportHeight - padding * 2);
      maxHeight = Math.min(maxHeight, 420);
    }
    const top = Math.min(rect.bottom + padding + window.scrollY, window.scrollY + viewportHeight - maxHeight - padding);
    setMenuPos({
      top,
      left: rect.left + window.scrollX,
      width: Math.max(rect.width, 260),
      maxHeight,
    });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    syncMenuPosition();
    const onScroll = () => syncMenuPosition();
    const onResize = () => syncMenuPosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, syncMenuPosition]);

  React.useEffect(() => {
    if (open) {
      setRenderMenu(true);
      return undefined;
    }
    const to = setTimeout(() => setRenderMenu(false), 160);
    return () => clearTimeout(to);
  }, [open]);

  return (
    <div className="relative w-full z-[60]" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={(e) => {
          if (disabled) return;
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`w-full rounded-lg border border-[var(--accent-line)] bg-[var(--panel)] px-3 py-1.5 pr-9 text-[11px] font-medium text-slate-50 shadow-[0_6px_18px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.03)] outline-none transition text-left ${
          disabled ? "opacity-70 cursor-not-allowed" : "focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-500/30"
        }`}
      >
        <div className="flex items-center gap-2">
          {isSuggested ? (
            <span
              className="inline-block h-[7px] w-[7px] rounded-full bg-emerald-400 flex-shrink-0"
              aria-hidden="true"
            />
          ) : null}
          <span className="truncate">{currentLabel}</span>
        </div>
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-slate-400 text-xs">▾</span>
      </button>
      {renderMenu && menuPos
        ? ReactDOM.createPortal(
            <div
              ref={menuRef}
              className="fixed z-[9999] overflow-hidden rounded-2xl border border-[var(--accent-line)] bg-[rgba(15,17,20,0.98)] shadow-[0_22px_48px_rgba(0,0,0,0.75)] backdrop-blur"
              style={{
                top: menuPos.top,
                left: menuPos.left,
                minWidth: menuPos.width,
                maxHeight: menuPos.maxHeight || 360,
                opacity: open ? 1 : 0,
                transform: open ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.99)",
                transition: "opacity 200ms cubic-bezier(0.16,0.84,0.44,1), transform 200ms cubic-bezier(0.16,0.84,0.44,1)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="overflow-y-auto overscroll-contain scrollbar-thin scrollbar-thumb-[rgba(255,255,255,0.12)] scrollbar-track-transparent"
                style={{ maxHeight: "inherit", scrollbarColor: "rgba(255,255,255,0.12) transparent" }}
              >
                {onResolutionChange ? (
                  <div className="border-b border-emerald-400/20 bg-emerald-950/15 py-1">
                    {RESOLUTION_OPTIONS.filter(([id]) => id !== "categorize_new").map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className={`flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-[12px] font-medium transition focus:outline-none focus-visible:bg-emerald-400/12 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-300/60 ${
                          resolution === id ? "bg-emerald-400/10 text-emerald-200" : "text-slate-100 hover:bg-emerald-400/[0.07]"
                        }`}
                        onClick={() => {
                          setOpen(false);
                          onResolutionChange(id);
                        }}
                      >
                        <span>{id === "match_existing_qbo" ? "Match existing QuickBooks transaction" : label}</span>
                        {resolution === id ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden="true" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {onCreateAccount ? (
                  <button
                    type="button"
                    className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-emerald-400/25 bg-[rgba(13,24,21,0.98)] px-3.5 py-2 text-left text-[12px] font-semibold text-emerald-200 shadow-[0_8px_14px_rgba(0,0,0,0.25)] hover:bg-emerald-400/10"
                    onClick={() => {
                      setOpen(false);
                      setCreateOpen(true);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add new account
                  </button>
                ) : null}
                <div className="px-3.5 py-2 border-b border-[var(--accent-line)]/60 bg-white/5">
                  <input
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search accounts..."
                    className="w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-[12px] text-white placeholder:text-white/50 outline-none focus:border-emerald-400/60"
                  />
                </div>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between px-3.5 py-2 text-left text-[12px] font-medium transition ${
                    !value ? "text-emerald-300 bg-white/5" : "text-slate-100 hover:bg-white/5"
                  }`}
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  Select account
                  {!value ? <span className="text-emerald-300">✓</span> : null}
                </button>
                {sections.map((section) => (
                  <div key={section.label} className="border-t border-[var(--accent-line)]/60">
                    <div className="px-3.5 py-1 text-[10px] uppercase tracking-wide text-white/50">{section.label}</div>
                    {section.items.map((acct) => {
                      const active = acct.id === value;
                      return (
                        <button
                          key={acct.id}
                          type="button"
                          className={`flex w-full items-center justify-between px-3.5 py-2 text-left text-[12px] transition ${
                            active ? "text-emerald-300 bg-white/5" : "text-slate-100 hover:bg-white/5"
                          }`}
                          onClick={() => {
                            onChange(acct.id);
                            onResolutionChange?.("categorize_new");
                            setOpen(false);
                          }}
                        >
                          <span className="truncate flex flex-col leading-tight">
                            <span className="truncate">{acct.fullyQualifiedName || acct.name}</span>
                            {acct.type ? (
                              <span className="text-[10px] text-white/50 capitalize">{acct.type}</span>
                            ) : null}
                          </span>
                          {active ? <span className="text-emerald-300">✓</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>,
            document.body
          )
        : null}
      <CreateQuickBooksAccountModal
        open={createOpen}
        onCreate={onCreateAccount}
        accountTypes={accountTypes}
        context={creationContext}
        returnFocusRef={buttonRef}
        onClose={(createdAccount) => {
          setCreateOpen(false);
          if (createdAccount?.id) {
            onCreatedAccountSelect ? onCreatedAccountSelect(createdAccount) : onChange(createdAccount.id);
          }
        }}
      />
    </div>
  );
}

export function CreditCardPaymentMatchControl({
  value = "",
  accounts = [],
  accountsLoaded = true,
  loadingAccounts = false,
  accountsError = "",
  statusLabel = "Credit Card Payment · Needs Match",
  targetLabel = "Match payment to",
  placeholder = "Match payment to...",
  matched = false,
  transferLabel = "",
  matchedLabel = "",
  error = "",
  loading = false,
  discovering = false,
  matching = false,
  candidate = null,
  disabled = false,
  onChange,
  onConfirm,
  onUseCoa,
  onRetryAccounts,
}) {
  const [open, setOpen] = React.useState(false);
  const [menuPos, setMenuPos] = React.useState(null);
  const ref = React.useRef(null);
  const menuRef = React.useRef(null);
  const currentAccount = accounts.find((acct) => String(acct.id) === String(value));
  const buttonLabel = matched
    ? statusLabel
    : currentAccount?.name || placeholder;
  const busy = discovering || matching || loading;
  const candidateAmount = Number(candidate?.amount_minor_units ?? 0) / 100;
  const candidateAmountLabel = candidate
    ? `${candidateAmount >= 0 ? "+" : "-"}$${Math.abs(candidateAmount).toFixed(2)}`
    : "";
  const candidateSummary = candidate
    ? [
        candidate.date,
        candidate.description,
        candidate.qbo_account_name,
        candidateAmountLabel,
      ].filter(Boolean).join(" · ")
    : "";

  const syncMenuPosition = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const padding = 10;
    const maxHeight = Math.min(280, Math.max(180, viewportHeight - rect.bottom - padding));
    setMenuPos({
      top: Math.min(rect.bottom + 6 + window.scrollY, window.scrollY + viewportHeight - maxHeight - padding),
      left: rect.left + window.scrollX,
      width: Math.max(rect.width, 250),
      maxHeight,
    });
  }, []);

  React.useEffect(() => {
    function onDocumentClick(e) {
      if (ref.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    syncMenuPosition();
    const onScroll = () => syncMenuPosition();
    const onResize = () => syncMenuPosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, syncMenuPosition]);

  return (
    <div className="w-full min-w-0" ref={ref} aria-busy={busy ? "true" : undefined}>
      <div className={`min-w-0 rounded-lg border px-2 py-1 shadow-[0_8px_22px_rgba(0,0,0,0.22)] ${
        matched
          ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
          : "border-cyan-300/25 bg-[#101614] text-cyan-100"
      }`}>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[10px] font-semibold leading-tight">{statusLabel}</span>
        </div>
        {!matched ? <div className="mt-0.5 truncate text-[9px] font-medium text-white/52">{targetLabel}</div> : null}
        {transferLabel ? <div className="mt-0.5 truncate text-[9px] text-white/58">{transferLabel}</div> : null}
        {matchedLabel ? <div className="mt-0.5 truncate text-[9px] text-white/50">{matchedLabel}</div> : null}
        {!matched ? (
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              disabled={disabled || matching}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((next) => {
                  const openNext = !next;
                  if (openNext) requestAnimationFrame(syncMenuPosition);
                  return openNext;
                });
              }}
              className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-[var(--accent-line)] bg-[var(--panel)] px-2 text-left text-[10px] font-medium text-white outline-none transition hover:border-emerald-300/35 focus:border-emerald-300/60 focus:ring-2 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="truncate">{buttonLabel}</span>
              <span className="shrink-0 text-white/45">▾</span>
            </button>
            {onConfirm ? (
              <button
                type="button"
                disabled={!currentAccount || discovering || busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onConfirm();
                }}
                className="inline-flex h-7 min-w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-md border border-emerald-300/35 bg-emerald-500/12 px-2 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {matching || loading ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Matching…
                  </>
                ) : "Confirm"}
              </button>
            ) : null}
          </div>
        ) : null}
        {discovering ? (
          <div className="mt-1 flex items-center gap-1.5 text-[9px] font-medium text-cyan-100/75" role="status" aria-live="polite">
            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Finding payment…
          </div>
        ) : null}
        {!discovering && candidateSummary ? (
          <div className="mt-1 whitespace-normal text-[9px] font-medium leading-snug text-cyan-100/70" role="status" aria-live="polite">
            Matched to {candidateSummary}
          </div>
        ) : null}
        {error ? <div className="mt-1 whitespace-normal text-[9px] text-amber-100/80">{error}</div> : null}
      </div>
      {open && !matched && menuPos
        ? ReactDOM.createPortal(
            <div
              ref={menuRef}
              className="fixed z-[10000] overflow-hidden rounded-xl border border-[var(--accent-line)] bg-[rgba(15,17,20,0.98)] shadow-[0_22px_48px_rgba(0,0,0,0.72)] backdrop-blur"
              style={{
                top: menuPos.top,
                left: menuPos.left,
                minWidth: menuPos.width,
                maxHeight: menuPos.maxHeight,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="max-h-[inherit] overflow-y-auto overscroll-contain py-1" style={{ scrollbarColor: "rgba(255,255,255,0.14) transparent" }}>
                {accounts.length ? accounts.map((acct) => {
                  const active = String(acct.id) === String(value);
                  return (
                    <button
                      key={acct.id}
                      type="button"
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] transition ${
                        active ? "bg-emerald-400/10 text-emerald-200" : "text-slate-100 hover:bg-white/[0.06]"
                      }`}
                      onClick={() => {
                        onChange?.(acct.id);
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{acct.name}</span>
                        <span className="block text-[10px] text-white/40">{isQboCreditCardAccount(acct) ? "Credit card" : isQboBankAccount(acct) ? "Bank account" : "Payment account"}</span>
                      </span>
                      {active ? <span className="text-emerald-300">✓</span> : null}
                    </button>
                  );
                }) : loadingAccounts ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-white/60">
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Loading credit-card accounts…
                  </div>
                ) : accountsError ? (
                  <div className="px-3 py-2">
                    <div className="text-[12px] text-amber-100/85">Couldn’t load credit-card accounts</div>
                    {onRetryAccounts ? (
                      <button
                        type="button"
                        className="mt-1 text-[11px] font-semibold text-cyan-100 hover:text-cyan-50"
                        onClick={() => onRetryAccounts()}
                      >
                        Try again
                      </button>
                    ) : null}
                  </div>
                ) : accountsLoaded ? (
                  <div className="px-3 py-2 text-[12px] text-white/48">
                    No eligible mapped payment accounts. Finish account mapping in Connected Accounts.
                  </div>
                ) : (
                  <div className="px-3 py-2 text-[12px] text-white/48">Loading credit-card accounts…</div>
                )}
                {onUseCoa ? (
                  <button
                    type="button"
                    className="mt-1 flex w-full items-center gap-2 border-t border-white/10 px-3 py-2 text-left text-[12px] font-semibold text-cyan-100 hover:bg-cyan-400/10"
                    onClick={() => {
                      setOpen(false);
                      onUseCoa();
                    }}
                  >
                    Not a credit card payment
                  </button>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function getTransactionMemo(txn = {}) {
  return (
    txn.description ||
    txn.full_description ||
    txn.fullDescription ||
    txn.original_description ||
    txn.originalDescription ||
    txn.name ||
    txn.merchant_name ||
    txn.merchantName ||
    ""
  );
}

function formatCcPairDate(value) {
  if (!value) return "";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSignedAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const sign = amount < 0 ? "-" : "+";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function formatMinorMoney(minor, currency = "USD") {
  const numeric = Number(minor);
  if (!Number.isFinite(numeric)) return "";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(numeric / 100);
}

function humanizeReason(code = "") {
  if (/^PGRST\d+$/i.test(String(code || ""))) return null;
  const labels = {
    exact_amount_cents: "Exact amount",
    compatible_positive_deposit_direction: "Incoming bank deposit",
    verified_same_bank_account: "Verified bank account",
    plaid_qbo_account_mapping_unverified: "Bank account could not be fully verified",
    plaid_qbo_account_mapping_missing: "Bank account could not be fully verified",
    qbo_deposit_affects_mapped_bank_account: "QBO deposit affects this bank account",
    qbo_payment_deposited_directly_to_mapped_bank_account: "QBO payment deposited to this bank account",
    qbo_sales_receipt_deposited_directly_to_mapped_bank_account: "QBO sales receipt deposited to this bank account",
    payment_linked_to_invoice: "Payment linked to invoice",
    deposit_payment_chain_reaches_invoice: "Deposit links through payment to invoice",
    unique_unmatched_qbo_bank_affecting_candidate: "Only one eligible QBO candidate",
    human_confirmation_required_for_launch: "Human confirmation required",
    strong_qbo_bank_affecting_candidate: "Strong QBO candidate",
    multiple_or_unproven_qbo_candidates: "Multiple or unverified candidates",
    ordinary_income_posting_blocked: "Posting blocked",
    qbo_match_cache_stale: "QBO cache is stale",
    qbo_match_cache_unavailable: "QBO cache unavailable",
    qbo_match_cache_never_synced: "QBO cache has not synced",
    quickbooks_match_check_temporarily_unavailable: "Temporary QuickBooks match check issue",
    incoming_deposit_match_schema_unavailable: "QuickBooks match check temporarily unavailable",
    qbo_match_evidence_columns_unavailable: "QuickBooks evidence check unavailable",
    invoice_only_duplicate_income_evidence: "Invoice-only duplicate evidence",
    invoice_only_payment_verification_needed: "Payment verification needed",
    incoming_deposit_match_rejected_review_required: "Rejected candidate needs review",
    confirmable_existing_qbo_match: "Ready for confirmation",
    ambiguous_match_requires_review: "Multiple candidates need review",
    fresh_match_check_required: "Fresh match check required",
    stale_match_refresh_required: "Fresh match check required",
    primary_match_item_missing: "Match details need refresh",
  };
  return labels[code] || String(code || "").replace(/_/g, " ");
}

function isTruthy(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function independentCandidateCount(candidates = []) {
  return (candidates || []).filter((candidate) => candidate?.candidate_role !== "supporting").length;
}

export function incomingDepositMatchState(txn = {}) {
  const meta = txn.meta || {};
  const processorActivity = detectProcessorSettlementActivity(txn);
  const processorFee = txn.processor_fee || meta.processor_fee || null;
  const isProbableProcessorFee = processorFee?.isProbable === true || processorActivity?.kind === "fee";
  const status = txn.incoming_deposit_match_status || meta.incoming_deposit_match_status || null;
  const blockReason = meta.post_block_reason || txn.post_error || null;
  const confirmableValue = txn.incoming_deposit_confirmable ?? meta.incoming_deposit_confirmable;
  const active =
    txn.status === "matched_existing_qbo" ||
    txn.matched_existing_qbo === true ||
    ["needs_confirmation", "ambiguous", "match_check_unavailable", "confirmed"].includes(String(status || "")) ||
    ["possible_existing_qbo_match", "incoming_deposit_needs_match", "match_check_unavailable", "incoming_deposit_bank_account_mapping_unverified", "incoming_deposit_match_rejected_review_required"].includes(String(blockReason || ""));
  if (!active && !isProbableProcessorFee) return { active: false };
  const candidates = txn.incoming_deposit_candidates || meta.incoming_deposit_candidates || [];
  const primary = candidates[0] || null;
  const hasQboCandidate = Boolean(primary?.qbo_entity_type && primary?.qbo_entity_id);
  const confirmed = txn.status === "matched_existing_qbo" || txn.matched_existing_qbo === true || status === "confirmed";
  const unavailable = status === "match_check_unavailable" || blockReason === "match_check_unavailable";
  const explicitIndependentCount = Number(txn.incoming_deposit_independent_candidate_count ?? meta.incoming_deposit_independent_candidate_count);
  const rootCount = Number.isFinite(explicitIndependentCount) ? explicitIndependentCount : independentCandidateCount(candidates);
  const needsFreshCheck = blockReason === "incoming_deposit_needs_match" && (status === "unchecked" || status === "superseded" || !primary);
  const ambiguous = status === "ambiguous" || (blockReason === "incoming_deposit_needs_match" && rootCount > 1);
  const invoiceOnly = candidates.length > 0 && candidates.every((candidate) => candidate.match_type === "qbo_invoice_only_context" || candidate.qbo_entity_type === "Invoice");
  return {
    active: true,
    isProcessorFee: isProbableProcessorFee,
    processor: processorFee?.processor || processorActivity?.profile?.name || null,
    processorMatchState: confirmed
      ? "matched_existing_qbo"
      : unavailable
        ? "qbo_match_check_unavailable"
        : status === "ambiguous"
          ? "multiple_qbo_matches"
          : hasQboCandidate
            ? "qbo_match_found"
            : processorFee?.matchState || (isProbableProcessorFee ? "checking_for_qbo_match" : null),
    canCreateNewFee: !hasQboCandidate && processorFee?.canCreateNewFee === true && meta.processor_fee_new_fee_authorized === true,
    confirmed,
    unavailable,
    ambiguous,
    needsFreshCheck,
    confirmable: isTruthy(confirmableValue) || (status === "needs_confirmation" && Boolean(primary) && Boolean(txn.incoming_deposit_match_id || meta.incoming_deposit_match_id)),
    confirmabilityReason: txn.incoming_deposit_confirmability_reason || meta.incoming_deposit_confirmability_reason || null,
    independentCandidateCount: rootCount,
    invoiceOnly,
    status,
    matchId: txn.incoming_deposit_match_id || meta.incoming_deposit_match_id || null,
    tier: txn.incoming_deposit_confidence_tier || meta.incoming_deposit_confidence_tier || null,
    reasons: txn.incoming_deposit_reason_codes || meta.incoming_deposit_reason_codes || [],
    candidates,
    primary,
  };
}

export function IncomingDepositMatchPanel({
  txn,
  state,
  action = {},
  readOnly = false,
  onInspect,
  onConfirm,
  onReject,
  onUndo,
  onRecordNewFee,
  onRecordNewIncome,
  accounts = [],
  resolutionOverride = null,
}) {
  const selectableCandidates = (state?.candidates || []).filter((candidate) => candidate?.candidate_role !== "supporting" && candidate?.qbo_entity_type !== "Invoice");
  const [selectedCandidateKeys, setSelectedCandidateKeys] = React.useState(() => new Set());
  const savedResolution = txn.meta?.incoming_deposit_resolution || {};
  const universalResolution = resolutionOverride || txn.meta?.user_selected_resolution;
  const [resolution, setResolution] = React.useState(universalResolution === "categorize_new" ? "create_new_income" : (savedResolution.resolution || "match_existing"));
  const [incomeAccountId, setIncomeAccountId] = React.useState(savedResolution.selected_qbo_income_account_id || txn.glAccountId || txn.suggestedAccountId || "");
  const [duplicateOverrideConfirmed, setDuplicateOverrideConfirmed] = React.useState(savedResolution.duplicate_check_override === true);
  React.useEffect(() => setSelectedCandidateKeys(new Set()), [state?.matchId]);
  React.useEffect(() => {
    setResolution((resolutionOverride || txn.meta?.user_selected_resolution) === "categorize_new" ? "create_new_income" : (savedResolution.resolution || "match_existing"));
    setIncomeAccountId(savedResolution.selected_qbo_income_account_id || txn.glAccountId || txn.suggestedAccountId || "");
    setDuplicateOverrideConfirmed(savedResolution.duplicate_check_override === true);
  }, [txn.id, resolutionOverride]); // immutable transaction identity owns resolution state
  if (!state?.active) return null;
  const primary = state.primary || {};
  const displayPrimary = action.refreshedCandidate ? { ...primary, ...action.refreshedCandidate } : primary;
  const isProcessorFee = state.isProcessorFee || primary.match_type === "qbo_processing_fee_expense";
  const incomeAccounts = accounts.filter((account) => ["income", "otherincome"].includes(String(account.type || account.account_type || "").replace(/[\s_-]+/g, "").toLowerCase()));
  const creatingNewIncome = !isProcessorFee && resolution === "create_new_income";
  const processorState = state.processorMatchState;
  const transitionSuccess = action.status === "success";
  const transitionMatching = action.status === "matching" || action.loading === true;
  const heading = state.confirmed || transitionSuccess
    ? "Matched to existing QuickBooks"
    : action.reason === "qbo_match_details_changed"
      ? "Match details changed"
    : action.reason === "qbo_entity_already_matched"
      ? "Already matched"
    : ["qbo_match_candidate_missing", "qbo_match_candidate_invalid_status"].includes(action.reason)
      ? "Match no longer available"
    : action.error
      ? "Match needs to be refreshed"
      : processorState === "posted_duplicate_review_required"
        ? "Duplicate review required"
      : state.unavailable || processorState === "qbo_match_check_unavailable"
      ? "QuickBooks match check temporarily unavailable"
      : processorState === "checking_for_qbo_match" || transitionMatching
        ? "Checking QuickBooks for an existing processing fee…"
      : processorState === "no_existing_qbo_match" && state.canCreateNewFee
        ? "No existing QuickBooks fee found"
      : processorState === "no_existing_qbo_match"
        ? "QuickBooks fee check complete"
      : state.invoiceOnly
        ? "Possible duplicate income - payment verification needed"
      : state.needsFreshCheck
        ? "Needs match"
      : state.ambiguous
        ? "Needs match"
        : isProcessorFee ? "Existing QuickBooks fee found" : "Possible QBO match";
  const description = state.confirmed || transitionSuccess
    ? transitionSuccess ? "Match confirmed. No new QuickBooks transaction was created." : "Confirmed against existing QuickBooks activity. Bizzi did not create a new QuickBooks transaction."
    : action.error
      ? action.error
    : processorState === "posted_duplicate_review_required"
      ? "Bizzi already has a QuickBooks posting receipt for this fee. It cannot be rematched automatically; review it through the correction workflow."
    : state.unavailable || processorState === "qbo_match_check_unavailable"
      ? `Bizzi couldn't safely check whether this ${isProcessorFee ? "fee" : "deposit"} is already recorded in QuickBooks. It has not been posted.`
      : processorState === "checking_for_qbo_match" || transitionMatching
        ? "The ordinary approval action is blocked until this check completes."
      : processorState === "no_existing_qbo_match" && state.canCreateNewFee
        ? "A fresh, complete QuickBooks check found no matching fee. Recording this fee will create a new QuickBooks expense using the selected processing-fee account."
      : processorState === "no_existing_qbo_match"
        ? "A fresh, complete QuickBooks check found no existing fee. This transaction can continue through the ordinary guarded approval workflow."
      : state.invoiceOnly
        ? "Bizzi found QuickBooks invoice activity that may already explain this deposit, but the payment or bank deposit chain still needs verification."
      : state.needsFreshCheck
        ? "This deposit needs a fresh QuickBooks match check before it can be posted as income."
      : state.ambiguous
        ? "Bizzi found more than one independent QuickBooks transaction that may explain this deposit."
        : isProcessorFee
          ? "Bizzi found an existing QuickBooks processing-fee expense that may explain this bank charge."
          : "Bizzi found an existing QuickBooks deposit or payment that may already explain this bank deposit.";
  const candidateCount = state.independentCandidateCount ?? independentCandidateCount(state.candidates || []);
  const selectedCandidates = selectableCandidates.filter((candidate) => selectedCandidateKeys.has(`${candidate.qbo_entity_type}:${candidate.qbo_entity_id}`));
  const selectedTotalMinor = selectedCandidates.reduce((sum, candidate) => sum + Math.abs(Number(candidate.amount_minor || 0)), 0);
  const bankAmountMinor = Math.round(Math.abs(Number(txn.amount || 0)) * 100);
  const selectionDifferenceMinor = bankAmountMinor - selectedTotalMinor;
  const canConfirmSelected = state.confirmable || (state.ambiguous && selectedCandidates.length > 0 && selectionDifferenceMinor === 0);
  const matchNoLongerConfirmable = ["qbo_entity_already_matched", "qbo_match_candidate_missing", "qbo_match_candidate_invalid_status"].includes(action.reason);
  const primaryActionLabel = isProcessorFee ? "Confirm match" : primary.qbo_entity_type === "Deposit" ? "Match existing QuickBooks deposit" : "Match existing payment";
  const refreshable = ["primary_match_item_missing", "fresh_match_check_required", "stale_match_refresh_required"].includes(String(state.confirmabilityReason || action.reason || ""));
  const bankEvidence = primary.bank_account_match === "verified_same_account" ? "Verified bank account" : "Bank account could not be fully verified";
  const customerName = primary.customer_ref?.name || primary.customer_ref?.Name || null;
  const invoiceRefs = Array.isArray(primary.invoice_refs) ? primary.invoice_refs : [];
  const invoiceText = invoiceRefs.length
    ? invoiceRefs
        .map((invoice) => invoice.document_number ? `#${invoice.document_number}` : invoice.qbo_entity_id || null)
        .filter(Boolean)
        .join(", ")
    : Array.isArray(primary.invoice_ids) && primary.invoice_ids.length ? primary.invoice_ids.join(", ") : null;
  const panelTone = state.confirmed || transitionSuccess
    ? "border-emerald-300/25 bg-emerald-500/8 text-emerald-50"
    : "border-amber-300/25 bg-amber-400/8 text-amber-50";
  const headingTone = state.confirmed || transitionSuccess ? "text-emerald-100" : "text-amber-100";
  const copyTone = state.confirmed || transitionSuccess ? "text-emerald-50/78" : "text-amber-50/78";
  const tierTone = state.confirmed || transitionSuccess ? "border-emerald-200/30 text-emerald-100" : "border-amber-200/30 text-amber-100";
  return (
    <div className={`mt-3 rounded-lg border p-3 text-left text-[11px] ${panelTone}`} aria-busy={transitionMatching ? "true" : "false"}>
      <span className="sr-only" aria-live="polite">{transitionMatching ? "Matching this bank deposit to the existing QuickBooks deposit." : transitionSuccess ? "Match confirmed." : ""}</span>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`flex items-center gap-1.5 text-[12px] font-semibold ${headingTone}`}>
            {transitionSuccess ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-200 motion-safe:animate-pulse" aria-hidden="true" /> : null}
            <span>{transitionSuccess ? "Match confirmed" : heading}</span>
          </div>
          <div className={`mt-1 max-w-2xl text-[11px] leading-5 ${copyTone}`}>{description}</div>
        </div>
        {transitionSuccess ? <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tierTone}`}>MATCHED</span> : state.tier ? <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tierTone}`}>{state.tier.replace("_", " ").toUpperCase()}</span> : null}
      </div>
      {displayPrimary.qbo_entity_type ? (
        <div className="mt-3 grid gap-2 text-[11px] text-slate-100 sm:grid-cols-3">
          <div><span className="text-slate-400">Bank amount</span><br />{formatMinorMoney(Math.round(Math.abs(Number(txn.amount || 0)) * 100), primary.currency || "USD") || "Not available"}</div>
          <div><span className="text-slate-400">Bank date</span><br />{formatNumericCalendarDate(txn.date, { fallback: "Not available" })}</div>
          <div><span className="text-slate-400">Bank description</span><br />{txn.description || txn.payee || txn.vendor || "Not available"}</div>
          <div><span className="text-slate-400">QBO {displayPrimary.qbo_entity_type}</span><br />{formatMinorMoney(displayPrimary.amount_minor, displayPrimary.currency || "USD") || "Not available"}</div>
          {displayPrimary.txn_date ? <div><span className="text-slate-400">QBO date</span><br />{formatNumericCalendarDate(displayPrimary.txn_date)}</div> : null}
          {primary.account_names?.length ? <div><span className="text-slate-400">QBO account</span><br />{primary.account_names.join(", ")}</div> : null}
          {primary.description ? <div><span className="text-slate-400">QBO description</span><br />{primary.description}</div> : null}
          {invoiceText ? <div><span className="text-slate-400">Invoice</span><br />{invoiceText}</div> : null}
          {customerName ? <div><span className="text-slate-400">Customer</span><br />{customerName}</div> : null}
          {state.confirmed ? <div><span className="text-slate-400">Matched by</span><br />you</div> : null}
        </div>
      ) : null}
      {!isProcessorFee && !state.confirmed && !transitionSuccess && !universalResolution ? (
        <div className="mt-3 rounded-lg border border-white/10 bg-black/10 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">Resolution</div>
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Income resolution">
            <button type="button" role="radio" aria-checked={resolution === "match_existing"} onClick={() => { setResolution("match_existing"); setSelectedCandidateKeys(new Set()); }} className={`rounded-md border px-2.5 py-1 text-[10px] font-semibold ${resolution === "match_existing" ? "border-emerald-300/40 bg-emerald-500/12 text-emerald-100" : "border-white/15 text-slate-200"}`}>Match existing QuickBooks transaction</button>
            <button type="button" role="radio" aria-checked={creatingNewIncome} onClick={() => { setResolution("create_new_income"); setSelectedCandidateKeys(new Set()); }} className={`rounded-md border px-2.5 py-1 text-[10px] font-semibold ${creatingNewIncome ? "border-emerald-300/40 bg-emerald-500/12 text-emerald-100" : "border-white/15 text-slate-200"}`}>Record as new income</button>
          </div>
          {creatingNewIncome ? (
            <div className="mt-3 space-y-3">
              <p className="text-[11px] leading-5 text-slate-200">Bizzi will create a new QuickBooks deposit using the connected bank account and the income account below. It will not create an invoice or invoice payment.</p>
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-300">Income account</label>
              <CoaDropdown value={incomeAccountId} suggestedId={txn.glAccountId || txn.suggestedAccountId} suggestedName={txn.glAccountName || txn.suggestedAccountName} accounts={incomeAccounts} onChange={setIncomeAccountId} status={txn.status} disabled={readOnly || transitionMatching} />
              {state.unavailable ? (
                <label className="flex items-start gap-2 text-[11px] text-amber-50/85">
                  <input type="checkbox" checked={duplicateOverrideConfirmed} onChange={(event) => setDuplicateOverrideConfirmed(event.target.checked)} className="mt-0.5" />
                  <span>I confirmed this income is not already recorded in QuickBooks.</span>
                </label>
              ) : null}
              <button type="button" disabled={readOnly || transitionMatching || !incomeAccountId || (state.unavailable && !duplicateOverrideConfirmed)} onClick={() => onRecordNewIncome?.(txn.id, { selectedQboAccountId: incomeAccountId, duplicateOverrideConfirmed })} className="rounded-md border border-emerald-300/40 bg-emerald-500/12 px-3 py-1.5 text-[10px] font-semibold text-emerald-100 disabled:opacity-45">{transitionMatching ? "Posting…" : "Post as new income"}</button>
            </div>
          ) : null}
        </div>
      ) : null}
      {processorState === "no_existing_qbo_match" && state.canCreateNewFee ? (
        <div className="mt-3 text-[11px] text-slate-100">
          <span className="text-slate-400">New fee account</span><br />
          {txn.glAccountName || txn.suggestedAccountName || "Payment Processing Fees"}
        </div>
      ) : null}
      {state.reasons?.length || primary.bank_account_match ? (
        <details className="mt-3 rounded-md border border-white/10 bg-black/10 px-2.5 py-2">
          <summary className="cursor-pointer text-[10px] font-semibold text-slate-200">Why this matched</summary>
          <div className="mt-2 text-[10px] text-slate-300">{bankEvidence}{state.tier ? ` · ${state.tier.replaceAll("_", " ")}` : ""}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
          {state.reasons.slice(0, 6).map((reason) => {
            const label = humanizeReason(reason);
            return label ? <span key={reason} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-200">{label}</span> : null;
          })}
          </div>
        </details>
      ) : null}
      {state.ambiguous && selectableCandidates.length > 1 ? (
        <fieldset className="mt-3 rounded-md border border-white/10 bg-black/10 p-2.5">
          <legend className="px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-100">Select one or more QuickBooks transactions</legend>
          <div className="space-y-1.5">{selectableCandidates.map((candidate) => {
            const key = `${candidate.qbo_entity_type}:${candidate.qbo_entity_id}`;
            return <label key={key} className="flex items-start gap-2 rounded-md border border-white/10 px-2 py-1.5 text-[10px] text-slate-100"><input type="checkbox" checked={selectedCandidateKeys.has(key)} onChange={() => setSelectedCandidateKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} /><span>{candidate.qbo_entity_type} · {candidate.txn_date || "date unavailable"} · {formatMinorMoney(candidate.amount_minor, candidate.currency || "USD") || "amount unavailable"} · {candidate.description || candidate.qbo_entity_id}</span></label>;
          })}</div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-slate-200"><div><span className="text-slate-400">Bank amount</span><br />{formatMinorMoney(bankAmountMinor)}</div><div><span className="text-slate-400">Selected total</span><br />{formatMinorMoney(selectedTotalMinor)}</div><div><span className="text-slate-400">Difference</span><br />{formatMinorMoney(selectionDifferenceMinor)}</div></div>
        </fieldset>
      ) : null}
      {!creatingNewIncome ? <div className="mt-3 flex flex-wrap gap-2">
        {transitionSuccess ? (
          <>
            <span className="rounded-md border border-emerald-300/35 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-100">Matched to existing QuickBooks</span>
            <span className="rounded-md border border-white/10 px-2.5 py-1 text-[10px] font-semibold text-slate-200">View in Matched</span>
          </>
        ) : state.confirmed ? (
          <>
            <span className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold text-slate-100">View match details</span>
            <button type="button" disabled={readOnly || action.loading || !state.matchId} onClick={() => onUndo?.(txn.id, state.matchId, txn)} className="rounded-md border border-amber-200/35 px-2.5 py-1 text-[10px] font-semibold text-amber-100 disabled:opacity-45">Undo match</button>
          </>
        ) : state.unavailable || processorState === "qbo_match_check_unavailable" || processorState === "checking_for_qbo_match" ? (
          <button type="button" disabled={readOnly || transitionMatching} onClick={() => onInspect?.(txn.id, null, txn)} className="inline-flex items-center gap-1.5 rounded-md border border-amber-200/35 px-2.5 py-1 text-[10px] font-semibold text-amber-100 disabled:opacity-45">{transitionMatching ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}{transitionMatching ? "Refreshing QuickBooks…" : "Try again"}</button>
        ) : processorState === "no_existing_qbo_match" && state.canCreateNewFee ? (
          <button type="button" disabled={readOnly || transitionMatching} onClick={() => onRecordNewFee?.(txn.id, txn.glAccountId || txn.suggestedAccountId || null)} className="rounded-md border border-emerald-300/40 bg-emerald-500/12 px-2.5 py-1 text-[10px] font-semibold text-emerald-100 disabled:opacity-45">Record New Fee</button>
        ) : processorState === "posted_duplicate_review_required" ? (
          <span className="rounded-md border border-rose-300/30 bg-rose-500/10 px-2.5 py-1 text-[10px] font-semibold text-rose-100">Posting receipt protected</span>
        ) : (
          <>
            {state.matchId && primary.qbo_entity_type && !state.invoiceOnly && canConfirmSelected && !matchNoLongerConfirmable ? (
              <button type="button" disabled={readOnly || transitionMatching} onClick={() => onConfirm?.(txn.id, state.matchId, txn, { qboEntities: selectedCandidates.map((candidate) => ({ qboEntityId: candidate.qbo_entity_id, qboEntityType: candidate.qbo_entity_type })) })} className="inline-flex min-w-[190px] items-center justify-center gap-1.5 rounded-md border border-emerald-300/40 bg-emerald-500/12 px-2.5 py-1 text-[10px] font-semibold text-emerald-100 disabled:opacity-45">
                {transitionMatching ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                {transitionMatching ? "Confirming…" : action.reason === "qbo_match_details_changed" ? "Confirm updated match" : primaryActionLabel}
              </button>
            ) : state.matchId && primary.qbo_entity_type && !state.invoiceOnly ? (
              <button type="button" disabled={readOnly || transitionMatching} onClick={() => onInspect?.(txn.id, null, txn)} className="inline-flex min-w-[116px] items-center justify-center gap-1.5 rounded-md border border-amber-200/35 px-2.5 py-1 text-[10px] font-semibold text-amber-100 disabled:opacity-45">
                {transitionMatching ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                {transitionMatching ? "Refreshing..." : refreshable ? "Refresh match" : "Retry match check"}
              </button>
            ) : null}
            {state.matchId ? (
              <button type="button" disabled={readOnly || transitionMatching} onClick={() => onReject?.(txn.id, state.matchId, txn)} className="rounded-md border border-white/15 px-2.5 py-1 text-[10px] font-semibold text-slate-100 disabled:opacity-45">Reject match</button>
            ) : null}
            {candidateCount > 1 && !state.ambiguous ? <span className="rounded-md border border-white/10 px-2.5 py-1 text-[10px] font-semibold text-slate-300">Review other matches</span> : null}
          </>
        )}
      </div> : null}
    </div>
  );
}

function ConfidenceBadge({ level }) {
  const styles = {
    high: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
    medium: "bg-amber-500/20 text-amber-200 border border-amber-400/40",
    low: "bg-rose-500/20 text-rose-200 border border-rose-400/40",
  };
  const label = level === "high" ? "High" : level === "medium" ? "Medium" : "Low";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${styles[level] || styles.low}`}>{label}</span>;
}

const RESOLUTION_OPTIONS = [
  ["categorize_new", "Categorize as new"],
  ["match_existing_qbo", "Match existing QuickBooks transaction"],
  ["match_credit_card_payment", "Match as credit card payment"],
  ["split_transaction", "Split transaction"],
];

export function TransactionResolutionSelector({ transactionId, value, suggested, disabled = false, busy = false, error = "", onChange }) {
  const labelId = `resolution-label-${transactionId}`;
  const selected = RESOLUTION_OPTIONS.find(([id]) => id === value) || RESOLUTION_OPTIONS[0];
  return (
    <div className="rounded-lg border border-white/10 bg-black/15 p-3" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={labelId} className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">Resolution</span>
        {suggested && suggested !== value ? <span className="text-[9px] text-slate-400">Bizzi suggested: {RESOLUTION_OPTIONS.find(([id]) => id === suggested)?.[1]}</span> : null}
      </div>
      <Listbox value={value} onChange={(next) => onChange?.(next)} disabled={disabled}>
        <div className="relative mt-2">
          <ListboxButton aria-labelledby={labelId} className="flex w-full items-center justify-between gap-3 rounded-lg border border-emerald-400/25 bg-[#101312] px-3 py-2 text-left text-[11px] font-medium text-slate-100 shadow-[0_8px_20px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.035)] outline-none transition hover:border-emerald-300/40 focus-visible:border-emerald-300/65 focus-visible:ring-2 focus-visible:ring-emerald-400/30 disabled:cursor-not-allowed disabled:opacity-50">
            <span className="truncate">{selected[1]}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          </ListboxButton>
          <ListboxOptions anchor={{ to: "bottom", gap: 6, padding: 12 }} portal transition className="z-[10030] w-[var(--button-width)] overflow-hidden rounded-xl border border-emerald-400/25 bg-[rgba(13,16,18,0.985)] p-1.5 text-white shadow-[0_22px_52px_rgba(0,0,0,0.72)] backdrop-blur-md outline-none transition duration-150 ease-out data-[closed]:translate-y-[-5px] data-[closed]:opacity-0">
            {RESOLUTION_OPTIONS.map(([id, label]) => (
              <ListboxOption key={id} value={id} className="group flex cursor-default select-none items-center justify-between gap-3 rounded-lg px-3 py-2 text-[11px] font-medium text-slate-100 outline-none data-[focus]:bg-emerald-400/10 data-[focus]:text-emerald-100 data-[selected]:text-emerald-200">
                <span>{label}</span>
                <Check className="invisible h-3.5 w-3.5 shrink-0 text-emerald-300 group-data-[selected]:visible" aria-hidden="true" />
              </ListboxOption>
            ))}
          </ListboxOptions>
        </div>
      </Listbox>
      {busy ? <div role="status" className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Saving choice…</div> : null}
      {error ? <div role="alert" className="mt-2 flex items-center justify-between gap-2 rounded-md border border-rose-300/25 bg-rose-500/10 px-2 py-1.5 text-[10px] text-rose-100"><span>{error}</span><button type="button" onClick={() => onChange?.(value)} className="shrink-0 rounded border border-rose-200/25 px-2 py-1 font-semibold hover:bg-rose-200/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-200/60">Retry</button></div> : null}
    </div>
  );
}

export default function BookkeepingFeed({
  transactions,
  selectedIds,
  allSelected,
  toggleSelectAll,
  toggleRow,
  onApprove,
  onUndo,
  onManualPost,
  onRejectCcPayment,
  onMarkCcPayment,
  onConfirmCcPaymentMatch,
  onConfirmLoanPaymentSplit,
  onConfirmSplitTransaction,
  onTreatLoanPaymentAsRegular,
  onInspectIncomingDepositMatch,
  onConfirmIncomingDepositMatch,
  onRejectIncomingDepositMatch,
  onUndoIncomingDepositMatch,
  onRecordIncomingDepositAsNewIncome,
  onResolutionChange,
  incomingDepositMatchActionState = {},
  ccPaymentActionState = {},
  ccPaymentAccounts = [],
  ccPaymentAccountsLoaded = true,
  loadingCcPaymentAccounts = false,
  ccPaymentAccountsError = "",
  onRetryCcPaymentAccounts,
  postingTransactionIds,
  accounts = [],
  onAccountChange,
  onCreatedAccountSelect,
  onCreateAccount,
  accountTypes,
  panelBg,
  panelBorder,
  page = 1,
  pageCount = 1,
  onPageChange,
  pageSize,
  totalCount,
  readOnly = false,
  showQboSchedule = false,
  allowCreditCardPaymentUndo = false,
  allowIncomingDepositUndo = false,
}) {
  // Column widths (px) — draggable like QuickBooks
  const initialColWidths = React.useMemo(
    () => (showQboSchedule ? [...BASE_COL_WIDTHS.slice(0, -1), QBO_COL_WIDTH, BASE_COL_WIDTHS[BASE_COL_WIDTHS.length - 1]] : BASE_COL_WIDTHS),
    [showQboSchedule]
  );
  const minColWidths = React.useMemo(
    () => (showQboSchedule ? [...BASE_MIN_COL_WIDTHS.slice(0, -1), QBO_MIN_COL_WIDTH, BASE_MIN_COL_WIDTHS[BASE_MIN_COL_WIDTHS.length - 1]] : BASE_MIN_COL_WIDTHS),
    [showQboSchedule]
  );
  const [colWidths, setColWidths] = React.useState(initialColWidths);
  const containerRef = React.useRef(null);
  const scrollAreaRef = React.useRef(null);
  const [containerWidth, setContainerWidth] = React.useState(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = React.useState(false);
  const [horizontalScrollActive, setHorizontalScrollActive] = React.useState(false);
  const scrollFadeTimerRef = React.useRef(null);
  const dragRef = React.useRef(null); // { index, startX, start }
  const gridTemplate = React.useMemo(() => colWidths.map((w) => `${w}px`).join(" "), [colWidths]);
  const totalGridWidth = React.useMemo(() => colWidths.reduce((sum, width) => sum + width, 0), [colWidths]);

  React.useEffect(() => {
    setColWidths(initialColWidths);
  }, [initialColWidths]);

  const beginDrag = (index, clientX) => {
    dragRef.current = { index, startX: clientX, start: [...colWidths] };
    document.addEventListener("mousemove", onDrag);
    document.addEventListener("mouseup", endDrag);
    document.body.style.userSelect = "none";
  };

  const onDrag = (e) => {
    if (!dragRef.current) return;
    const { index, startX, start } = dragRef.current;
    const delta = e.clientX - startX;
    const min = minColWidths[index] || 60;
    const next = [...start];
    next[index] = Math.max(min, start[index] + delta);
    setColWidths(next);
  };

  const endDrag = () => {
    dragRef.current = null;
    document.removeEventListener("mousemove", onDrag);
    document.removeEventListener("mouseup", endDrag);
    document.body.style.userSelect = "";
  };

  React.useEffect(
    () => () => {
      document.removeEventListener("mousemove", onDrag);
      document.removeEventListener("mouseup", endDrag);
      document.body.style.userSelect = "";
      if (scrollFadeTimerRef.current) clearTimeout(scrollFadeTimerRef.current);
    },
    []
  );

  // Measure container to keep columns fitting and the Action column visible on first render
  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect?.width || 0);
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const syncOverflow = () => {
      setHasHorizontalOverflow(el.scrollWidth - el.clientWidth > 8);
    };
    syncOverflow();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncOverflow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerWidth, totalGridWidth, transactions.length]);

  const pulseHorizontalScrollbar = React.useCallback(() => {
    setHorizontalScrollActive(true);
    if (scrollFadeTimerRef.current) clearTimeout(scrollFadeTimerRef.current);
    scrollFadeTimerRef.current = setTimeout(() => {
      setHorizontalScrollActive(false);
    }, 1200);
  }, []);

  React.useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const onScroll = () => pulseHorizontalScrollbar();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [pulseHorizontalScrollbar]);

  const checkboxClasses =
    "relative h-4 w-4 appearance-none rounded border border-[var(--accent-line)] bg-[var(--panel)] text-emerald-500 shadow-inner transition-colors duration-150 outline-none " +
    "focus:ring-2 focus:ring-emerald-500/40 focus:ring-offset-0 focus:ring-offset-transparent " +
    "checked:bg-emerald-500 checked:border-emerald-300 checked:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.28)] " +
    "after:pointer-events-none after:absolute after:content-[''] after:h-2 after:w-1 after:border-b-2 after:border-r-2 after:border-white after:rotate-45 after:left-[6px] after:top-[2px] after:opacity-0 after:transition-opacity " +
    "checked:after:opacity-100";
  const [accountSelections, setAccountSelections] = React.useState(() => new Map());
  const [splitDrafts, setSplitDrafts] = React.useState(() => new Map());
  const [resolutionSelections, setResolutionSelections] = React.useState(() => new Map());
  const [resolutionActionState, setResolutionActionState] = React.useState(() => new Map());
  const [sort, setSort] = React.useState({ column: null, direction: null }); // direction: 'asc' | 'desc' | null
  const [expandedRowId, setExpandedRowId] = React.useState(null);

	  React.useEffect(() => {
	    let changed = false;
	    const next = new Map(accountSelections);
	    transactions.forEach((txn) => {
	      const meta = txn.meta || {};
	      const hasPair = Boolean(txn.cc_payment_pair_id || meta.cc_payment_pair_id);
	      const ccTarget =
	        hasPair
	          ? txn.cc_payment_transfer_target_qbo_account_id ||
	            meta.cc_payment_transfer_target_qbo_account_id ||
	            txn.cc_payment_cc_qbo_account_id ||
	            meta.cc_payment_cc_qbo_account_id ||
	            ""
	          : "";
	      const suggested = txn.glAccountId || txn.suggestedAccountId || ccTarget || "";
	      if (!next.has(txn.id) || next.get(txn.id) !== suggested) {
	        next.set(txn.id, suggested);
	        changed = true;
      }
    });
    if (changed) setAccountSelections(next);
  }, [transactions]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAccountSelect = (txnId, accountId) => {
    if (readOnly) return;
    setAccountSelections((prev) => {
      const next = new Map(prev);
      next.set(txnId, accountId);
      return next;
    });
    if (onAccountChange) onAccountChange(txnId, accountId);
  };

  React.useEffect(() => {
    setResolutionSelections((previous) => {
      const next = new Map(previous);
      transactions.forEach((txn) => {
        const persisted = effectiveTransactionResolution(txn);
        if (!next.has(txn.id)) next.set(txn.id, persisted);
      });
      return next;
    });
  }, [transactions]);

  const changeResolution = async (txn, resolution) => {
    if (readOnly || txn.status === "posted") return;
    setResolutionSelections((state) => new Map(state).set(txn.id, resolution));
    setResolutionActionState((state) => new Map(state).set(txn.id, { busy: true, error: "" }));
    if (resolution === "categorize_new") {
      const normalAccountId = txn.final_qbo_account_id || txn.glAccountId || txn.suggestedAccountId || txn.suggested_qbo_account_id || "";
      setAccountSelections((state) => new Map(state).set(txn.id, normalAccountId));
    }
    if (resolution === "match_existing_qbo") setExpandedRowId(txn.id);
    if (resolution === "split_transaction") {
      const legacyLoan = ["loan_payment", "loan_movement"].includes(String(txn.taxonomy_type || txn.meta?.taxonomy_type || "").toLowerCase()) || txn.meta?.loan_payment_split_id;
      setSplitDrafts((state) => new Map(state).set(txn.id, legacyLoan ? { ...buildInitialLoanSplitDraft(txn, accounts), mode: "general", legacyLoanSplit: true } : buildInitialSplitTransactionDraft("general", txn, accounts)));
    }
    try {
      await Promise.resolve(onResolutionChange?.(txn.id, resolution, suggestedTransactionResolution(txn)));
      if (resolution === "match_existing_qbo") {
        await Promise.resolve(onInspectIncomingDepositMatch?.(txn.id, null, txn));
      } else if (resolution === "match_credit_card_payment") {
        await Promise.resolve(onMarkCcPayment?.(txn.id));
      } else if (resolution === "categorize_new" && (txn.taxonomy_type === "cc_payment" || txn.meta?.taxonomy_type === "cc_payment")) {
        await Promise.resolve(onRejectCcPayment?.(txn.id));
      }
      setResolutionActionState((state) => new Map(state).set(txn.id, { busy: false, error: "" }));
    } catch (error) {
      setResolutionActionState((state) => new Map(state).set(txn.id, { busy: false, error: error?.body?.message || error?.message || "Could not save this workflow choice." }));
    }
  };

  const clearLoanSplit = (txnId) => {
    setSplitDrafts((prev) => {
      const next = new Map(prev);
      next.delete(txnId);
      return next;
    });
  };

  const updateLoanSplitDraft = (txnId, draft) => {
    setSplitDrafts((prev) => {
      const next = new Map(prev);
      next.set(txnId, draft);
      return next;
    });
  };

  const fmtDate = (iso) => {
    return formatNumericCalendarDate(iso, { fallback: String(iso || "") });
  };

  const sortedTransactions = React.useMemo(() => {
    if (!sort?.column || !sort?.direction) return transactions;
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...transactions].sort((a, b) => {
      if (sort.column === "date") {
        const da = new Date(a.date || a.created_at || 0).getTime();
        const db = new Date(b.date || b.created_at || 0).getTime();
        return (da - db) * dir;
      }
      if (sort.column === "description") {
        const sa = (a.description || "").toLowerCase();
        const sb = (b.description || "").toLowerCase();
        if (sa === sb) return 0;
        return sa > sb ? dir : -dir;
      }
      return 0;
    });
  }, [transactions, sort]);

  const cycleSort = (column) => {
    setSort((prev) => {
      if (prev.column !== column) return { column, direction: column === "date" ? "desc" : "asc" };
      if (prev.direction === "desc") return { column, direction: "asc" };
      if (prev.direction === "asc") return { column: null, direction: null };
      return { column, direction: column === "date" ? "desc" : "asc" };
    });
  };

  const renderSortIndicator = (column) => {
    if (sort.column !== column || !sort.direction) return null;
    return <span className="ml-1 text-[10px] text-white/60">{sort.direction === "asc" ? "↑" : "↓"}</span>;
  };

  const toggleExpandedRow = (txnId) => {
    setExpandedRowId((prev) => (prev === txnId ? null : txnId));
  };

  const activeLoanSplitEntry = React.useMemo(() => {
    for (const [txnId, draft] of splitDrafts.entries()) {
      const txn = transactions.find((item) => String(item.id) === String(txnId));
      if (txn) return { txnId, txn, draft };
    }
    return null;
  }, [splitDrafts, transactions]);

  return (
    <div
      ref={containerRef}
      className="mt-2 rounded-xl border overflow-hidden relative"
      style={{ background: panelBg, borderColor: panelBorder }}
    >
      <style>{`
        .books-feed-x-scroll {
          overflow-x: auto;
          overflow-y: hidden;
          scrollbar-width: thin;
          scrollbar-color: transparent transparent;
        }
        .books-feed-x-scroll::-webkit-scrollbar {
          height: 8px;
        }
        .books-feed-x-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .books-feed-x-scroll::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: 9999px;
          transition: background 180ms ease;
        }
        .books-feed-x-scroll.scrollbar-visible {
          scrollbar-color: rgba(148,163,184,0.38) transparent;
        }
        .books-feed-x-scroll.scrollbar-visible::-webkit-scrollbar-thumb {
          background: rgba(148,163,184,0.38);
        }
        .books-feed-x-scroll.scrollbar-visible::-webkit-scrollbar-thumb:hover {
          background: rgba(148,163,184,0.52);
        }
      `}</style>
      <div
        ref={scrollAreaRef}
        className={`books-feed-x-scroll ${hasHorizontalOverflow && horizontalScrollActive ? "scrollbar-visible" : ""}`}
        onMouseEnter={() => {
          if (hasHorizontalOverflow) pulseHorizontalScrollbar();
        }}
      >
        <div style={{ minWidth: totalGridWidth }}>
          <div
            className="grid text-[11px] uppercase tracking-wide text-slate-400 border-b px-3 py-2.5 divide-x divide-[rgba(255,255,255,0.06)]"
            style={{ background: panelBg, borderColor: panelBorder, columnGap: 0, rowGap: 0, gridTemplateColumns: gridTemplate }}
          >
            <div className="flex items-center justify-center relative">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={readOnly}
                onChange={() => {
                  if (readOnly) return;
                  toggleSelectAll();
                }}
                className={`${checkboxClasses} ${readOnly ? "opacity-50 cursor-not-allowed" : ""}`}
              />
            </div>
            {(showQboSchedule
              ? ["date", "description", "payee", "account", "total", "posts", "action"]
              : ["date", "description", "payee", "account", "total", "action"]
            ).map((key, idx) => {
              const labelMap = { date: "Date", description: "Description", payee: "Payee/Customer", account: "Account", total: "Total", posts: "QBO", action: "Action" };
              const align =
                key === "total"
                  ? "text-right"
                  : key === "action"
                  ? "text-center"
                  : "text-left";
              const onClick =
                key === "date" ? () => cycleSort("date") : key === "description" ? () => cycleSort("description") : undefined;
              return (
                <div key={key} className={`relative flex items-center ${align} w-full`}>
                  <button
                    type={onClick ? "button" : "button"}
                    onClick={onClick}
                    className={`flex items-center w-full ${align === "text-left" ? "justify-start" : align === "text-right" ? "justify-end" : "justify-center"}`}
                    title={onClick ? `Sort by ${labelMap[key]}` : undefined}
                    style={{ cursor: onClick ? "pointer" : "default" }}
                  >
                    <span className={align === "text-right" ? "w-full text-right" : ""}>{labelMap[key]}</span>
                    {key === "date" || key === "description" ? renderSortIndicator(key) : null}
                  </button>
                  {idx < colWidths.length - 1 ? (
                    <div
                      role="separator"
                      onMouseDown={(e) => beginDrag(idx + 1, e.clientX)}
                      className="absolute right-[-6px] top-0 h-full w-3 cursor-col-resize"
                      style={{ touchAction: "none" }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>

          {sortedTransactions.map((txn) => {
            const payeeConfidence = txn.payeeConfidence || txn.counterparty_confidence || txn.confidence || null;
            const showAddToQbo =
              ENABLE_QBO_ADD_STUB &&
              txn.vendor &&
              !txn.qboEntityId &&
              payeeConfidence === "high";
            const isPosted = txn.status === "posted";
            const isPending = txn.pending === true;
            const isPosting = Boolean(postingTransactionIds?.has?.(txn.id));
            const isExpanded = expandedRowId === txn.id;
            const incomingMatch = incomingDepositMatchState(txn);
            const effectiveResolution = resolutionSelections.get(txn.id) || effectiveTransactionResolution(txn);
            const systemSuggestedResolution = suggestedTransactionResolution(txn);
            const resolutionAction = resolutionActionState.get(txn.id) || {};
            const incomingMatchAction = incomingDepositMatchActionState?.[txn.id] || {};
            const fullMemo = getTransactionMemo(txn) || "No bank memo available.";
            const operatorRequest = txn.operator_request || null;
            const customerAnswered = Boolean(txn.customer_answered || (operatorRequest?.answer_text && operatorRequest?.status === "answered" && !operatorRequest?.resolved_at));
            const customerResponseText = txn.customer_response || operatorRequest?.answer_text || "";
            const customerRespondedAt = txn.customer_responded_at || operatorRequest?.answered_at || null;
            const ccRejected = txn.cc_payment_rejected === true || txn.meta?.cc_payment_rejected === true || txn.meta?.taxonomy_override === "not_cc_payment";
            const hasCcPair = Boolean(txn.cc_payment_pair_id || txn.meta?.cc_payment_pair_id);
            const isCcPaymentSuspected = !ccRejected && !hasCcPair && (txn.taxonomy_type === "cc_payment" || txn.meta?.taxonomy_type === "cc_payment");
            const isCcPayment = !ccRejected && hasCcPair;
            const ccWorkflowStatus = deriveResolutionAwareCreditCardPaymentStatus(txn, effectiveResolution);
            const isCcPaymentWorkflow = Boolean(ccWorkflowStatus);
            const ccOrientation = deriveCreditCardPaymentOrientation(txn);
            const ccPairRole = txn.cc_payment_pair_role || txn.meta?.cc_payment_pair_role || null;
            const ccTargetId =
              txn.cc_payment_transfer_target_qbo_account_id ||
              txn.meta?.cc_payment_transfer_target_qbo_account_id ||
              (ccPairRole === "credit_card"
                ? txn.cc_payment_bank_qbo_account_id || txn.meta?.cc_payment_bank_qbo_account_id
                : txn.cc_payment_cc_qbo_account_id || txn.meta?.cc_payment_cc_qbo_account_id) ||
              null;
            const ccTargetName =
              txn.cc_payment_transfer_target_qbo_account_name ||
              txn.meta?.cc_payment_transfer_target_qbo_account_name ||
              (ccPairRole === "credit_card"
                ? txn.cc_payment_bank_qbo_account_name || txn.meta?.cc_payment_bank_qbo_account_name
                : txn.cc_payment_cc_qbo_account_name || txn.meta?.cc_payment_cc_qbo_account_name) ||
              txn.suggestedAccountName ||
              txn.glAccountName ||
              null;
            const ccTransferLabel = isCcPayment
              ? `Credit Card Payment ${ccPairRole === "credit_card" ? "←" : "→"} ${ccTargetName || "matched account"}`
              : null;
            const ccCounterpartAmount = txn.cc_payment_pair_counterpart_amount ?? txn.meta?.cc_payment_pair_counterpart_amount ?? null;
            const ccCounterpartAccount =
              txn.cc_payment_pair_counterpart_account_name ||
              txn.meta?.cc_payment_pair_counterpart_account_name ||
              ccTargetName ||
              null;
            const ccCounterpartDate = txn.cc_payment_pair_counterpart_date || txn.meta?.cc_payment_pair_counterpart_date || null;
            const ccMatchedParts = [
              formatSignedAmount(ccCounterpartAmount),
              ccCounterpartAccount ? `on ${ccCounterpartAccount}` : null,
              formatCcPairDate(ccCounterpartDate),
            ].filter(Boolean);
            const ccMatchedLabel = isCcPayment && ccMatchedParts.length
              ? `Matched to ${ccMatchedParts.join(" · ")}`
              : null;
            const ccSelectableAccounts = accounts.filter((account) => {
              if (ccOrientation.counterpartAccountType === "Bank") {
                return isQboBankAccount(account) && String(account.id) !== String(txn.source_qbo_account_id || "");
              }
              if (ccOrientation.counterpartAccountType === "CreditCard") {
                return isQboCreditCardAccount(account) && String(account.id) !== String(txn.source_qbo_account_id || "");
              }
              return false;
            });
            const ccPaymentDestinationAccounts = ccOrientation.counterpartAccountType === "CreditCard"
              ? ccPaymentAccounts.filter((account) => String(account.id) !== String(txn.source_qbo_account_id || ""))
              : ccSelectableAccounts;
            const selectedAccountValue = accountSelections.get(txn.id) ?? txn.glAccountId ?? txn.suggestedAccountId ?? (readOnly ? "" : txn.accountId) ?? "";
            const selectedCcTargetValue = accountSelections.get(txn.id) ?? ccTargetId ?? "";
            const qboSchedule = showQboSchedule ? formatQboPostingSchedule(txn) : null;
            const readOnlyGlLabel =
              txn.glAccountName ||
              txn.final_qbo_account_name ||
              txn.finalQboAccountName ||
              txn.suggestedAccountName ||
              txn.suggested_qbo_account_name ||
              "Uncategorized";
            const canRejectCcPayment =
              !readOnly &&
              !isPosted &&
              txn.status !== "posted" &&
              (effectiveResolution === "match_credit_card_payment" || isCcPaymentSuspected || (isCcPayment && !["confirmed", "posted"].includes(String(txn.cc_payment_pair_status || txn.meta?.cc_payment_pair_status || "").toLowerCase())));
            const ccAction = ccPaymentActionState?.[txn.id] || {};
            const ccConfirmBusy = ccAction.loading === true || ccAction.matching === true;
            const loanSplitDraft = splitDrafts.get(txn.id) || null;
            const isLoanSplitWorkflow = Boolean(loanSplitDraft) || String(txn.taxonomy_type || txn.meta?.taxonomy_type || "").toLowerCase() === "loan_payment";
            const canUndoCcPaymentPair = allowCreditCardPaymentUndo && isCcPaymentWorkflow && hasCcPair && !isPosted && !txn.qbo_txn_id && !txn.qboTxnId && !txn.posted_at;
            const rowSelectable = !isPosted && !isPending && effectiveResolution === "categorize_new" && !readOnly;

            return (
              <React.Fragment key={txn.id}>
              <div
                className="grid cursor-pointer items-center px-3 py-2 text-[11px] text-slate-100 border-b divide-x divide-[rgba(255,255,255,0.06)] transition-colors"
                style={{
                  background: panelBg,
                  borderColor: panelBorder,
                  transition: "background 120ms ease",
                  gridTemplateColumns: gridTemplate,
                }}
                role="button"
                tabIndex={0}
                aria-busy={(ccAction.discovering === true || ccAction.matching === true || ccAction.loading === true) ? "true" : undefined}
                aria-expanded={isExpanded}
                aria-label={`Show full memo for ${txn.description || "transaction"}`}
                onClick={() => toggleExpandedRow(txn.id)}
                onKeyDown={(e) => {
                  if (isEditableKeyboardTarget(e.target)) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpandedRow(txn.id);
                  }
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = ROW_HOVER_BG)}
                onMouseLeave={(e) => (e.currentTarget.style.background = panelBg)}
              >
              <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  disabled={!rowSelectable}
                  checked={selectedIds.has(txn.id)}
                  onChange={() => {
                    if (!rowSelectable) return;
                    toggleRow(txn.id);
                  }}
                  className={`${checkboxClasses} ${!rowSelectable ? "opacity-50 cursor-not-allowed" : ""}`}
                  title={isPending ? "Pending transactions are not actionable yet." : isCcPaymentWorkflow ? "Use the credit-card payment matching workflow." : isPosted ? "Already posted to QuickBooks." : readOnly ? "Billing required to edit transactions." : undefined}
                />
              </div>
              <div className="text-slate-300 truncate">{fmtDate(txn.date)}</div>
              <div className="min-w-0 pl-2 text-[10px] font-medium text-slate-50 truncate leading-tight whitespace-nowrap" title={txn.description || ""}>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-[11px] text-slate-300 transition ${
                      isExpanded ? "rotate-90 border-emerald-400/40 text-emerald-300" : ""
                    }`}
                    aria-hidden="true"
                  >
                    ›
                  </span>
                  <span className="truncate">{txn.description || "—"}</span>
                  {txn.is_check ? (
                    <span
                      className="inline-flex items-center rounded-full border border-slate-500/70 bg-white/5 px-2 py-[1px] text-[9px] font-semibold text-slate-100"
                      title="Checks often don’t include vendor details. Bizzi needs one quick clarification."
                    >
                      Check
                    </span>
                  ) : null}
                  {customerAnswered ? (
                    <span
                      className="inline-flex items-center rounded-full border border-cyan-300/45 bg-cyan-400/10 px-2 py-[1px] text-[9px] font-semibold text-cyan-100"
                      title="Customer response received; accountant review still required."
                    >
                      Customer answered
                    </span>
                  ) : null}
                </div>
                {txn.is_check && txn.check_number ? (
                  <span className="text-[9px] text-slate-400">Check #{txn.check_number}</span>
                ) : null}
              </div>
              <div className="min-w-0 flex flex-col text-slate-400 leading-tight whitespace-nowrap" title={txn.vendor || ""}>
                <span className="truncate">{txn.vendor || "—"}</span>
                {showAddToQbo ? (
                  <button
                    type="button"
                    onClick={() => window.alert("Add to QuickBooks coming soon")}
                    className="mt-[2px] inline-flex w-fit items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-[2px] text-[9px] font-semibold text-slate-100 hover:border-emerald-400/50 hover:text-emerald-200"
                  >
                    Add to QuickBooks
                  </button>
                ) : null}
              </div>
              <div className="relative z-[20] flex min-w-0 flex-col items-stretch gap-1 overflow-hidden text-slate-200 text-[11px] leading-tight whitespace-nowrap">
                {isPosted ? (
                  <span className="inline-flex w-fit items-center rounded-full px-2 py-[2px] text-[10px] font-semibold bg-emerald-500/10 text-emerald-200 border border-emerald-500/40">
                    Posted to QuickBooks
                  </span>
                ) : null}
                {isPending ? (
                  <span className="inline-flex w-fit max-w-full flex-col rounded-md border border-amber-300/25 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-100">
                    <span className="truncate">Pending</span>
                    {(txn.suggestedAccountName || txn.glAccountName) ? (
                      <span className="truncate text-[9px] font-medium text-amber-100/65">{txn.suggestedAccountName || txn.glAccountName} · Suggested</span>
                    ) : null}
                  </span>
                ) : incomingMatch.active && effectiveResolution === "match_existing_qbo" ? (
                  <span className={`inline-flex w-fit max-w-full flex-col rounded-md border px-2 py-1 text-[10px] font-semibold ${
                    incomingMatch.confirmed
                      ? "border-emerald-300/30 bg-emerald-500/10 text-emerald-100"
                      : "border-amber-300/25 bg-amber-400/10 text-amber-100"
                  }`}>
                    <span className="truncate">
                      {incomingMatch.confirmed ? "Matched to existing QuickBooks" : incomingMatch.unavailable ? "Match check unavailable" : incomingMatch.ambiguous || incomingMatch.needsFreshCheck ? "Needs Match" : "Possible QBO match"}
                    </span>
                    <span className={`truncate text-[9px] font-medium ${incomingMatch.confirmed ? "text-emerald-100/65" : "text-amber-100/65"}`}>
                      {incomingMatch.primary?.qbo_entity_type || "QuickBooks"} {incomingMatch.primary?.txn_date || ""}
                    </span>
                  </span>
                ) : ccWorkflowStatus && effectiveResolution === "match_credit_card_payment" ? (
                  <CreditCardPaymentMatchControl
                    value={selectedCcTargetValue}
                    accounts={ccPaymentDestinationAccounts}
                    accountsLoaded={ccOrientation.counterpartAccountType === "CreditCard" ? ccPaymentAccountsLoaded : true}
                    loadingAccounts={ccOrientation.counterpartAccountType === "CreditCard" ? loadingCcPaymentAccounts : false}
                    accountsError={ccOrientation.counterpartAccountType === "CreditCard" ? ccPaymentAccountsError : ""}
                    statusLabel={ccWorkflowStatus.label}
                    targetLabel={ccOrientation.label}
                    placeholder={ccOrientation.placeholder}
                    matched={ccWorkflowStatus.matched}
                    transferLabel={ccTransferLabel}
                    matchedLabel={ccMatchedLabel}
                    error={ccAction.error}
                    loading={ccConfirmBusy}
                    discovering={ccAction.discovering === true}
                    matching={ccAction.matching === true}
                    candidate={ccAction.candidate || null}
                    disabled={readOnly}
                    onChange={(id) => handleAccountSelect(txn.id, id)}
                    onConfirm={() => onConfirmCcPaymentMatch?.(txn.id, selectedCcTargetValue, ccAction.targetTransactionId || ccAction.candidate?.transaction_id || null)}
                    onUseCoa={canRejectCcPayment ? () => changeResolution(txn, "categorize_new") : null}
                    onRetryAccounts={onRetryCcPaymentAccounts}
                  />
                ) : ccTransferLabel ? (
                  <span className="inline-flex w-fit max-w-full flex-col rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-100">
                    <span className="truncate">{ccTransferLabel}</span>
                    {ccMatchedLabel ? <span className="truncate text-[9px] font-medium text-emerald-100/65">{ccMatchedLabel}</span> : null}
                  </span>
                ) : null}
                {isCcPaymentSuspected && !ccWorkflowStatus && effectiveResolution === "match_credit_card_payment" ? (
                  <span className="inline-flex w-fit max-w-full rounded-md border border-amber-300/25 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-100">
                    Possible credit card payment
                  </span>
                ) : null}
                {effectiveResolution === "split_transaction" && loanSplitDraft ? (
                  <span className="inline-flex w-fit max-w-full rounded-md border border-amber-300/25 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-100">
                    Loan Payment · Needs Split
                  </span>
                ) : effectiveResolution === "split_transaction" && isLoanSplitWorkflow ? (
                  <span className="inline-flex w-fit max-w-full rounded-md border border-amber-300/25 bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-100">
                    Loan Payment · Needs Split
                  </span>
                ) : !isPending && effectiveResolution === "categorize_new" && accounts.length > 0 ? (
                  <CoaDropdown
                    value={selectedAccountValue}
                    suggestedId={txn.suggestedAccountId}
                    suggestedName={txn.suggestedAccountName || txn.glAccountName}
                    accounts={accounts}
                    onCreateAccount={onCreateAccount}
                    onCreatedAccountSelect={(account) => onCreatedAccountSelect?.(txn, account)}
                    accountTypes={accountTypes}
                    creationContext={{
                      amount: txn.signed_amount ?? txn.signedAmount ?? txn.amount,
                      direction: txn.direction,
                      qboTxnType: txn.qbo_txn_type,
                    }}
                    status={txn.status}
                    disabled={
                      isPosted ||
                      txn.status === "failed" ||
                      (["approved", "auto_approved"].includes(txn.status) && !txn.canEdit) ||
                      readOnly
                    }
                    resolution={effectiveResolution}
                    onResolutionChange={(nextResolution) => changeResolution(txn, nextResolution)}
                    onChange={(id) => {
                      handleAccountSelect(txn.id, id);
                      if (id && effectiveResolution !== "categorize_new") changeResolution(txn, "categorize_new");
                    }}
                  />
                ) : !isPending && effectiveResolution === "categorize_new" ? (
                  <span className="text-slate-400 text-[11px] truncate">{readOnlyGlLabel}</span>
                ) : null}
                {txn.status === "auto_approved" && !isCcPaymentWorkflow ? (
                  <span className="inline-flex w-fit items-center rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-[2px] text-[9px] font-semibold uppercase tracking-wide text-emerald-200/90">
                    Auto-approved
                  </span>
                ) : null}
              </div>
              <div
                className={`pr-4 text-right font-semibold whitespace-nowrap ${
                  (Number(txn.signed_amount ?? txn.signedAmount ?? txn.amount ?? 0) || 0) < 0 ? "text-rose-400" : "text-emerald-400"
                }`}
              >
                {(() => {
                  const display = Number(txn.signed_amount ?? txn.signedAmount ?? txn.amount ?? 0) || 0;
                  const isOutflow = display < 0;
                  const abs = Math.abs(display);
                  return `${isOutflow ? "-" : "+"}$${abs.toFixed(2)}`;
                })()}
              </div>
              {showQboSchedule && qboSchedule ? (
                <div className="flex min-w-0 items-center justify-center px-2 text-center" title={qboSchedule.detail}>
                  <span
                    className={`inline-flex max-w-full items-center justify-center rounded-full border px-2 py-[3px] text-[10px] font-semibold leading-tight ${
                      QBO_SCHEDULE_TONE_CLASSES[qboSchedule.tone] || QBO_SCHEDULE_TONE_CLASSES.neutral
                    }`}
                  >
                    <span className="truncate">{qboSchedule.label}</span>
                  </span>
                </div>
              ) : null}
              <div className="flex justify-center pl-3 pr-3" onClick={(e) => e.stopPropagation()}>
                {isPosted ? (
                  <span className="text-[10px] text-slate-400">Posted</span>
                ) : isPending ? (
                  <span className="text-[10px] text-amber-100/80">Pending</span>
                ) : incomingMatch.active && effectiveResolution === "match_existing_qbo" ? (
                  incomingMatch.confirmed && allowIncomingDepositUndo && incomingMatch.matchId ? (
                    <button
                      type="button"
                      onClick={() => onUndoIncomingDepositMatch?.(txn.id, incomingMatch.matchId, txn)}
                      disabled={readOnly || incomingMatchAction.loading === true}
                      className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-amber-300/35 bg-amber-400/8 px-2.5 text-[10px] font-semibold text-amber-100/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-amber-300/60 hover:bg-amber-400/14 disabled:cursor-not-allowed disabled:opacity-45"
                      title={readOnly ? "Billing required to edit transactions." : "Undo QuickBooks match"}
                      aria-label="Undo QuickBooks match"
                    >
                      <RotateCcw size={11} strokeWidth={2.2} aria-hidden="true" />
                      Undo
                    </button>
                  ) : incomingMatch.confirmed ? (
                    <button
                      type="button"
                      onClick={() => toggleExpandedRow(txn.id)}
                      className="inline-flex min-h-8 min-w-[124px] items-center justify-center whitespace-nowrap rounded-full border border-emerald-300/35 bg-emerald-500/10 px-3.5 py-1.5 text-[10px] font-semibold leading-none text-emerald-100/95 transition hover:border-emerald-300/65 hover:bg-emerald-500/16"
                    >
                      View match details
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => incomingMatch.unavailable ? onInspectIncomingDepositMatch?.(txn.id, null, txn) : toggleExpandedRow(txn.id)}
                      disabled={readOnly || incomingMatchAction.loading === true}
                      className={`inline-flex min-h-8 min-w-[104px] items-center justify-center whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[10px] font-semibold leading-none transition disabled:cursor-not-allowed disabled:opacity-45 ${
                        incomingMatch.unavailable
                          ? "border-amber-300/35 bg-amber-400/8 text-amber-100/95 hover:border-amber-300/60 hover:bg-amber-400/14"
                          : "border-emerald-300/35 bg-emerald-500/10 text-emerald-100/95 hover:border-emerald-300/65 hover:bg-emerald-500/16"
                      }`}
                    >
                          {incomingMatchAction.loading === true
                            ? "Checking..."
                            : incomingMatch.unavailable || incomingMatch.processorMatchState === "qbo_match_check_unavailable"
                              ? "Retry"
                              : incomingMatch.processorMatchState === "checking_for_qbo_match"
                                ? "Check QuickBooks"
                                : incomingMatch.processorMatchState === "no_existing_qbo_match" && incomingMatch.canCreateNewFee
                                  ? "Record New Fee"
                                  : incomingMatch.processorMatchState === "posted_duplicate_review_required"
                                    ? "Review duplicate"
                                    : incomingMatch.isProcessorFee
                                      ? "Possible QBO match"
                                      : "Review match"}
                    </button>
                  )
                ) : effectiveResolution === "match_credit_card_payment" ? (
                  canUndoCcPaymentPair ? (
                    <button
                      className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-amber-300/35 bg-amber-400/8 px-2.5 text-[10px] font-semibold text-amber-100/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-amber-300/60 hover:bg-amber-400/14 disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={readOnly || isPosting}
                      onClick={() => {
                        if (readOnly || isPosting) return;
                        onUndo && onUndo(txn.id);
                      }}
                      title={readOnly ? "Billing required to edit transactions." : "Undo credit-card payment match"}
                      aria-label="Undo credit-card payment match"
                    >
                      <RotateCcw size={11} strokeWidth={2.2} aria-hidden="true" />
                      Undo
                    </button>
                  ) : (
                    <span className="text-[10px] text-slate-400">Needs match</span>
                  )
                ) : effectiveResolution === "split_transaction" ? (
                  <span className="text-[10px] text-slate-400">{loanSplitDraft ? "Needs split" : "Loan split"}</span>
                ) : ["approved", "auto_approved", "handled", "failed"].includes(txn.status) ? (
                  <div className="flex items-center justify-center gap-1.5">
                    <button
                      className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-amber-300/35 bg-amber-400/8 px-2.5 text-[10px] font-semibold text-amber-100/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-amber-300/60 hover:bg-amber-400/14 disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={readOnly || isPosting}
                      onClick={() => {
                        if (readOnly || isPosting) return;
                        onUndo && onUndo(txn.id);
                      }}
                      title={readOnly ? "Billing required to edit transactions." : "Undo approval"}
                      aria-label="Undo approval"
                    >
                      <RotateCcw size={11} strokeWidth={2.2} aria-hidden="true" />
                      Undo
                    </button>
                    <button
                      className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-emerald-300/35 bg-emerald-500/10 px-2.5 text-[10px] font-semibold text-emerald-100/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-emerald-300/65 hover:bg-emerald-500/16 disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={readOnly || isPosting}
                      onClick={() => {
                        if (readOnly || isPosting) return;
                        onManualPost && onManualPost(txn.id);
                      }}
                      title={readOnly ? "Billing required to post transactions." : txn.status === "failed" ? "Retry posting this handled transaction to QuickBooks." : "Post this handled transaction to QuickBooks now."}
                      aria-label={txn.status === "failed" ? "Retry QuickBooks posting" : "Post to QuickBooks"}
                    >
                      <UploadCloud size={12} strokeWidth={2.2} aria-hidden="true" />
                      {isPosting ? "Posting..." : txn.status === "failed" ? "Retry" : "Post"}
                    </button>
                  </div>
                ) : (
                 <button
                   className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-emerald-300/60 bg-emerald-500/14 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/24 hover:border-emerald-300/90 active:scale-[0.99] disabled:opacity-45 disabled:cursor-not-allowed shadow-[0_2px_6px_rgba(0,0,0,0.2)] transition-transform"
                   disabled={
                     readOnly ||
                     txn.is_check &&
                     !(accountSelections.get(txn.id) ?? txn.glAccountId ?? txn.suggestedAccountId ?? null)
                   }
                   title={
                     txn.is_check && !(accountSelections.get(txn.id) ?? txn.glAccountId ?? txn.suggestedAccountId ?? null)
                       ? "Select a category to approve this check."
                       : readOnly
                       ? "Billing required to approve transactions."
                       : "Approve"
                   }
	                  onClick={() => {
	                    if (readOnly) return;
	                    onApprove && onApprove(txn.id, selectedAccountValue || null);
	                  }}
                  aria-label="Approve transaction"
                >
                  ✓
                </button>
                )}
             </div>
           </div>
           <div
             className={`overflow-hidden border-b transition-[max-height,opacity] duration-200 ease-out ${
               isExpanded ? "max-h-[34rem] opacity-100" : "max-h-0 opacity-0"
             }`}
             style={{ background: "rgba(15,17,20,0.92)", borderColor: panelBorder }}
             aria-hidden={!isExpanded}
           >
             <div className="px-3 py-3">
               <div
                 className="rounded-xl border px-4 py-3"
                 style={{
                   background: "rgba(255,255,255,0.025)",
                   borderColor: "rgba(16,185,129,0.18)",
                 }}
               >
                 <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                   Full bank memo
                 </div>
                 <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-100">
                   {fullMemo}
                 </div>
                 {!isPosted && !isPending ? <div className="mt-3">
                   <TransactionResolutionSelector
                     transactionId={txn.id}
                     value={effectiveResolution}
                     suggested={systemSuggestedResolution}
                     disabled={readOnly}
                     busy={resolutionAction.busy === true}
                     error={resolutionAction.error || ""}
                     onChange={(resolution) => changeResolution(txn, resolution)}
                   />
                 </div> : null}
                 {effectiveResolution === "match_existing_qbo" && !incomingMatch.active ? (
                   <div className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-500/[0.055] px-4 py-4" role="status">
                     <div className="flex items-center gap-2 text-[12px] font-semibold text-emerald-100"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Checking QuickBooks for an existing transaction…</div>
                     <div className="mt-1 text-[10px] text-slate-400">You can continue reviewing other transactions while candidates load.</div>
                   </div>
                 ) : null}
                 {effectiveResolution === "match_credit_card_payment" && !ccWorkflowStatus ? (
                   <div className="mt-3 rounded-xl border border-cyan-300/20 bg-cyan-500/[0.055] px-4 py-4" role="status">
                     <div className="flex items-center gap-2 text-[12px] font-semibold text-cyan-100"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Preparing credit-card payment matching…</div>
                   </div>
                 ) : null}
                 {incomingMatch.active && ["match_existing_qbo", "categorize_new"].includes(effectiveResolution) ? <IncomingDepositMatchPanel
                   txn={txn}
                   state={incomingMatch}
                   action={incomingMatchAction}
                   readOnly={readOnly}
                   onInspect={onInspectIncomingDepositMatch}
                   onConfirm={onConfirmIncomingDepositMatch}
                   onReject={onRejectIncomingDepositMatch}
                   onUndo={onUndoIncomingDepositMatch}
                   onRecordNewFee={onApprove}
                   onRecordNewIncome={onRecordIncomingDepositAsNewIncome}
                   accounts={accounts}
                   resolutionOverride={effectiveResolution}
                 /> : null}
                 {customerAnswered ? (
                   <div className="mt-3 rounded-lg border border-cyan-300/18 bg-cyan-400/[0.06] px-3 py-2">
                     <div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-100/80">
                       Customer response
                     </div>
                     <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-100">
                       {customerResponseText}
                     </div>
                     {customerRespondedAt ? (
                       <div className="mt-1 text-[10px] text-slate-400">
                         Answered {new Date(customerRespondedAt).toLocaleString()}
                       </div>
                     ) : null}
                   </div>
                 ) : null}
               </div>
             </div>
           </div>
           </React.Fragment>
          );
          })}
        </div>
      </div>
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-slate-400">
        <span>
          {totalCount ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, totalCount)} of ${totalCount}` : null}
        </span>
        <div className="flex items-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => onPageChange && onPageChange(page - 1)}
            className="h-5 w-5 rounded border border-slate-700 text-slate-200 disabled:opacity-40 flex items-center justify-center"
          >
            ‹
          </button>
          <span className="px-2 py-0.5 rounded border border-slate-700 text-slate-100">{page}</span>
          <button
            disabled={page >= pageCount}
            onClick={() => onPageChange && onPageChange(page + 1)}
            className="h-5 w-5 rounded border border-slate-700 text-slate-200 disabled:opacity-40 flex items-center justify-center"
          >
            ›
          </button>
        </div>
      </div>
      <SplitTransactionModal
        mode={activeLoanSplitEntry?.draft?.mode || "loan_payment"}
        open={Boolean(activeLoanSplitEntry)}
        txn={activeLoanSplitEntry?.txn}
        accounts={accounts}
        draft={activeLoanSplitEntry?.draft || {}}
        disabled={readOnly}
        onCreateAccount={onCreateAccount}
        accountTypes={accountTypes}
        onChange={(draft) => activeLoanSplitEntry && updateLoanSplitDraft(activeLoanSplitEntry.txnId, draft)}
        onConfirm={async (split) => {
          if (!activeLoanSplitEntry) return;
          if (split?.mode === "general") await onConfirmSplitTransaction?.(activeLoanSplitEntry.txnId, split);
          else await onConfirmLoanPaymentSplit?.(activeLoanSplitEntry.txnId, split);
          clearLoanSplit(activeLoanSplitEntry.txnId);
        }}
        onTreatAsRegular={async () => {
          if (!activeLoanSplitEntry) return;
          await onTreatLoanPaymentAsRegular?.(activeLoanSplitEntry.txnId);
          clearLoanSplit(activeLoanSplitEntry.txnId);
        }}
        onClose={() => activeLoanSplitEntry && clearLoanSplit(activeLoanSplitEntry.txnId)}
      />
    </div>
  );
}
 
