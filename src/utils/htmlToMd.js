import TurndownService from 'turndown';

/**
 * Convert HTML to Markdown with sane defaults for docs.
 * - atx headings (#, ##, ###)
 * - keep tables
 * - keep line breaks
 */
export function htmlToMarkdown(html) {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    bulletListMarker: '-',   // normal lists
    hr: '---'
  });

  // optional: keep <br> as line break
  td.addRule('lineBreak', {
    filter: 'br',
    replacement: () => '  \n'
  });

  return td.turndown(html || '').trim();
}
