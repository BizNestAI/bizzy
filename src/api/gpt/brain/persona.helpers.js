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
    /\b(best ways|strateg(y|ies)|guide|playbook|deep dive|comprehensive|in depth|how to|ideas|tactics|framework|step by step|explain|thoughts)\b/.test(p);

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
  return 'mini-essay (paragraphs), avoid bullets unless explicitly asked';
}

/**
 * NEW: Detects when structured reasoning (section headers or breakdowns)
 * would improve clarity. Bizzi can then decide to use headings dynamically.
 */
function detectStructuredReasoning(prompt = '') {
  const p = String(prompt || '').toLowerCase();
  const signals =
    /\b(risks?|advantages?|pros|cons|benefits?|issues?|problems?|causes?|effects?|impact|analysis|breakdown|explain|thoughts|opinion|future|plan)\b/.test(p);
  const longQuery = p.split(/\s+/).length > 10;
  if (signals || longQuery) return true;
  return false;
}

/**
 * Choose depth (controls verbosity)
 */
function chooseDepth({ flags = {}, surface } = {}) {
  if (flags.quick || surface === 'popover' || surface === 'chip') return 'brief';
  if (flags.deepDive || surface === 'doc') return 'comprehensive';
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
    intent === 'kpi_compare';

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
  let depth = opts.depth || chooseDepth({ flags, surface });
  if (!opts.depth && !flags.quick) {
    if (flags.deepDive || hints.wantsThorough) depth = 'comprehensive';
  }

  const style = chooseStyle({ intent, prompt, flags });
  let narrative = chooseNarrativeHint(prompt);
  if (flags.demoPunchy) {
    narrative = 'headline + metric bullets + 2–3 action steps; call out risks before the plan';
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
      `This question benefits from a reasoned, multi-part answer. Use 2–4 short paragraphs and, only if truly helpful, add a brief topic-specific label (no boilerplate headings).`
    );
  }

  if (flags.demoPunchy) {
    systemHints.push(
      'Demo mode: lead with a short titled section, list raw metrics or KPIs as bullets, then give a numbered or bulleted action plan that references exact dollars, percentages, or lead counts. Close by offering to execute a concrete next step.'
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
