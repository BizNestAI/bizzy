// src/api/email/gmail.parse.js
import sanitizeHtml from 'sanitize-html';

/**
 * Build a reliable list-row summary:
 * - Use the most recent message that actually has headers
 * - Always return sender (name/email), subject, and a short preview
 */
export function normalizeThreadSummary(t) {
  const msgs = t.messages || [];

  // Most recent message with headers
  let chosen = null;
  let headers = {};
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const h = objHeaders(m?.payload?.headers || []);
    if (Object.keys(h).length) {
      chosen = m;
      headers = h;
      break;
    }
  }
  // Fallback to first message headers
  if (!chosen && msgs[0]) {
    chosen = msgs[0];
    headers = objHeaders(msgs[0]?.payload?.headers || []);
  }

  const from = headers.from || '';
  const subject =
    headers.subject ||
    (t.snippet ? t.snippet.slice(0, 120) : '') ||
    '';

  // Preview priority: text/plain > stripped text/html > thread snippet
  let preview = t.snippet || '';
  if (chosen?.payload) {
    const textPart = findPart(chosen.payload, 'text/plain');
    const htmlPart = !textPart ? findPart(chosen.payload, 'text/html') : null;

    if (textPart?.body?.data) {
      const txt = decodeBody(textPart.body) || '';
      preview = txt;
    } else if (htmlPart?.body?.data) {
      const html = decodeBody(htmlPart.body) || '';
      const noTags = html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ');
      preview = noTags;
    }
  }

  preview = (preview || '').replace(/\s+/g, ' ').trim().slice(0, 180);

  return {
    threadId: t.id,
    subject,
    from_name: parseName(from) || parseEmail(from) || '',
    from_email: parseEmail(from) || '',
    snippet: preview,
    last_message_ts: inferLastMessageIso(t),
  };
}

/**
 * Full thread used by the reader panel.
 */
export function normalizeThread(t) {
  const messages = (t.messages || []).map((m) => {
    const headers = objHeaders(m.payload?.headers || []);
    const htmlPart = findPart(m.payload, 'text/html');
    const textPart = findPart(m.payload, 'text/plain');

    const html = htmlPart ? decodeBody(htmlPart.body) : null;
    const text = textPart ? decodeBody(textPart.body) : null;

    return {
      id: m.id,
      date: headers.date || new Date(Number(m.internalDate || Date.now())).toISOString(),
      from: headers.from || '',
      to: headers.to || '',
      cc: headers.cc || '',
      subject: headers.subject || '',
      html: html
        ? sanitizeHtml(html, {
            allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
            allowedAttributes: {
              a: ['href', 'name', 'target', 'rel'],
              img: ['src', 'alt', 'title', 'width', 'height', 'style'],
              '*': ['style'],
            },
            allowedStyles: {
              '*': {
                'text-align': [/^left$|^right$|^center$/],
                'font-size': [/^\d+(?:px|em|rem|%)$/],
              },
              img: { width: [/^\d+(?:px|%)$/], height: [/^\d+(?:px|%)$/] },
            },
          })
        : null,
      text,
      attachments: getAttachments(m.payload, m.id),
    };
  });

  return {
    threadId: t.id,
    messages,
  };
}

/* ----------------------- helpers ----------------------- */

function inferLastMessageIso(t) {
  const last = t.messages?.[t.messages.length - 1];
  if (last?.internalDate) return new Date(Number(last.internalDate)).toISOString();
  const hdr = objHeaders(last?.payload?.headers || []);
  if (hdr.date && !Number.isNaN(Date.parse(hdr.date))) {
    return new Date(Date.parse(hdr.date)).toISOString();
  }
  return null;
}

function findPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  if (payload.parts) {
    for (const p of payload.parts) {
      const found = findPart(p, mimeType);
      if (found) return found;
    }
  }
  return null;
}

function decodeBody(body) {
  try {
    const data = body?.data;
    if (!data) return null;
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function getAttachments(payload, messageId) {
  const out = [];
  function walk(p) {
    if (!p) return;
    if ((p.filename || '').length > 0 && p.body?.attachmentId) {
      out.push({ filename: p.filename, mimeType: p.mimeType, attachmentId: p.body.attachmentId, messageId });
    }
    if (p.parts) p.parts.forEach(walk);
  }
  walk(payload);
  return out;
}

function objHeaders(headers) {
  const o = {};
  headers.forEach((h) => {
    o[h.name.toLowerCase()] = h.value;
  });
  return o;
}
function parseEmail(from) {
  if (!from) return '';
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}
function parseName(from) {
  if (!from) return '';
  const match = from.match(/(.*)<[^>]+>/);
  return match ? match[1].trim() : from;
}
