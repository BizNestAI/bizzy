import React, { useEffect, useMemo, useState } from "react";
import { getClarificationRequests, submitClarificationAnswers } from "../../services/bookkeeping/bookkeepingClient";
import { Check } from "lucide-react";

export default function OperatorStatusCard({
  count = 0,
  onReview,
  onHide,
  loading = false,
  subtitle,
  ctaLabel = "Review now \u2192",
  businessId,
  onRefresh,
  mockMode = false,
  mockRequests = [],
  requests: externalRequests = null,
  showExpand = true,
}) {
  const effectiveCount = Array.isArray(externalRequests)
    ? externalRequests.length
    : Number(count) > 0
    ? Number(count)
    : mockMode
    ? mockRequests.length
    : 0;
  const hasOpenRequests = effectiveCount > 0;
  if (!effectiveCount || effectiveCount <= 0) return null;
  const hasItems = effectiveCount > 0;
  const title = "Bizzi needs clarification";
  const sub = subtitle || `${effectiveCount} transaction${effectiveCount === 1 ? "" : "s"} need clarification`;

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
  const [answers, setAnswers] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submittingId, setSubmittingId] = useState(null);

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
        const res = await getClarificationRequests(businessId, { limit: 200 });
        if (!alive) return;
        const rows = res?.rows || res || [];
        setRequests(sortRequestsByDate(rows));
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
        const res = await getClarificationRequests(businessId, { limit: 200 });
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

  const showList = expanded && requests.length > 0;
  const showEmpty = expanded && requests.length === 0 && !loadingList;
  const monthLabel = formatMonthLabel(requests);

  return (
    <div
      className={[
        "bizzy-operator-card relative w-full max-w-4xl mx-auto rounded-2xl md:rounded-3xl border px-6 py-5 text-white",
        hasOpenRequests ? "bizzy-operator-attn bizzy-ai-pulse" : "",
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
        <div className="text-[11px] tracking-[0.3em] uppercase font-semibold bizzy-operator-label">
          <span className="bizzy-operator-dot">●</span> Operator Requests
        </div>
        <div className="text-[12px] tracking-[0.26em] uppercase font-semibold text-white/80">
          Questions on your transactions
        </div>
        <div className="text-sm text-white/65">Please tell me what each transaction was for.</div>
      </div>

      {expanded && (
        <div className="mt-5 pt-4 border-t border-white/10">
          {loadingList && <div className="text-xs text-white/60">Loading…</div>}
          {showList && (
            <div
              className="space-y-3 max-h-[320px] overflow-y-auto pr-1 pb-20 scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-900/60"
              style={{ scrollbarColor: "rgba(107,114,128,0.85) rgba(26,28,30,0.7)" }}
            >
              {requests.map((req) => {
                const txn = req.txn || {};
                const memo = txn.name || "";
                const merchant = txn.merchant_name || txn.counterparty_name || "Unknown merchant";
                const answered = (answers[req.id] || "").trim().length >= 3;
                const canSubmit = answered;
                return (
                  <div
                    key={req.id}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 shadow-inner shadow-black/30 transition-transform transition-colors duration-200 hover:-translate-y-[1px] hover:border-white/20 hover:bg-white/8 hover:shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
                  >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-white font-semibold">{merchant}</span>
              </div>
              <div className="text-[11px] text-white/70 flex items-center gap-3">
                {txn.date && <span>{txn.date}</span>}
                <span>{txn.amount !== undefined ? formatAmount(txn.amount) : ""}</span>
              </div>
              <div className="text-xs text-white/60 leading-snug">{memo || "No memo available"}</div>
            </div>
            <div className="w-[240px] space-y-1.5">
              <label className="block text-[10px] uppercase tracking-[0.12em] text-white/60">
                What was this charge for?
              </label>
              <div className="flex items-center gap-2">
                <div className="relative w-full">
                  <input
                    type="text"
                    value={answers[req.id] || ""}
                    onChange={(e) => handleChange(req.id, e.target.value)}
                    placeholder="e.g., materials for Elm St roof"
                    className="bizzy-operator-input w-full rounded-lg bg-black/40 border border-white/12 px-3 py-1.5 pr-8 text-[13px] text-white placeholder-white/30 focus:outline-none"
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
                    className={`flex items-center justify-center rounded-full h-8 w-8 transition border ${
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
                  className="flex gap-1.5 overflow-x-auto whitespace-nowrap pr-1 pt-0.5 pb-2 -mb-2 scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-900/60"
                  style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(107,114,128,0.85) rgba(26,28,30,0.7)" }}
                >
                  {QUICK_INTENTS.map((chip) => {
                    const active = (answers[req.id] || "").toLowerCase() === chip.toLowerCase();
                    return (
                      <button
                        key={chip}
                                type="button"
                                onClick={() => handleChip(req.id, chip)}
                                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition border flex-shrink-0 ${
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
              <div className="h-10" aria-hidden />
            </div>
          )}
          {showEmpty && (
            <div className="text-center text-white/60 text-sm py-4">No open requests right now.</div>
          )}
          {requests.length > 0 && (
            <div className="mt-4 flex items-center justify-between">
              <div className="text-xs text-white/60">Answered {answeredCount} of {requests.length}</div>
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
