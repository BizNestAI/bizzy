import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Inbox, Send, FileText, MailQuestion, Mail, Loader2 } from "lucide-react";

import SearchBar from "../../components/email/SearchBar";
import InboxList from "../../components/email/InboxList";
import ThreadView from "../../components/email/ThreadView";
import ReplyComposer from "../../components/email/ReplyComposer";
import AutoResponderDrawer from "../../components/email/AutoResponderDrawer";

import useGmailConnect from "../../hooks/email/useGmailConnect";
import useEmailThreads from "../../hooks/email/useEmailThreads";
import useEmailThread from "../../hooks/email/useEmailThread";
import useEmailSummary from "../../hooks/email/useEmailSummary";

import { apiUrl, safeFetch } from "../../utils/safeFetch";
import { supabase } from "../../services/supabaseClient";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../calendar/AgendaWidget.jsx";
import SyncButton from "../../components/Integrations/SyncButton.jsx";
import { useNavigate } from "react-router-dom";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

/* Graphite neutrals */
const NEUTRAL_BORDER = "rgba(165,167,169,0.18)";
const PANEL_BG = "var(--panel)";
const MUTED = "var(--text-2)";

async function authedHeaders({ userId, businessId }) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token || "";
  return {
    "Content-Type": "application/json",
    "x-user-id": userId || localStorage.getItem("user_id") || "",
    "x-business-id":
      businessId ||
      localStorage.getItem("business_id") ||
      localStorage.getItem("currentBusinessId") ||
      "",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchEmailAccounts({ userId, businessId }) {
  const headers = await authedHeaders({ userId, businessId });
  return safeFetch(apiUrl("/api/email/accounts"), { headers, cache: "no-store" });
}

const LABEL_TABS = [
  { key: "INBOX", label: "Inbox", icon: Inbox },
  { key: "SENT", label: "Sent", icon: Send },
  { key: "DRAFT", label: "Drafts", icon: FileText },
  { key: "UNREAD", label: "Unread", icon: MailQuestion },
];

export default function EmailPage() {
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState(null);
  const [accountId, setAccountId] = useState(null);
  const [accountEmail, setAccountEmail] = useState("");
  const [autoDrawerOpen, setAutoDrawerOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef(null);
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();

  const userId = localStorage.getItem("user_id") || "";
  const businessId =
    localStorage.getItem("business_id") ||
    localStorage.getItem("currentBusinessId") ||
    "";

  const { connect, disconnect, connecting, error: connectError } = useGmailConnect();

  const refreshAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const json = await fetchEmailAccounts({ userId, businessId });
      const items = Array.isArray(json?.items) ? json.items : [];
      setAccounts(items);

      if (items.length > 0) {
        if (!accountId) {
          setAccountId(items[0].id);
          setAccountEmail(items[0].google_email);
        } else {
          const match = items.find((a) => a.id === accountId);
          if (!match) {
            setAccountId(items[0].id);
            setAccountEmail(items[0].google_email);
          } else {
            setAccountEmail(match.google_email);
          }
        }
      } else {
        setAccountId(null);
        setAccountEmail("");
      }
    } catch (e) {
      const msg = String(e?.message || "").toLowerCase();
      if (msg.includes("unauthorized") || msg.includes("missing access token")) {
        setAccounts([]);
        setAccountId(null);
        setAccountEmail("");
        setAccountsError(null);
      } else {
        console.error(e);
        setAccountsError(e.message || "Failed to load Gmail accounts");
      }
    } finally {
      setAccountsLoading(false);
    }
  }, [accountId, userId, businessId]);

  // Publish Agenda to right rail
  useEffect(() => {
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="bizzy"
        onOpenCalendar={() => navigate("/dashboard/calendar")}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  // Allow Insights/other parts of the app to open a specific thread/account
  useEffect(() => {
    const handler = (e) => {
      try {
        const { threadId, accountId: targetAccountId } = e.detail || {};
        if (targetAccountId && targetAccountId !== accountId) {
          setAccountId(targetAccountId);
        }
        if (threadId) {
          setSelectedThreadId(threadId);
        }
      } catch {
        // no-op
      }
    };
    window.addEventListener("bizzy:email:openThread", handler);
    return () => window.removeEventListener("bizzy:email:openThread", handler);
  }, [accountId]);

  useEffect(() => {
    refreshAccounts();
  }, [refreshAccounts]);

  useEffect(() => {
    const onClick = (e) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const [label, setLabel] = useState("INBOX");
  const [q, setQ] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [activityOpen, setActivityOpen] = useState(false);
  if (!shouldUseDemoData()) {
    return <LiveModePlaceholder title="Connect Gmail to view Email HQ" />;
  }

  const {
    items: threads,
    loading: listLoading,
    error: listError,
    loadMore,
    hasMore,
    refresh: refreshThreads,
  } = useEmailThreads({ accountId, label: label === "UNREAD" ? "INBOX" : label, q });

  const {
    thread,
    loading: threadLoading,
    error: threadError,
    refetch: refetchThread,
  } = useEmailThread({ accountId, threadId: selectedThreadId });

  const { summarize, summarizing } = useEmailSummary();
  const [summary, setSummary] = useState("");
  const doSummarize = useCallback(async () => {
    if (!accountId || !selectedThreadId) return;
    const text = await summarize({ accountId, threadId: selectedThreadId });
    setSummary(text || "");
  }, [accountId, selectedThreadId, summarize]);
  useEffect(() => setSummary(""), [selectedThreadId]);

  const visibleThreads = useMemo(() => {
    if (label !== "UNREAD") return threads;
    return (threads || []).filter((t) => t.unread);
  }, [threads, label]);

  const markThreadRead = useCallback(async () => {
    if (!selectedThreadId || !accountId) return;
    try {
      const headers = await authedHeaders({ userId, businessId });
      await safeFetch(apiUrl(`/api/email/threads/${selectedThreadId}/mark-read`), {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId }),
      });
      refreshThreads();
      refetchThread();
    } catch (e) {
      console.error("[email] mark-read failed:", e);
    }
  }, [selectedThreadId, accountId, refreshThreads, refetchThread, userId, businessId]);

  const handleSent = useCallback(() => {
    refetchThread();
    refreshThreads();
  }, [refetchThread, refreshThreads]);

  const showConnectBanner = !accountsLoading && accounts.length === 0;
  const inboxCollapsed = !selectedThreadId;

  return (
    <div className="h-full flex flex-col px-4 pt-2 pb-4 bg-app text-primary overflow-hidden">
      {/* Header Card */}
      <div
        className="mb-3 rounded-3xl border shadow-bizzi p-4 md:p-5 backdrop-blur"
        style={{
          background: "linear-gradient(145deg, rgba(16,19,24,0.9), rgba(9,11,15,0.9))",
          borderColor: NEUTRAL_BORDER,
        }}
      >
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          <span
            className="inline-flex items-center rounded-full px-4 py-2 text-sm font-semibold tracking-[0.18em] border min-h-[38px]"
            style={{ borderColor: NEUTRAL_BORDER, background: "rgba(255,255,255,0.04)", color: "var(--text)" }}
          >
            Bizzi Email Overview
          </span>

          <div className="flex flex-wrap items-center gap-2 md:gap-3">
            <SyncButton
              size="sm"
              label={accounts.length ? "Add inbox" : "Sync Gmail"}
              providers={["gmail"]}
            />
            {accountsLoading ? (
              <div className="text-xs inline-flex items-center gap-1 min-h-[38px]" style={{ color: MUTED }}>
                <Loader2 size={14} className="animate-spin" /> Loading accounts…
              </div>
            ) : accounts.length > 0 ? (
              <>
                <div className="relative" ref={accountMenuRef}>
                  <button
                    onClick={() => setAccountMenuOpen((v) => !v)}
                    className="inline-flex items-center gap-2 rounded-full px-3 py-2 min-h-[38px] text-xs border transition"
                    style={{
                      background: "rgba(20,21,22,0.9)",
                      border: `1px solid ${NEUTRAL_BORDER}`,
                      color: "var(--text)",
                    }}
                  >
                    {accountEmail || "Select inbox"}
                    <span className="text-[10px]" style={{ color: MUTED }}>▼</span>
                  </button>
                  {accountMenuOpen && (
                    <div
                      className="absolute right-0 mt-2 w-56 rounded-lg border shadow-2xl p-1 z-20"
                      style={{ background: PANEL_BG, borderColor: NEUTRAL_BORDER }}
                    >
                      {accounts.map((a) => {
                        const active = a.id === accountId;
                        return (
                          <button
                            key={a.id}
                            onClick={() => {
                              setAccountId(a.id);
                              setAccountEmail(a.google_email || "");
                              setSelectedThreadId(null);
                              setAccountMenuOpen(false);
                            }}
                            className="w-full text-left rounded-md px-2 py-1.5 text-xs flex items-center justify-between hover:bg-white/5 transition"
                            style={{ color: "var(--text)" }}
                          >
                            <span className="truncate">{a.google_email}</span>
                            {active ? <span style={{ color: MUTED }}>•</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <button
                  onClick={async () => {
                    await disconnect(accountId);
                    await refreshAccounts();
                  }}
                  className="rounded-full px-3 py-2 min-h-[38px] text-xs"
                  style={{
                    color: "rgb(255,176,176)",
                    border: "1px solid rgba(255,99,132,0.40)",
                    background: "rgba(255,99,132,0.10)",
                  }}
                >
                  Disconnect
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Connect banner */}
      {showConnectBanner && (
        <div
          className="mb-3 p-3 rounded border"
          style={{ borderColor: "rgba(59,176,255,0.35)", background: "rgba(59,176,255,0.10)" }}
        >
          <div className="text-sm font-medium" style={{ color: "rgb(174,219,255)" }}>
            Connect your Gmail
          </div>
          <div className="text-xs mt-1" style={{ color: MUTED }}>
            Draft, summarize, and send emails with Bizzy. Only the emails you choose are read.
          </div>
          <div className="mt-2">
            <button
              onClick={() => connect()}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-3 py-2 rounded text-white disabled:opacity-50"
              style={{ background: "rgb(14,165,233)" }}
            >
              {connecting ? <Loader2 className="animate-spin" size={16} /> : <Mail size={16} />}
              Connect Gmail
            </button>
            {connectError && <div className="text-xs text-rose-400 mt-2">{connectError}</div>}
          </div>
        </div>
      )}

      {/* Main grid (lock height so inner columns scroll) */}
      <div
        className="flex-1 min-h-0 rounded-3xl border shadow-bizzi p-3 md:p-4 overflow-hidden"
        style={{
          background: "rgba(16,18,22,0.8)",
          borderColor: NEUTRAL_BORDER,
          height: "calc(100vh - 120px)",
        }}
      >
        <div className="grid grid-cols-12 gap-4 h-full max-h-full overflow-hidden content-start min-h-0">
        {/* LEFT: Search + Inbox */}
          <aside
            className="col-span-12 md:col-span-3 lg:col-span-3 h-full min-h-0 flex flex-col border-r pr-2 overflow-hidden"
            style={{ borderColor: NEUTRAL_BORDER }}
          >
            <SearchBar value={q} onChange={setQ} onSubmit={setQ} />
            <div
              className="flex-1 min-h-0 overflow-y-auto pr-1 pb-4"
              style={{
                maxHeight: inboxCollapsed ? "520px" : "calc(100vh - 220px)",
              }}
            >
              <InboxList
                items={visibleThreads}
                loading={listLoading}
                error={listError}
                selectedId={selectedThreadId}
                onSelect={setSelectedThreadId}
                onLoadMore={loadMore}
                hasMore={hasMore}
                onRefresh={refreshThreads}
                headerLabel={
                  label === "UNREAD"
                    ? "Unread"
                    : LABEL_TABS.find((t) => t.key === label)?.label || "Inbox"
                }
                label={label}
                setLabel={setLabel}
              />
            </div>
          </aside>

        {/* MIDDLE: Thread view */}
          <main className="col-span-12 md:col-span-9 lg:col-span-9 h-full min-h-0 max-h-full flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 max-h-full overflow-y-auto">
              <ThreadView
                accountId={accountId}
                threadId={selectedThreadId}
                thread={thread}
                loading={threadLoading}
                error={threadError}
                summary={summary}
                onSummarize={doSummarize}
                summarizing={summarizing}
                scrollWithinParent
                embeddedHeader={
                  selectedThreadId
                    ? {
                        subject:
                          thread?.messages?.[thread.messages.length - 1]?.subject || "(no subject)",
                        participantsText: thread ? buildParticipants(thread) : "",
                        unread: !!getUnreadFlag(threads, selectedThreadId),
                        onMarkRead: markThreadRead,
                        onOpenAutoPanel: () => setAutoDrawerOpen(true),
                      }
                    : undefined
                }
              >
                {selectedThreadId && accountId && (
                  <div id="bizzy-reply-composer">
                    <ReplyComposer
                      accountId={accountId}
                      threadId={selectedThreadId}
                      defaultTone="professional"
                      onSent={handleSent}
                    />
                  </div>
                )}
              </ThreadView>
            </div>
          </main>

          {/* RIGHT: spacer rail (kept as-is to let center breathe) */}
          <aside className="hidden md:block lg:col-span-0 xl:hidden h-full min-h-0" />
        </div>
      </div>

      <AutoResponderDrawer
        open={autoDrawerOpen}
        onClose={() => setAutoDrawerOpen(false)}
        accountId={accountId}
      />
    </div>
  );
}

function buildParticipants(thread) {
  if (!thread) return "";
  const last = thread.messages?.[thread.messages.length - 1];
  if (!last) return "";
  const people = [];
  if (last.from) people.push(last.from);
  if (last.to) people.push(`→ ${last.to}`);
  if (last.cc) people.push(`cc ${last.cc}`);
  return people.join("  ");
}

function getUnreadFlag(threads, threadId) {
  const t = (threads || []).find((x) => x.threadId === threadId);
  return t?.unread || false;
}
