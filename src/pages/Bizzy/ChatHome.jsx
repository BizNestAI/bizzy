// src/pages/Bizzy/ChatHome.jsx
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import BizzyChatBar from "../../components/Bizzy/BizzyChatBar";
import ChatCanvas from "../../components/Bizzy/ChatCanvas";
import useOnboardingStatus from "../../hooks/useOnboardingStatus";
import ChatGreeting from "../../components/Bizzy/ChatGreeting";
import OperatorRequestsPanel from "../../components/Bizzy/OperatorRequestsPanel";
import { useBusiness } from "../../context/BusinessContext";
import OperatorStatusCard from "../../components/Bizzy/OperatorStatusCard";
import { CHAT_BAR_MAX_W, CHAT_BAR_VW } from "../../config/chatLayout";
import { getDemoMode, shouldUseDemoData, getDemoData } from "../../services/demo/demoClient";
import { getClarificationRequests, getTransactions } from "../../services/bookkeeping/bookkeepingClient.js";

export default function ChatHome() {
  return <ChatHomeInner />;
}

function ChatHomeInner() {
  const navigate = useNavigate();
  const { isCanvasOpen = false, closeCanvas } = useBizzyChatContext();
  const location = useLocation();
  const { quickPromptMode } = useOnboardingStatus();
  const dashboardTarget = "/dashboard/accounting";
  const { businessId, currentBusiness } = useBusiness();
  const [needsReviewRequests, setNeedsReviewRequests] = useState([]);
  const [clarLoading, setClarLoading] = useState(false);
  const [clarOpen, setClarOpen] = useState(false);
  const [showStatusCard, setShowStatusCard] = useState(false);
  const dataMode = getDemoMode?.() || "";
  const isMockMode =
    import.meta?.env?.VITE_MOCK === "true" ||
    dataMode === "demo" ||
    shouldUseDemoData(currentBusiness) ||
    localStorage.getItem("bizzy:dataMode") === "demo" ||
    localStorage.getItem("bizzy:demo") === "1";

  const mockNeedsReviewRequests = useMemo(() => {
    if (!isMockMode) return [];
    const demoTxns = getDemoData()?.bookkeeping?.transactions || [];
    const fallback = [
      {
        id: "mock-1",
        transaction_id: "mock-1",
        vendor: "ACME Supplies",
        amount: -182.45,
        date: "2026-01-10",
        description: "ACME SUPPLIES 2214",
        status: "needs_review",
      },
      {
        id: "mock-2",
        transaction_id: "mock-2",
        vendor: "Cedar Roofing",
        amount: -642.0,
        date: "2026-01-12",
        description: "CEDAR ROOFING CTR",
        status: "needs_review",
      },
      {
        id: "mock-3",
        transaction_id: "mock-3",
        vendor: "Fuel Depot",
        amount: -94.12,
        date: "2026-01-14",
        description: "FUEL DEPOT #4481",
        status: "needs_review",
      },
    ];
    const base = Array.isArray(demoTxns) && demoTxns.length ? demoTxns : fallback;
    const handled = new Set(["approved", "auto_approved", "posted", "handled"]);
    const filtered = base.filter((txn) => !handled.has((txn.status || "").toLowerCase()));
    return filtered.map((txn, idx) => {
      const tid = txn.transaction_id || txn.id || `mock-${idx}`;
      const merchant = txn.vendor || txn.merchant_name || txn.counterparty_name || txn.description || txn.name || "Unknown merchant";
      return {
        id: tid,
        transaction_id: tid,
        txn: {
          merchant_name: merchant,
          counterparty_name: txn.counterparty_name || merchant,
          amount: txn.signed_amount ?? txn.amount ?? null,
          date: txn.date || txn.txn_date || null,
          name: txn.description || txn.name || "",
        },
      };
    });
  }, [isMockMode]);

  const normalizeList = useCallback((res) => {
    if (Array.isArray(res?.rows)) return res.rows;
    if (Array.isArray(res?.items)) return res.items;
    if (Array.isArray(res?.transactions)) return res.transactions;
    if (Array.isArray(res)) return res;
    return [];
  }, []);

  const loadNeedsReviewRequests = useCallback(async () => {
    const normalizeMerchant = (txn, existing = null) => {
      const raw =
        txn.vendor ||
        txn.merchant_name ||
        txn.counterparty_name ||
        txn.description ||
        txn.name ||
        existing?.txn?.merchant_name ||
        existing?.txn?.counterparty_name ||
        existing?.txn?.name ||
        existing?.txn?.description ||
        "Unknown merchant";
      const upper = String(raw || "").toUpperCase();
      const patterns = [
        { test: /UBER/, name: "Uber" },
        { test: /LYFT/, name: "Lyft" },
        { test: /DOORDASH|DOOR DASH/, name: "DoorDash" },
        { test: /GRUBHUB/, name: "Grubhub" },
        { test: /POSTMATES/, name: "Postmates" },
        { test: /AIRBNB/, name: "Airbnb" },
        { test: /VENMO/, name: "Venmo" },
        { test: /CASH APP|CASHAPP/, name: "Cash App" },
        { test: /PAYPAL/, name: "PayPal" },
        { test: /ZELLE/, name: "Zelle" },
        { test: /STRIPE/, name: "Stripe" },
        { test: /SQUARE/, name: "Square" },
        { test: /INTUIT PAYMENT|QUICKBOOKS PAYMENTS/, name: "QuickBooks Payments" },
        { test: /AMZN|AMAZON/, name: "Amazon" },
        { test: /WALMART/, name: "Walmart" },
        { test: /TARGET/, name: "Target" },
        { test: /HOME DEPOT|HOMEDPOT/, name: "Home Depot" },
        { test: /LOWE'S|LOWES/, name: "Lowe's" },
        { test: /COSTCO/, name: "Costco" },
        { test: /SAM'S CLUB|SAMS CLUB/, name: "Sam's Club" },
        { test: /TRANSFER/, name: "Transfer" },
        { test: /ACH/, name: "ACH Electronic" },
        { test: /CREDIT CARD PAYMENT|CC PAYMENT|CARD PMT/, name: "Credit Card Payment" },
        { test: /INTEREST/, name: "Interest Payment" },
        { test: /CD DEPOSIT|CERTIFICATE OF DEPOSIT/, name: "CD Deposit" },
        { test: /WIRE/, name: "Wire Transfer" },
        { test: /PAYMENT/, name: "Payment" },
      ];
      const matched = patterns.find((p) => p.test.test(upper));
      return matched ? matched.name : raw;
    };

    if (isMockMode) {
      setNeedsReviewRequests(mockNeedsReviewRequests);
      setClarLoading(false);
      return;
    }
    if (!businessId) {
      setNeedsReviewRequests([]);
      return;
    }
    setClarLoading(true);
    try {
      const [clarRes, txnRes] = await Promise.all([
        getClarificationRequests(businessId, { limit: 200 }),
        getTransactions(businessId, { status: "needs_review", range: "all", page_size: 200 }),
      ]);
      const clarRows = normalizeList(clarRes);
      const needsReviewTxns = normalizeList(txnRes).filter((txn) => {
        const status = (txn?.status || "").toLowerCase();
        return !["approved", "auto_approved", "posted", "handled"].includes(status);
      });
      const clarByTxn = new Map();
      clarRows.forEach((req) => {
        const tid = req?.transaction_id || req?.txn?.id;
        if (!tid) return;
        clarByTxn.set(String(tid), req);
      });
      const merged = [];
      needsReviewTxns.forEach((txn) => {
        const tid = txn.transaction_id || txn.id;
        if (!tid) return;
        const key = String(tid);
        const existing = clarByTxn.get(key);
        const merchant = normalizeMerchant(txn, existing);
        if (existing) {
          merged.push({
            ...existing,
            txn: {
              ...existing?.txn,
              ...txn,
              merchant_name: merchant,
              counterparty_name: txn.counterparty_name || merchant,
              amount: txn.signed_amount ?? txn.amount ?? existing?.txn?.amount,
              name: txn.description || txn.name || existing?.txn?.name,
              description: txn.description || existing?.txn?.description || txn.name || existing?.txn?.name,
              date: txn.date || txn.txn_date || existing?.txn?.date,
            },
          });
        } else {
          const fallbackName = txn.description || txn.name || merchant;
          merged.push({
            id: tid,
            transaction_id: tid,
            txn: {
              ...txn,
              merchant_name: merchant,
              counterparty_name: txn.counterparty_name || merchant,
              amount: txn.signed_amount ?? txn.amount,
              date: txn.date || txn.txn_date,
              name: fallbackName,
              description: txn.description || txn.name || "",
            },
          });
        }
      });
      setNeedsReviewRequests(merged);
    } catch {
      setNeedsReviewRequests([]);
    } finally {
      setClarLoading(false);
    }
  }, [businessId, isMockMode, mockNeedsReviewRequests, normalizeList]);
  // Ensure IBM Plex Sans is available (once)
  useEffect(() => {
    const id = "ibm-plex-sans-font";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  // Subtle contrast shade ONLY for ChatHome’s chat bar shell
  // Use the same neutral shell as dashboard/chat canvas (no override)
  const chatHomeShell = "";

  // Always start with hero visible on /chat
  useEffect(() => {
    const t = setTimeout(() => closeCanvas?.(), 0);
    return () => clearTimeout(t);
  }, [closeCanvas]);

  const showCanvas = isCanvasOpen;
  const showHero = !showCanvas;

  // Measure center column for canvas + bottom dock
  const centerRef = useRef(null);
  const [bounds, setBounds] = useState({ left: 0, width: 0 });
  const measure = useCallback(() => {
    const el = centerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBounds({ left: Math.round(r.left), width: Math.round(r.width) });
  }, []);
  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (centerRef.current) ro.observe(centerRef.current);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [measure]);

  const statusSubtitle = useMemo(
    () => "I need ~2 minutes from you so I can categorize correctly and keep the books clean.",
    []
  );

  const handleReview = useCallback(() => {
    setClarOpen(true);
  }, []);

  const clarCount = needsReviewRequests.length;
  const hasPendingQuestions = clarCount > 0;
  const isChatHome = (location?.pathname || "").includes("/chat");
  const heroOpacity = 0.92;
  // Keep the hero in a stable position regardless of pending state.
  const centerTranslate = "translateY(clamp(128px, 12vh, 212px))";

  // Keep hidden by default; hide automatically when nothing remains.
  useEffect(() => {
    if (clarCount === 0) {
      setShowStatusCard(false);
    }
  }, [clarCount]);

  useEffect(() => {
    loadNeedsReviewRequests();
  }, [loadNeedsReviewRequests]);

  return (
    <div className="bizzy-chathome bizzy-chathome-root relative h-screen min-h-screen overflow-hidden">
      <div className="bizzy-chathome-content">
        {/* CENTER column wrapper */}
        <section className="relative z-[1] flex flex-col min-h-[calc(100vh-64px)] bg-transparent text-primary overflow-hidden">
          <div style={{ position: "relative", zIndex: 1, height: "100%" }}>
          {/* Anchor for pinning canvas below header */}
          <div className="absolute left-0 right-0 top-[64px] pointer-events-none" data-chat-top-anchor />

          {/* Anchor for measuring center width/left */}
          <div
            ref={centerRef}
            className="hidden md:block"
            style={{
              width: `min(${CHAT_BAR_VW * 100}vw, ${CHAT_BAR_MAX_W}px)`,
              maxWidth: `${CHAT_BAR_MAX_W}px`,
              height: 1,
              margin: "0 auto",
            }}
          />

            {/* HERO (safe, in-flow) */}
            {showHero && (
              <div className="hidden md:flex flex-1 min-h-0 items-center justify-center">
                <div
                  className="bizzy-chathome-center w-full flex flex-col items-center"
                  style={{
                    width: `min(${CHAT_BAR_VW * 100}vw, ${CHAT_BAR_MAX_W}px)`,
                    maxWidth: `${CHAT_BAR_MAX_W}px`,
                    transform: centerTranslate,
                  }}
                >
                  <div
                    className="bizzy-chathome-halo"
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      transform: "translate(-50%, -50%)",
                      width: `min(${CHAT_BAR_VW * 100}vw, ${CHAT_BAR_MAX_W}px)`,
                      maxWidth: `${CHAT_BAR_MAX_W}px`,
                      height: "520px",
                      pointerEvents: "none",
                      zIndex: 0,
                    }}
                  />
                  <div className="w-full mt-1">
                    <OperatorRequestsPanel
                      businessId={businessId}
                      openExternally={clarOpen}
                      onCloseExternal={() => {
                        setClarOpen(false);
                        loadNeedsReviewRequests();
                      }}
                    />
                  </div>
                  <div className="w-full text-center mb-3 px-2 mt-1">
                    <ChatGreeting className="bizzy-chathome-headline" opacity={heroOpacity} />
                  </div>

                  <div className="w-full relative">
                    <div className="bizzy-chathome-barhalo" aria-hidden />
                    <div className="relative z-[1]">
                      <BizzyChatBar
                        variant="inline"
                        forceVisible
                        tone="neutral"
                        className="w-full"
                        shellClassName={chatHomeShell}
                        placeholder="Talk to Bizzi about your books, cash flow, jobs, or taxes…"
                        centerPlaceholder
                        quickPromptMode={quickPromptMode}
                      />
                    </div>
                  </div>
                  <AnimatePresence>
                    {clarCount > 0 && showStatusCard ? (
                      <motion.div
                        key="operator-status-card"
                        initial={{ opacity: 0, y: 180 }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          transition: {
                            type: "spring",
                            stiffness: 100,
                            damping: 16,
                            mass: 1.05,
                          },
                        }}
                        exit={{
                          opacity: 0,
                          y: 120,
                          transition: { duration: 0.32, ease: [0.22, 0.1, 0.25, 1] },
                        }}
                        className="w-full mt-16 relative"
                      >
                        <OperatorStatusCard
                          count={clarCount}
                          loading={clarLoading}
                          subtitle={statusSubtitle}
                        onReview={handleReview}
                        businessId={businessId}
                        onRefresh={loadNeedsReviewRequests}
                        mockMode={isMockMode}
                        mockRequests={mockNeedsReviewRequests}
                        requests={needsReviewRequests}
                        onHide={() => setShowStatusCard(false)}
                        showExpand
                      />
                        <div
                          className="pointer-events-none absolute inset-x-0 -bottom-8 h-12"
                          aria-hidden
                          style={{
                            background: "linear-gradient(180deg, rgba(15,17,20,0) 0%, rgba(15,17,20,0.55) 60%, rgba(15,17,20,0.8) 100%)",
                          }}
                        />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                  {/* Keep layout height stable when the card is hidden so the halo/glow behind the chat bar doesn't shift */}
                  {clarCount > 0 && !showStatusCard ? (
                    <div
                      className="w-full mt-16 rounded-3xl"
                      aria-hidden
                      style={{
                        height: 360,
                        background: "transparent",
                      }}
                    />
                  ) : null}
                </div>
              </div>
            )}

            {!showStatusCard && hasPendingQuestions && isChatHome && !isCanvasOpen && typeof document !== "undefined"
              ? createPortal(
                  <button
                    type="button"
                    onClick={() => setShowStatusCard(true)}
                    aria-label="Show questions"
                    className="group fixed bottom-12 inline-flex items-center justify-center text-[13px] text-white/70 hover:text-white transition z-[12050] relative px-2 py-1"
                    style={{
                      left: bounds?.width ? bounds.left + bounds.width / 2 : "50%",
                      transform: "translateX(-50%)",
                    }}
                  >
                    <span className="pointer-events-none absolute -top-3 left-1/2 -translate-x-1/2 text-[11px] text-white/70 transition-all duration-150">
                      ↑
                    </span>
                    {clarCount} remaining transaction{clarCount === 1 ? "" : "s"}
                  </button>,
                  document.body
                )
              : null}

            {import.meta?.env?.DEV && showHero ? (
              <div style={{ position: "fixed", top: 8, right: 8, zIndex: 99999, color: "#fff", fontSize: 12, opacity: 0.6 }}>
                ChatHome hero: ON
              </div>
            ) : null}

            {/* DESKTOP: ChatCanvas overlays the center when active */}
            {showCanvas && (
              <ChatCanvas
                left={bounds.left}
                width={bounds.width}
                topAnchorSelector="[data-chat-top-anchor]"
                quickPromptMode={quickPromptMode}
              />
            )}

            {/* MOBILE: bottom dock (keyboard-aware) */}
            <MobileDock shellClassName={chatHomeShell} quickPromptMode={quickPromptMode} />

            {/* DESKTOP: bottom dock not rendered while canvas is open to avoid duplication */}
          </div>
        </section>
      </div>
    </div>
  );
}

function MobileDock({ shellClassName, quickPromptMode = "normal" }) {
  const [bottomInset, setBottom] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => {
      const delta = Math.max(0, window.innerHeight - Math.ceil(vv.height));
      setBottom(delta);
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    onChange();
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);
  return (
    <div
      className="md:hidden fixed inset-x-0 bottom-0 z-[10000] px-3"
      style={{ paddingBottom: `max(${bottomInset}px, env(safe-area-inset-bottom))` }}
    >
      <BizzyChatBar
        variant="inline"
        forceVisible
        className="w-full"
        shellClassName={shellClassName}
        placeholder="Ask Bizzi anything…"
        quickPromptMode={quickPromptMode}
      />
    </div>
  );
}
