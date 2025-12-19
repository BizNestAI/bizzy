// File: /src/components/BizzyDocs/UploadDocModal.jsx
import React, { useRef, useState } from 'react';
import { X, UploadCloud, Loader2 } from 'lucide-react';
import { supabase } from '../../services/supabaseClient';
import { uploadFileToBizzyBucket } from '../../services/bizzyDocs/storageUploads';
import { createUploadedFileDoc } from '../../services/bizzyDocs/docsService';
import { extractPdfText } from '../../utils/pdfText';
import { toMarkdownSections } from '../../utils/pdfToBizzyFormat';
import mammoth from 'mammoth';
import { htmlToPlainText } from '../../utils/htmlToText';
import { htmlToMarkdown } from '../../utils/htmlToMd';
import { formatDocxMarkdown } from '../../utils/docxToBizzyFormat';

const CATEGORIES = [
  { key: 'general', label: 'General' },
  { key: 'financials', label: 'Financials' },
  { key: 'tax', label: 'Tax' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'investments', label: 'Investments' },
];

export default function UploadDocModal({
  open,
  onClose,
  defaultCategory = 'general',
  onCreated, // (newId) => void
}) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(defaultCategory);
  const [tags, setTags] = useState('');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!open) return null;

  const tagArray = tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  function isPdfFile(f) {
    if (!f) return false;
    const mime = (f.type || '').toLowerCase();
    return mime.includes('pdf') || /\.pdf$/i.test(f.name || '');
  }

  function isDocxFile(f) {
    if (!f) return false;
    const mime = (f.type || '').toLowerCase();
    return (
      mime.includes('officedocument.wordprocessingml.document') ||
      /\.docx$/i.test(f.name || '')
    );
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    if (!file) return setErr('Please choose a file.');
    setErr('');
    setBusy(true);
    setProgress(0);

    try {
      // 1) Upload to Supabase Storage
      const up = await uploadFileToBizzyBucket(file, { onProgress: setProgress });

      // 2) Build contentOverride:
      //    - For PDFs: download & extract text -> store as sections/plain_excerpt
      //    - For DOCX: download -> mammoth (HTML) -> Markdown -> format -> store sections
      //    - Else: keep minimal 'upload' content (title-only excerpt)
      let contentOverride = {
        format: 'upload',
        sections: [],
        plain_excerpt: up.filename || '',
      };

      if (isPdfFile(file)) {
        const { data, error } = await supabase
          .storage
          .from(up.storage_bucket)
          .download(up.storage_path);
        if (error) throw error;

        const buf = await data.arrayBuffer();
        const text = await extractPdfText(buf);
        const fm = toMarkdownSections(text);

        contentOverride = {
          format: 'sections',
          sections: fm.sections,
          plain_excerpt: (text || '').slice(0, 600),
        };

      } else if (isDocxFile(file)) {
        // Download DOCX bytes from storage
        // Download the file we just uploaded
    const { data, error } = await supabase
      .storage.from(up.storage_bucket)
      .download(up.storage_path);
    if (error) throw error;
    const buf = await data.arrayBuffer();
 
    // DOCX → HTML (Mammoth)
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer: buf });
 
    // HTML → Markdown
    let md = htmlToMarkdown(html);
 
    // Normalize: remove stray <div align="center">, convert bold-only lines
    // into proper headings, and turn “Total … $amount” rows into 2-col tables.
    md = formatDocxMarkdown(md);
 
    contentOverride = {
      format: 'sections',
      sections: [{ heading: '', body: md }],
      plain_excerpt: htmlToPlainText(html).slice(0, 600),
    };
      }

      // 3) Create a doc row linked to that upload
      const newId = await createUploadedFileDoc({
        title: title || file.name,
        category,
        filename: up.filename,
        mime_type: up.mime_type,
        size: up.size,
        storage_bucket: up.storage_bucket, // optional column
        storage_path: up.storage_path,     // optional column
        file_hash: up.file_hash,           // optional column
        tags: tagArray,
        contentOverride,                   // <-- use parsed text when available
      });

      setBusy(false);
      onClose?.();
      onCreated?.(newId);
    } catch (e) {
      setBusy(false);
      setErr(e?.message || 'Upload failed');
    }
  }

  return (
    <div className="fixed inset-0 z-[999] grid place-items-center bg-black/60 backdrop-blur-sm">
      <div className="w-[92vw] max-w-lg rounded-2xl border border-white/10 bg-[#0B0E13] p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-white text-lg font-semibold">Upload document</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10">
            <X className="h-5 w-5 text-white/70" />
          </button>
        </div>

        {err && (
          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-200">
            {err}
          </div>
        )}

        <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <input
              ref={inputRef}
              type="file"
              className="block w-full text-sm text-white/80"
              onChange={(e) => {
                const f = e.target.files?.[0];
                setFile(f || null);
                if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
              }}
              accept="*/*"
              disabled={busy}
            />
            <div className="mt-2 text-xs text-white/50">
              PDF, images, spreadsheets, slides, docs…
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs text-white/60 mb-1">Title</div>
              <input
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 focus:border-[var(--accent)] outline-none"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter a title"
                disabled={busy}
              />
            </label>
            <label className="block">
              <div className="text-xs text-white/60 mb-1">Category</div>
              <select
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 focus:border-[var(--accent)] outline-none"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={busy}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <div className="text-xs text-white/60 mb-1">Tags (comma separated)</div>
            <input
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 focus:border-[var(--accent)] outline-none"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. estimate, 2025, ACME"
              disabled={busy}
            />
          </label>

          {busy && (
            <div className="flex items-center gap-3 text-sm text-white/70">
              <Loader2 className="h-4 w-4 animate-spin-slow" />
              Uploading… {Math.round(progress * 100)}%
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-white/10 text-white/80 hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--accent)]/50 text-[var(--accent)] hover:bg-[var(--accent)]/10 transition disabled:opacity-60"
              disabled={busy || !file}
            >
              <UploadCloud className="h-4 w-4" /> Upload
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
