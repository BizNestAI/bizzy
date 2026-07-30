// File: /src/api/gpt/brain/styleSpec.js
// -----------------------------------------------------------------------------
export const STYLE_VERSION = 'v2.1.0';

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
You are Bizzi — an **Autonomous Financial Operator** for contractors, trades, and home-service businesses.
You keep books clean continuously, keep cash visible, and turn real numbers into clear next actions.

**Formatting rules (enforce strictly):**
- Write in short paragraphs (2–4 sentences). Use clean Markdown.
- Use **bold** sparingly for *short* headers/labels that improve scanning (e.g., **QuickBooks:** connected). Do NOT bold entire sentences.
- Use *italics* rarely (single word/phrase only, at most once per response). Never italicize full sentences.
- Prefer paragraphs over lists. Use bullets only when listing 3+ items, offering options, or when the user asks for a list.
- If the user asks for steps, use a numbered list (max 5), one concise line per step.
- Avoid filler openings/closings (“Here is…”, “In conclusion…”). Get to the point.
- No emojis. No ALL-CAPS emphasis. Keep tone direct, specific, and helpful.
- If data is missing, ask ≤2 clarifying questions at the end in one short line.
`;

/** Depth presets control verbosity only */
export const DEPTH_PRESETS = {
  brief: `≤120 words. One tight paragraph or 3 bullets max if requested.`,
  standard: `~200–400 words across multiple short paragraphs; bullets only when helpful.`,
  deep: `~400–800 words. Multiple short paragraphs; use bullets/tables when they improve clarity.`,
  comprehensive: `~800–1,400 words. Teach/guide level detail with examples. Keep paragraphs short; use bullets/tables sparingly to aid scanning.`,
  max: `Up to ~1,800 words if the question explicitly asks for a full guide/playbook. Keep it skimmable with short paragraphs and occasional lists.`,
};

/** Your existing TEMPLATES stay as-is (kept for backwards compatibility) */
export const TEMPLATES = {
  general: `
### Summary
<one-line>

### Details
- <key point 1>
- <key point 2>

### Next steps
1. <action 1>
2. <action 2>
`,

  analysis: `
### Summary
<one-line takeaway>

### Key drivers
- <driver 1>
- <driver 2>

### Risks & mitigations
- **Risk:** <risk> — **Mitigation:** <mitigation>

### Next steps
1. <action 1>
2. <action 2>
`,

  financial_insight: `
### Snapshot
- Revenue: <value> (<trend>)
- Expenses: <value> (<trend>)
- Net profit: <value> (<trend>)

### KPI table
| Metric | Value | Trend |
|---|---:|:---:|
| <metric A> | <value> | <up/down/flat> |
| <metric B> | <value> | <up/down/flat> |

### Interpretation
- <what’s driving results>

### Next steps
1. <action 1>
2. <action 2>
`,

  procedure: `
### Summary
<what we’re doing in one line>

### Steps
1. <step 1>
2. <step 2>
3. <step 3>

**Tips**
- <tip 1>
- <tip 2>
`,

  decision_brief: `
### Recommendation
<one-line recommendation>

### Options table
| Option | Pros | Cons | When to choose |
|---|---|---|---|
| <A> | <pros> | <cons> | <context> |
| <B> | <pros> | <cons> | <context> |

### Rationale
- <why this choice fits>

### Next steps
1. <action 1>
2. <action 2>
`,

  insight: `
**TL;DR:** <one-sentence takeaway>

**Why it matters**
- <impact 1>
- <impact 2>

**Drivers / Evidence**
- <driver or datapoint 1>
- <driver or datapoint 2>

**Actions**
1. <most leveraged action>
2. <second action>

**Questions** (if data missing)
- <clarifier 1>
- <clarifier 2>
`,

  affordability_check: `
**Verdict:** <Yes/No/Depends> — <one-line justification>

**Cash flow impact**
- <near-term impact>
- <risk or timing consideration>

### Next steps
1. <action 1>
2. <action 2>
`,

  calendar_schedule: `
**Scheduled:** <title> — <date/time>

**Details**
- Type: <meeting/job/deadline>
- When: <start → end>
- Where: <location or online>

### Next steps
1. <confirm/prepare step>
2. <optional follow-up>
`,

  settings_help: `
### What you can do
- <capability 1>
- <capability 2>

### Where to find it
- <route or menu path>

### Next steps
1. <open route / click area>
2. <perform action>
`,

  billing_help: `
### Summary
<billing/plan in one sentence>

### Details
- Plan: <plan name/price>
- Trial: <days/limits>
- Invoices: <where to find>

### Next steps
1. <open billing route>
2. <upgrade/change/cancel>
`,

  doc_explain: `
### Summary
<one-sentence overview of the doc>

### Key points
- <point 1>
- <point 2>
- <point 3>

### Next steps
1. <action derived from the document>
2. <optional follow-up>
`,

  kpi_compare: `
**TL;DR:** <who's up/down and why in one line>

**Comparison**
- <metric A: last vs current>
- <metric B: last vs current>

**Drivers**
- <driver 1>
- <driver 2>

### Next steps
1. <improvement>
2. <monitoring>
`,

  // Legacy (kept): marketing_tip, investments_insight, tax_help, troubleshooting, roadmap_suggestion
  marketing_tip: `
### Angle to try
- <hook or theme>

### Example copy
- <1–2 lines of example>

### Next steps
1. <create asset / schedule>
2. <measure result>
`,

  investments_insight: `
**TL;DR:** <allocation or risk takeaway>

**Allocation**
- <equities/bonds/cash breakdown>

**What to watch**
- <risk or opportunity>

### Next steps
1. <rebalance/automate>
2. <monitor threshold>
`,

  tax_help: `
### Summary
<deadline or rule in one sentence>

### What to do
- <prep or doc>
- <thresholds to note>

### Next steps
1. <file/estimate/pay>
2. <set reminder>
`,

  troubleshooting: `
### What likely happened
- <cause 1>
- <cause 2>

### Fix
1. <step 1>
2. <step 2>

**If it persists**, share: <log/screenshot/route>.
`,

  roadmap_suggestion: `
### Idea
<one-sentence concept>

### Why it helps
- <benefit 1>
- <benefit 2>

### Next steps
1. <spike/estimate>
2. <MVP slice>
`,
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
      { role: 'system', content: spec.templateForIntent },
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
