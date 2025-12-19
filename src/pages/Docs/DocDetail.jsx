// File: /src/pages/Docs/DocDetail.jsx
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import { getDoc, deleteDoc, updateDoc } from '../../services/bizzyDocs/docsService';
import { useCurrentBusiness } from '../../context/BusinessContext';
import { jsPDF } from 'jspdf';
import domtoimage from 'dom-to-image-more';
import MarkdownRenderer from '../../components/Bizzy/MarkdownRenderer';
import { supabase } from '../../services/supabaseClient';
import { extractPdfText } from '../../utils/pdfText';
import { toMarkdownSections } from '../../utils/pdfToBizzyFormat';
import '../../styles/prose-bizzy.css';

const LIST_ROUTE = '/dashboard/bizzy-docs';

/* --------------------------------- tokens -------------------------------- */
const NEUTRAL_BORDER = 'rgba(165,167,169,0.18)';
const NEUTRAL_BORDER_SOFT = 'rgba(165,167,169,0.12)';
const PANEL_BG = '#0B0E13';
const SUBPANEL_BG = 'rgba(255,255,255,0.05)';
const TEXT_MAIN = 'var(--text)';
const TEXT_MUTED = 'var(--text-2)';

/* ----------------------------- small helpers ----------------------------- */
function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Math.max(n, 0);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

const AMOUNT_RE = /(?<![\d,.\$])\s(\$?[0-9][0-9,]*(?:\.\d{2})?)\s*$/;

function looksLikeHtml(s) { return /<\/?[a-z][\s\S]*>/i.test(s || ''); }

function stripHtmlToPlain(html) {
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    const text = tmp.textContent || tmp.innerText || '';
    return text.replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n');
  } catch { return html || ''; }
}

function mdToPlain(s = '') {
  return String(s)
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, ''))
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/^\s*-\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** VIEW formatting (markdown). */
function formatForView(input) {
  let s = String(input || '');
  if (looksLikeHtml(s)) s = stripHtmlToPlain(s);

  const out = [];
  for (const rawLine of s.split(/\r?\n/)) {
    let line = rawLine;

    const boldOnly = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
    if (boldOnly) { out.push('# ' + boldOnly[1].trim()); continue; }

    const m = AMOUNT_RE.exec(line);
    if (m && line.trim().length > m[1].length + 1) {
      const amount = m[1].startsWith('$') ? m[1] : `$${m[1]}`;
      const label = line.replace(AMOUNT_RE, '').trim();
      out.push(`| ${label} | ${amount} |`);
      out.push(`| :--- | ---: |`);
      continue;
    }

    out.push(line);
  }
  return out.join('\n').replace(/^\s*---\s*$/gm, '___');
}

/** EDIT formatting (plain, no tables). */
function formatForEdit(input) {
  let s = String(input || '');
  if (looksLikeHtml(s)) s = stripHtmlToPlain(s);

  const out = [];
  for (const rawLine of s.split(/\r?\n/)) {
    let line = rawLine;
    const boldOnly = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
    if (boldOnly) { out.push(boldOnly[1].trim()); continue; }
    out.push(line);
  }
  return out.join('\n');
}

function plainForExport(viewMd) { return mdToPlain(viewMd); }

