// File: /src/pages/Docs/DocsLibraryPage.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FileText, File, Image as ImageIcon, Video,
  Presentation as SlideIcon, FileSpreadsheet, FileCode,
  Search, ArrowUpDown, X, MoreVertical, PlusCircle, FileUp
} from 'lucide-react';

import { listDocs, getDocFacets, createDoc } from '../../services/bizzyDocs/docsService';
import { useCurrentBusiness } from '../../context/BusinessContext';
import UploadDocModal from '../../components/BizzyDocs/UploadDocModal';

/* ───────── Graphite tokens / neutrals ───────── */
const NEUTRAL_BORDER = 'rgba(165,167,169,0.18)';
const NEUTRAL_BORDER_SOFT = 'rgba(165,167,169,0.12)';
const PANEL_BG = 'var(--panel)';
const TEXT_MUTED = 'var(--text-2)';
const TEXT_MAIN = 'var(--text)';

const CATEGORY_META = [
  { key: 'all',         label: 'All' },
  { key: 'financials',  label: 'Financials' },
  { key: 'tax',         label: 'Tax' },
  { key: 'marketing',   label: 'Marketing' },
  { key: 'investments', label: 'Investments' },
  { key: 'general',     label: 'General' },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORY_META.map(c => [c.key, c.label]));
const CATEGORY_ACCENTS = {
  financials: { border: 'rgba(34,197,94,0.45)', soft: 'rgba(34,197,94,0.14)', glow: 'rgba(34,197,94,0.08)' },
  tax:         { border: 'rgba(255,215,0,0.42)', soft: 'rgba(255,215,0,0.12)', glow: 'rgba(255,215,0,0.08)' },
  marketing:   { border: 'rgba(59,130,246,0.40)', soft: 'rgba(59,130,246,0.14)', glow: 'rgba(59,130,246,0.08)' },
  investments: { border: 'rgba(147,51,234,0.42)', soft: 'rgba(147,51,234,0.12)', glow: 'rgba(147,51,234,0.08)' },
  general:     { border: NEUTRAL_BORDER, soft: 'rgba(255,255,255,0.08)', glow: 'rgba(255,255,255,0.04)' },
  all:         { border: NEUTRAL_BORDER, soft: 'rgba(255,255,255,0.06)', glow: 'rgba(255,255,255,0.03)' },
};

const SORT_CHOICES = [
  { key: 'new',  label: 'Newest' },
  { key: 'old',  label: 'Oldest' },
  { key: 'az',   label: 'A–Z'    },
  { key: 'za',   label: 'Z–A'    },
];
const SORT_LABEL = Object.fromEntries(SORT_CHOICES.map(s => [s.key, s.label]));

