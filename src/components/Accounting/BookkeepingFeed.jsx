import React from "react";
import ReactDOM from "react-dom";

function CoaDropdown({ value, suggestedId, accounts, onChange }) {
  const [open, setOpen] = React.useState(false);
  const [renderMenu, setRenderMenu] = React.useState(false);
  const ref = React.useRef(null);
  const menuRef = React.useRef(null);
  const [menuPos, setMenuPos] = React.useState(null);

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
    const buckets = {
      income: [],
      expense: [],
      equity: [],
      other: [],
    };
    accounts.forEach((a) => {
      if (buckets[a.type]) buckets[a.type].push(a);
      else buckets.other.push(a);
    });
    return [
      { label: "Revenue", items: buckets.income },
      { label: "Expenses", items: buckets.expense },
      { label: "Equity", items: buckets.equity },
      { label: "Other", items: buckets.other },
    ].filter((s) => s.items.length);
  }, [accounts]);

  const currentLabel = accounts.find((a) => a.id === value)?.name || value || "Select account";
  const isSuggested = suggestedId && value === suggestedId;

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
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="w-full rounded-xl border border-[var(--accent-line)] bg-[var(--panel)] px-3 py-2 pr-9 text-[11px] font-medium text-slate-50 shadow-[0_6px_18px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.03)] outline-none transition focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-500/30 text-left"
      >
        <div className="flex items-center gap-2">
          {isSuggested ? <span className="text-[10px] px-2 py-[2px] rounded-full border border-emerald-400/40 bg-emerald-500/10 text-emerald-200">Suggested</span> : null}
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
              <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: "inherit" }}>
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
                            setOpen(false);
                          }}
                        >
                          <span className="truncate">{acct.name}</span>
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

export default function BookkeepingFeed({
  transactions,
  selectedIds,
  allSelected,
  toggleSelectAll,
  toggleRow,
  onApprove,
  onUndo,
  accounts = [],
  onAccountChange,
  panelBg,
  panelBorder,
  page = 1,
  pageCount = 1,
  onPageChange,
  pageSize,
  totalCount,
}) {
  const colTemplate = "grid-cols-[32px_120px_1.4fr_1.1fr_170px_110px_90px]";
  const checkboxClasses =
    "relative h-4 w-4 appearance-none rounded border border-[var(--accent-line)] bg-[var(--panel)] text-emerald-500 shadow-inner transition-colors duration-150 outline-none " +
    "focus:ring-2 focus:ring-emerald-500/40 focus:ring-offset-0 focus:ring-offset-transparent " +
    "checked:bg-emerald-500 checked:border-emerald-300 checked:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.28)] " +
    "after:pointer-events-none after:absolute after:content-[''] after:h-2 after:w-1 after:border-b-2 after:border-r-2 after:border-white after:rotate-45 after:left-[6px] after:top-[2px] after:opacity-0 after:transition-opacity " +
    "checked:after:opacity-100";
  const [accountSelections, setAccountSelections] = React.useState(() => new Map());

  React.useEffect(() => {
    let changed = false;
    const next = new Map(accountSelections);
    transactions.forEach((txn) => {
      const suggested = txn.glAccountId || txn.suggestedAccountId || txn.accountId || "";
      if (!next.has(txn.id) || next.get(txn.id) !== suggested) {
        next.set(txn.id, suggested);
        changed = true;
      }
    });
    if (changed) setAccountSelections(next);
  }, [transactions]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAccountSelect = (txnId, accountId) => {
    setAccountSelections((prev) => {
      const next = new Map(prev);
      next.set(txnId, accountId);
      return next;
    });
    if (onAccountChange) onAccountChange(txnId, accountId);
  };

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
  };

  return (
    <div className="mt-2 rounded-xl border overflow-visible relative" style={{ background: panelBg, borderColor: panelBorder }}>
      <div
        className={`grid ${colTemplate} text-[11px] uppercase tracking-wide text-slate-400 border-b px-3 py-2.5 divide-x divide-slate-800/60`}
        style={{ background: panelBg, borderColor: panelBorder }}
      >
        <div className="flex items-center justify-center">
          <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className={checkboxClasses} />
        </div>
        <div>Date</div>
        <div>Description</div>
        <div>Payee/Customer</div>
        <div>Account</div>
        <div className="text-right">Total</div>
        <div className="text-center">Action</div>
      </div>

      {transactions.map((txn, idx) => (
        <div
          key={txn.id}
          className={`grid ${colTemplate} items-center px-3 py-3 text-[11px] text-slate-100 border-b divide-x divide-slate-800/50 ${idx % 2 === 0 ? "bg-slate-900/20" : "bg-transparent"}`}
          style={{
            background: panelBg,
            borderColor: panelBorder,
            transition: "background 120ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(26,24,22,0.82)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = panelBg)}
        >
          <div className="flex items-center justify-center">
            <input
              type="checkbox"
              checked={selectedIds.has(txn.id)}
              onChange={() => toggleRow(txn.id)}
              className={checkboxClasses}
            />
          </div>
          <div className="text-slate-300 truncate">{fmtDate(txn.date)}</div>
          <div className="min-w-0 text-[10px] font-medium text-slate-50 truncate leading-tight whitespace-nowrap" title={txn.description || txn.vendor}>
            {txn.description || txn.vendor}
          </div>
          <div className="min-w-0 text-slate-400 truncate leading-tight whitespace-nowrap" title={txn.vendor}>
            {txn.vendor}
          </div>
          <div className="flex items-center gap-1 text-slate-200 text-[11px] leading-tight whitespace-nowrap overflow-visible relative z-[120]">
            {accounts.length > 0 ? (
              <CoaDropdown
                value={accountSelections.get(txn.id) ?? txn.glAccountId ?? txn.suggestedAccountId ?? txn.accountId ?? ""}
                suggestedId={txn.suggestedAccountId}
                accounts={accounts}
                onChange={(id) => handleAccountSelect(txn.id, id)}
              />
            ) : (
              <span className="text-slate-400 text-[11px] truncate">{txn.currentAccount}</span>
            )}
          </div>
          <div className={`text-right font-semibold whitespace-nowrap ${txn.amount < 0 ? "text-rose-400" : "text-emerald-400"}`}>
            {txn.amount < 0 ? "-" : "+"}${Math.abs(txn.amount).toFixed(2)}
          </div>
          <div className="flex justify-center">
            {txn.status === "approved" ? (
              <button
                className="inline-flex items-center justify-center rounded-full border border-amber-300/60 bg-amber-500/15 px-2 py-[3px] text-[10px] font-medium text-amber-100 hover:bg-amber-500/25"
                onClick={() => onUndo && onUndo(txn.id)}
              >
                Undo
              </button>
            ) : (
              <button
                className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-1.5 py-[2px] text-[10px] font-medium text-slate-950 hover:bg-emerald-400"
                onClick={() => onApprove(txn.id)}
              >
                Approve
              </button>
            )}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between px-3 py-2 text-[10px] text-slate-400">
        <span>
          {totalCount ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, totalCount)} of ${totalCount}` : null}
        </span>
        <div className="flex items-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => onPageChange && onPageChange(page - 1)}
            className="h-6 w-6 rounded border border-slate-700 text-slate-200 disabled:opacity-40 flex items-center justify-center"
          >
            ‹
          </button>
          <span className="px-2 py-1 rounded border border-slate-700 text-slate-100">{page}</span>
          <button
            disabled={page >= pageCount}
            onClick={() => onPageChange && onPageChange(page + 1)}
            className="h-6 w-6 rounded border border-slate-700 text-slate-200 disabled:opacity-40 flex items-center justify-center"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