/* -------------------------------- component ------------------------------ */
export default function DocDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const ctx = (typeof useCurrentBusiness === 'function' ? useCurrentBusiness() : null) || {};
  const ctxBusinessId = ctx?.businessId;
  const lsBusinessId =
    (typeof window !== 'undefined' && (localStorage.getItem('business_id') || localStorage.getItem('currentBusinessId'))) || '';
  const effectiveBusinessId = ctxBusinessId || lsBusinessId;

  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [showDelete, setShowDelete] = useState(false);

  const [title, setTitle] = useState('');
  const [body, setBody]   = useState('');     // canonical stored body (plain/markdown)
  const [editorText, setEditorText] = useState(''); // ⬅️ live textarea text while editing

  const cardRef = useRef(null);

  const isPdf = (d) => !!d && ((d.mime_type?.toLowerCase().includes('pdf')) || /\.pdf$/i.test(d.filename || ''));

  async function maybeAutoExtractPdf(row) {
    try {
      if (!isPdf(row)) return row;
      const isUploadStub = !Array.isArray(row.content?.sections) || row.content.sections.length === 0;
      if (!isUploadStub) return row;
      if (!row.storage_bucket || !row.storage_path) return row;

      const { data, error } = await supabase.storage.from(row.storage_bucket).download(row.storage_path);
      if (error) throw error;

      const buf  = await data.arrayBuffer();
      const text = await extractPdfText(buf);
      const fm   = toMarkdownSections(text);
      const next = {
        format: 'sections',
        sections: fm.sections,
        plain_excerpt: text.slice(0, 600),
      };

      const patched = await updateDoc(row.id, {
        title: (row.title || row.filename || 'From PDF').replace(/\.pdf$/i, ''),
        content: next,
      });

      return patched || row;
    } catch (e) {
      console.warn('[auto-extract] pdf failed:', e);
      return row;
    }
  }

  // load
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr('');
      try {
        if (!id) throw new Error('missing_id');
        if (!effectiveBusinessId) throw new Error('missing_or_invalid_business_id');

        let row = await getDoc(id, { business_id: effectiveBusinessId });
        if (!alive) return;
        if (!row) throw new Error('not_found');

        row = await maybeAutoExtractPdf(row);
        if (!alive) return;

        const sections = Array.isArray(row.content?.sections) ? row.content.sections : [];
        const combined = sections.length
          ? sections.map(s => [s.heading, s.body].filter(Boolean).join('\n\n')).join('\n\n\n')
          : (typeof row.content === 'string'
              ? row.content
              : (row.content?.plain_excerpt || ''));

        setDoc(row);
        setTitle(row.title || row.filename || 'Untitled');
        setBody(combined || '');

        if (new URLSearchParams(location.search).get('edit') === '1') {
          setEditing(true);
        }
      } catch (e) {
        if (!alive) return;
        setErr(e?.message || 'not_found');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id, effectiveBusinessId, location.search]);

  // enter edit mode → seed editorText
  useEffect(() => {
    if (editing) setEditorText(formatForEdit(body));
  }, [editing, body]);

  // Cmd/Ctrl+S to save while editing
  useEffect(() => {
    const onKey = (e) => {
      if (!editing) return;
      const isSave = (e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey);
      if (isSave) {
        e.preventDefault();
        saveNow();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, title, editorText]);

  async function saveNow() {
    if (!doc) return;
    setSaving(true);
    try {
      const clean = formatForEdit(editorText);
      const nextContent = {
        format: 'plain',
        sections: [{ heading: '', body: clean }],
        plain_excerpt: clean.slice(0, 600),
      };
      const patched = await updateDoc(doc.id, { title, content: nextContent });
      setDoc(patched);
      setBody(clean);              // keep view in sync
      setSavedAt(new Date());
      setEditing(false);
    } catch (e) {
      alert(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function exportPDF() {
    try {
      const node = cardRef.current;
      if (!node) throw new Error('no card element');

      await new Promise(requestAnimationFrame);

      const pdf = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const scale = Math.min(2, window.devicePixelRatio || 1.5);
      const margin = 56;

      const filter = (el) => {
        if (el.closest && el.closest('[data-bizzy-chatbar]')) return false;
        return true;
      };

      const dataUrl = await domtoimage.toPng(node, {
        filter,
        bgcolor: '#111418',
        height: node.scrollHeight,
        width: node.scrollWidth,
        style: { transform: `scale(${scale})`, transformOrigin: 'top left', background: '#111418' },
      });

      const img = new Image();
      img.src = dataUrl;
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

      const printableW = pageW - margin * 2;
      const renderH    = img.height * (printableW / img.width);

      let totalRendered = 0;
      let yOnImage = 0;

      while (totalRendered < renderH) {
        if (totalRendered > 0) pdf.addPage();
        const sliceH = Math.min(renderH - totalRendered, pageH - margin * 2);
        const sliceScale = img.width / printableW;

        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = img.width;
        pageCanvas.height = sliceH * sliceScale;
        const ctx = pageCanvas.getContext('2d');

        ctx.drawImage(img, 0, yOnImage * sliceScale, img.width, pageCanvas.height, 0, 0, pageCanvas.width, pageCanvas.height);

        const pageData = pageCanvas.toDataURL('image/png');
        pdf.addImage(pageData, 'PNG', margin, margin, printableW, sliceH);

        yOnImage += sliceH;
        totalRendered += sliceH;
      }

      pdf.save(`${(title || 'bizzy_doc').replace(/\s+/g, '_')}.pdf`);
    } catch (e) {
      console.error('[exportPDF] failed', e);
      alert('Could not export this document.');
    }
  }

  async function handleDelete() {
    if (!doc) return;
    try {
      await deleteDoc(doc.id);
      navigate(LIST_ROUTE);
    } catch (e) {
      alert(e?.message || 'Delete failed.');
    }
  }

  const created = doc?.created_at ? new Date(doc.created_at) : null;
  const createdText = created
    ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(created)
    : '';
  const category = (doc?.category || 'general').toUpperCase();
  const size = doc?.size ? fmtBytes(doc.size) : '';
  const author = doc?.author || '';

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="rounded-2xl border" style={{ borderColor: NEUTRAL_BORDER, background: PANEL_BG }}>
          <div className="p-6 animate-pulse">
            <div className="h-6 w-1/2 rounded" style={{ background: 'rgba(255,255,255,0.08)' }} />
            <div className="mt-3 h-4 w-1/3 rounded" style={{ background: 'rgba(255,255,255,0.08)' }} />
            <div className="mt-6 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-3 rounded" style={{ background: 'rgba(255,255,255,0.08)' }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (err || !doc) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="rounded-2xl p-6" style={{ background: 'rgba(244,63,94,0.10)', border: '1px solid rgba(244,63,94,0.30)', color: 'rgb(252,165,165)' }}>
          Error: {err || 'not_found'}
          <div className="mt-3">
            <Link to={LIST_ROUTE} className="underline">Back to library</Link>
          </div>
        </div>
      </div>
    );
  }

  const viewMd = formatForView(body);

  return (
    <div className="w-full max-w-7xl mx-auto px-4 pt-0 pb-40">
      {/* Top bar */}
      <div className="mb-3 flex items-center justify-between">
        <Link to={LIST_ROUTE} className="text-sm" style={{ color: TEXT_MUTED }}>
          ← Back to Docs
        </Link>
        <div className="flex items-center gap-3 text-xs" style={{ color: TEXT_MUTED }}>
          {savedAt ? `Saved ${new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'}).format(savedAt)}` : ''}
        </div>
      </div>

      {/* Card */}
      <div ref={cardRef} className="rounded-2xl border" style={{ borderColor: NEUTRAL_BORDER, background: PANEL_BG }}>
        <div className="p-6 pb-3 flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-xs" style={{ color: TEXT_MUTED }}>{category}</div>

            {!editing ? (
              <h1 className="mt-1 text-2xl md:text-3xl font-semibold" style={{ color: TEXT_MAIN }}>
                {title}
              </h1>
            ) : (
              <input
                className="mt-1 w-full rounded-lg px-3 py-2 text-lg md:text-xl outline-none"
                style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
                value={title}
                onChange={(e)=>setTitle(e.target.value)}
              />
            )}

            <div className="mt-1 text-xs" style={{ color: TEXT_MUTED }}>
              {author ? `${author} • ` : ''}{createdText}{size ? ` • ${size}` : ''}
            </div>
          </div>

          <div className="flex gap-2 shrink-0">
            {!editing ? (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="px-3 py-2 rounded-lg transition"
                  style={{ border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
                >
                  Edit
                </button>
                <button
                  onClick={exportPDF}
                  className="px-3 py-2 rounded-lg transition"
                  style={{ border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
                >
                  Export PDF
                </button>
                <button
                  onClick={() => setShowDelete(true)}
                  className="px-3 py-2 rounded-lg transition"
                  style={{ border: '1px solid rgba(244,63,94,0.55)', color: 'rgb(252,165,165)' }}
                >
                  Delete
                </button>

                {showDelete && (
                  <div className="fixed inset-0 z-[999] bg-black/60 backdrop-blur-sm grid place-items-center">
                    <div className="w-[92vw] max-w-md rounded-2xl p-5 shadow-xl"
                         style={{ border: '1px solid rgba(244,63,94,0.35)', background: '#160e11' }}>
                      <h3 className="text-lg font-semibold" style={{ color: TEXT_MAIN }}>Delete document?</h3>
                      <p className="mt-2 text-sm" style={{ color: 'rgb(252,165,165)' }}>
                        This action can’t be undone. The note and its contents will be permanently removed.
                      </p>
                      <div className="mt-4 flex justify-end gap-2">
                        <button
                          onClick={() => setShowDelete(false)}
                          className="px-3 py-2 rounded-lg transition"
                          style={{ border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={async () => { setShowDelete(false); await handleDelete(); }}
                          className="px-3 py-2 rounded-lg transition"
                          style={{ border: '1px solid rgba(244,63,94,0.55)', color: 'rgb(252,165,165)', background: 'rgba(244,63,94,0.12)' }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <button
                onClick={saveNow}
                disabled={saving}
                className="px-3 py-2 rounded-lg transition disabled:opacity-60"
                style={{ border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN }}
              >
                {saving ? 'Saving…' : 'Done'}
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 pb-6">
          {!editing ? (
            <div className="rounded-2xl p-5" style={{ background: SUBPANEL_BG, border: `1px solid ${NEUTRAL_BORDER_SOFT}` }}>
              <MarkdownRenderer value={viewMd} className="prose-bizzy max-w-none" />
            </div>
          ) : (
            <textarea
              className="w-full min-h-[70vh] md:min-h-[75vh] rounded-xl outline-none leading-7"
              style={{ background: '#101418', border: `1px solid ${NEUTRAL_BORDER}`, color: TEXT_MAIN, padding: '16px' }}
              value={editorText}
              onChange={(e)=>setEditorText(e.target.value)}
              placeholder="Write or paste your content…"
            />
          )}
        </div>
      </div>
    </div>
  );
}