function classNames(...xs){ return xs.filter(Boolean).join(' '); }
function fmtBytes(n){
  if (!n && n !== 0) return '';
  const u = ['B','KB','MB','GB','TB']; let i = 0, v = Math.max(n,0);
  while (v >= 1024 && i < u.length-1) { v/=1024; i++; }
  return `${v.toFixed(v<10&&i?1:0)} ${u[i]}`;
}
function fileIcon(mimeOrExt=''){
  const s = String(mimeOrExt).toLowerCase();
  if (s.includes('image') || /\.(png|jpg|jpeg|gif|webp|svg)$/.test(s))  return <ImageIcon className="h-4 w-4" />;
  if (s.includes('video') || /\.(mp4|mov|webm)$/.test(s))               return <Video className="h-4 w-4" />;
  if (s.includes('sheet') || /\.(xlsx|csv|xls)$/.test(s))               return <FileSpreadsheet className="h-4 w-4" />;
  if (s.includes('presentation') || /\.(ppt|pptx)$/.test(s))            return <SlideIcon className="h-4 w-4" />;
  if (s.includes('pdf') || /\.pdf$/.test(s))                            return <FileText className="h-4 w-4" />;
  if (s.includes('json') || s.includes('text') || /\.(md|txt|json)$/.test(s)) return <FileCode className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

export default function DocsLibraryPage(props) {
  const navigate = useNavigate();

  const [showUpload, setShowUpload] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const newMenuRef = useRef(null);
  const sortMenuRef = useRef(null);
  const closeNewMenu = useCallback(() => setShowNewMenu(false), []);
  const closeSortMenu = useCallback(() => setShowSortMenu(false), []);
  useEffect(() => {
    function onDocClick(e) {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target)) setShowNewMenu(false);
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target)) setShowSortMenu(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Prefer context -> prop -> localStorage
  const ctx = (typeof useCurrentBusiness === 'function' ? useCurrentBusiness() : null) || {};
  const ctxBusinessId = ctx?.businessId;
  const propBusinessId = props?.businessId;
  const lsBusinessId =
    (typeof window !== 'undefined' && (localStorage.getItem('currentBusinessId') || localStorage.getItem('business_id'))) || '';
  const effectiveBusinessId = propBusinessId || ctxBusinessId || lsBusinessId;

  // State
  const [docs, setDocs] = useState([]);
  const [count, setCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [requestId, setRequestId] = useState('');
  const [category, setCategory] = useState('all');
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [facets, setFacets] = useState(null);
  const [sort, setSort] = useState('new');

  const offsetRef = useRef(0);
  const abortRef  = useRef(null);

  // Debounce search
  useEffect(() => {
    const id = setTimeout(() => setQDebounced(q.trim()), 220);
    return () => clearTimeout(id);
  }, [q]);

  // Load facets
  useEffect(() => {
    let alive = true;
    async function loadFacets() {
      if (!effectiveBusinessId) { setFacets(null); return; }
      try {
        const data = await getDocFacets(effectiveBusinessId);
        if (alive) setFacets(data || null);
      } catch {
        if (alive) setFacets(null);
      }
    }
    loadFacets();
    return () => { alive = false; };
  }, [effectiveBusinessId]);

  // Params
  const baseParams = useMemo(
    () => ({
      business_id: effectiveBusinessId || '',
      category,
      q: qDebounced,
      limit: 30,
      sort,
    }),
    [effectiveBusinessId, category, qDebounced, sort]
  );

  // Reset paging when filters change
  useEffect(() => {
    offsetRef.current = 0;
    setDocs([]); setCount(0); setHasMore(false);
  }, [baseParams.business_id, baseParams.category, baseParams.q, baseParams.sort]);

  // First page load
  useEffect(() => {
    if (!effectiveBusinessId) return;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    async function loadFirstPage() {
      setError(''); setRequestId(''); setLoading(true);
      try {
        const out = await listDocs({ ...baseParams, offset: 0, signal: controller.signal });
        const data = Array.isArray(out?.data) ? out.data : [];
        setDocs(data);
        setCount(out?.count ?? data.length);
        setHasMore(!!out?.hasMore);
        setRequestId(out?.request_id || '');
        offsetRef.current = data.length;
        getDocFacets(baseParams.business_id, { force: true }).then(setFacets).catch(()=>{});
      } catch (e) {
        if (controller.signal.aborted) return;
        setDocs([]); setCount(0); setHasMore(false);
        setError(e?.message || 'Failed to load documents');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    loadFirstPage();
    return () => controller.abort();
  }, [baseParams, effectiveBusinessId]);

  // Load more
  async function loadMore() {
    if (!hasMore || loadingMore) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoadingMore(true);
    try {
      const out = await listDocs({ ...baseParams, offset: offsetRef.current, signal: controller.signal });
      const page = Array.isArray(out?.data) ? out.data : [];
      setDocs(prev => [...prev, ...page]);
      setHasMore(!!out?.hasMore);
      offsetRef.current += page.length;
      setRequestId(out?.request_id || requestId);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e?.message || 'Failed to load more');
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  // Open modal
  const onUpload = () => setShowUpload(true);

  // Create a Bizzy-native blank note and jump to it
  async function createBlankNote(editImmediately = false) {
    try {
      const newDoc = await createDoc({
        business_id: effectiveBusinessId,
        title: 'Untitled Note',
        category: category === 'all' ? 'general' : category,
        content: { format: 'sections', sections: [{ heading: '', body: '' }], plain_excerpt: '' },
        tags: []
      });
      // refresh and navigate
      setDocs([]); setCount(0); setHasMore(false);
      if (newDoc?.id) {
        navigate(`/dashboard/bizzy-docs/${newDoc.id}${editImmediately ? '?edit=1' : ''}`);
      }
    } catch (e) {
      console.error('createBlankNote failed', e);
      alert('Could not create the note.');
    }
  }

  return (
    <div className="w-full mx-auto px-4 pt-0 pb-28 bg-app text-primary min-h-screen">
      {/* Header (calm, professional) */}
      <div
        className="relative overflow-hidden rounded-2xl shadow-bizzi border p-5 md:p-7"
        style={{
          background: 'linear-gradient(145deg, rgba(16,18,24,0.95), rgba(9,11,15,0.92))',
          borderColor: NEUTRAL_BORDER
        }}
      >
        <div
          className="pointer-events-none absolute -inset-1 rounded-2xl opacity-25 blur-2xl"
          style={{
            background: 'radial-gradient(55% 55% at 20% 20%, rgba(255,255,255,.08), transparent 65%)'
          }}
        />
        <div className="relative flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-semibold leading-tight tracking-[0.18em] text-[color:var(--text)]">
              Bizzi Docs Library
            </h1>
            <p className="mt-2 text-sm" style={{ color: TEXT_MUTED }}>
              Your summaries, uploads, and references—searchable and organized.
            </p>
          </div>
          <div className="shrink-0 text-sm">
            <span
              className="inline-flex items-center gap-2 rounded-full px-3 py-1 border backdrop-blur"
              style={{ borderColor: NEUTRAL_BORDER, background: 'rgba(255,255,255,0.04)', color: TEXT_MAIN }}
            >
              <FileText className="h-4 w-4" />
              {count ? `${count.toLocaleString()} document${count === 1 ? '' : 's'}` : 'No documents yet'}
            </span>
          </div>
        </div>
      </div>

      {/* Controls bar */}
      <div className="mt-6 mb-6">
        <div
          className="rounded-2xl shadow-bizzi border p-3 backdrop-blur"
          style={{
            background: 'linear-gradient(145deg, rgba(18,20,24,0.92), rgba(12,13,16,0.9))',
            borderColor: NEUTRAL_BORDER,
            boxShadow: '0 20px 50px rgba(0,0,0,0.48)',
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* Category pills */}
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Document categories">
              {CATEGORY_META.map((c) => {
                const pillCount =
                  c.key === 'all' ? facets?.all :
                  c.key === 'financials' ? facets?.financials :
                  c.key === 'tax' ? facets?.tax :
                  c.key === 'marketing' ? facets?.marketing :
                  c.key === 'investments' ? facets?.investments :
                  facets?.general;

                const active = category === c.key;
                const accent = CATEGORY_ACCENTS[c.key] || CATEGORY_ACCENTS.general;
                return (
                  <button
                    key={c.key}
                    onClick={() => setCategory(c.key)}
                    role="tab"
                    aria-selected={active}
                    className={classNames(
                      'px-3 py-1.5 rounded-full text-sm border transition focus:outline-none shadow-[0_6px_18px_rgba(0,0,0,0.28)]',
                      active
                        ? 'text-[color:var(--text)]'
                        : 'text-[color:var(--text-2)] hover:text-[color:var(--text)]'
                    )}
                    style={{
                      background: active ? accent.soft : 'transparent',
                      border: `1px solid ${active ? accent.border : NEUTRAL_BORDER}`,
                      boxShadow: active ? `0 0 0 1px ${accent.border}` : undefined,
                    }}
                  >
                    {c.label}{typeof pillCount === 'number' ? ` (${pillCount})` : ''}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              {/* Sort */}
              <div className="relative" ref={sortMenuRef}>
                <button
                  onClick={() => setShowSortMenu((v) => !v)}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition shadow-[0_10px_28px_rgba(0,0,0,0.35)]"
                  style={{
                    background: 'rgba(24,26,31,0.9)',
                    border: `1px solid ${NEUTRAL_BORDER}`,
                    color: TEXT_MAIN
                  }}
                >
                  <ArrowUpDown className="h-4 w-4" style={{ color: TEXT_MUTED }} />
                  {SORT_LABEL[sort] || 'Sort'}
                </button>
                {showSortMenu && (
                  <div
                    className="absolute left-0 mt-2 w-44 rounded-lg p-1 shadow-2xl z-10 border transition-all duration-150 ease-out"
                    style={{
                      background: PANEL_BG,
                      borderColor: NEUTRAL_BORDER,
                      transformOrigin: 'top left',
                    }}
                  >
                    {SORT_CHOICES.map((s) => (
                      <button
                        key={s.key}
                        onClick={() => { setSort(s.key); closeSortMenu(); }}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5"
                        style={{ color: TEXT_MAIN }}
                      >
                        <span>{s.label}</span>
                        {sort === s.key ? <span style={{ color: TEXT_MUTED }}>•</span> : null}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4" style={{ color: TEXT_MUTED }} />
                <input
                  value={q}
                  onChange={(e)=>setQ(e.target.value)}
                  placeholder="Search title or content…"
                  className="pl-8 pr-7 py-2 rounded-lg text-sm outline-none shadow-inner"
                  style={{
                    background: 'rgba(24,26,31,0.9)',
                    border: `1px solid ${NEUTRAL_BORDER}`,
                    color: TEXT_MAIN
                  }}
                  onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
                  aria-label="Search documents"
                />
                {q && (
                  <button
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1.5 p-1 rounded hover:bg-white/10"
                    onClick={()=>setQ('')}
                    style={{ color: TEXT_MUTED }}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {/* New (compact menu) */}
              <div className="relative" ref={newMenuRef}>
                <button
                  onClick={() => setShowNewMenu(v => !v)}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition shadow-[0_10px_28px_rgba(0,0,0,0.35)]"
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: `1px solid ${NEUTRAL_BORDER}`,
                    color: TEXT_MAIN
                  }}
                >
                  <PlusCircle className="h-4 w-4" />
                  New
                  <MoreVertical className="h-4 w-4 opacity-70" />
                </button>
                {showNewMenu && (
                  <div
                    className="absolute right-0 mt-2 w-44 rounded-lg p-1 shadow-2xl z-10 border transition-all duration-150 ease-out"
                    style={{ background: PANEL_BG, borderColor: NEUTRAL_BORDER, transformOrigin: 'top right' }}
                  >
                    <button
                      onClick={() => { closeNewMenu(); setShowUpload(true); }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5"
                      style={{ color: TEXT_MAIN }}
                    >
                      <FileUp className="h-4 w-4" /> Upload file
                    </button>
                    <button
                      onClick={() => { closeNewMenu(); createBlankNote(true); }}
                      className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5"
                      style={{ color: TEXT_MAIN }}
                    >
                      <FileText className="h-4 w-4" /> New note
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content states */}
      <div className="mt-4">
        {!effectiveBusinessId && (
          <div
            className="rounded-xl p-5"
            style={{ background: PANEL_BG, border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MUTED }}
          >
            No business selected. Choose a business to see its documents.
          </div>
        )}

            {effectiveBusinessId && loading && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {Array.from({ length: 6 }).map((_,i)=>(
                  <div
                    key={i}
                    className="rounded-2xl p-4 animate-pulse shadow-bizzi border"
                    style={{ background: 'linear-gradient(145deg, rgba(24,26,30,0.85), rgba(14,16,20,0.9))', borderColor: NEUTRAL_BORDER }}
                  >
                    <div className="h-4 w-24 rounded" style={{ background: 'rgba(255,255,255,0.06)' }} />
                    <div className="mt-3 h-6 w-3/4 rounded" style={{ background: 'rgba(255,255,255,0.06)' }} />
                    <div className="mt-2 h-3 w-1/2 rounded" style={{ background: 'rgba(255,255,255,0.06)' }} />
                  </div>
            ))}
          </div>
        )}

        {effectiveBusinessId && !loading && error && (
          <div
            className="rounded-xl p-4"
            style={{ background: 'rgba(244,63,94,0.10)', border: '1px solid rgba(244,63,94,0.30)', color: 'rgb(252,165,165)' }}
          >
            {error}
            {requestId ? <div className="text-xs mt-1" style={{ color: 'rgb(248,113,113)' }}>Request ID: {requestId}</div> : null}
          </div>
        )}

        {effectiveBusinessId && !loading && !error && docs.length === 0 && (
          <div
            className="rounded-2xl p-8 text-center shadow-bizzi border"
            style={{ background: PANEL_BG, borderColor: NEUTRAL_BORDER }}
          >
            <div
              className="mx-auto mb-3 h-10 w-10 rounded-full grid place-items-center"
              style={{ border: `1px solid ${NEUTRAL_BORDER}`, background: 'rgba(255,255,255,0.06)' }}
            >
              <FileText className="h-5 w-5" style={{ color: TEXT_MUTED }} />
            </div>
            <div className="font-medium" style={{ color: TEXT_MAIN }}>No docs yet</div>
            <div className="text-sm mt-1" style={{ color: TEXT_MUTED }}>
              Upload files or create a note to get started.
            </div>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={() => setShowUpload(true)}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition"
                style={{ border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
              >
                <FileUp className="h-4 w-4" /> Upload
              </button>
              <button
                onClick={() => createBlankNote(true)}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition"
                style={{ border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
              >
                <FileText className="h-4 w-4" /> New note
              </button>
            </div>
          </div>
        )}

        {effectiveBusinessId && !loading && !error && docs.length > 0 && (
          <>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">
              {docs.map((d, i) => {
                const title = d.title || d.filename || 'Untitled';
                const extOrMime = (d.mime_type || d.extension || '').toString();
                const href = `/dashboard/bizzy-docs/${d.id ?? d.doc_id ?? i}`;
                const created = d.created_at ? new Date(d.created_at) : null;
                const categoryKey = (d.category || 'general').toString();
                const categoryLabel = CATEGORY_LABEL[categoryKey] || categoryKey;
                const accent = CATEGORY_ACCENTS[categoryKey] || CATEGORY_ACCENTS.general;

                return (
                  <li key={d.id ?? d.doc_id ?? `${title}-${i}`}>
                    <Link
                      to={href}
                      className="group block rounded-2xl shadow-bizzi border transition p-4"
                      style={{
                        background: 'linear-gradient(150deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01))',
                        borderColor: accent.border,
                        boxShadow: `0 20px 50px rgba(0,0,0,0.45), 0 0 0 1px ${accent.glow}`,
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-2 text-xs" style={{ color: TEXT_MUTED }}>
                          <span
                            className="grid place-items-center h-6 w-6 rounded-md"
                            style={{ border: `1px solid ${accent.border}`, background: accent.soft }}
                          >
                            {fileIcon(extOrMime)}
                          </span>
                          <span className="uppercase tracking-wide">{categoryLabel}</span>
                        </span>
                        {created && (
                          <span className="text-xs" style={{ color: TEXT_MUTED }}>
                            {new Intl.DateTimeFormat(undefined, { year:'numeric', month:'short', day:'2-digit' }).format(created)}
                          </span>
                        )}
                      </div>

                      <div className="mt-2 line-clamp-2 font-medium group-hover:text-[var(--text)]">
                        {title}
                      </div>

                      <div className="mt-1 text-xs flex items-center gap-2" style={{ color: TEXT_MUTED }}>
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                          style={{ background: accent.soft, border: `1px solid ${accent.border}`, color: TEXT_MAIN }}
                        >
                          <File className="h-3 w-3" />
                          {categoryLabel}
                        </span>
                        {d.size ? fmtBytes(d.size) : ''} {d.author ? `• ${d.author}` : ''}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>

            {hasMore && (
              <div className="flex justify-center mt-4">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-4 py-2 rounded-lg transition disabled:opacity-60"
                  style={{ border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Upload modal lives at page root */}
      <UploadDocModal
        open={showUpload}
        onClose={() => setShowUpload(false)}
        onCreated={(newId) => {
          setShowUpload(false);
          setDocs([]); setCount(0); setHasMore(false);
          if (newId) navigate(`/dashboard/bizzy-docs/${newId}`);
        }}
      />
    </div>
  );
}
