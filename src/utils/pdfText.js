// /src/utils/pdfText.js
import * as pdfjs from 'pdfjs-dist/build/pdf';
import pdfWorker from 'pdfjs-dist/build/pdf.worker?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * Extract text where lines are grouped by Y position and gaps on X become spaces.
 * This preserves headings and pseudo-columns in a readable way.
 */
export async function extractPdfText(input) {
  const loadingTask = typeof input === 'string'
    ? pdfjs.getDocument(input)
    : pdfjs.getDocument({ data: input });

  const pdf = await loadingTask.promise;
  let full = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent({ normalizeWhitespace: true });

    // 1) group by Y (line) with a small tolerance
    const toleranceY = 3;              // px
    const lines = [];
    content.items.forEach((item) => {
      const str = 'str' in item ? item.str : '';
      if (!str) return;
      const tr = item.transform || [1,0,0,1,0,0];
      const x = tr[4];                 // e
      const y = tr[5];                 // f
      let line = lines.find(l => Math.abs(l.y - y) <= toleranceY);
      if (!line) lines.push(line = { y, items: [] });
      line.items.push({ x, str, width: item.width || 0 });
    });

    // 2) sort: top-to-bottom (y desc), left-to-right (x asc)
    lines.sort((a, b) => b.y - a.y);
    const gapThreshold = 10;           // px – gap that becomes spaces
    const spacesPerGap = 2;

    const pageText = lines.map(line => {
      line.items.sort((a, b) => a.x - b.x);

      let text = '';
      let lastX = line.items.length ? line.items[0].x : 0;
      line.items.forEach((it, idx) => {
        if (idx > 0) {
          const gap = it.x - lastX;
          if (gap > gapThreshold) text += ' '.repeat(spacesPerGap);
        }
        text += it.str;
        lastX = it.x + it.width; // approximate advance
      });

      // trim trailing spaces and return line
      return text.replace(/[ \t]+$/,'');
    }).join('\n');

    full += pageText.trim() + '\n\n';
  }

  return full.trim();
}
