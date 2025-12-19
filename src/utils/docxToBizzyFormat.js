/**
 * Try to center the first 1–3 title lines and return a single "section".
 * Accepts Markdown (converted from DOCX HTML) and returns:
 *   { sections: [{ heading:'', body: <markdown+html allowed> }] }
 */
export function formatDocxMarkdown(md) {
  const lines = (md || '').split(/\r?\n/);

  // collect first heading block (e.g., "# Title", "## Subtitle")
  const titleLines = [];
  let i = 0;
  while (i < Math.min(lines.length, 6)) {
    const ln = lines[i].trim();
    if (/^#{1,3}\s+/.test(ln) || /^(?:[A-Z][A-Za-z].*)$/.test(ln) && ln.length < 80) {
      titleLines.push(ln.replace(/^#{1,3}\s+/, '')); // remove markdown "# "
      i++;
      continue;
    }
    break;
  }

  // We'll render the centered block with a tiny bit of HTML (safe because we allow rehypeRaw)
  let body = '';
  if (titleLines.length) {
    const centered =
      `<div align="center">` +
      titleLines.map(t => `<div><strong>${escapeHtml(t)}</strong></div>`).join('') +
      `</div>\n\n`;
    body += centered;
  }

  // Remainder of the content
  body += lines.slice(titleLines.length).join('\n').trim();

  return { sections: [{ heading: '', body }] };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
