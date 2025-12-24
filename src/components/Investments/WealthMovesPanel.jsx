// Wealth Moves Panel — resilient, accessible, and polished
// -----------------------------------------------------------------------------
import React, { useEffect, useRef, useState } from "react";
import {
  RotateCcw,
  ChevronRight,
  ChevronLeft,
  Clock,
  HelpCircle,
  CheckCircle2,
  Wand2,
  ExternalLink,
  X,
} from "lucide-react";
import CardHeader from "../UI/CardHeader";

// ✅ API helpers (go through safeFetch with Authorization + ids)
import { getWealthMoves, refreshWealthMoves } from "../../services/investmentsApi";

const NEON = "#C084FC";
const CARD_BG = "bg-[#0B0E13]";
const CARD_BORDER = "border border-white/5";
const GLOW = "shadow-[0_0_24px_#c084fc33]";

export default function WealthMovesPanel({
  userId,
  className = "",
  onAskBizzy,
  onApplyMove,
  autoRotateMs = 7000,
  /** Optional: lock min-height so it lines up with the card next to it */
  height, // e.g., 280
}) {
  const [payload, setPayload] = useState(null);
  const [moves, setMoves] = useState([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [openDrawer, setOpenDrawer] = useState(false);

  // Auto-rotate, pause on hover/focus
  const rotateRef = useRef(null);
  const startRotate = () => {
    if (!moves.length || !autoRotateMs) return;
    rotateRef.current = setInterval(
      () => setActive((i) => (i + 1) % moves.length),
      autoRotateMs
    );
  };
  const stopRotate = () => rotateRef.current && clearInterval(rotateRef.current);

  useEffect(() => {
    stopRotate();
    startRotate();
    return stopRotate;
  }, [moves.length, autoRotateMs]);

  // Initial load (via helper)
  useEffect(() => {
    let ignore = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const json = await getWealthMoves(); // ✅ helper
        if (!ignore) {
          setPayload(json || null);
          const arr = Array.isArray(json?.moves) ? json.moves : [];
          setMoves(arr);
          setActive(0);
        }
      } catch (e) {
        if (!ignore) setError(e?.message || "Failed to load moves");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [userId]);

  const onRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const json = await refreshWealthMoves(); // ✅ helper
      setPayload(json || null);
      const arr = Array.isArray(json?.moves) ? json.moves : [];
      setMoves(arr);
      setActive(0);
    } catch (e) {
      setError(e?.message || "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const move = moves[active];
  const minH = typeof height === "number" ? height : undefined;

  return (
    <div
      className={`${CARD_BG} ${CARD_BORDER} ${GLOW} rounded-2xl p-3 sm:p-4 ${className}`}
      style={minH ? { minHeight: minH } : undefined}
      onMouseEnter={stopRotate}
      onMouseLeave={startRotate}
      onFocus={stopRotate}
      onBlur={startRotate}
      aria-label="Suggested wealth moves"
    >
      {/* Compact CardHeader */}
      <CardHeader
        title="SUGGESTED WEALTH MOVES"
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
        right={
          <div className="flex items-center gap-2">
            {!!payload?.month_ym && (
              <div className="hidden sm:flex items-center gap-1 text-[12px] text-white/55" aria-label="Month">
                <Clock size={14} />
                <span>{payload.month_ym}</span>
              </div>
            )}
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10 text-white/80"
              title="Regenerate for this month"
              aria-label="Refresh moves"
            >
              <RotateCcw size={14} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Body */}
      {loading ? (
        <Skeleton />
      ) : error ? (
        <div className="text-rose-400 text-sm">{error}</div>
      ) : !moves.length ? (
        <div className="text-white/60 text-sm">
          No moves yet. Try refreshing or connect accounts to unlock personalized suggestions.
        </div>
      ) : (
        <div>
          <MoveCard
            move={move}
            onPrev={() => setActive((i) => (i - 1 + moves.length) % moves.length)}
            onNext={() => setActive((i) => (i + 1) % moves.length)}
            onLearnMore={() => setOpenDrawer(true)}
            onAsk={() =>
              onAskBizzy?.(`Tell me more about: ${move.move_title}. ${move.description}`)}
            onApply={() => onApplyMove?.(move)}
            index={active}
            total={moves.length}
          />

          {/* Pagination dots (smaller) */}
          <div className="mt-2.5 flex items-center justify-center gap-1">
            {moves.map((_, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === active ? "w-5 bg-white/90" : "w-2.5 bg-white/30 hover:bg-white/50"
                }`}
                aria-label={`Show move ${i + 1}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Learn More slide-over */}
      <Drawer
        open={openDrawer}
        onClose={() => setOpenDrawer(false)}
        title={move?.move_title}
      >
        <LearnMore move={move} meta={payload?.meta} onAskBizzy={onAskBizzy} />
      </Drawer>
    </div>
  );
}

/* ------------------------------ Move Card ------------------------------ */
function MoveCard({ move, onPrev, onNext, onLearnMore, onAsk, onApply, index, total }) {
  if (!move) return null;
  const urgencyColor =
    move.urgency === "High"
      ? "text-rose-300 border-rose-400/30"
      : move.urgency === "Medium"
      ? "text-amber-300 border-amber-400/30"
      : "text-emerald-300 border-emerald-400/30";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-[14px] sm:text-[15px] font-semibold text-white/90 truncate">
              {move.move_title}
            </h4>
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full border ${urgencyColor} shrink-0`}
              title="Urgency"
            >
              {move.urgency || "—"}
            </span>
          </div>

          <p className="text-[13px] sm:text-sm text-white/80 mt-1">{move.description}</p>

          {move.estimated_impact && (
            <div className="mt-2 text-[13px] text-[#C084FC]">
              <Wand2 size={14} className="inline mr-1 -mt-0.5" />
              {move.estimated_impact}
            </div>
          )}

          {!!(move.tags?.length) && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {move.tags.slice(0, 3).map((t, i) => (
                <Tag key={`${t}-${i}`}>{t}</Tag>
              ))}
            </div>
          )}

          {move.scenario_context && (
            <div className="mt-2 text-[12px] text-white/60">
              <HelpCircle size={13} className="inline mr-1 -mt-0.5" />
              {move.scenario_context}
            </div>
          )}
        </div>

        {/* pager (compact) */}
        <div className="shrink-0 flex flex-col items-center gap-1.5">
          <button
            onClick={onPrev}
            className="p-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10"
            aria-label="Previous"
          >
            <ChevronLeft size={14} />
          </button>
          <div className="text-[11px] text-white/50">
            {index + 1}/{total}
          </div>
          <button
            onClick={onNext}
            className="p-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10"
            aria-label="Next"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* actions (condensed) */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={onLearnMore}
          className="inline-flex items-center gap-1 text-[12px] px-3 py-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-white/90"
        >
          Learn more <ChevronRight size={13} />
        </button>
       
      </div>
    </div>
  );
}

/* ------------------------------ Drawer ------------------------------ */
function Drawer({ open, onClose, title, children }) {
  return (
    <div
      className={`fixed inset-0 z-[60] transition ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      {/* panel */}
      <div
        className={`absolute right-0 top-0 h-full w-full sm:w-[440px] ${CARD_BG} ${CARD_BORDER} ${GLOW}
          transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}
        role="dialog"
        aria-label="Wealth move details"
      >
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div className="text-sm font-medium text-white/90 truncate">{title || "Details"}</div>
          <button
            onClick={onClose}
            className="p-2 rounded-full border border-white/10 bg-white/5 hover:bg-white/10"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto h-[calc(100%-56px)]">{children}</div>
      </div>
    </div>
  );
}

function LearnMore({ move, meta, onAskBizzy }) {
  if (!move) {
    return <div className="text-sm text-white/60">No move selected.</div>;
  }
  return (
    <div className="space-y-4">
      <div className="text-white/80 text-sm">{move.description}</div>
      {move.estimated_impact && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="text-[11px] text-white/60 mb-1">Estimated impact</div>
          <div className="text-sm text-[#C084FC]">{move.estimated_impact}</div>
        </div>
      )}
      {!!(move.tags?.length) && (
        <div>
          <div className="text-[11px] text-white/60 mb-1">Categories</div>
          <div className="flex flex-wrap gap-1.5">
            {move.tags.map((t, i) => (
              <Tag key={`${t}-${i}`}>{t}</Tag>
            ))}
          </div>
        </div>
      )}
      {meta?.generated_at && (
        <div className="text-[11px] text-white/50">
          Generated <span className="font-mono">{new Date(meta.generated_at).toLocaleString()}</span>
        </div>
      )}
      {/* Quick prompts */}
      <div className="pt-2">
        <div className="text-[11px] text-white/60 mb-1">Quick prompts</div>
        <div className="flex flex-wrap gap-2">
          <PromptChip onClick={() => onAskBizzy?.(
            `Explain the trade-offs for this move: ${move.move_title}. Consider my taxes and retirement goal.`
          )}>
            Trade-offs?
          </PromptChip>
          <PromptChip onClick={() => onAskBizzy?.(
            `Run a quick scenario: If I follow "${move.move_title}" this month, how does my retirement projection change?`
          )}>
            Run scenario
          </PromptChip>
          <PromptChip onClick={() => onAskBizzy?.(
            `What risks should I consider before I ${move.move_title.toLowerCase()}?`
          )}>
            Risks?
          </PromptChip>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Bits ------------------------------ */
function Tag({ children }) {
  return (
    <span className="text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/5 text-white/80">
      {children}
    </span>
  );
}
function PromptChip({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-[12px] px-3 py-1.5 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-[#C084FC]"
    >
      {children}
    </button>
  );
}
function Skeleton() {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 animate-pulse">
      <div className="h-4 w-40 bg-white/10 rounded mb-3" />
      <div className="h-4 w-5/6 bg-white/10 rounded mb-2" />
      <div className="h-4 w-4/6 bg-white/10 rounded mb-4" />
      <div className="flex gap-2">
        <div className="h-7 w-24 bg-white/10 rounded" />
        <div className="h-7 w-32 bg-white/10 rounded" />
        <div className="h-7 w-28 bg-white/10 rounded" />
      </div>
    </div>
  );
}
