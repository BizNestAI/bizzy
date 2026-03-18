// Lightweight post-formatter to gently enforce Markdown structure (labels, steps, bullets)
export function formatBizzyMarkdown(raw = '') {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) return text;

  const lines = text.split('\n');
  const out = [];
  let inFence = false;

  const isListy = (line = '') => /^\s*([-*+]\s|\d+\.\s)/.test(line.trim());
  const isHeading = (line = '') => /^\s*#{1,6}\s/.test(line.trim());
  const labelMatch = (line = '') => {
    const m = /^\s*([^:\n]+):\s*(.+?)\s*$/.exec(line);
    if (!m) return null;
    const label = m[1].trim();
    const value = m[2].trim();
    if (!label || !value) return null;
    if (label.length > 24 || value.length > 160) return null;
    return { label, value };
  };

  // Mark consecutive label lines for bullets
  const labelEligible = [];
  let fenceState = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      fenceState = !fenceState;
      labelEligible.push(false);
      continue;
    }
    if (fenceState || isListy(line) || isHeading(line)) {
      labelEligible.push(false);
      continue;
    }
    labelEligible.push(!!labelMatch(line));
  }

  const shouldBullet = new Array(lines.length).fill(false);
  let runStart = -1;
  labelEligible.forEach((flag, idx) => {
    if (flag && runStart === -1) runStart = idx;
    if (!flag && runStart !== -1) {
      if (idx - runStart >= 3) {
        for (let i = runStart; i < idx; i += 1) shouldBullet[i] = true;
      }
      runStart = -1;
    }
  });
  if (runStart !== -1 && lines.length - runStart >= 3) {
    for (let i = runStart; i < lines.length; i += 1) shouldBullet[i] = true;
  }

  // Pass 2: render
  inFence = false;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      out.push(line);
      return;
    }
    if (inFence) {
      out.push(line);
      return;
    }

    // Skip lines already with bold/italic markers to avoid double styling
    const hasInlineEmphasis = /(\*\*|__|\*|_)/.test(trimmed);

    // Header-like lines ending with ":" (not label/value)
    if (!isListy(trimmed) && !isHeading(trimmed) && !hasInlineEmphasis) {
      if (trimmed.endsWith(':') && trimmed.length <= 48 && !trimmed.includes('**')) {
        // Avoid short label:value patterns already handled below
        const labelish = trimmed.slice(0, -1).trim();
        if (labelish && !labelMatch(trimmed)) {
          out.push(`**${labelish}:**`);
          return;
        }
      }
    }

    // Step conversion
    const stepMatch = /^step\s*(\d+)\s*[:.-]\s*(.+)$/i.exec(trimmed);
    if (stepMatch && !isListy(trimmed)) {
      const [, num, rest] = stepMatch;
      out.push(`${Number(num)}. ${rest.trim()}`);
      return;
    }

    const lv = labelMatch(line);
    if (lv && !isListy(trimmed) && !isHeading(trimmed)) {
      const rendered = `- **${lv.label}:** ${lv.value}`;
      out.push(rendered);
      return;
    }

    out.push(line);
  });

  return out.join('\n');
}
