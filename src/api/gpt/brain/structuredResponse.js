const MAX_ARTIFACTS = 2;

export const VERIFIED_CHAT_ROUTES = new Set([
  '/dashboard/bizzi',
  '/dashboard/bizzi/chat',
  '/dashboard/accounting',
  '/dashboard/accounting/bookkeeping',
  '/dashboard/accounting/forecasts',
  '/dashboard/accounting/reports',
  '/dashboard/accounting/reconciliations',
  '/dashboard/marketing',
  '/dashboard/tax',
  '/dashboard/investments',
  '/dashboard/calendar',
  '/dashboard/settings',
  '/dashboard/settings?tab=Integrations',
  '/dashboard/bizzi-docs',
]);

export function isVerifiedChatRoute(route = '') {
  const value = String(route || '').trim();
  if (VERIFIED_CHAT_ROUTES.has(value)) return true;
  return /^\/dashboard\/accounting\/reports\?month=\d{4}-\d{2}&open=pnl$/.test(value);
}

function extractJsonCandidate(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === 'object') return direct;
  } catch {
    // Continue to the fenced-JSON fallback.
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Invalid model JSON is treated as ordinary text below.
    }
  }
  return null;
}

function sanitizeArtifacts(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((artifact) => ({
      type: artifact?.type,
      title: artifact?.title || '',
      subtitle: artifact?.subtitle || '',
      url: artifact?.url || '',
      meta: artifact?.meta,
    }))
    .filter((artifact) =>
      artifact.type === 'pnl_pdf' &&
      artifact.title &&
      /^\/dashboard\/accounting\/reports\?month=\d{4}-\d{2}&open=pnl$/.test(artifact.url)
    )
    .slice(0, MAX_ARTIFACTS);
}

function sanitizeActions(raw = [], allowNavigation = false) {
  if (!allowNavigation || !Array.isArray(raw)) return [];
  return raw
    .filter((action) =>
      action?.type === 'navigate' &&
      action?.payload?.to &&
      action?.label &&
      isVerifiedChatRoute(action.payload.to)
    )
    .map((action) => ({ type: 'navigate', label: action.label, payload: { to: action.payload.to } }));
}

function normalizeDocSuggestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { should_show, shouldShow, reason, suggested_title, suggestedTitle } = raw;
  const allowedReason = reason === 'user_requested' || reason === 'strategic_decision'
    ? reason
    : undefined;
  const show = Boolean(allowedReason && (should_show ?? shouldShow ?? false));
  const title = suggested_title || suggestedTitle || undefined;
  return {
    should_show: show,
    reason: allowedReason,
    ...(title ? { suggested_title: title } : {}),
  };
}

export function parseStructuredResponse(rawText, { allowNavigation = false } = {}) {
  const parsed = extractJsonCandidate(rawText);
  if (!parsed || typeof parsed !== 'object') {
    return { content: rawText, artifacts: [], actions: [], doc_suggestion: null };
  }
  return {
    content: typeof parsed.content === 'string' ? parsed.content : rawText,
    artifacts: sanitizeArtifacts(parsed.artifacts),
    actions: sanitizeActions(parsed.actions, allowNavigation),
    doc_suggestion: normalizeDocSuggestion(parsed.doc_suggestion || parsed.docSuggestion),
  };
}
