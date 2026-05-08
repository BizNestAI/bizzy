import React from "react";
import ReactDOM from "react-dom";

const ENABLE_QBO_ADD_STUB = false;
const ROW_HOVER_BG = "#1A1D1C";
const DIVIDER_COLOR = "rgba(255,255,255,0.06)";
const MIN_COL_WIDTHS = [36, 90, 160, 140, 150, 100, 170]; // px floors per column

function CoaDropdown({ value, suggestedId, suggestedName, accounts, onChange, status, disabled }) {
  const [open, setOpen] = React.useState(false);
  const [renderMenu, setRenderMenu] = React.useState(false);
  const ref = React.useRef(null);
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
      if (buckets[a.type]) buckets[a.type].push(a);
      else buckets.other.push(a);
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
        type="button"
        disabled={disabled}
        onClick={(e) => {
          if (disabled) return;
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`w-full rounded-xl border border-[var(--accent-line)] bg-[var(--panel)] px-3 py-2 pr-9 text-[11px] font-medium text-slate-50 shadow-[0_6px_18px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.03)] outline-none transition text-left ${
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
                            setOpen(false);
                          }}
                        >
                          <span className="truncate flex flex-col leading-tight">
                            <span className="truncate">{acct.name}</span>
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
  readOnly = false,
}) {
  // Column widths (px) — draggable like QuickBooks
  const [colWidths, setColWidths] = React.useState([36, 90, 220, 160, 170, 100, 180]);
  const containerRef = React.useRef(null);
  const scrollAreaRef = React.useRef(null);
  const [containerWidth, setContainerWidth] = React.useState(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = React.useState(false);
  const [horizontalScrollActive, setHorizontalScrollActive] = React.useState(false);
  const scrollFadeTimerRef = React.useRef(null);
  const dragRef = React.useRef(null); // { index, startX, start }
  const gridTemplate = React.useMemo(() => colWidths.map((w) => `${w}px`).join(" "), [colWidths]);
  const totalGridWidth = React.useMemo(() => colWidths.reduce((sum, width) => sum + width, 0), [colWidths]);

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
    const min = MIN_COL_WIDTHS[index] || 60;
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
  const [sort, setSort] = React.useState({ column: null, direction: null }); // direction: 'asc' | 'desc' | null

  React.useEffect(() => {
    let changed = false;
    const next = new Map(accountSelections);
    transactions.forEach((txn) => {
      const suggested = txn.glAccountId || txn.suggestedAccountId || "";
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

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
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
            {["date", "description", "payee", "account", "total", "action"].map((key, idx) => {
              const labelMap = { date: "Date", description: "Description", payee: "Payee/Customer", account: "Account", total: "Total", action: "Action" };
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

          {sortedTransactions.map((txn, idx) => {
            const payeeConfidence = txn.payeeConfidence || txn.counterparty_confidence || txn.confidence || null;
            const showAddToQbo =
              ENABLE_QBO_ADD_STUB &&
              txn.vendor &&
              !txn.qboEntityId &&
              payeeConfidence === "high";
            const isPosted = txn.status === "posted";

            return (
              <div
                key={txn.id}
                className="grid items-center px-3 py-3 text-[11px] text-slate-100 border-b divide-x divide-[rgba(255,255,255,0.06)] transition-colors"
                style={{
                  background: panelBg,
                  borderColor: panelBorder,
                  transition: "background 120ms ease",
                  gridTemplateColumns: gridTemplate,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = ROW_HOVER_BG)}
                onMouseLeave={(e) => (e.currentTarget.style.background = panelBg)}
              >
              <div className="flex items-center justify-center">
                <input
                  type="checkbox"
                  disabled={isPosted || readOnly}
                  checked={selectedIds.has(txn.id)}
                  onChange={() => {
                    if (isPosted || readOnly) return;
                    toggleRow(txn.id);
                  }}
                  className={`${checkboxClasses} ${(isPosted || readOnly) ? "opacity-50 cursor-not-allowed" : ""}`}
                  title={isPosted ? "Already posted to QuickBooks." : readOnly ? "Billing required to edit transactions." : undefined}
                />
              </div>
              <div className="text-slate-300 truncate">{fmtDate(txn.date)}</div>
              <div className="min-w-0 pl-2 text-[10px] font-medium text-slate-50 truncate leading-tight whitespace-nowrap" title={txn.description || ""}>
                <div className="flex items-center gap-2">
                  <span className="truncate">{txn.description || "—"}</span>
                  {txn.is_check ? (
                    <span
                      className="inline-flex items-center rounded-full border border-slate-500/70 bg-white/5 px-2 py-[1px] text-[9px] font-semibold text-slate-100"
                      title="Checks often don’t include vendor details. Bizzi needs one quick clarification."
                    >
                      Check
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
              <div className="flex items-center gap-1 text-slate-200 text-[11px] leading-tight whitespace-nowrap overflow-visible relative z-[120]">
                {isPosted ? (
                  <span className="inline-flex items-center rounded-full px-2 py-[2px] text-[10px] font-semibold bg-emerald-500/10 text-emerald-200 border border-emerald-500/40">
                    Posted to QuickBooks
                  </span>
                ) : null}
                {accounts.length > 0 ? (
                  <CoaDropdown
                    value={accountSelections.get(txn.id) ?? txn.glAccountId ?? txn.suggestedAccountId ?? txn.accountId ?? ""}
                    suggestedId={txn.suggestedAccountId}
                    suggestedName={txn.suggestedAccountName || txn.glAccountName}
                    accounts={accounts}
                    status={txn.status}
                    disabled={
                      isPosted ||
                      txn.status === "failed" ||
                      (["approved", "auto_approved"].includes(txn.status) && !txn.canEdit) ||
                      readOnly
                    }
                    onChange={(id) => handleAccountSelect(txn.id, id)}
                  />
                ) : (
                  <span className="text-slate-400 text-[11px] truncate">{txn.currentAccount}</span>
                )}
              </div>
              <div
                className={`text-right font-semibold whitespace-nowrap ${
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
              <div className="flex justify-center">
                {isPosted ? (
                  <span className="text-[10px] text-slate-400">Posted</span>
                ) : ["approved", "auto_approved", "failed"].includes(txn.status) ? (
                  <>
                    <button
                      className="inline-flex items-center justify-center rounded-full border border-amber-300/60 bg-amber-500/15 px-2 py-[3px] text-[10px] font-medium text-amber-100 hover:bg-amber-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={readOnly}
                      onClick={() => {
                        if (readOnly) return;
                        onUndo && onUndo(txn.id);
                      }}
                    >
                      Undo
                    </button>
                    {txn.status === "auto_approved" ? (
                      <span className="ml-2 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-[2px] text-[9px] font-semibold text-emerald-100">
                        Auto-approved
                      </span>
                    ) : null}
                  </>
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
                    onApprove && onApprove(txn.id, accountSelections.get(txn.id) ?? txn.glAccountId ?? txn.suggestedAccountId ?? null);
                  }}
                  aria-label="Approve transaction"
                >
                  ✓
                </button>
                )}
             </div>
           </div>
          );
          })}
        </div>
      </div>
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
 
