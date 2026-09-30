// File: /src/api/gpt/brain/styleSpec.js
// -----------------------------------------------------------------------------
export const STYLE_VERSION = 'v3.0.0';

/** SURFACES decide how much “structure” we inject */
export const SURFACES = {
  CHAT: 'chat',       // main conversational UI (default)
  REPORT: 'report',   // pulse cards, KPI explainers, exports, emails
};

/**
 * High-level style guide (used for scaffolded/report surfaces only).
 * NOTE: Persona/identity is defined in personaSpec + bizzySystemPrompt.
 * This guide focuses on formatting + clarity.
 */
export const STYLE_GUIDE = `
**Formatting rules (enforce strictly):**
- Write in short paragraphs (2–4 sentences). Use clean Markdown.
- Use **bold** sparingly for *short* headers/labels that improve scanning (e.g., **QuickBooks:** connected). Do NOT bold entire sentences.
- Use *italics* rarely (single word/phrase only, at most once per response). Never italicize full sentences.
- Prefer paragraphs over lists. Use bullets only when listing 3+ items, offering options, or when the user asks for a list.
- If the user asks for steps, use a numbered list (max 5), one concise line per step.
- Avoid filler openings/closings (“Here is…”, “In conclusion…”). Get to the point.
- No emojis. No ALL-CAPS emphasis. Keep tone direct, specific, and helpful.
- Do not force a formal conclusion, action list, or closing offer. Include them only when useful.
- If data is missing, give the safe portion first, then ask the minimum questions needed; normally no more than two.
`;

/** Depth presets control verbosity only */
export const DEPTH_PRESETS = {
  brief: `Simple answer: usually one to three short paragraphs, often under about 120 words. Treat this as an approximate target, not a hard limit.`,
  standard: `Normal answer: usually about 80–250 words. Use only the detail the question needs.`,
  deep: `Detailed explanation: usually about 250–600 words. Structure only where it improves comprehension.`,
  comprehensive: `Deep analysis or a requested playbook may be longer when genuinely necessary. Keep it selective and skimmable.`,
  max: `Use extended length only for an explicitly requested, genuinely complex guide or playbook.`,
};

/** Optional reasoning aids. They are not mandatory output shells. */
export const TEMPLATES = {
  general: `Answer directly. Add evidence or an implication only when it helps. Recommend an action only when a meaningful action exists.`,
  analysis: `Lead with the finding, then explain the strongest evidence and material implications. Include risks or actions only when supported and relevant.`,
  financial_insight: `Lead with the main conclusion. Use the reporting period, basis, freshness, and most relevant metrics to support it. Explain what changed without dumping every metric.`,
  procedure: `State the goal briefly, then use a concise numbered sequence. Include warnings or prerequisites only where needed.`,
  decision_brief: `Give the recommendation first. Compare meaningful options in prose or a small table, then explain the decisive tradeoff.`,
  insight: `Lead with the useful finding. Explain why it matters using available evidence; omit action lists when there is no meaningful action.`,
  affordability_check: `Give a Yes, No, or Depends verdict, then explain cash impact, timing, assumptions, and the safest meaningful action.`,
  settings_help: `Answer precisely with only verified menus or routes. If a route is not established, describe the destination without inventing navigation.`,
  billing_help: `Answer the billing question directly. Include plan, timing, or route details only when known.`,
  doc_explain: `State what the document means, then surface only the material points or decisions.`,
  kpi_compare: `State the comparison result first, preserve period and basis, and explain only supported drivers.`,
  marketing_tip: `Give a practical angle and optional draft copy; distinguish the draft from anything sent or published.`,
  investments_insight: `Explain the allocation or risk implication using supplied data and assumptions; avoid unsupported certainty.`,
  tax_help: `Explain the tax-readiness issue, relevant documentation or deadline, and CPA questions when warranted. Do not present Bizzi as the filer, attorney, or CPA.`,
  troubleshooting: `Identify the likely cause from evidence, distinguish known facts from hypotheses, then give an ordered diagnostic procedure.`,
  roadmap_suggestion: `State the product idea and its likely value, then identify the smallest useful validation step.`,
};

/** Fallback for unknown intents */
export function getTemplateForIntent(intent) {
  if (!intent) return TEMPLATES.general;
  return TEMPLATES[intent] || TEMPLATES.general;
}

/** Returns spec to inject into system messages */
export function getStyleSpec({ intent = 'general', depth = 'standard' } = {}) {
  const templateForIntent = getTemplateForIntent(intent);
  const depthGuide = DEPTH_PRESETS[depth] || DEPTH_PRESETS.standard;

  return {
    version: STYLE_VERSION,
    styleGuide: STYLE_GUIDE.trim(),
    templateForIntent: templateForIntent.trim(),
    depthGuide: depthGuide.trim(),
  };
}

