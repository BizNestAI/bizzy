import React from "react";
import ReactDOM from "react-dom";
import { Check, Loader2, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import CreateQuickBooksAccountModal from "./CreateQuickBooksAccountModal.jsx";
import { normalizeCurrencyAmountDraft, sanitizeCurrencyAmountDraft } from "./currencyAmountDraft.js";

function normalizeAccountType(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

export function isLoanPrincipalAccountOption(account = {}) {
  const type = normalizeAccountType(account.type || account.accountType || account.account_type || account.AccountType);
  return type === "longtermliability" || type === "othercurrentliability";
}

export function isLoanInterestAccountOption(account = {}) {
  const type = normalizeAccountType(account.type || account.accountType || account.account_type || account.AccountType);
  return type === "expense" || type === "otherexpense" || type === "costofgoodssold" || type === "costofgoodsold";
}

function isGeneralPostingAccountOption(account = {}) {
  const type = normalizeAccountType(account.type || account.accountType || account.account_type || account.AccountType);
  return !["bank", "creditcard", "creditcardaccount", "accountsreceivable", "accountspayable"].includes(type);
}

function accountName(account = {}) {
  return account.fullyQualifiedName || account.FullyQualifiedName || account.name || "Account";
}

function accountTypeLabel(account = {}) {
  return account.type || account.accountType || account.account_type || account.AccountType || "";
}

function isExactInterestExpenseAccount(account = {}) {
  const name = String(accountName(account)).trim().toLowerCase();
  return isLoanInterestAccountOption(account) && ["interest expense", "interest paid", "loan interest expense"].includes(name);
}

export function findSafeDefaultInterestAccountId(accounts = [], loanProfile = null) {
  const profileAccountId =
    loanProfile?.default_interest_qbo_account_id ||
    loanProfile?.defaultInterestQboAccountId ||
    loanProfile?.interest_qbo_account_id ||
    loanProfile?.meta?.default_interest_qbo_account_id ||
    null;
  if (profileAccountId) {
    const profileAccount = (accounts || []).find((account) => String(account.id || "") === String(profileAccountId));
    if (profileAccount && isLoanInterestAccountOption(profileAccount)) return String(profileAccount.id);
  }
  const exact = (accounts || []).find(isExactInterestExpenseAccount);
  return exact?.id ? String(exact.id) : "";
}

export function buildInitialSplitTransactionDraft(mode = "general", txn = {}, accounts = []) {
  if (mode === "loan_payment") {
    const loanProfiles = txn.loan_profiles || txn.loanProfiles || [];
    const profile = loanProfiles[0] || null;
    return {
      mode: "loan_payment",
      lenderProfileId: profile?.id || null,
      lines: [
        {
          id: "principal",
          role: "principal",
          description: "Principal",
          qboAccountId: profile?.default_principal_qbo_account_id || profile?.defaultPrincipalQboAccountId || "",
          amount: "",
          fixed: true,
        },
        {
          id: "interest",
          role: "interest",
          description: "Interest",
          qboAccountId: findSafeDefaultInterestAccountId(accounts, profile),
          amount: "",
          fixed: true,
        },
      ],
      loanProfiles,
    };
  }
  return {
    mode: "general",
    lines: [
      { id: "line-1", role: "general", description: "", qboAccountId: "", amount: "" },
      { id: "line-2", role: "general", description: "", qboAccountId: "", amount: "" },
    ],
  };
}

export function buildInitialLoanSplitDraft(txn = {}, accounts = []) {
  return buildInitialSplitTransactionDraft("loan_payment", txn, accounts);
}

function toMinorUnits(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100);
}

function transactionTotalMinor(txn = {}) {
  const explicitMinor = Number(txn.signed_amount_minor ?? txn.signedAmountMinor ?? txn.amount_minor ?? txn.amountMinor);
  if (Number.isInteger(explicitMinor) && explicitMinor !== 0) return Math.abs(explicitMinor);
  const signed = Number(txn.signed_amount ?? txn.signedAmount ?? txn.amount ?? 0);
  return Math.abs(Math.round(signed * 100));
}

function formatMoney(minor) {
  const sign = Number(minor || 0) < 0 ? "-" : "";
  return `${sign}$${Math.abs(Number(minor || 0) / 100).toFixed(2)}`;
}

function metadataDateLabel(txn = {}) {
  const raw = txn?.date || txn?.txn_date || "";
  if (!raw) return "Date unavailable";
  const date = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function selectedAccount(accounts = [], accountId) {
  return (accounts || []).find((account) => String(account.id || "") === String(accountId || ""));
}

function normalizeDraftLines(draft = {}) {
  if (Array.isArray(draft.lines)) return draft.lines;
  const lines = [
    { id: "principal", role: "principal", description: "Principal", qboAccountId: draft.principalQboAccountId || "", amount: draft.principalAmount || "", fixed: true },
    { id: "interest", role: "interest", description: "Interest", qboAccountId: draft.interestQboAccountId || "", amount: draft.interestAmount || "", fixed: true },
  ];
  for (const [index, line] of (draft.feeLines || []).entries()) {
    lines.push({ id: line.id || `fee-${index}`, role: "fee", description: line.label || "Fee", qboAccountId: line.qboAccountId || "", amount: line.amount || "" });
  }
  return lines;
}

function useFocusTrap(open, panelRef, onClose) {
  React.useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    const focusable = () =>
      Array.from(panel?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || []).filter(
        (node) => !node.disabled && node.getAttribute("aria-hidden") !== "true"
      );
    window.setTimeout(() => focusable()[0]?.focus(), 0);
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previous && typeof previous.focus === "function") window.setTimeout(() => previous.focus(), 0);
    };
  }, [open, onClose, panelRef]);
}

