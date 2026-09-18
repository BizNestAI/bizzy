import React from "react";
import ReactDOM from "react-dom";
import { Check, Loader2, Plus, Trash2, X } from "lucide-react";

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

function accountName(account = {}) {
  return account.name || account.fullyQualifiedName || account.FullyQualifiedName || "Account";
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

function metadataDateLabel(txn = {}) {
  const raw = txn?.date || txn?.txn_date || "";
  if (!raw) return "Date unavailable";
  const date = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function cleanLoanLenderSuggestion(txn = {}) {
  const raw = txn.vendor || txn.payee || txn.merchant || txn.counterparty_name || txn.merchant_name || "";
  return String(raw || "")
    .replace(/\b(?:dep|pymt|pmt|ach|debit|credit|web|online|payment)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildInitialLoanSplitDraft(txn = {}, accounts = []) {
  const loanProfiles = txn.loan_profiles || txn.loanProfiles || [];
  return {
    lenderProfileId: "new",
    lenderName: cleanLoanLenderSuggestion(txn),
    loanName: "",
    referenceLastFour: "",
    expectedCadence: "",
    rememberProfile: true,
    principalAmount: "",
    interestAmount: "",
    principalQboAccountId: "",
    interestQboAccountId: findSafeDefaultInterestAccountId(accounts, null),
    feeLines: [],
    loanProfiles,
  };
}

function toMinorUnits(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.]/g, "");
  if (!cleaned) return 0;
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
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

function selectedAccount(accounts = [], accountId) {
  return (accounts || []).find((account) => String(account.id || "") === String(accountId || ""));
}

function profileLabel(profile = {}) {
  const loanName = profile.name || profile.loan_name || profile.meta?.loan_name || profile.lender_display_name || "Loan";
  const lender = profile.meta?.lender_name || profile.lender_display_name || "";
  const lastFour = profile.meta?.reference_last_four || profile.reference_last_four || "";
  return [loanName, lender && lender !== loanName ? lender : null, lastFour ? `ending ${lastFour}` : null].filter(Boolean).join(" - ");
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
    return accounts.filter((account) => `${accountName(account)} ${accountTypeLabel(account)}`.toLowerCase().includes(term));
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
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-left text-sm text-white outline-none transition hover:border-emerald-300/45 focus:border-emerald-300/65 focus:ring-2 focus:ring-emerald-500/25 disabled:opacity-50"
      >
        <span className="min-w-0">
          <span className={`block truncate font-semibold ${selected ? "text-white" : "text-white/50"}`}>{selected ? accountName(selected) : placeholder}</span>
          {selected && accountTypeLabel(selected) ? <span className="block truncate text-xs text-white/40">{accountTypeLabel(selected)}</span> : null}
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
                <input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search accounts..."
                  className="h-9 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none placeholder:text-white/40 focus:border-emerald-300/55"
                />
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: Math.max(120, pos.maxHeight - 54) }}>
                <button
                  type="button"
                  className="flex w-full px-3 py-2 text-left text-sm text-white/55 hover:bg-white/5"
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  {placeholder}
                </button>
                {filtered.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white hover:bg-white/5"
                    onClick={() => {
                      onChange(String(account.id));
                      setOpen(false);
                    }}
                  >
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

export default function LoanPaymentSplitModal({
  open = false,
  txn,
  accounts = [],
  draft = {},
  disabled = false,
  onChange,
  onConfirm,
  onTreatAsRegular,
  onClose,
}) {
  const panelRef = React.useRef(null);
  const [saving, setSaving] = React.useState(false);
  const feeLines = Array.isArray(draft.feeLines) ? draft.feeLines : [];
  const loanProfiles = React.useMemo(
    () => draft.loanProfiles || txn?.loan_profiles || txn?.loanProfiles || [],
    [draft.loanProfiles, txn?.loanProfiles, txn?.loan_profiles]
  );
  const selectedProfile = loanProfiles.find((profile) => String(profile.id) === String(draft.lenderProfileId || ""));
  const totalMinor = transactionTotalMinor(txn);
  const principalMinor = toMinorUnits(draft.principalAmount);
  const interestMinor = toMinorUnits(draft.interestAmount);
  const feeMinor = feeLines.reduce((sum, line) => sum + toMinorUnits(line.amount), 0);
  const allocatedMinor = principalMinor + interestMinor + feeMinor;
  const remainingMinor = totalMinor - allocatedMinor;
  const principalAccount = selectedAccount(accounts, draft.principalQboAccountId);
  const interestAccount = selectedAccount(accounts, draft.interestQboAccountId);
  const liabilityAccounts = accounts.filter(isLoanPrincipalAccountOption);
  const expenseAccounts = accounts.filter(isLoanInterestAccountOption);
  const isNewLoan = !draft.lenderProfileId || draft.lenderProfileId === "new";
  const hasUnsavedInput = principalMinor > 0 || interestMinor > 0 || feeMinor > 0 || String(draft.loanName || "").trim();
  const validFees = feeLines.every((line) => toMinorUnits(line.amount) === 0 || (line.qboAccountId && selectedAccount(accounts, line.qboAccountId)));
  const canConfirm =
    !saving &&
    !disabled &&
    totalMinor > 0 &&
    remainingMinor === 0 &&
    principalMinor > 0 &&
    principalAccount &&
    isLoanPrincipalAccountOption(principalAccount) &&
    (interestMinor === 0 || (interestAccount && isLoanInterestAccountOption(interestAccount))) &&
    validFees &&
    (!isNewLoan || (String(draft.lenderName || "").trim() && String(draft.loanName || "").trim()));
  const sourceLabel = txn?.source_account_name || txn?.sourceAccountName || txn?.account_name || txn?.accountName || txn?.plaid_account_name || "Source account";
  const description = txn?.description || txn?.name || txn?.vendor || txn?.payee || "Transaction";
  const dateLabel = metadataDateLabel(txn);
  const update = React.useCallback((patch) => onChange?.({ ...draft, ...patch }), [draft, onChange]);
  const requestClose = React.useCallback(() => {
    if (saving) return;
    if (hasUnsavedInput && !window.confirm("Discard this loan split?")) return;
    onClose?.();
  }, [hasUnsavedInput, onClose, saving]);
  useFocusTrap(open, panelRef, requestClose);

  React.useEffect(() => {
    if (!open || draft.lenderProfileId === "new") return;
    const profile = loanProfiles.find((item) => String(item.id) === String(draft.lenderProfileId));
    if (!profile) return;
    const next = {};
    const principal = profile.default_principal_qbo_account_id || profile.defaultPrincipalQboAccountId;
    const interest = findSafeDefaultInterestAccountId(accounts, profile);
    if (principal && !draft.principalQboAccountId) next.principalQboAccountId = String(principal);
    if (interest && !draft.interestQboAccountId) next.interestQboAccountId = String(interest);
    if (Object.keys(next).length) update(next);
  }, [accounts, draft.interestQboAccountId, draft.lenderProfileId, draft.principalQboAccountId, loanProfiles, open, update]);

  if (!open || !txn) return null;

  const setProfile = (value) => {
    const profile = loanProfiles.find((item) => String(item.id) === String(value));
    update({
      lenderProfileId: value,
      ...(value === "new"
        ? { principalQboAccountId: draft.principalQboAccountId || "", interestQboAccountId: findSafeDefaultInterestAccountId(accounts, null) }
        : {
            principalQboAccountId: profile?.default_principal_qbo_account_id || draft.principalQboAccountId || "",
            interestQboAccountId: findSafeDefaultInterestAccountId(accounts, profile),
          }),
    });
  };
  const updateFeeLine = (index, patch) => update({ feeLines: feeLines.map((line, idx) => (idx === index ? { ...line, ...patch } : line)) });
  const removeFeeLine = (index) => update({ feeLines: feeLines.filter((_, idx) => idx !== index) });
  const confirm = async () => {
    if (!canConfirm) return;
    setSaving(true);
    try {
      await onConfirm?.({
        lender_profile_id: draft.lenderProfileId && draft.lenderProfileId !== "new" ? draft.lenderProfileId : null,
        lender_name: draft.lenderName?.trim() || null,
        loan_name: draft.loanName?.trim() || null,
        reference_last_four: draft.referenceLastFour || null,
        expected_cadence: draft.expectedCadence || null,
        remember_profile: draft.rememberProfile !== false,
        principal_amount_minor: principalMinor,
        principal_qbo_account_id: draft.principalQboAccountId,
        interest_amount_minor: interestMinor,
        interest_qbo_account_id: interestMinor > 0 ? draft.interestQboAccountId : null,
        fee_lines: feeLines
          .map((line) => ({ label: line.label || "Fee", amount_minor: toMinorUnits(line.amount), qbo_account_id: line.qboAccountId }))
          .filter((line) => line.amount_minor > 0),
      });
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10000]" role="presentation">
      <button type="button" aria-label="Close loan split modal" className="absolute inset-0 cursor-default bg-black/62 backdrop-blur-[3px]" onClick={requestClose} />
      <div className="relative z-10 flex min-h-dvh items-center justify-center p-8 max-[850px]:p-4">
        <section
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="loan-split-title"
          className="flex max-h-[min(820px,calc(100vh-64px))] min-w-[min(760px,calc(100vw-64px))] w-[min(1180px,calc(100vw-64px))] flex-col overflow-hidden rounded-2xl border border-emerald-300/20 bg-[#0d100f] text-white shadow-[0_34px_110px_rgba(0,0,0,0.78)] max-[850px]:h-[calc(100dvh-32px)] max-[850px]:max-h-[calc(100dvh-32px)] max-[850px]:min-w-0 max-[850px]:w-[calc(100vw-32px)] max-[640px]:rounded-xl"
        >
        <header className="shrink-0 border-b border-white/10 bg-[#0d100f]/98 px-6 py-4 backdrop-blur max-[850px]:px-4">
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <h2 id="loan-split-title" className="text-lg font-semibold text-white">Split loan payment</h2>
              <p className="mt-1 max-w-[760px] truncate text-sm text-white/62" title={description}>{description}</p>
              <p className="mt-1 truncate text-xs text-white/45">{dateLabel} - {sourceLabel} - {formatMoney(totalMinor)}</p>
            </div>
            <button type="button" onClick={requestClose} aria-label="Close loan split modal" className="shrink-0 rounded-full border border-white/10 p-2 text-white/70 hover:bg-white/8 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 max-[850px]:px-4">
          <div className="grid grid-cols-3 gap-3 rounded-xl border border-white/10 bg-black/24 px-4 py-3 max-[640px]:grid-cols-1">
            <SummaryItem label="Payment total" value={formatMoney(totalMinor)} />
            <SummaryItem label="Allocated" value={formatMoney(allocatedMinor)} tone="accent" />
            <SummaryItem label="Remaining" value={formatMoney(remainingMinor)} icon={remainingMinor === 0 ? Check : null} tone={remainingMinor === 0 ? "good" : remainingMinor < 0 ? "bad" : "warn"} />
          </div>

          <div className="mt-5 grid grid-cols-[minmax(300px,0.4fr)_minmax(420px,0.6fr)] gap-5 max-[1024px]:grid-cols-[minmax(290px,0.42fr)_minmax(360px,0.58fr)] max-[1024px]:gap-4 max-[850px]:grid-cols-1">
            <section className="min-w-0">
              <h3 className="text-sm font-semibold text-white">Loan details</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 min-[851px]:grid-cols-1">
                <label className="block min-w-0">
                  <span className="mb-1 block text-xs font-semibold text-white/55">Loan</span>
                  <select value={draft.lenderProfileId || "new"} onChange={(event) => setProfile(event.target.value)} className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-white outline-none focus:border-emerald-300/55">
                    <option value="new">Set up new loan</option>
                    {loanProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profileLabel(profile)}</option>)}
                  </select>
                </label>
                {!isNewLoan && selectedProfile ? (
                  <div className="min-w-0 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.05] px-3 py-2 text-xs text-emerald-50/75 sm:col-span-2 min-[851px]:col-span-1">
                    <div className="truncate font-semibold text-emerald-50" title={profileLabel(selectedProfile)}>{profileLabel(selectedProfile)}</div>
                    <div className="mt-1 truncate" title={selectedProfile.default_principal_qbo_account_name || selectedProfile.default_principal_qbo_account_id || "Not set"}>Principal account: {selectedProfile.default_principal_qbo_account_name || selectedProfile.default_principal_qbo_account_id || "Not set"}</div>
                    <div className="mt-1 truncate" title={selectedProfile.default_interest_qbo_account_name || selectedProfile.default_interest_qbo_account_id || "Not set"}>Interest account: {selectedProfile.default_interest_qbo_account_name || selectedProfile.default_interest_qbo_account_id || "Not set"}</div>
                  </div>
                ) : null}
                {isNewLoan ? (
                  <>
                    <TextField label="Lender name" value={draft.lenderName || ""} onChange={(value) => update({ lenderName: value })} />
                    <TextField label="Loan name/identifier" value={draft.loanName || ""} onChange={(value) => update({ loanName: value })} />
                    <TextField label="Last four/reference, optional" value={draft.referenceLastFour || ""} inputMode="numeric" onChange={(value) => update({ referenceLastFour: value.replace(/\D/g, "").slice(0, 4) })} />
                    <label className="block min-w-0">
                      <span className="mb-1 block text-xs font-semibold text-white/55">Expected cadence</span>
                      <select value={draft.expectedCadence || ""} onChange={(event) => update({ expectedCadence: event.target.value })} className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-white outline-none focus:border-emerald-300/55">
                        <option value="">Cadence optional</option>
                        <option value="monthly">Monthly</option>
                        <option value="biweekly">Biweekly</option>
                        <option value="weekly">Weekly</option>
                        <option value="irregular">Irregular</option>
                      </select>
                    </label>
                    <label className="inline-flex items-start gap-2 text-sm text-white/72 sm:col-span-2 min-[851px]:col-span-1">
                      <input type="checkbox" checked={draft.rememberProfile !== false} onChange={(event) => update({ rememberProfile: event.target.checked })} className="mt-0.5" />
                      <span>
                        <span className="block font-semibold text-white/78">Remember this loan and description</span>
                        <span className="block text-xs text-white/42">Use this mapping when the same lender appears again.</span>
                      </span>
                    </label>
                  </>
                ) : null}
              </div>
            </section>

            <section className="min-w-0 border-l border-white/10 pl-5 max-[850px]:border-l-0 max-[850px]:border-t max-[850px]:pl-0 max-[850px]:pt-5">
              <h3 className="text-sm font-semibold text-white">Payment allocation</h3>
              <p className="mt-2 text-sm leading-5 text-white/58">
                Enter the principal and interest shown on the lender statement. The allocation must equal the payment total.
              </p>
              <div className="mt-3 overflow-x-hidden rounded-xl border border-white/10 bg-black/18">
                <div className="grid grid-cols-[112px_minmax(220px,1fr)_128px_44px] gap-2 border-b border-white/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/36 max-[640px]:hidden">
                  <span>Type</span>
                  <span>QuickBooks account</span>
                  <span className="text-right">Amount</span>
                  <span />
                </div>
                <div className="divide-y divide-white/10">
                  <AllocationRow
                    type="Principal"
                    accountLabel="Principal liability account"
                    accountValue={draft.principalQboAccountId || ""}
                    accounts={liabilityAccounts}
                    accountPlaceholder="Liability account"
                    amount={draft.principalAmount || ""}
                    onAccountChange={(value) => update({ principalQboAccountId: value })}
                    onAmountChange={(value) => update({ principalAmount: value })}
                  />
                  <AllocationRow
                    type="Interest"
                    accountLabel="Interest expense account"
                    accountValue={draft.interestQboAccountId || ""}
                    accounts={expenseAccounts}
                    accountPlaceholder="Select interest account"
                    amount={draft.interestAmount || ""}
                    onAccountChange={(value) => update({ interestQboAccountId: value })}
                    onAmountChange={(value) => update({ interestAmount: value })}
                  />
                  {feeLines.map((line, index) => (
                    <AllocationRow
                      key={line.id || index}
                      type={line.label || "Fee"}
                      accountLabel="Fee expense account"
                      accountValue={line.qboAccountId || ""}
                      accounts={expenseAccounts}
                      accountPlaceholder="Expense account"
                      amount={line.amount || ""}
                      onLabelChange={(value) => updateFeeLine(index, { label: value })}
                      onAccountChange={(value) => updateFeeLine(index, { qboAccountId: value })}
                      onAmountChange={(value) => updateFeeLine(index, { amount: value })}
                      onRemove={() => removeFeeLine(index)}
                    />
                  ))}
                </div>
              </div>
              <button type="button" onClick={() => update({ feeLines: [...feeLines, { id: `fee-${Date.now()}`, label: "Fee", qboAccountId: "", amount: "" }] })} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/12 px-3 py-2 text-sm font-semibold text-white/75 hover:bg-white/5">
                <Plus className="h-4 w-4" />
                Add fee or another line
              </button>
              {!canConfirm ? <ValidationText remainingMinor={remainingMinor} principalMinor={principalMinor} principalAccount={principalAccount} interestMinor={interestMinor} interestAccount={interestAccount} isNewLoan={isNewLoan} draft={draft} /> : null}
            </section>
          </div>
        </div>

        <footer className="shrink-0 border-t border-white/10 bg-[#0d100f]/98 px-6 py-4 backdrop-blur max-[850px]:px-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" disabled={saving || disabled} onClick={onTreatAsRegular} className="rounded-lg px-3 py-2 text-sm font-semibold text-white/65 hover:bg-white/5 disabled:opacity-45">Treat as regular transaction</button>
            <div className="flex items-center gap-2">
              <button type="button" disabled={saving} onClick={requestClose} className="rounded-lg border border-white/12 px-3 py-2 text-sm font-semibold text-white/75 hover:bg-white/5 disabled:opacity-45">Cancel</button>
              <button type="button" disabled={!canConfirm} onClick={confirm} className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/35 bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-500/24 disabled:cursor-not-allowed disabled:opacity-45">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {saving ? "Saving..." : "Confirm split"}
              </button>
            </div>
          </div>
        </footer>
      </section>
      </div>
    </div>,
    document.body
  );
}

function SummaryItem({ label, value, tone, icon: Icon }) {
  const toneClass = tone === "good" ? "text-emerald-200" : tone === "bad" ? "text-rose-300" : tone === "warn" ? "text-amber-200" : tone === "accent" ? "text-emerald-100" : "text-white";
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/36">{label}</div>
      <div className={`mt-1 inline-flex items-center gap-1.5 text-sm font-semibold ${toneClass}`}>
        {Icon ? <Icon className="h-4 w-4" /> : null}
        {value}
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, inputMode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-white/55">{label}</span>
      <input value={value} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-emerald-300/55" />
    </label>
  );
}