/** Convenience helper for your OpenAI messages array */
export function buildStyleSystemMessages({ intent = 'general', depth = 'standard' } = {}) {
  const spec = getStyleSpec({ intent, depth });
  return {
    spec,
    systemMessages: [
      { role: 'system', content: spec.styleGuide },
      { role: 'system', content: `Optional reasoning aid for this request: ${spec.templateForIntent}` },
      { role: 'system', content: spec.depthGuide },
    ],
  };
}

/** Optional guard */
export function isKnownIntent(intent) {
  return Boolean(TEMPLATES[intent] || intent === 'general');
}

/* =============================================================================
   NEW: ChatGPT-style everyday chat (minimal structure, but allows tasteful bold/italics)
   ============================================================================= */

/** Independent version for the chat style block */
export const STYLE_CHAT_VERSION = 'v1.1.0';

/**
 * STYLE_CHAT — compact paragraphs, minimal structure.
 * Use when you want plain ChatGPT-like answers in the main chat:
 *  - No boilerplate headers ("Summary", "Details", "Next steps").
 *  - Bold/italics are allowed but must be intentional and sparse.
 */
export const STYLE_CHAT = `
Chat formatting rules (enforce strictly):
- Write in short paragraphs (2–4 sentences). Use clean Markdown.
- Avoid boilerplate headers like "Summary", "Details", or "Next steps".
- **Bold** is allowed for short labels or micro-headers that improve scanning (e.g., **Risk:**). Do not bold full sentences.
- Do not end with a labeled "**Next action:**" line. If a closing question or offer is useful, ask it directly as a normal sentence.
- *Italics* are allowed but must be rare: a single word/phrase at most once per response. Never italicize whole sentences.
- Use a bullet list only when listing 3+ items, offering options, or when the user asks for steps; keep each bullet to one short line.
- If the user asks for steps, use a numbered list (max 5), one concise line per step.
- Avoid filler like "Here is a summary". Prefer active voice, concrete verbs, and specific recommendations.
- No emojis. No ALL CAPS emphasis. Keep tone pragmatic and clear.
- If asked for a "short version", keep to ≤5 lines.
`;

/** Build a chat-style spec (opt-in) */
export function getChatStyleSpec({ depth = 'standard' } = {}) {
  const depthGuide = DEPTH_PRESETS[depth] || DEPTH_PRESETS.standard;
  return {
    version: STYLE_CHAT_VERSION,
    styleGuide: STYLE_CHAT.trim(),
    depthGuide: depthGuide.trim(),
  };
}

/* =============================================================================
   REPORT STYLE (used for KPI explainers, pulse cards, exports, emails)
   ============================================================================= */

export const STYLE_REPORT_VERSION = 'v1.0.0';

/**
 * STYLE_REPORT — more structured than chat, designed for “output surfaces”.
 * This is not the main chat. It can use headings/tables when appropriate.
 */
export const STYLE_REPORT = `
Report formatting rules (enforce strictly):
- Use clear Markdown and keep it skimmable.
- Headings are allowed when they improve readability (e.g., "Snapshot", "Drivers", "Next actions").
- Prefer short sections over long walls of text.
- Use **bold** for section labels and key numbers.
- Use bullet lists for key points; keep bullets ≤6 items.
- Use numbered steps for procedures or action sequences; max 6 steps.
- If data is missing, ask ≤2 clarifying questions at the end.
`;

/** Build system messages for the conversational main chat */
export function buildChatStyleSystemMessages({ depth = 'standard' } = {}) {
  const depthGuide = DEPTH_PRESETS[depth] || DEPTH_PRESETS.standard;
  return {
    surface: SURFACES.CHAT,
    systemMessages: [
      { role: 'system', content: STYLE_CHAT.trim() },
      { role: 'system', content: depthGuide.trim() },
    ],
  };
}

/** Build system messages for report-like responses (KPI cards, pulse, exports) */
export function buildReportStyleSystemMessages({
  template = 'general',
  depth = 'standard',
} = {}) {
  const tmpl = TEMPLATES[template] || TEMPLATES.general;
  const depthGuide = DEPTH_PRESETS[depth] || DEPTH_PRESETS.standard;
  return {
    surface: SURFACES.REPORT,
    systemMessages: [
      { role: 'system', content: STYLE_REPORT.trim() },
      { role: 'system', content: tmpl.trim() },
      { role: 'system', content: depthGuide.trim() },
    ],
  };
}

/** Convenience selector */
export function buildSystemMessagesForSurface({
  surface = SURFACES.CHAT,
  template, // only used for REPORT
  depth = 'standard',
} = {}) {
  return surface === SURFACES.REPORT
    ? buildReportStyleSystemMessages({ template, depth })
    : buildChatStyleSystemMessages({ depth });
}
