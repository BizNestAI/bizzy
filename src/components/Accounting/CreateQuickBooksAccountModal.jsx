import React from "react";
import ReactDOM from "react-dom";
import { Check, ChevronDown, Loader2, X } from "lucide-react";

const DEFAULT_ACCOUNT_TYPES = [
  {
    accountType: "Income",
    label: "Income",
    subTypes: [{ value: "ServiceFeeIncome", label: "Service/Fee Income" }],
  },
  {
    accountType: "Other Income",
    label: "Other Income",
    subTypes: [{ value: "OtherMiscellaneousIncome", label: "Other Miscellaneous Income" }],
  },
  {
    accountType: "Expense",
    label: "Expense",
    subTypes: [{ value: "OtherBusinessExpenses", label: "Other Business Expenses" }],
  },
  {
    accountType: "Cost of Goods Sold",
    label: "Cost of Goods Sold",
    subTypes: [{ value: "OtherCostsOfServiceCos", label: "Other Costs of Service" }],
  },
];

function defaultTypeForContext(context = {}) {
  const explicit = Array.isArray(context.allowedAccountTypes) ? context.allowedAccountTypes.filter(Boolean) : [];
  if (explicit.includes("Expense") || explicit.includes("Cost of Goods Sold")) return "Expense";
  if (explicit.includes("Income") || explicit.includes("Other Income")) return "Income";
  const direction = String(context.direction || "").toLowerCase();
  const qboTxnType = String(context.qboTxnType || context.qbo_txn_type || "").replace(/[\s_-]+/g, "").toLowerCase();
  const amount = Number(context.amount ?? context.signed_amount ?? context.signedAmount ?? 0);
  if (direction === "inflow" || direction === "income" || direction === "deposit" || qboTxnType === "deposit" || amount > 0) {
    return "Income";
  }
  if (
    direction === "outflow" ||
    direction === "expense" ||
    direction === "purchase" ||
    qboTxnType === "purchase" ||
    qboTxnType === "creditcardcharge" ||
    amount < 0
  ) {
    return "Expense";
  }
  return "Expense";
}

function preferredSubTypeForAccountType(accountType, subTypes = []) {
  const preferred = {
    Income: "ServiceFeeIncome",
    "Other Income": "OtherMiscellaneousIncome",
    Expense: "OtherBusinessExpenses",
    "Cost of Goods Sold": "OtherCostsOfServiceCos",
  }[accountType];
  return subTypes.find((entry) => entry.value === preferred)?.value || subTypes[0]?.value || "";
}

function friendlyCreateAccountError(error) {
  const code = error?.code || error?.body?.code || error?.body?.error || error?.error || error?.message || "";
  if (code === "qbo_account_already_exists") return "This account already exists in QuickBooks.";
  if (code === "qbo_inactive_account_exists") return "An inactive QuickBooks account with this name already exists.";
  if (code === "invalid_qbo_account_type_detail_type" || code === "invalid_qbo_account_type") {
    return "This QuickBooks account type and detail type cannot be used together.";
  }
  if (code === "quickbooks_reconnect_required") return "QuickBooks needs to be reconnected before creating an account.";
  if (error?.status === 403) return "You do not have permission to create QuickBooks accounts here.";
  return "QuickBooks could not create this account. Please try again.";
}

function focusableElements(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true");
}