function AllocationRow({ type, accountLabel, accountValue, accounts, accountPlaceholder, amount, onLabelChange, onAccountChange, onAmountChange, onRemove }) {
  return (
    <div className="grid grid-cols-[112px_minmax(220px,1fr)_128px_44px] items-center gap-2 px-3 py-3 max-[640px]:grid-cols-1">
      {onLabelChange ? (
        <input value={type} aria-label="Line type" onChange={(event) => onLabelChange(event.target.value)} className="h-10 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 text-sm font-semibold text-white outline-none focus:border-emerald-300/55" />
      ) : (
        <div className="text-sm font-semibold text-white/84">{type}</div>
      )}
      <AccountSelect label={accountLabel} value={accountValue} accounts={accounts} placeholder={accountPlaceholder} onChange={onAccountChange} />
      <input
        value={amount}
        inputMode="decimal"
        placeholder="0.00"
        onChange={(event) => onAmountChange(event.target.value.replace(/[^0-9.]/g, ""))}
        className="h-11 min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 text-right text-sm text-white outline-none placeholder:text-white/35 focus:border-emerald-300/55"
      />
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${type}`} className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/12 text-white/60 hover:bg-white/5">
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function ValidationText({ remainingMinor, principalMinor, principalAccount, interestMinor, interestAccount, isNewLoan, draft }) {
  let message = "";
  if (remainingMinor !== 0) message = remainingMinor < 0 ? `Allocation exceeds payment total by ${formatMoney(Math.abs(remainingMinor))}.` : `${formatMoney(remainingMinor)} remains to be allocated.`;
  else if (principalMinor <= 0) message = "Principal must be greater than zero.";
  else if (!principalAccount) message = "Select the loan liability account for principal.";
  else if (interestMinor > 0 && !interestAccount) message = "Select an expense account for interest.";
  else if (isNewLoan && (!String(draft.lenderName || "").trim() || !String(draft.loanName || "").trim())) message = "Enter the lender and loan name for the new loan.";
  if (!message) return null;
  return <div className="mt-3 text-sm font-medium text-amber-100">{message}</div>;
}