function AccountSelect({ label, value, accounts = [], placeholder, disabled, onChange }) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [pos, setPos] = React.useState(null);
  const buttonRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const selected = selectedAccount(accounts, value);
  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return accounts;
    return accounts.filter((account) =>
      `${accountName(account)} ${account.shortName || ""} ${account.parentRef?.name || ""} ${accountTypeLabel(account)}`
        .toLowerCase()
        .includes(term)
    );
  }, [accounts, search]);

  React.useEffect(() => {
    if (!open) return undefined;
    const sync = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportPadding = 12;
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
      const spaceAbove = rect.top - viewportPadding;
      const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
      const maxHeight = Math.min(320, Math.max(180, openAbove ? spaceAbove - 6 : spaceBelow - 6));
      setPos({
        top: openAbove ? Math.max(viewportPadding, rect.top - maxHeight - 6) : rect.bottom + 6,
        left: Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - rect.width - viewportPadding)),
        width: Math.min(rect.width, window.innerWidth - viewportPadding * 2),
        maxHeight,
      });
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    const onMouseDown = (event) => {
      if (buttonRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        onClick={() => !disabled && setOpen((current) => !current)}
        className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-left text-xs text-white outline-none transition hover:border-emerald-300/45 focus:border-emerald-300/65 focus:ring-2 focus:ring-emerald-500/25 disabled:opacity-50"
      >
        <span className="min-w-0">
          <span className={`block truncate font-semibold ${selected ? "text-white" : "text-white/50"}`}>{selected ? accountName(selected) : placeholder}</span>
          {selected && accountTypeLabel(selected) ? <span className="block truncate text-[10px] text-white/40">{accountTypeLabel(selected)}</span> : null}
        </span>
        <span className="text-white/45">v</span>
      </button>
      {open && pos
        ? ReactDOM.createPortal(
            <div
              ref={menuRef}
              className="fixed z-[10020] overflow-hidden rounded-xl border border-emerald-300/25 bg-[#0b0f0d] shadow-[0_24px_64px_rgba(0,0,0,0.72)]"
              style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            >
              <div className="border-b border-white/10 p-2">
                <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search accounts..." className="h-9 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none placeholder:text-white/40 focus:border-emerald-300/55" />
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: Math.max(120, pos.maxHeight - 54) }}>
                <button type="button" className="flex w-full px-3 py-2 text-left text-sm text-white/55 hover:bg-white/5" onClick={() => { onChange(""); setOpen(false); }}>
                  {placeholder}
                </button>
                {filtered.map((account) => (
                  <button key={account.id} type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/5" onClick={() => { onChange(String(account.id)); setOpen(false); }}>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{accountName(account)}</span>
                      {accountTypeLabel(account) ? <span className="block truncate text-xs text-white/42">{accountTypeLabel(account)}</span> : null}
                    </span>
                    {String(account.id) === String(value || "") ? <Check className="h-4 w-4 shrink-0 text-emerald-300" /> : null}
                  </button>
                ))}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export default function SplitTransactionModal({
  mode = "general",
  open = false,
  txn,
  accounts = [],
  draft = {},
  disabled = false,
  onCreateAccount,
  accountTypes,
  onChange,
  onConfirm,
  onTreatAsRegular,
  onCancel,
  onClose,
}) {
  const panelRef = React.useRef(null);
  const discardDialogRef = React.useRef(null);
  const [saving, setSaving] = React.useState(false);
  const [createAccountLineIndex, setCreateAccountLineIndex] = React.useState(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = React.useState(false);
  const activeMode = draft.mode || mode;
  const isLoanMode = activeMode === "loan_payment";
  const lines = normalizeDraftLines(draft);
  const totalMinor = transactionTotalMinor(txn);
  const lineStates = lines.map((line) => ({
    ...line,
    amountMinor: toMinorUnits(line.amount),
    account: selectedAccount(accounts, line.qboAccountId),
  }));
  const hasInvalidAmounts = lineStates.some((line) => line.amountMinor == null);
  const allocatedMinor = lineStates.reduce((sum, line) => sum + (line.amountMinor || 0), 0);
  const remainingMinor = totalMinor - allocatedMinor;
  const nonzeroLines = lineStates.filter((line) => line.amountMinor > 0);
  const validAccounts = lineStates.every((line) => {
    if (line.amountMinor === 0) return true;
    if (!line.account) return false;
    if (isLoanMode && line.role === "principal") return isLoanPrincipalAccountOption(line.account);
    if (isLoanMode && (line.role === "interest" || line.role === "fee")) return isLoanInterestAccountOption(line.account);
    return isGeneralPostingAccountOption(line.account);
  });
  const canConfirm = !saving && !disabled && !hasInvalidAmounts && totalMinor > 0 && remainingMinor === 0 && nonzeroLines.length >= 2 && validAccounts;
  const hasUnsavedInput = allocatedMinor > 0 || lines.some((line) => String(line.description || "").trim() && !line.fixed);
  const sourceLabel = txn?.source_account_name || txn?.sourceAccountName || txn?.account_name || txn?.accountName || txn?.plaid_account_name || "Source account";
  const description = txn?.description || txn?.name || txn?.vendor || txn?.payee || "Transaction";
  const dateLabel = metadataDateLabel(txn);
  const update = React.useCallback((patch) => onChange?.({ ...draft, ...patch, mode: activeMode }), [activeMode, draft, onChange]);
  const updateLine = (index, patch) => update({ lines: lines.map((line, idx) => (idx === index ? { ...line, ...patch } : line)) });
  const addLine = () => update({ lines: [...lines, { id: `line-${Date.now()}`, role: isLoanMode ? "fee" : "general", description: isLoanMode ? "Fee" : "", qboAccountId: "", amount: "" }] });
  const removeLine = (index) => update({ lines: lines.filter((_, idx) => idx !== index) });
  const cancelAndClose = React.useCallback(() => {
    if (onCancel) onCancel();
    else onClose?.();
  }, [onCancel, onClose]);
  const requestClose = React.useCallback(() => {
    if (saving) return;
    if (createAccountLineIndex != null) return;
    if (showDiscardConfirm) {
      setShowDiscardConfirm(false);
      return;
    }
    if (hasUnsavedInput) {
      setShowDiscardConfirm(true);
      return;
    }
    cancelAndClose();
  }, [cancelAndClose, createAccountLineIndex, hasUnsavedInput, saving, showDiscardConfirm]);
  useFocusTrap(open && !showDiscardConfirm, panelRef, requestClose);
  useFocusTrap(showDiscardConfirm, discardDialogRef, () => setShowDiscardConfirm(false));

  React.useEffect(() => {
    if (!open) setShowDiscardConfirm(false);
  }, [open]);

  if (!open || !txn) return null;

  const confirm = async () => {
    if (!canConfirm) return;
    setSaving(true);
    try {
      if (isLoanMode) {
        const principal = lineStates.find((line) => line.role === "principal");
        const interest = lineStates.find((line) => line.role === "interest");
        await onConfirm?.({
          mode: "loan_payment",
          lender_profile_id: draft.lenderProfileId && draft.lenderProfileId !== "new" ? draft.lenderProfileId : null,
          principal_amount_minor: principal?.amountMinor || 0,
          principal_qbo_account_id: principal?.amountMinor > 0 ? principal.qboAccountId : null,
          interest_amount_minor: interest?.amountMinor || 0,
          interest_qbo_account_id: interest?.amountMinor > 0 ? interest.qboAccountId : null,
          fee_lines: lineStates
            .filter((line) => line.role !== "principal" && line.role !== "interest")
            .map((line) => ({ label: line.description || "Fee", amount_minor: line.amountMinor, qbo_account_id: line.qboAccountId }))
            .filter((line) => line.amount_minor > 0),
        });
      } else {
        await onConfirm?.({
          mode: "general",
          lines: lineStates
            .map((line, index) => ({
              description: line.description || `Line ${index + 1}`,
              amount_minor: line.amountMinor,
              qbo_account_id: line.qboAccountId,
              qbo_account_name: line.account ? accountName(line.account) : null,
            }))
            .filter((line) => line.amount_minor > 0),
        });
      }
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10000]" role="presentation">
      <button type="button" aria-label="Close split transaction modal" className="absolute inset-0 cursor-default bg-black/62 backdrop-blur-[3px]" onClick={requestClose} />
      <div className="relative z-10 flex min-h-dvh items-center justify-center p-6 max-[850px]:p-4">
        <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="split-transaction-title" className="relative flex max-h-[calc(100vh-48px)] w-[min(760px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-emerald-300/20 bg-[#0d100f] text-white shadow-[0_28px_90px_rgba(0,0,0,0.76)] max-[640px]:max-h-[calc(100dvh-24px)]">
          <header className="shrink-0 border-b border-white/10 bg-[#0d100f]/98 px-5 py-3.5 backdrop-blur max-[850px]:px-4">
            <div className="flex items-start justify-between gap-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 id="split-transaction-title" className="text-base font-semibold text-white">Split transaction</h2>
                  {isLoanMode ? <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold text-amber-100">Loan payment</span> : null}
                </div>
                <p className="mt-0.5 max-w-[640px] truncate text-xs text-white/62" title={description}>{description}</p>
                <p className="mt-0.5 truncate text-[11px] text-white/45">{dateLabel} - {sourceLabel} - {formatMoney(totalMinor)}</p>
              </div>
              <button type="button" onClick={requestClose} aria-label="Close split transaction modal" className="shrink-0 rounded-full border border-white/10 p-1.5 text-white/70 hover:bg-white/8 hover:text-white">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3.5 max-[850px]:px-4">
            <div className="grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-black/24 px-3.5 py-2.5 max-[640px]:grid-cols-1">
              <SummaryItem label="Transaction total" value={formatMoney(totalMinor)} />
              <SummaryItem label="Allocated" value={formatMoney(allocatedMinor)} tone="accent" />
              <SummaryItem label="Remaining" value={formatMoney(remainingMinor)} icon={remainingMinor === 0 ? Check : null} tone={remainingMinor === 0 ? "good" : remainingMinor < 0 ? "bad" : "warn"} />
            </div>

            <section className="mt-4 min-w-0">
              <h3 className="text-[13px] font-semibold text-white">Payment allocation</h3>
              <div className="mt-2 overflow-x-hidden rounded-lg border border-white/10 bg-black/18">
                <div className="grid grid-cols-[minmax(130px,.9fr)_minmax(200px,1.4fr)_112px_36px] gap-2 border-b border-white/10 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/36 max-[640px]:hidden">
                  <span>Type/description</span>
                  <span>QuickBooks account</span>
                  <span className="text-right">Amount</span>
                  <span />
                </div>
                <div className="divide-y divide-white/10">
                  {lineStates.map((line, index) => {
                    const accountOptions = isLoanMode && line.role === "principal"
                      ? accounts.filter(isLoanPrincipalAccountOption)
                      : isLoanMode && (line.role === "interest" || line.role === "fee")
                        ? accounts.filter(isLoanInterestAccountOption)
                        : accounts.filter(isGeneralPostingAccountOption);
                    return (
                      <AllocationRow
                        key={line.id || index}
                        line={line}
                        fixedLabel={isLoanMode && (line.role === "principal" || line.role === "interest")}
                        accounts={accountOptions}
                        accountPlaceholder={line.role === "principal" ? "Liability account" : line.role === "interest" ? "Interest expense account" : "Select account"}
                        onChange={(patch) => updateLine(index, patch)}
                        onCreateAccount={
                          isLoanMode && line.role === "principal" && onCreateAccount
                            ? () => setCreateAccountLineIndex(index)
                            : null
                        }
                        onRemove={line.fixed ? null : () => removeLine(index)}
                      />
                    );
                  })}
                </div>
              </div>
              <button type="button" onClick={addLine} className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs font-semibold text-white/75 hover:bg-white/5">
                <Plus className="h-3.5 w-3.5" />
                Add another line
              </button>
              <ValidationText remainingMinor={remainingMinor} allocatedMinor={allocatedMinor} nonzeroLineCount={nonzeroLines.length} validAccounts={validAccounts} hasInvalidAmounts={hasInvalidAmounts} />
            </section>
          </div>

          <footer className="shrink-0 border-t border-white/10 bg-[#0d100f]/98 px-5 py-3 backdrop-blur max-[850px]:px-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {isLoanMode ? <button type="button" disabled={saving || disabled} onClick={onTreatAsRegular} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white/65 hover:bg-white/5 disabled:opacity-45">Treat as regular transaction</button> : <span />}
              <div className="flex items-center gap-2">
                <button type="button" disabled={saving} onClick={requestClose} className="rounded-lg border border-white/12 px-2.5 py-1.5 text-xs font-semibold text-white/75 hover:bg-white/5 disabled:opacity-45">Cancel</button>
                <button type="button" disabled={!canConfirm} onClick={confirm} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300/35 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-500/24 disabled:cursor-not-allowed disabled:opacity-45">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {saving ? "Saving..." : "Confirm split"}
                </button>
              </div>
            </div>
          </footer>
          {showDiscardConfirm ? (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/72 p-5 backdrop-blur-[2px]" onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowDiscardConfirm(false);
            }}>
              <div ref={discardDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="discard-split-title" aria-describedby="discard-split-description" className="w-full max-w-[380px] rounded-xl border border-white/12 bg-[#151917] p-4 shadow-[0_24px_80px_rgba(0,0,0,0.72)]">
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-amber-300/25 bg-amber-300/10 text-amber-200">
                    <TriangleAlert className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3 id="discard-split-title" className="text-base font-semibold text-white">Discard this split?</h3>
                    <p id="discard-split-description" className="mt-1 text-sm leading-5 text-white/58">Your allocation amounts and account selections will be lost.</p>
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" autoFocus onClick={() => setShowDiscardConfirm(false)} className="rounded-lg border border-white/12 px-3.5 py-2 text-sm font-semibold text-white/78 hover:bg-white/6">Continue editing</button>
                  <button type="button" onClick={() => {
                    setShowDiscardConfirm(false);
                    cancelAndClose();
                  }} className="rounded-lg border border-rose-300/30 bg-rose-400/12 px-3.5 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-400/20">Discard split</button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </div>
      <CreateQuickBooksAccountModal
        open={createAccountLineIndex != null}
        onCreate={onCreateAccount}
        accountTypes={accountTypes}
        context={{
          workflow: "loan_principal",
          financialStatement: "Balance Sheet",
          defaultAccountType: "Long Term Liability",
        }}
        onClose={(createdAccount) => {
          const targetIndex = createAccountLineIndex;
          setCreateAccountLineIndex(null);
          if (!createdAccount?.id || targetIndex == null) return;
          updateLine(targetIndex, { qboAccountId: String(createdAccount.id) });
        }}
      />
    </div>,
    document.body
  );
}

function SummaryItem({ label, value, tone, icon: Icon }) {
  const toneClass = tone === "good" ? "text-emerald-200" : tone === "bad" ? "text-rose-300" : tone === "warn" ? "text-amber-200" : tone === "accent" ? "text-emerald-100" : "text-white";
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-[0.17em] text-white/36">{label}</div>
      <div className={`mt-0.5 inline-flex items-center gap-1 text-[13px] font-semibold ${toneClass}`}>
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        {value}
      </div>
    </div>
  );
}

function AllocationRow({ line, fixedLabel, accounts, accountPlaceholder, onChange, onCreateAccount, onRemove }) {
  return (
    <div className="grid grid-cols-[minmax(130px,.9fr)_minmax(200px,1.4fr)_112px_36px] items-center gap-2 px-2.5 py-2 max-[640px]:grid-cols-1">
      {fixedLabel ? (
        <div className="text-xs font-semibold text-white/84">{line.description}</div>
      ) : (
        <input value={line.description || ""} aria-label="Line description" placeholder="Description" onChange={(event) => onChange({ description: event.target.value })} className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/30 px-2.5 text-xs font-semibold text-white outline-none placeholder:text-white/35 focus:border-emerald-300/55" />
      )}
      <div className="min-w-0">
        <AccountSelect label={`${line.description || "Split line"} account`} value={line.qboAccountId || ""} accounts={accounts} placeholder={accountPlaceholder} onChange={(value) => onChange({ qboAccountId: value })} />
        {onCreateAccount ? (
          <button type="button" onClick={onCreateAccount} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-emerald-300/20 bg-emerald-400/[0.08] px-2.5 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-400/[0.14]">
            <Plus className="h-3.5 w-3.5" />
            Add liability account
          </button>
        ) : null}
      </div>
      <CurrencyAmountInput
        value={line.amount ?? ""}
        label={`${line.description || "Split line"} amount`}
        onChange={(amount) => onChange({ amount })}
      />
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${line.description || "line"}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/12 text-white/60 hover:bg-white/5">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : <span />}
    </div>
  );
}

function CurrencyAmountInput({ value, label, onChange }) {
  const inputRef = React.useRef(null);
  const [draft, setDraft] = React.useState(() => String(value ?? ""));

  React.useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(String(value ?? ""));
  }, [value]);

  const handleChange = (event) => {
    const next = sanitizeCurrencyAmountDraft(event.target.value);
    setDraft(next);
    onChange?.(next);
  };

  const handleBlur = () => {
    const normalized = normalizeCurrencyAmountDraft(draft);
    setDraft(normalized);
    if (normalized !== String(value ?? "")) onChange?.(normalized);
  };

  return (
    <div className="relative min-w-0">
      <span aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-white/45">$</span>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        inputMode="decimal"
        autoComplete="off"
        aria-label={label}
        placeholder="0.00"
        onFocus={(event) => event.currentTarget.select()}
        onChange={handleChange}
        onBlur={handleBlur}
        className="h-9 w-full min-w-0 rounded-lg border border-white/10 bg-black/30 py-0 pl-6 pr-2.5 text-right text-xs tabular-nums text-white outline-none placeholder:text-white/35 focus:border-emerald-300/55"
      />
    </div>
  );
}

function ValidationText({ remainingMinor, allocatedMinor, nonzeroLineCount, validAccounts, hasInvalidAmounts }) {
  let message = "";
  if (hasInvalidAmounts) message = "Amounts must be nonnegative.";
  else if (remainingMinor !== 0) message = remainingMinor < 0 ? `Allocation exceeds the payment by ${formatMoney(Math.abs(remainingMinor))}.` : `${formatMoney(remainingMinor)} remains to be allocated.`;
  else if (allocatedMinor <= 0) message = "Enter at least one allocation amount.";
  else if (nonzeroLineCount < 2) message = "Enter at least two allocation lines.";
  else if (!validAccounts) message = "Select a QuickBooks account for every nonzero line.";
  else message = "Payment fully allocated.";
  const tone = message === "Payment fully allocated." ? "text-emerald-100" : "text-amber-100";
  return <div className={`mt-2.5 text-xs font-medium ${tone}`}>{message}</div>;
}
