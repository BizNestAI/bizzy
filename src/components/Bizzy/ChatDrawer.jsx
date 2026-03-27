// File: /src/components/Bizzy/ChatDrawer.jsx
import React, { useState, forwardRef, useImperativeHandle } from 'react';
import { useLocation } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { MessageSquare } from 'lucide-react';
import useChatThreads from '../../hooks/useChatThreads';
import { useBizzyChatContext } from '../../context/BizzyChatContext';
import { ACCENT_HEX } from '../../config/accent';

/* ------------------------------- */
/* Small helpers / portal elements */
/* ------------------------------- */

// --- soft accent helpers (same feel as InsightCards) ---
const THREAD_ACCENT = {
  chrome:      ACCENT_HEX,
  bizzy:       ACCENT_HEX,
  accounting:  ACCENT_HEX,
  financials:  ACCENT_HEX,
  marketing:   ACCENT_HEX,
  tax:         ACCENT_HEX,
  investments: ACCENT_HEX,
  email:       ACCENT_HEX,
};

function hexToRgba(hex, alpha = 1) {
  let c = (hex || '').replace('#', '');
  if (c.length === 3) c = c.split('').map(s => s + s).join('');
  const n = parseInt(c || '000000', 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[11000] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative z-[11010] w-[min(92vw,460px)] rounded-2xl border border-white/10 bg-[#0B0E13] p-4 shadow-[0_10px_30px_rgba(0,0,0,0.6)]">
        <div className="text-sm font-semibold mb-1">{title}</div>
        {message && (
          <div className="text-sm text-white/80 whitespace-pre-line mb-4">
            {message}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            className="px-3 py-0.5 text-sm rounded-md border border-white/12 hover:bg-white/10"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded-md border border-rose-500/50 text-rose-400 hover:bg-rose-500/10"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const ChatHistoryIcon = ({ size = 14 }) => (
  <MessageSquare size={size} strokeWidth={1.5} />
);

function MenuPortal({ anchorEl, width = 128, children }) {
  if (!anchorEl) return null;
  const rect = anchorEl.getBoundingClientRect();
  const left = Math.max(8, rect.right - width);
  const top = rect.top;
  const style = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    transform: 'translateY(calc(-100% - 8px))',
    width: `${width}px`,
    zIndex: 20000,
  };
  return createPortal(<div style={style}>{children}</div>, document.body);
}

/* -------------------------------- */
/* Drawer body (list of chat rows)  */
/* -------------------------------- */

function ChatDrawerBody({
  loading,
  error,
  displayThreads,
  threadId,
  activeAccentHex,
  beginRename,
  saveRename,
  cancelRename,
  editingId,
  toggleMenu,
  menuFor,
  menuAnchor,
  closeMenu,
  requestDelete,
  handleOpenThread,
  canViewMore,
  onViewMore,
  inputRefs,
  paging,
}) {
  return (
    <div className="flex-1 min-h-0 overflow-visible px-2 pt-2 space-y-2 relative pb-[var(--chat-clearance,112px)]">
      {loading && displayThreads.length === 0 && (
        <div className="px-1 py-2 text-xs text-white/50">Loading…</div>
      )}
      {!loading && error && (
        <div className="px-1 py-2 text-xs text-rose-400">{error}</div>
      )}
      {!loading && !error && displayThreads.length === 0 && (
        <div className="px-1 py-2 text-xs text-white/50">
          No chats yet.
        </div>
      )}

      {displayThreads.map((t) => {
        const active = threadId === t.id;
        const isEditing = editingId === t.id;
        const updatedAt = new Date(t.updated_at || t.created_at);

        // Use the provided accent (module or chrome) for the active row only
        const borderCol = hexToRgba(activeAccentHex, 0.18);
        const glowCol   = hexToRgba(activeAccentHex, 0.08);

        return (
          <div
            key={t.id}
            className={[
              "bizzy-chat-thread-row relative group rounded-xl border mr-2 transition shadow-[0_0_6px_rgba(0,0,0,0.25)]",
              active ? "is-active bg-white/[0.06]" : "border-white/10 bg-white/[0.04] hover:bg-white/[0.06]",
            ].join(" ")}
            style={active ? {
              borderColor: borderCol,
              boxShadow: `0 0 0 1px ${borderCol}, 0 0 10px ${glowCol}, 0 0 6px rgba(0,0,0,0.25)`
            } : undefined}
          >
            {/* Row click surface */}
            <div
              role="button"
              tabIndex={0}
              className="w-full text-left px-3 py-1 rounded-xl focus:outline-none cursor-pointer"
              onClick={(e) => {
                if (e.target instanceof Element && e.target.closest('[data-menu]')) return;
                handleOpenThread?.(t.id, isEditing, t.module);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (e.target instanceof Element && e.target.closest('[data-menu]')) return;
                  handleOpenThread?.(t.id, isEditing, t.module);
                }
              }}
              aria-label={`Open chat: ${t.title}`}
            >
              {/* Title + hover timestamp */}
              <div className="flex items-start gap-2 justify-between">
                <div className="flex-1 min-w-0">
                  {/* Title / Rename field */}
                  <input
                    ref={(el) => { inputRefs.current[t.id] = el; }}
                    className={`bg-transparent w-full outline-none disabled:opacity-90 truncate
                      text-[12px] md:text-sm font-medium
                      ${isEditing ? 'ring-1 rounded px-1 bg-white/[0.03]' : ''}`}
                    style={isEditing ? { boxShadow: `0 0 0 1px ${borderCol}` } : undefined}
                    defaultValue={t.title}
                    disabled={!isEditing}
                    onBlur={(e) => saveRename(t, e.currentTarget)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); saveRename(t, e.currentTarget); }
                      if (e.key === 'Escape') { e.preventDefault(); cancelRename(t); }
                      e.stopPropagation();
                    }}
                    aria-label={isEditing ? 'Edit chat title' : 'Rename chat'}
                  />

                  {/* Hover-only timestamp */}
                  <div className="mt-0.5 text-[10px] text-white/45 opacity-0 group-hover:opacity-100 transition-opacity select-none">
                    {updatedAt.toLocaleString([], {
                      month: 'short',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>

                {/* Kebab menu */}
                <div className="relative shrink-0" data-menu>
                  <button
                    className="inline-flex items-center justify-center text-white/60 hover:text-white text-sm px-1 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto"
                    onClick={(e) => { e.stopPropagation(); toggleMenu?.(t.id, e.currentTarget); }}
                    title="More"
                  >
                    …
                  </button>

                  {menuFor === t.id && (
                    <MenuPortal anchorEl={menuAnchor} width={128} side="right">
                      <div className="rounded-md border border-white/10 bg-black/90 shadow-lg" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="block w-full text-left text-xs px-3 py-2 hover:bg-white/10"
                          onClick={() => { beginRename?.(t.id); closeMenu(); }}
                        >
                          Rename
                        </button>
                        <button
                          className="block w-full text-left text-xs px-3 py-2 hover:bg-white/10 text-rose-400"
                          onClick={() => { requestDelete?.(t); closeMenu(); }}
                        >
                          Delete
                        </button>
                      </div>
                    </MenuPortal>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {/* “View more chats” button */}
      {canViewMore && (
        <div className="pt-2 pb-3 pr-2">
          <button
            onClick={onViewMore}
            disabled={paging}
            className="w-full text-xs rounded-md border border-white/12 bg-white/5 hover:bg-white/10 text-white/80 py-1.5 transition disabled:opacity-60 disabled:cursor-not-allowed"
            title="Load older chats"
          >
            {paging ? 'Loading…' : 'View more chats'}
          </button>
        </div>
      )}
    </div>
  );
}

function CollapsedHistoryTooltip({
  anchor,
  loading,
  error,
  threads,
  onHover,
  onLeave,
  onOpenThread,
  canViewMore,
  onViewMore,
  loadingMore,
  onRename,
  onDelete,
  menuFor,
  toggleMenu,
}) {
  const [viewMoreAttempted, setViewMoreAttempted] = useState(false);
  const [filter, setFilter] = useState('');
  if (!anchor) return null;
  const anchorEl = anchor?.el || anchor;
  const rect = anchor?.rect || anchorEl?.getBoundingClientRect?.();
  if (!rect) return null;
  const width = 260;
  const alignBottom = anchor?.align === 'bottom';
  const top = Math.round(alignBottom ? rect.top : Math.max(24, rect.top - 220));
  const bottomPadding = 12;
  const availableHeight = Math.max(200, (window.innerHeight || 800) - top - bottomPadding);
  const style = {
    position: 'fixed',
    left: Math.round(rect.right + 28), // nudge further clear of the NavRail border
    top,
    zIndex: 30000,
    width,
    height: availableHeight,
    maxHeight: availableHeight,
  };

  const filteredThreads = filter
    ? threads.filter((t) =>
        (t.title || '').toLowerCase().includes(filter.trim().toLowerCase())
      )
    : threads;
  const limitedThreads = filteredThreads.slice(0, 20);

  return createPortal(
    <div
      className="bizzy-chat-history-panel bizzy-chat-history-tooltip rounded-2xl border shadow-[0_28px_70px_rgba(0,0,0,0.65)] backdrop-blur-lg p-3 text-white/85 flex flex-col bizzy-tooltip-fade"
      onMouseEnter={() => onHover?.(anchorEl)}
      onMouseLeave={() => {
        onLeave?.();
        toggleMenu?.(null, null);
      }}
      style={{
        ...style,
        backgroundColor: "var(--surface-graphite)",
      }}
    >
      <div className="mb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search chats"
          className="bizzy-chat-history-search w-full rounded-lg bg-white/6 border border-white/14 px-2 py-2 text-[13px] text-white/90 placeholder-white/40 focus:outline-none focus:border-white/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
        />
      </div>
      <div className="overflow-y-auto pr-1 space-y-2 text-sm history-scroll flex-1 min-h-0">
        {!loading && error && (
          <div className="text-xs text-rose-400">{error}</div>
        )}
        {!loading && !error && limitedThreads.length === 0 && (
          <div className="text-xs text-white/50">No chats yet.</div>
        )}
        {limitedThreads.map((t) => (
          <div
            key={t.id}
            className="bizzy-chat-thread-row group relative rounded-xl bg-white/[0.04] hover:bg-white/[0.08] transition text-[13px] border border-white/6 shadow-[0_4px_14px_rgba(0,0,0,0.35)]"
          >
            <button
              onClick={() => {
                onOpenThread(t);
                onLeave?.();
              }}
              className="w-full text-left px-3 py-2 rounded-xl"
            >
              <div className="truncate font-medium">{t.title}</div>
              <div className="text-[10px] text-white/45 mt-0.5">
                {new Date(t.updated_at || t.created_at).toLocaleString([], {
                  month: 'short',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </button>
            {(onRename || onDelete) && (
              <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleMenu?.(t.id, e.currentTarget);
                    }}
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-white/80 hover:text-white"
                    title="Rename or delete"
                  >
                    …
                  </button>
                  {menuFor === t.id && (
                    <div className="absolute right-0 mt-1 w-28 rounded-md bg-black/90 border border-white/12 shadow-lg p-1 z-50">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMenu?.(null, null);
                          if (onRename) onRename(t);
                        }}
                        className="w-full text-left px-2 py-1 rounded text-white/85 hover:bg-white/10 text-[12px]"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMenu?.(null, null);
                          if (onDelete) onDelete(t);
                        }}
                        className="w-full text-left px-2 py-1 rounded text-rose-200 hover:bg-rose-500/10 text-[12px]"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {!viewMoreAttempted ? (
          <div className="pt-2">
            <button
              onClick={() => {
                setViewMoreAttempted(true);
                onViewMore?.();
              }}
              disabled={loadingMore}
              className="w-full text-center text-xs text-white/70 hover:text-white py-1 disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "View more"}
            </button>
          </div>
        ) : (
          <div className="pt-3 text-center text-[11px] text-white/45">
            Max: 20 threads right now.
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

/* -------------------------------- */
/* ChatDrawer wrapper               */
/* -------------------------------- */

// Routes that should **always** use chrome/silver accent
const isChromeRoute = (p = '') =>
   p.startsWith('/dashboard/bizzy') ||             // Pulse & Bizzi core
   p.startsWith('/chat') ||                        // legacy ChatHome
   p.includes('/dashboard/bizzy-docs') ||
   p.includes('/dashboard/companion') ||
   p.includes('/dashboard/settings') ||
   p.includes('/dashboard/calendar') ||
   p.includes('/dashboard/leads-jobs') ||
   p.includes('/dashboard/jobs');

const ChatDrawer = forwardRef(function ChatDrawer({
  businessId,
  onOpenThread,
  className = '',
  collapsed = false,
  onToggle,
  refreshKey,
  showHistoryTrigger = true,
}, ref) {
  const location = useLocation();

  // Map pathname to either 'chrome' or the module key
  const routeToAccentKey = (p = '') => {
    if (isChromeRoute(p)) return 'chrome';
    if (p.includes('/dashboard/accounting') || p.includes('/dashboard/financials')) return 'accounting';
    if (p.includes('/dashboard/marketing'))    return 'marketing';
    if (p.includes('/dashboard/tax'))          return 'tax';
    if (p.includes('/dashboard/investments'))  return 'investments';
    if (p.includes('/dashboard/email'))        return 'email';
    return 'bizzy';
  };

  const activeAccentKey = routeToAccentKey(location.pathname);
  const activeAccentHex = THREAD_ACCENT[activeAccentKey] || THREAD_ACCENT.chrome;

  const {
    threads,
    loading,
    error,
    q,
    setQ,
    rename,
    archive,
    refresh,
    hasMore,
    loadMore,
  } = useChatThreads(businessId);

  const ctx = useBizzyChatContext() || {};
  const { threadId, openThread, focusThread, openCanvas } = ctx;

  const openThreadFn = onOpenThread || openThread;

  React.useEffect(() => {
    if (!businessId) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, businessId]);

  const inputRefs = React.useRef({});
  const [editingId, setEditingId] = React.useState(null);

  // pager state
  const [shownCount, setShownCount] = React.useState(10);
  const visibleThreadsRef = React.useRef([]);
  const hasMoreRef = React.useRef(hasMore);
  const [paging, setPaging] = React.useState(false);

  React.useEffect(() => { setShownCount(10); }, [businessId, q, refreshKey]);
  React.useEffect(() => {
    setShownCount((prev) => {
      if (threads.length === 0) return prev;
      // Only clamp downward if the list shrank; do not reset when more threads arrive
      if (threads.length < prev) return threads.length;
      return prev;
    });
  }, [threads.length]);
  React.useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);

  const beginRename = (id) => {
    setEditingId(id);
    requestAnimationFrame(() => {
      const el = inputRefs.current[id];
      if (el) { el.removeAttribute('disabled'); el.focus(); el.select(); }
    });
  };
  const saveRename = async (t, el) => {
    const next = (el.value || '').trim();
    el.setAttribute('disabled', 'disabled');
    setEditingId(null);
    if (next && next !== t.title) await rename(t.id, next);
  };
  const cancelRename = (t) => {
    const el = inputRefs.current[t.id];
    if (el) {
      el.value = t.title;
      el.setAttribute('disabled', 'disabled');
    }
    setEditingId(null);
  };

  const [confirmFor, setConfirmFor] = React.useState(null);
  const requestDelete = (t) => setConfirmFor(t);
  const performDelete = async () => {
    if (!confirmFor) return;
    await archive(confirmFor.id, true);
    setConfirmFor(null);
    refresh();
  };

  const [menuFor, setMenuFor] = React.useState(null);
  const [menuAnchor, setMenuAnchor] = React.useState(null);
  const toggleMenu = (id, el) => {
    setMenuFor(prev => {
      const next = prev === id ? null : id;
      setMenuAnchor(next ? el : null);
      return next;
    });
  };
  const closeMenu = () => { setMenuFor(null); setMenuAnchor(null); };
  React.useEffect(() => {
    const onDoc = () => closeMenu();
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  const visibleThreads = threads.filter((t) => !t.archived);
  visibleThreadsRef.current = visibleThreads;
  const displayThreads = visibleThreads.slice(0, shownCount);
  const collapsedPreview = visibleThreads.slice(0, Math.min(shownCount, visibleThreads.length));

  const historyAnchorRef = React.useRef(null);
  const [historyAnchor, setHistoryAnchor] = React.useState(null);
  const historyTimer = React.useRef(null);
  const snapshotAnchor = React.useCallback((anchorEl, align = null) => {
    if (!anchorEl?.getBoundingClientRect) return null;
    const rect = anchorEl.getBoundingClientRect();
    return {
      el: anchorEl,
      align,
      rect: {
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }, []);
  const handleHistoryHover = (anchor, opts = {}) => {
    if (!collapsed) return;
    if (historyTimer.current) clearTimeout(historyTimer.current);
    const anchorEl =
      anchor?.el ||
      anchor ||
      historyAnchor?.el ||
      historyAnchorRef.current;
    // Allow optional alignment override
    setHistoryAnchor(anchorEl ? snapshotAnchor(anchorEl, opts.align || null) : null);
  };
  const handleHistoryLeave = () => {
    if (!collapsed) return;
    if (historyTimer.current) clearTimeout(historyTimer.current);
    historyTimer.current = setTimeout(() => setHistoryAnchor(null), 80);
  };

  useImperativeHandle(ref, () => ({
    openHistory: (anchorEl, opts) => handleHistoryHover(anchorEl, opts),
    closeHistory: handleHistoryLeave,
    setHistoryAnchor: (anchorEl) => setHistoryAnchor(anchorEl || null),
  }));

  const handleViewMore = async () => {
    if (paging) return;
    setPaging(true);
    const target = shownCount + 10;
    let guard = 0;
    while (
      visibleThreadsRef.current.length < target &&
      hasMoreRef.current &&
      guard < 10
    ) {
      await loadMore();
      await new Promise((r) => setTimeout(r, 60));
      guard++;
    }
    // Always advance the visible window to the requested target; if data is still loading,
    // it will fill as threads arrive (and clamp only if list shrinks).
    setShownCount(target);
    setPaging(false);
  };

  // ✅ click → select thread AND open the ChatCanvas
  const handleOpenThread = async (id, isEditingRow, module) => {
    if (isEditingRow) return;
    const mod = (module || 'bizzy').toLowerCase();

    if (typeof openCanvas === 'function') {
      openCanvas(mod);
    }

    try {
      if (typeof focusThread === 'function') {
        await Promise.resolve(focusThread(id, mod));
      } else if (typeof openThreadFn === 'function') {
        await Promise.resolve(openThreadFn(id, { module: mod }));
      }
    } finally {
      requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('bizzy:scrollCanvasBottom')));
      setTimeout(() => window.dispatchEvent(new CustomEvent('bizzy:scrollCanvasBottom')), 120);
    }
  };

  const canViewMore =
    hasMore ||
    visibleThreadsRef.current.length > shownCount;

  return (
    <aside className={`text-white/90 ${className} h-full flex flex-col overflow-hidden${collapsed && !showHistoryTrigger ? '' : ' bizzy-chat-history-panel'}`}>
      {/* Header (omitted when an external trigger is provided) */}
      {(showHistoryTrigger || !collapsed) && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 shrink-0">
          {showHistoryTrigger && (
            <button
              onClick={onToggle}
              className="text-xs text-white/60 hover:text-white flex items-center gap-1"
              title={collapsed ? 'Expand chats' : 'Collapse chats'}
              ref={historyAnchorRef}
              onMouseEnter={() => handleHistoryHover(historyAnchorRef.current)}
              onMouseLeave={handleHistoryLeave}
            >
              <ChatHistoryIcon size={18} />
            </button>
          )}
          {!collapsed && (
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search chats"
              className="bizzy-chat-history-search bg-black/30 border border-white/10 rounded px-2 py-1 text-xs w-40"
              aria-label="Search chats"
            />
          )}
        </div>
      )}

      {/* Body */}
      {!collapsed && (
        <ChatDrawerBody
          loading={loading}
          error={error}
          displayThreads={displayThreads}
          threadId={threadId}
          activeAccentHex={activeAccentHex}
          beginRename={beginRename}
          saveRename={saveRename}
          cancelRename={cancelRename}
          editingId={editingId}
          toggleMenu={toggleMenu}
          menuFor={menuFor}
          menuAnchor={menuAnchor}
          closeMenu={() => {
            setMenuFor(null);
            setMenuAnchor(null);
          }}
          requestDelete={requestDelete}
          handleOpenThread={handleOpenThread}
          canViewMore={canViewMore}
          onViewMore={handleViewMore}
          inputRefs={inputRefs}
          paging={paging}
        />
      )}

      {collapsed && (
        <CollapsedHistoryTooltip
          anchor={historyAnchor}
          loading={loading}
          error={error}
          threads={collapsedPreview}
          onHover={() => {
            if (historyTimer.current) clearTimeout(historyTimer.current);
          }}
          onLeave={handleHistoryLeave}
          onOpenThread={(thread) => handleOpenThread(thread.id, false, thread.module)}
          canViewMore={collapsedPreview.length < Math.min(visibleThreads.length, shownCount + 10)}
          onViewMore={handleViewMore}
          loadingMore={paging}
          onRename={(t) => beginRename(t.id)}
          onDelete={(t) => requestDelete(t)}
          menuFor={menuFor}
          toggleMenu={(id, el) => {
            if (!id) {
              setMenuAnchor(null);
              setMenuFor(null);
              return;
            }
            setMenuAnchor(el || null);
            setMenuFor(id);
          }}
        />
      )}

      {/* Confirm delete dialog */}
      <ConfirmDialog
        open={!!confirmFor}
        title="Delete this chat?"
        message={
          confirmFor ? `"${confirmFor.title}"\n\nThis will remove it from your list.` : ''
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={performDelete}
        onCancel={() => setConfirmFor(null)}
      />
    </aside>
  );
});

export default ChatDrawer;
