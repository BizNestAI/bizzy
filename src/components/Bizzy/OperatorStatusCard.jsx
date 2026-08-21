import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getOperatorRequests, submitClarificationAnswers } from "../../services/bookkeeping/bookkeepingClient";
import { ArrowDownLeft, ArrowUpRight, Check } from "lucide-react";

const OPERATOR_REQUEST_PAGE_SIZE = 25;

export default function OperatorStatusCard({
  count = 0,
  onHide,
  businessId,
  onRefresh,
  mockMode = false,
  mockRequests = [],
  requests: externalRequests = null,
  showExpand = true,
  error = "",
}) {
  const effectiveCount = Number(count) > 0
    ? Number(count)
    : Array.isArray(externalRequests)
    ? externalRequests.length
    : mockMode
    ? mockRequests.length
    : 0;
  const hasOpenRequests = effectiveCount > 0;

  const borderColor = "rgba(255, 255, 255, 0.08)";
  const outerShadow = "0 20px 60px rgba(0,0,0,0.45)";

  const QUICK_INTENTS = [
    "Materials",
    "Fuel",
    "Meals",
    "Advertising",
    "Contractor",
    "Software",
    "Tools/Equipment",
    "Rent",
    "Insurance",
    "Taxes",
    "Supplies",
    "Travel",
    "Training",
  ];

  const sortRequestsByDate = (list = []) => {
    return [...list].sort((a, b) => {
      const da = new Date(a?.txn?.date || a?.date || 0).getTime();
      const db = new Date(b?.txn?.date || b?.date || 0).getTime();
      return da - db;
    });
  };

  const formatAmount = (amt) => {
    if (amt === null || amt === undefined || Number.isNaN(Number(amt))) return "";
    const val = Number(amt);
    const formatted = Math.abs(val).toFixed(2);
    return val < 0 ? `($${formatted})` : `$${formatted}`;
  };

  const getMoneyDirection = (amt) => {
    const val = Number(amt);
    if (!Number.isFinite(val) || val === 0) {
      return {
        label: "Neutral",
        tone: "text-white/55 border-white/12 bg-white/[0.04]",
        amountClass: "text-white/70",
        Icon: null,
      };
    }
    if (val < 0) {
      return {
        label: "Money out",
        tone: "text-rose-100/85 border-rose-300/18 bg-rose-300/[0.06]",
        amountClass: "text-rose-100/80",
        Icon: ArrowUpRight,
      };
    }
    return {
      label: "Money in",
      tone: "text-emerald-100/85 border-emerald-300/20 bg-emerald-300/[0.07]",
      amountClass: "text-emerald-100/85",
      Icon: ArrowDownLeft,
    };
  };

  const formatMonthLabel = (reqs) => {
    const first = reqs?.[0];
    const d = new Date(first?.txn?.date || first?.date || "");
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };

  const [expanded, setExpanded] = useState(() => {
    if (mockMode && !externalRequests) return true;
    if (Array.isArray(externalRequests) && externalRequests.length) return true;
    return false;
  });

  const initialRequests = useMemo(() => {
    if (Array.isArray(externalRequests)) return sortRequestsByDate(externalRequests);
    if (mockMode && !externalRequests) return sortRequestsByDate(mockRequests || []);
    return [];
  }, [externalRequests, mockMode, mockRequests]);

  const [requests, setRequests] = useState(initialRequests);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedPage, setLoadedPage] = useState(initialRequests.length ? 1 : 0);
  const [answers, setAnswers] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submittingId, setSubmittingId] = useState(null);
  const scrollElRef = useRef(null);

  const mergeRequests = useCallback((current = [], incoming = []) => {
    const byId = new Map();
    [...current, ...(incoming || [])].forEach((row) => {
      const id = row?.id || row?.transaction_id;
      if (id) byId.set(String(id), row);
    });
    return sortRequestsByDate(Array.from(byId.values()));
  }, []);

  useEffect(() => {
    if (!Array.isArray(externalRequests)) return;
    const signature = externalRequests
      .map((r) => `${r?.transaction_id || r?.id || ""}-${r?.txn?.date || ""}`)
      .join("|");
    setRequests((prev) => {
      const prevSig = prev.map((r) => `${r?.transaction_id || r?.id || ""}-${r?.txn?.date || ""}`).join("|");
      if (signature === prevSig) return prev;
      return sortRequestsByDate(externalRequests || []);
    });
    setLoadedPage(externalRequests.length ? 1 : 0);
    if (externalRequests.length) {
      setExpanded((prev) => prev || true);
    }
  }, [externalRequests]);

  useEffect(() => {
    if (mockMode && !externalRequests) {
      setRequests(sortRequestsByDate(mockRequests || []));
      setExpanded(true);
      return;
    }
    if (externalRequests) return;
    if (!expanded || !businessId) return;
    let alive = true;
    const load = async () => {
      setLoadingList(true);
      try {
        const res = await getOperatorRequests(businessId, { page: 1, page_size: OPERATOR_REQUEST_PAGE_SIZE });
        if (!alive) return;
        const rows = res?.rows || res || [];
        setRequests(sortRequestsByDate(rows));
        setLoadedPage(rows.length ? 1 : 0);
      } catch (e) {
        console.warn("[OperatorStatusCard] fetch clarifications failed", e);
      } finally {
        if (alive) setLoadingList(false);
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, [expanded, businessId, mockMode, mockRequests, externalRequests]);

  const knownPageCount = Math.max(1, Math.ceil(effectiveCount / OPERATOR_REQUEST_PAGE_SIZE));
  const canLoadMore = !mockMode
    && expanded
    && businessId
    && requests.length > 0
    && requests.length < effectiveCount
    && loadedPage < knownPageCount;

  const loadMore = useCallback(async () => {
    if (!canLoadMore || loadingList || loadingMore) return;
    const nextPage = Math.max(loadedPage + 1, 2);
    setLoadingMore(true);
    try {
      const res = await getOperatorRequests(businessId, { page: nextPage, page_size: OPERATOR_REQUEST_PAGE_SIZE });
      const rows = res?.rows || res || [];
      setRequests((prev) => mergeRequests(prev, rows));
      setLoadedPage(Number(res?.meta?.page || nextPage));
    } catch (e) {
      console.warn("[OperatorStatusCard] fetch more clarifications failed", e);
    } finally {
      setLoadingMore(false);
    }
  }, [businessId, canLoadMore, loadedPage, loadingList, loadingMore, mergeRequests]);

  const handleListScroll = useCallback((event) => {
    const el = event.currentTarget;
    if (!el || !canLoadMore || loadingMore) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < 72) {
      loadMore();
    }
  }, [canLoadMore, loadMore, loadingMore]);

  const handleChip = (id, chip) => {
    setAnswers((prev) => {
      const current = (prev[id] || "").trim();
      const next = current.toLowerCase() === chip.toLowerCase() ? "" : chip;
      return { ...prev, [id]: next };
    });
  };
  const handleChange = (id, text) => {
    setAnswers((prev) => ({ ...prev, [id]: text }));
  };

  const readyAnswers = useMemo(() => {
    return requests
      .map((r) => ({
        request_id: r.id,
        transaction_id: r.transaction_id,
        answer_text: (answers[r.id] || "").trim(),
      }))
      .filter((a) => a.answer_text.length >= 3);
  }, [requests, answers]);
  const answeredCount = readyAnswers.length;

  const onSubmit = async () => {
    if (mockMode) {
      setSubmitting(true);
      setTimeout(() => {
        setSubmitting(false);
        setRequests([]);
        setExpanded(false);
        if (onRefresh) onRefresh();
      }, 400);
      return;
    }
    if (!businessId || !readyAnswers.length) return;
    setSubmitting(true);
    try {
      await submitClarificationAnswers(businessId, { answers: readyAnswers });
      setAnswers({});
      if (onRefresh) await onRefresh();
      if (!externalRequests) {
        // refetch to show remaining only when we manage our own list
        const res = await getOperatorRequests(businessId, { page: 1, page_size: 25 });
        const rows = res?.rows || res || [];
        setRequests(sortRequestsByDate(rows));
        if (!rows.length && onRefresh) {
          setExpanded(false);
        }
      }
    } catch (e) {
      console.warn("[OperatorStatusCard] submit failed", e);
    } finally {
      setSubmitting(false);
    }
  };

  const submitOne = async (req) => {
    const answerText = (answers[req.id] || "").trim();
    if (!answerText) return;
    if (mockMode) {
      setSubmittingId(req.id);
      setTimeout(() => {
        setSubmittingId(null);
        setRequests((prev) => prev.filter((r) => r.id !== req.id));
        if (onRefresh) onRefresh();
      }, 250);
      return;
    }
    if (!businessId) return;
    setSubmittingId(req.id);
    try {
      await submitClarificationAnswers(businessId, {
        answers: [
          {
            request_id: req.id,
            transaction_id: req.transaction_id,
            answer_text: answerText,
          },
        ],
      });
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[req.id];
        return next;
      });
      if (onRefresh) await onRefresh();
      setRequests((prev) => prev.filter((r) => r.id !== req.id));
    } catch (e) {
      console.warn("[OperatorStatusCard] submit single failed", e);
  } finally {
      setSubmittingId(null);
    }
  };

  if (!effectiveCount || effectiveCount <= 0) return null;

  const showList = expanded && requests.length > 0;
  const showEmpty = expanded && requests.length === 0 && !loadingList;
  const monthLabel = formatMonthLabel(requests);

  return (
    <div
      className={[
        "bizzy-operator-card relative w-full max-w-4xl mx-auto rounded-2xl md:rounded-3xl border px-6 py-5 text-white",
        hasOpenRequests ? "bizzy-operator-attn" : "",
      ].join(" ")}
      style={{
        background: "rgba(17,19,21,0.9)",
        borderColor,
        boxShadow: `${outerShadow}`,
      }}
    >
      {monthLabel ? (
        <div className="absolute top-4 left-6 text-sm text-white/65 font-medium">
          {monthLabel}
        </div>
      ) : null}

      {onHide ? (
        <button
          type="button"
          onClick={onHide}
          className="group absolute top-3 right-3 text-sm text-white/80 hover:text-white inline-flex items-center gap-1 px-2 py-1 rounded-md bg-transparent"
        >
          <span>Hide</span>
          <span className="text-[10px] translate-y-[1px] opacity-0 group-hover:opacity-100 transition-opacity duration-150">↓</span>
        </button>
      ) : null}

      <div className="flex flex-col items-center justify-center space-y-1 text-center">
        <div className="inline-flex items-center justify-center gap-1.5 text-[10px] tracking-[0.11em] uppercase font-bold bizzy-operator-label">
          <span className="bizzy-operator-dot" aria-hidden="true" />
          <span>Operator Requests</span>
        </div>
        <div className="text-[12px] tracking-[0.26em] uppercase font-semibold text-white/80">
          Questions on your transactions
        </div>
        <div className="text-sm text-white/65">Please tell me what each transaction was for.</div>
      </div>

      {expanded && (
        <div className="mt-5 pt-4 border-t border-white/10">
          {loadingList && <div className="text-xs text-white/60">Loading…</div>}
          {error ? <div className="mb-2 text-xs text-amber-100/85">{error}</div> : null}
          {showList && (
            <div
              ref={scrollElRef}
              onScroll={handleListScroll}
              className="space-y-2 max-h-[300px] overflow-y-auto pr-1 pb-12 scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-900/60"
              style={{ scrollbarColor: "rgba(107,114,128,0.85) rgba(26,28,30,0.7)" }}
            >
              {requests.map((req) => {
                const txn = req.txn || {};
                const memo = txn.name || "";
                const merchant = txn.merchant_name || txn.counterparty_name || "Unknown merchant";
                const answered = (answers[req.id] || "").trim().length >= 3;
                const canSubmit = answered;
                const direction = getMoneyDirection(txn.amount);
                const DirectionIcon = direction.Icon;
                const promptLabel = Number(txn.amount) > 0 ? "What was this deposit for?" : "What was this charge for?";
                return (
                  <div
                    key={req.id}
                    className="rounded-lg border border-white/10 bg-[#151717] px-3 py-1.5 shadow-inner shadow-black/30 transition-transform transition-colors duration-200 hover:-translate-y-[1px] hover:border-emerald-300/22 hover:bg-emerald-300/[0.06] hover:shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
                  >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate text-[15px] text-white font-semibold leading-tight">{merchant}</span>
              </div>
              <div className="text-[11px] text-white/70 flex items-center gap-3">
                {txn.date && <span>{txn.date}</span>}
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none ${direction.tone}`}>
                  {DirectionIcon ? <DirectionIcon size={11} strokeWidth={2.2} aria-hidden="true" /> : null}
                  {direction.label}
                </span>
                <span className={`font-semibold ${direction.amountClass}`}>
                  {txn.amount !== undefined ? formatAmount(txn.amount) : ""}
                </span>
              </div>
              <div className="truncate text-[11px] text-white/60 leading-snug">{memo || "No memo available"}</div>
            </div>
            <div className="w-[300px] max-w-[45%] space-y-1">
              <label className="block text-[10px] uppercase tracking-[0.12em] text-white/60">
                {promptLabel}
              </label>
              <div className="flex items-center gap-2">
                <div className="relative w-full">
                  <input
                    type="text"
                    id={`operator-status-answer-${req.id}`}
                    name={`operator-status-answer-${req.id}`}
                    value={answers[req.id] || ""}
                    onChange={(e) => handleChange(req.id, e.target.value)}
                    placeholder="e.g., materials for Elm St roof"
                    className="bizzy-operator-input h-8 w-full rounded-lg bg-black/40 border border-white/12 px-2.5 pr-8 text-[12px] text-white placeholder-white/30 focus:outline-none"
                  />
                  {answers[req.id] ? (
                    <button
                      type="button"
                      onClick={() => handleChange(req.id, "")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-white/50 hover:text-white/80 text-xs"
                      aria-label="Clear answer"
                      title="Clear"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                {answered ? (
                  <button
                    type="button"
                    onClick={() => submitOne(req)}
                    disabled={submittingId === req.id || !canSubmit}
                    className={`flex items-center justify-center rounded-full h-7 w-7 flex-shrink-0 transition border ${
                      submittingId === req.id || !canSubmit
                        ? "bg-white/8 text-white/35 border-white/10 cursor-not-allowed"
                        : "bg-[rgba(30,180,124,0.16)] text-white border-[rgba(30,180,124,0.34)] hover:shadow-[0_0_10px_rgba(30,180,124,0.20)]"
                    }`}
                    aria-label="Submit"
                    title="Mark handled"
                  >
                    <Check size={15} strokeWidth={2.3} />
                  </button>
                ) : null}
              </div>
                <div
                  className="flex gap-1.5 overflow-x-auto whitespace-nowrap pr-1 pt-0.5 pb-1 -mb-1 scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-900/60"
                  style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(107,114,128,0.85) rgba(26,28,30,0.7)" }}
                >
                  {QUICK_INTENTS.map((chip) => {
                    const active = (answers[req.id] || "").toLowerCase() === chip.toLowerCase();
                    return (
                      <button
                        key={chip}
                                type="button"
                                onClick={() => handleChip(req.id, chip)}
                                className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition border flex-shrink-0 ${
                                  active
                                    ? "bg-emerald-500/15 text-emerald-50 border-emerald-400/50"
                                    : "bg-white/5 text-white/70 border-white/12 hover:border-white/30"
                                }`}
                              >
                                {chip}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {canLoadMore ? (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/65 hover:text-white hover:border-white/20 transition disabled:opacity-50"
                >
                  {loadingMore ? "Loading more…" : `Load more (${requests.length} of ${effectiveCount})`}
                </button>
              ) : requests.length < effectiveCount ? (
                <div className="text-center text-xs text-white/45 py-2">
                  Showing {requests.length} of {effectiveCount}
                </div>
              ) : null}
              <div className="h-10" aria-hidden />
            </div>
          )}
          {showEmpty && (
            <div className="text-center text-white/60 text-sm py-4">No open requests right now.</div>
          )}
          {requests.length > 0 && (
            <div className="mt-4 flex items-center justify-between">
              <div className="text-xs text-white/60">Answered {answeredCount} of {effectiveCount}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onSubmit}
                  disabled={submitting || answeredCount === 0}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition border ${
                    submitting || answeredCount === 0
                      ? "bg-white/10 text-white/40 border-white/10 cursor-not-allowed"
                      : "bg-[rgba(60,255,190,0.10)] text-white border-[rgba(60,255,190,0.30)] hover:shadow-[0_0_18px_rgba(60,255,190,0.20)]"
                  }`}
                >
                  {submitting ? "Submitting…" : "Submit answers"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {!expanded && showExpand ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-4 text-[13px] text-white/60 hover:text-white/80"
        >
          {effectiveCount} remaining transaction{effectiveCount === 1 ? "" : "s"}
        </button>
      ) : null}
    </div>
  );
}
