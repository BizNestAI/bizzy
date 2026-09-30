// File: /src/api/gpt/persona/persona.helpers.js

import {
  buildPersonaMessage,
  buildPersonaWithChatStyle,
  buildPersonaAndStyleSystems, // style = 'chat' | 'scaffolded'
} from './personaSpec.js';

/**
 * Lightweight heuristics to infer when the user likely wants structure.
 */
function inferStructureFromPrompt(prompt = '') {
  const p = String(prompt || '').toLowerCase();
  const wantsThorough =
    /\b(playbook|deep dive|comprehensive|in depth|detailed analysis|full analysis|thorough|framework)\b/.test(p);

  const asksWhy = /\bwhy|reason|because|rationale|tradeoff|trade-off\b/.test(p);
  const asksHow = /\bhow\b/.test(p);
  const asksCompare = /\bcompare|versus|vs\.?|pros and cons|tradeoff|trade-off|which should i choose\b/.test(p);

  const wantsSteps =
    /\b(step|steps|checklist|how do i|procedure|walk me through|process)\b/.test(p);

  const wantsTable =
    /\b(table|tabulate|matrix|grid|columns)\b/.test(p);

  const wantsBrief =
    /\b(tl;dr|short version|brief|summary only|one line|one-liner)\b/.test(p);

  return {
    wantsSteps,
    wantsCompare: asksCompare,
    wantsTable,
    wantsBrief,
    wantsThorough,
    asksWhy,
    asksHow,
    wantsScaffold: wantsSteps || asksCompare || wantsTable,
  };
}

/**
 * High-level narrative hint: influences tone and structure style.
 */
function chooseNarrativeHint(prompt = '') {
  const h = inferStructureFromPrompt(prompt);
  if (h.wantsBrief) return 'direct-answer';
  if (h.wantsSteps) return 'numbered-steps';
  if (h.wantsCompare || h.wantsTable) return 'contrast-brief';
  if (h.asksWhy) return 'mini-essay-with-reasoning';
  if (h.asksHow) return 'example-led-explanation';
  return 'direct answer in short paragraphs; add structure only when it materially improves clarity';
}

/**
 * Detect explicit complexity signals without using prompt length as a proxy.
 */
function detectStructuredReasoning(prompt = '') {
  const p = String(prompt || '').toLowerCase();
  return /\b(compare|comparison|versus|vs\.?|pros and cons|forecast|afford|financial review|troubleshoot|diagnose|procedure|step by step|deep dive|comprehensive|breakdown|playbook)\b/.test(p);
}

/**
 * Choose depth (controls verbosity)
 */
function chooseDepth({ flags = {}, surface, prompt = '' } = {}) {
  if (flags.quick || surface === 'popover' || surface === 'chip') return 'brief';
  if (flags.deepDive || surface === 'doc') return 'comprehensive';
  const p = String(prompt || '').trim().toLowerCase();
  if (p.length <= 100 && /^(what (?:is|are|does)|define|when (?:is|do|does)|who (?:is|are))\b/.test(p)) return 'brief';
  return 'standard';
}

/**
 * Choose style ("chat" vs "scaffolded")
 */
function chooseStyle({ intent, prompt, flags = {} } = {}) {
  const hints = inferStructureFromPrompt(prompt);
  const structuralIntent =
    intent === 'procedure' ||
    intent === 'decision_brief' ||
    intent === 'kpi_compare' ||
    intent === 'forecast_generate' ||
    intent === 'affordability_check' ||
    intent === 'financial_insight' ||
    intent === 'troubleshooting';

  if (flags.wantStructure || hints.wantsScaffold || structuralIntent) {
    return 'scaffolded';
  }
  return 'chat';
}

/**
 * Tone + persona dials
 */
export function applyPersona(opts = {}) {
  const intent = opts.intent || 'general';
  const moduleKey = opts.module || 'bizzy';
  const flags = opts.flags || {};
  const dials = { humor: 1, energy: 2, brevity: 2, optimism: 2 };

  if (flags.bad_news) {
    dials.humor = 0;
    dials.brevity = 3;
    dials.optimism = 1;
  }

  if (flags.celebration) {
    dials.energy = 3;
    dials.optimism = 3;
    dials.humor = 2;
  }

  if (flags.quick) dials.brevity = 3;
  if (flags.deepDive) dials.brevity = 1;

  const message = buildPersonaMessage({ intent, module: moduleKey, dials });
  return { message, dials };
}

/**
 * Main: build persona + style + contextual hints
 */
export function buildPersonaSystems(opts = {}) {
  const intent = (opts.intent || 'general').toLowerCase();
  const moduleKey = (opts.module || 'bizzy').toLowerCase();
  const flags = { ...(opts.flags || {}) };
  const prompt = opts.prompt || '';
  const surface = opts.surface;

  // Tone dials
  const { dials } = applyPersona({ intent, module: moduleKey, flags });

  // Depth & style
  const hints = inferStructureFromPrompt(prompt);
  let depth = opts.depth || chooseDepth({ flags, surface, prompt });
  if (!opts.depth && !flags.quick) {
    if (flags.deepDive || hints.wantsThorough) depth = 'comprehensive';
  }

  const style = opts.style || chooseStyle({ intent, prompt, flags });
  let narrative = chooseNarrativeHint(prompt);
  if (flags.demoPunchy) {
    narrative = 'lead with the material finding; use metric bullets or actions only when they improve the answer';
  }
  const shouldStructure = detectStructuredReasoning(prompt);

  // Compose persona + style
  let result;
  if (style === 'scaffolded') {
    result = buildPersonaAndStyleSystems({
      intent,
      module: moduleKey,
      dials,
      depth,
      style: 'scaffolded',
    });
  } else {
    result = buildPersonaWithChatStyle({
      intent,
      module: moduleKey,
      dials,
      depth,
    });
  }

  // Final injected behavioral prompt
  const systemHints = [
    `Prefer narrative flow: ${narrative}.`,
    `Do not force uniform paragraph counts.`,
    `Avoid mechanical or repetitive structure — vary tone and format based on what fits the question.`,
    `Skip generic headings like "Summary", "Details", or "Next steps". Only add a short, topic-specific label if the user asks for structure or it clearly improves clarity.`,
  ];

  if (shouldStructure) {
    systemHints.push(
      `This question benefits from multi-part reasoning. Use topic-specific labels, bullets, steps, or a small table only where they materially improve clarity.`
    );
  }

  if (flags.demoPunchy) {
    systemHints.push(
      'Demo mode: lead with the material finding and use exact supplied dollars, percentages, or lead counts. Add an action plan or offer a draft/checklist only when it materially helps.'
    );
  }

  return {
    systemMessages: [
      ...result.systemMessages,
      { role: 'system', content: systemHints.join(' ') },
    ],
    dials,
    style,
    depth,
    intent,
    module: moduleKey,
  };
}

/**
 * Convenience: Build full OpenAI messages array
 */
export function buildMessagesForChat({ baseSystems = [], history = [], prompt = '', ...opts } = {}) {
  const { systemMessages } = buildPersonaSystems({ prompt, ...opts });
  return [...baseSystems, ...systemMessages, ...history, { role: 'user', content: prompt }];
}
