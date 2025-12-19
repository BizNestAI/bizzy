// /src/utils/pdfToBizzyFormat.js
const amountRe    = /([-\$]?\d[\d,]*(?:\.\d{2})?)$/;
const importantRe = /\b(total\b|gross profit\b|net income\b|net operating income\b)/i;
const headingRe   = /^(?:[A-Z][A-Z\s&/.-]+|(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,5}))$/;

/* Two-column table with BLANK headers (so no "Item | Total") */
function blockToTableMarkdown(lines) {
  const rows = [];
  for (const ln of lines) {
    const m = ln.match(amountRe);
    if (m) {
      const amount = m[1];
      const label = ln.slice(0, ln.length - m[1].length).trim().replace(/[ :]+$/, '');
      rows.push([label || '—', amount]);
    } else {
      const parts = ln.split(/\s{2,}/);
      rows.push(parts.length >= 2 ? [parts.slice(0,-1).join(' '), parts.at(-1)] : [ln.trim(), '']);
    }
  }
  if (!rows.length) return null;
  let md = `|  |  |\n| --- | ---: |\n`;
  for (const [label, amt] of rows) md += `| ${label} | ${amt} |\n`;
  return md.trim();
}

/* Bold important lines */
function stylizeLine(line) {
  return importantRe.test(line) ? `**${line}**` : line;
}

/* Use thin/thick rules to imitate report lines */
function addSeparatorsAroundTotals(lines) {
  const out = [];
  for (const ln of lines) {
    if (/^cost of goods sold$/i.test(ln) || /^gross profit$/i.test(ln)) {
      if (out.at(-1) !== '<hr class="bizzy-hr-thin" />') out.push('<hr class="bizzy-hr-thin" />');
      out.push(stylizeLine(ln));
      continue;
    }
    if (importantRe.test(ln)) {
      out.push(stylizeLine(ln));
      out.push('<hr class="bizzy-hr-thick" />');
      continue;
    }
    out.push(stylizeLine(ln));
  }
  return out;
}

/** Convert extracted text to { sections: [{ heading, body (Markdown/HTML) }] } */
export function toMarkdownSections(text) {
  const blocks = text
    .replace(/\u00A0/g, ' ')
    .split(/\n{2,}/)
    .map(b => b.split(/\n/).map(l => l.trim()).filter(Boolean))
    .filter(b => b.length);

  const sections = [];
  let current = { heading: '', bodyLines: [] };

  const pushCurrent = () => {
    const body = current.bodyLines.join('\n').trim();
    if (body) sections.push({ heading: current.heading, body });
    current = { heading: '', bodyLines: [] };
  };

  blocks.forEach((lines, idx) => {
    // Center the first small block (title area)
    if (idx === 0 && lines.length <= 5) {
      const html =
        `<div align="center">` +
        lines.map(l => `<div>${l}</div>`).join('') +
        `</div>`;
      pushCurrent();
      sections.push({ heading: '', body: html });
      return;
    }

    const numericish = lines.filter(l => amountRe.test(l)).length;
    const looksLikeTable = numericish >= Math.max(3, Math.ceil(lines.length * 0.6));
    const firstLine = lines[0];
    const isHeading = firstLine.length <= 64 && headingRe.test(firstLine);

    const withHR = addSeparatorsAroundTotals(lines);

    if (isHeading) {
      pushCurrent();
      current.heading = firstLine.replace(/\s{2,}/g, ' ').trim();
      const rest = withHR.slice(1);
      if (rest.length) {
        const maybeTable = (numericish >= Math.max(2, Math.ceil((lines.length - 1) * 0.6)))
          ? blockToTableMarkdown(rest)
          : null;
        current.bodyLines.push(maybeTable || rest.join('\n'));
      }
      return;
    }

    if (looksLikeTable) {
      current.bodyLines.push(blockToTableMarkdown(withHR));
    } else {
      // Fallback: if we see an *isolated* "Total ..." row with amount, render as a 1-row table
    const singleTotalRows = [];
    const otherLines = [];
    for (const ln of withHR) {
      if (/^<hr\b/i.test(ln)) { otherLines.push(ln); continue; }
      const m = ln.match(/^(total\b.*)\s+([-\$]?\d[\d,]*(?:\.\d{2})?)$/i);
      if (m) singleTotalRows.push([m[1], m[2]]);
      else otherLines.push(ln);
    }
    if (singleTotalRows.length) {
      const md = `|  |  |\n| --- | ---: |\n` +
        singleTotalRows.map(([l,a]) => `| ${l} | ${a} |`).join('\n');
      current.bodyLines.push(md);
      if (otherLines.length) current.bodyLines.push(otherLines.join('\n'));
    } else {
      current.bodyLines.push(otherLines.join('\n'));
    }
    }
  });

  pushCurrent();
  if (!sections.length) sections.push({ heading: '', body: text });
  return { sections };
}
