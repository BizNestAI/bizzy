import React from "react";
import { Loader2, X } from "lucide-react";

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

const EXPENSE_TYPES = new Set(["Expense", "Cost of Goods Sold"]);
const INCOME_TYPES = new Set(["Income", "Other Income"]);

function typeSetForContext(context = {}) {
  const explicit = Array.isArray(context.allowedAccountTypes) ? context.allowedAccountTypes.filter(Boolean) : [];
  if (explicit.length) return new Set(explicit);
  const direction = String(context.direction || "").toLowerCase();
  const qboTxnType = String(context.qboTxnType || context.qbo_txn_type || "").replace(/[\s_-]+/g, "").toLowerCase();
  const amount = Number(context.amount ?? context.signed_amount ?? context.signedAmount ?? 0);
  if (direction === "inflow" || direction === "income" || direction === "deposit" || qboTxnType === "deposit" || amount > 0) {
    return INCOME_TYPES;
  }
  if (
    direction === "outflow" ||
    direction === "expense" ||
    direction === "purchase" ||
    qboTxnType === "purchase" ||
    qboTxnType === "creditcardcharge" ||
    amount < 0
  ) {
    return EXPENSE_TYPES;
  }
  return null;
}

function friendlyCreateAccountError(error) {
  const code = error?.body?.error || error?.error || error?.message || "";
  if (code === "qbo_account_already_exists") return "This account already exists in QuickBooks.";
  if (code === "qbo_inactive_account_exists") return "An inactive QuickBooks account with this name already exists.";
  if (code === "invalid_qbo_account_type_detail_type" || code === "invalid_qbo_account_type") {
    return "This QuickBooks account type and detail type cannot be used together.";
  }
  if (code === "quickbooks_reconnect_required") return "QuickBooks needs to be reconnected before creating an account.";
  if (error?.status === 403) return "You do not have permission to create QuickBooks accounts here.";
  return "QuickBooks could not create this account. Please try again.";
}

export default function CreateQuickBooksAccountModal({
  open,
  onClose,
  onCreate,
  accountTypes = DEFAULT_ACCOUNT_TYPES,
  context = {},
  allowShowAll = false,
}) {
  const contextTypeSet = React.useMemo(() => typeSetForContext(context), [context]);
  const [showAll, setShowAll] = React.useState(false);
  const visibleTypes = React.useMemo(() => {
    const source = Array.isArray(accountTypes) && accountTypes.length ? accountTypes : DEFAULT_ACCOUNT_TYPES;
    if (showAll || !contextTypeSet) return source;
    return source.filter((entry) => contextTypeSet.has(entry.accountType));
  }, [accountTypes, contextTypeSet, showAll]);
  const [name, setName] = React.useState("");
  const [accountType, setAccountType] = React.useState("");
  const [accountSubType, setAccountSubType] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const first = visibleTypes[0] || DEFAULT_ACCOUNT_TYPES[0];
    setAccountType(first.accountType);
    setAccountSubType(first.subTypes?.[0]?.value || "");
    setName("");
    setDescription("");
    setError("");
    setBusy(false);
  }, [open, visibleTypes]);

  React.useEffect(() => {
    if (!open) return;
    if (!visibleTypes.some((entry) => entry.accountType === accountType)) {
      const first = visibleTypes[0] || DEFAULT_ACCOUNT_TYPES[0];
      setAccountType(first.accountType);
      setAccountSubType(first.subTypes?.[0]?.value || "");
    }
  }, [accountType, open, visibleTypes]);

  const selectedType = visibleTypes.find((entry) => entry.accountType === accountType) || visibleTypes[0] || DEFAULT_ACCOUNT_TYPES[0];
  const subTypes = React.useMemo(() => selectedType.subTypes || [], [selectedType]);

  React.useEffect(() => {
    if (!subTypes.some((entry) => entry.value === accountSubType)) {
      setAccountSubType(subTypes[0]?.value || "");
    }
  }, [accountSubType, subTypes]);

  if (!open) return null;

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
      const account = result?.account || result;
      if (!account?.id) throw new Error("qbo_create_missing_id");
      onClose?.(account);
    } catch (err) {
      setError(friendlyCreateAccountError(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 px-4 py-6" onMouseDown={(event) => event.stopPropagation()}>
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-emerald-400/25 bg-[#101315] p-4 shadow-[0_24px_60px_rgba(0,0,0,0.65)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200/75">QuickBooks</div>
            <div className="mt-1 text-base font-semibold text-white">Add new account</div>
          </div>
          <button type="button" onClick={() => onClose?.()} className="rounded-lg p-1.5 text-white/55 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-white/65">Account Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
              className="mt-1 w-full rounded-lg border border-white/12 bg-black/28 px-3 py-2 text-sm text-white outline-none focus:border-emerald-300/60"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-white/65">Account Type</span>
            <select
              value={accountType}
              onChange={(event) => setAccountType(event.target.value)}
              className="mt-1 w-full rounded-lg border border-white/12 bg-black/28 px-3 py-2 text-sm text-white outline-none focus:border-emerald-300/60"
            >
              {visibleTypes.map((entry) => (
                <option key={entry.accountType} value={entry.accountType}>{entry.label || entry.accountType}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-white/65">Detail Type</span>
            <select
              value={accountSubType}
              onChange={(event) => setAccountSubType(event.target.value)}
              className="mt-1 w-full rounded-lg border border-white/12 bg-black/28 px-3 py-2 text-sm text-white outline-none focus:border-emerald-300/60"
            >
              {subTypes.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-white/65">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              className="mt-1 w-full resize-none rounded-lg border border-white/12 bg-black/28 px-3 py-2 text-sm text-white outline-none focus:border-emerald-300/60"
            />
          </label>

          {allowShowAll && contextTypeSet ? (
            <label className="flex items-center gap-2 text-xs text-white/65">
              <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
              Show all P&L account types
            </label>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 text-xs font-medium text-amber-100">
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-white/10 pt-3">
          <button type="button" onClick={() => onClose?.()} disabled={busy} className="rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-sm font-semibold text-white/70 hover:bg-white/[0.08] disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim() || !accountSubType} className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/25 bg-emerald-400/15 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-400/20 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create Account
          </button>
        </div>
      </form>
    </div>
  );
}
