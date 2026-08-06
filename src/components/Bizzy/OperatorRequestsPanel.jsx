import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  getClarificationRequests,
  submitClarificationAnswers,
  snoozeClarifications,
} from "../../services/bookkeeping/bookkeepingClient";

const CHIPS = ["Materials", "Fuel", "Meals", "Advertising", "Tools/Equipment", "Software", "Travel", "Other"];
const QUICK_INTENTS = ["Materials", "Fuel", "Meals", "Advertising", "Contractor", "Software"];

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function formatAmount(amount) {
  const num = Number(amount || 0);
  const sign = num < 0 ? "-" : "";
  return `${sign}${currency.format(Math.abs(num))}`;
}

function formatDate(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ClarificationModal({ open, onClose, requests = [], businessId, onSubmitted }) {
  const [answers, setAnswers] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    if (open) {
      setAnswers({});
      setSuccessMsg("");
    }
  }, [open]);

  const handleChange = (id, text) => {
    setAnswers((prev) => ({ ...prev, [id]: text }));
  };

  const handleChip = (id, chip) => {
    setAnswers((prev) => ({ ...prev, [id]: chip }));
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

  const answeredCount = useMemo(() => readyAnswers.length, [readyAnswers]);

  const onSubmit = async () => {
    if (!businessId || !readyAnswers.length) return;
    setSubmitting(true);
    setSuccessMsg("");
    try {
      await submitClarificationAnswers(businessId, { answers: readyAnswers });
      setSuccessMsg("Saved. Bizzi will categorize and learn this vendor.");
      await onSubmitted?.();
      setAnswers({});
    } catch (e) {
      console.warn("[OperatorRequests] submit failed", e);
    } finally {
      setSubmitting(false);
    }
  };

  const onSnooze = async (hours = 24) => {
    const ids = requests.map((r) => r.id);
    if (!ids.length || !businessId) return;
    try {
      await snoozeClarifications(businessId, { request_ids: ids, hours });
      await onSubmitted?.();
    } catch (e) {
      console.warn("[OperatorRequests] snooze failed", e);
    }
  };

  const totalCount = requests?.length || 0;
  const openCount = Math.max(totalCount - answeredCount, 0);

  const modal = (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[20000] flex items-start justify-center px-4 pb-10 pt-12 md:pt-16"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          <motion.div
            className="absolute inset-0 bg-[rgba(0,0,0,0.55)] backdrop-blur-[10px]"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          />
          <motion.div
            className="relative w-full max-w-[900px] rounded-[18px] text-white border flex flex-col overflow-hidden pointer-events-auto"
            style={{
              background: "linear-gradient(180deg, rgba(24,26,28,0.92), rgba(16,18,20,0.92))",
              borderColor: "rgba(60,255,190,0.18)",
              boxShadow: "0 30px 90px rgba(0,0,0,0.55)",
              maxHeight: "80vh",
            }}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
        <div className="flex items-start justify-between px-6 py-5 border-b border-white/10 shrink-0">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-200/80">Operator requests</div>
            <div className="text-xl font-semibold mt-1">Bizzi needs quick clarifications</div>
            <div className="text-sm text-white/70">
              Answer these so I can finish categorizing and keep your books clean.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {totalCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-white/5 bg-white/5">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80">
              <span className={`inline-block h-2 w-2 rounded-full ${openCount > 0 ? "bg-emerald-300" : "bg-white/50"}`} />
              <span>Open: {openCount}</span>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              Answered: {answeredCount}
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              Estimated time: ~2 min
            </div>
            <div className="flex-1 min-w-[120px]">
              <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-400/80 transition-all"
                  style={{ width: `${Math.min(100, Math.round((answeredCount / totalCount) * 100))}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] text-white/60">Answered {answeredCount} of {totalCount}</div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {requests.map((req) => {
            const txn = req.txn || {};
            const memo = txn.name || "";
            const merchant = txn.merchant_name || txn.counterparty_name || "";
            const answered = (answers[req.id] || "").trim().length >= 3;
            return (
              <div
                key={req.id}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 shadow-inner shadow-black/30"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-semibold">{merchant || "Unknown merchant"}</span>
                      <span className={`text-[11px] rounded-full px-2 py-0.5 border ${answered ? "border-emerald-300/60 text-emerald-200 bg-emerald-400/10" : "border-white/15 text-white/60 bg-white/5"}`}>
                        {answered ? "Answered" : "Needs input"}
                      </span>
                    </div>
                    <div className="text-xs text-white/70 flex items-center gap-3">
                      {txn.date && <span>{formatDate(txn.date)}</span>}
                      <span>{formatAmount(txn.amount)}</span>
                    </div>
                    <div className="text-sm text-white/60 leading-snug">{memo || "No memo available"}</div>
                  </div>
                  <div className="w-[220px] space-y-2">
                    <label className="block text-[11px] uppercase tracking-[0.12em] text-white/60">
                      What was this for?
                    </label>
                    <input
                      type="text"
                      id={`operator-request-answer-${req.id}`}
                      name={`operator-request-answer-${req.id}`}
                      value={answers[req.id] || ""}
                      onChange={(e) => handleChange(req.id, e.target.value)}
                      placeholder="e.g., materials for Elm St roof"
                      className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-cyan-400 focus:outline-none"
                    />
                    <div className="flex flex-wrap gap-2">
                      {QUICK_INTENTS.map((chip) => {
                        const active = (answers[req.id] || "").toLowerCase() === chip.toLowerCase();
                        return (
                          <button
                            key={chip}
                            type="button"
                            onClick={() => handleChip(req.id, chip)}
                            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition border ${
                              active
                                ? "bg-cyan-500/20 text-cyan-100 border-cyan-400/50"
                                : "bg-white/5 text-white/70 border-white/10 hover:border-white/30"
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

          {requests.length === 0 && (
            <div className="text-center text-white/70 py-10 text-sm flex flex-col items-center gap-2">
              <div className="h-10 w-10 rounded-full bg-emerald-400/10 border border-emerald-300/30 flex items-center justify-center text-emerald-200 text-lg">
                ✓
              </div>
              <div className="text-base font-semibold text-white">All caught up</div>
              <div className="text-sm text-white/60">I’ll surface anything that needs your input the moment it appears.</div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
          <div className="text-xs text-white/60">
            {successMsg ? <span className="text-emerald-300">{successMsg}</span> : "Tip: Submit everything in one pass — Bizzi learns your vendor patterns."}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onSnooze(24)}
              className="px-3 py-2 text-sm rounded-lg border border-white/15 bg-white/5 text-white/70 hover:border-white/30 transition"
            >
              Remind me later
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={submitting || readyAnswers.length === 0}
              title={readyAnswers.length === 0 ? "Nothing to submit" : undefined}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition border ${
                submitting || readyAnswers.length === 0
                  ? "bg-white/10 text-white/40 border-white/10 cursor-not-allowed"
                  : "bg-[rgba(60,255,190,0.10)] text-white border-[rgba(60,255,190,0.30)] hover:shadow-[0_0_18px_rgba(60,255,190,0.20)]"
              }`}
            >
              {submitting ? "Sending…" : "Submit answers"}
            </button>
          </div>
        </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  if (typeof document === "undefined") return modal;
  return createPortal(modal, document.body);
}

export default function OperatorRequestsPanel({ businessId, onCountChange, openExternally, onCloseExternal }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      const res = await getClarificationRequests(businessId, { limit: 50 });
      setRequests(res?.rows || res || []);
      if (onCountChange) onCountChange((res?.rows || res || []).length || 0);
    } catch (e) {
      console.warn("[OperatorRequests] fetch failed", e);
      if (onCountChange) onCountChange(0);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    load();
  }, [load]);

  const pendingCount = requests.length;

  const title = pendingCount
    ? `Bizzi needs ${pendingCount} quick clarification${pendingCount === 1 ? "" : "s"}`
    : "Bizzi will ask if anything is unclear";

  return (
    <>
      <div className="w-full mb-4" style={{ display: "none" }}>
        <div className="rounded-2xl bg-gradient-to-r from-[#10151f] via-[#0b111a] to-[#0f1422] border border-white/10 shadow-xl px-5 py-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-white font-semibold text-lg">{title}</div>
            <div className="text-sm text-white/70">
              Answer these so I can finish categorizing and post clean books.
            </div>
          </div>
          <div className="flex items-center gap-3">
            {pendingCount > 0 && (
              <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full text-xs font-semibold bg-cyan-500/20 text-cyan-100 border border-cyan-400/40">
                {pendingCount}
              </span>
            )}
            <button
              type="button"
              onClick={() => setOpen(true)}
              disabled={loading}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                loading
                  ? "bg-white/5 text-white/40 cursor-not-allowed"
                  : "bg-white text-black hover:bg-cyan-100"
              }`}
            >
              Review now
            </button>
          </div>
        </div>
      </div>

      <ClarificationModal
        open={openExternally || open}
        onClose={() => {
          setOpen(false);
          if (onCloseExternal) onCloseExternal();
          load();
        }}
        requests={requests}
        businessId={businessId}
        onSubmitted={async () => {
          await load();
        }}
      />
    </>
  );
}