function DarkSelect({ label, value, options, onChange }) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const ref = React.useRef(null);
  const buttonId = React.useId();
  const listboxId = React.useId();
  const selected = options.find((entry) => entry.value === value) || options[0] || null;

  React.useEffect(() => {
    const index = Math.max(0, options.findIndex((entry) => entry.value === value));
    setActiveIndex(index);
  }, [options, value]);

  React.useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const selectIndex = React.useCallback((index) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }, [onChange, options]);

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      selectIndex(activeIndex);
    }
  };

  return (
    <label className="block" ref={ref}>
      <span className="text-xs font-medium text-white/65">{label}</span>
      <div className="relative mt-1">
        <button
          id={buttonId}
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/12 bg-black/28 px-3 py-2 text-left text-sm font-medium text-white outline-none transition hover:bg-white/[0.06] focus:border-emerald-300/60 focus:ring-2 focus:ring-emerald-500/20"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={onKeyDown}
        >
          <span className="truncate">{selected?.label || "Select"}</span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-white/50 transition ${open ? "rotate-180 text-emerald-200" : ""}`} />
        </button>
        {open ? (
          <div
            id={listboxId}
            role="listbox"
            aria-labelledby={buttonId}
            tabIndex={-1}
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 max-h-56 overflow-y-auto overscroll-contain rounded-lg border border-emerald-400/25 bg-[#111417] py-1 shadow-[0_18px_42px_rgba(0,0,0,0.7)] scrollbar-thin scrollbar-thumb-[rgba(255,255,255,0.16)] scrollbar-track-transparent"
            style={{ scrollbarColor: "rgba(255,255,255,0.16) transparent" }}
          >
            {options.map((option, index) => {
              const selectedOption = option.value === value;
              const active = index === activeIndex;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selectedOption}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition ${
                    selectedOption
                      ? "bg-emerald-400/12 text-emerald-100"
                      : active
                        ? "bg-white/[0.07] text-white"
                        : "text-white/82 hover:bg-white/[0.06] hover:text-white"
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectIndex(index)}
                >
                  <span className="truncate">{option.label}</span>
                  {selectedOption ? <Check className="h-4 w-4 shrink-0 text-emerald-300" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </label>
  );
}

export default function CreateQuickBooksAccountModal({
  open,
  onClose,
  onCreate,
  accountTypes = DEFAULT_ACCOUNT_TYPES,
  context = {},
  returnFocusRef,
}) {
  const supportedTypes = React.useMemo(() => {
    const source = Array.isArray(accountTypes) && accountTypes.length ? accountTypes : DEFAULT_ACCOUNT_TYPES;
    return DEFAULT_ACCOUNT_TYPES.map((fallback) => {
      const fromCatalog = source.find((entry) => entry.accountType === fallback.accountType);
      return fromCatalog || fallback;
    });
  }, [accountTypes]);
  const defaultAccountType = React.useMemo(() => defaultTypeForContext(context), [context]);
  const [name, setName] = React.useState("");
  const [accountType, setAccountType] = React.useState("");
  const [accountSubType, setAccountSubType] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const wasOpenRef = React.useRef(false);
  const dialogRef = React.useRef(null);
  const nameInputRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const initialType = supportedTypes.find((entry) => entry.accountType === defaultAccountType) || supportedTypes[0] || DEFAULT_ACCOUNT_TYPES[0];
    setAccountType(initialType.accountType);
    setAccountSubType(preferredSubTypeForAccountType(initialType.accountType, initialType.subTypes));
    setName("");
    setDescription("");
    setError("");
    setBusy(false);
  }, [defaultAccountType, open, supportedTypes]);

  React.useEffect(() => {
    if (!open) return;
    if (!supportedTypes.some((entry) => entry.accountType === accountType)) {
      const first = supportedTypes[0] || DEFAULT_ACCOUNT_TYPES[0];
      setAccountType(first.accountType);
      setAccountSubType(preferredSubTypeForAccountType(first.accountType, first.subTypes));
    }
  }, [accountType, open, supportedTypes]);

  const selectedType = supportedTypes.find((entry) => entry.accountType === accountType) || supportedTypes[0] || DEFAULT_ACCOUNT_TYPES[0];
  const subTypes = React.useMemo(() => selectedType.subTypes || [], [selectedType]);

  React.useEffect(() => {
    if (!subTypes.some((entry) => entry.value === accountSubType)) {
      setAccountSubType(preferredSubTypeForAccountType(selectedType.accountType, subTypes));
    }
  }, [accountSubType, selectedType.accountType, subTypes]);

  React.useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const html = document.documentElement;
    const body = document.body;
    const returnFocusNode = returnFocusRef?.current || null;
    const previous = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
    };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      html.style.overflow = previous.htmlOverflow;
      body.style.overflow = previous.bodyOverflow;
      returnFocusNode?.focus?.();
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  const closeModal = () => {
    if (busy) return;
    onClose?.();
  };

  const onDialogKeyDownCapture = (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      if (!busy) onClose?.();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = focusableElements(dialogRef.current);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await onCreate?.({
        name,
        accountType,
        accountSubType,
        description,
      });
      if (result?.ok === false && result?.expected) {
        setError(friendlyCreateAccountError(result));
        setBusy(false);
        return;
      }
      const account = result?.account || result;
      if (!account?.id) throw new Error("qbo_create_missing_id");
      onClose?.(account);
    } catch (err) {
      setError(friendlyCreateAccountError(err));
      setBusy(false);
    }
  };

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[2147483000] flex items-center justify-center overflow-y-auto bg-black/70 px-4 py-6"
      data-qbo-account-modal="true"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) closeModal();
      }}
      onKeyDownCapture={onDialogKeyDownCapture}
    >
      <form
        ref={dialogRef}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="qbo-account-create-title"
        className="w-full max-w-md rounded-xl border border-emerald-400/25 bg-[#101315] p-4 shadow-[0_24px_60px_rgba(0,0,0,0.65)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200/75">QuickBooks</div>
            <div id="qbo-account-create-title" className="mt-1 text-base font-semibold text-white">Add new account</div>
          </div>
          <button type="button" onClick={closeModal} disabled={busy} className="rounded-lg p-1.5 text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-50" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-white/65">Account Name</span>
            <input
              autoFocus
              ref={nameInputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
              className="mt-1 w-full rounded-lg border border-white/12 bg-black/28 px-3 py-2 text-sm text-white outline-none focus:border-emerald-300/60"
            />
          </label>

          <DarkSelect
            label="Account Type"
            value={accountType}
            options={supportedTypes.map((entry) => ({ value: entry.accountType, label: entry.label || entry.accountType }))}
            onChange={setAccountType}
          />

          <DarkSelect
            label="Detail Type"
            value={accountSubType}
            options={subTypes}
            onChange={setAccountSubType}
          />

          <label className="block">
            <span className="text-xs font-medium text-white/65">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              className="mt-1 w-full resize-none rounded-lg border border-white/12 bg-black/28 px-3 py-2 text-sm text-white outline-none focus:border-emerald-300/60"
            />
          </label>

          {error ? (
            <div className="rounded-lg border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-xs font-medium text-amber-100">
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-white/10 pt-3">
          <button type="button" onClick={closeModal} disabled={busy} className="rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-sm font-semibold text-white/70 hover:bg-white/[0.08] disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim() || !accountSubType} className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/25 bg-emerald-400/15 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-400/20 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create Account
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
