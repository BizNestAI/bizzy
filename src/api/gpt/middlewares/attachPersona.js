// File: /src/api/gpt/middlewares/attachPersona.js
// Adds Bizzy's persona system message to the request.
// - Uses applyPersona() to compute tone dials/context flags
// - For deep INSIGHT only, includes a tiny exemplar via buildPersonaMessage({ includeExemplar: true })

import { applyPersona } from '../brain/persona.helpers.js';
import { buildPersonaMessage } from '../brain/personaSpec.js';

export function attachPersona(req, _res, next) {
  try {
    req.bizzy = req.bizzy || {};

    // Source of truth for intent/module
    const intent = req.bizzy.intent || req.body?.intent || req.body?.type || 'general';
    const moduleKey = req.bizzy.module || 'bizzy';

    // Depth (from style middleware, body, or header)
    const depth =
      req.bizzy?.style?.depth ||
      (req.body?.opts?.depth && String(req.body.opts.depth).toLowerCase()) ||
      (req.headers['x-bizzy-depth'] && String(req.headers['x-bizzy-depth']).toLowerCase()) ||
      'standard';

    // Lightweight flags (derive from contextBundle if available)
    const metrics = req.bizzy?.contextBundle?.kpis || [];
    const hasNeg =
      Array.isArray(metrics) &&
      metrics.some(
        (m) =>
          (m.margin_pct_delta || 0) < 0 ||
          (m.net_profit_delta || 0) < 0 ||
          (m.total_revenue_delta || 0) < 0
      );

    const flags = {
      bad_news: hasNeg && (intent === 'insight' || intent === 'kpi_compare'),
      celebration: !hasNeg && (intent === 'insight' || intent === 'marketing_tip'),
      quick: depth === 'brief',
      deepDive: depth === 'deep',
    };

    // First, compute context-sensitive dials/message
    const { message: basePersona, dials } = applyPersona({ intent, module: moduleKey, flags });

    // Deep INSIGHT only → include a tiny exemplar
    const includeExemplar = intent === 'insight' && (depth === 'deep' || flags.deepDive === true);

    const personaMessage = includeExemplar
      ? buildPersonaMessage({ intent, module: moduleKey, dials, includeExemplar: true })
      : basePersona;

    req.bizzy.personaMessage = personaMessage;
    next();
  } catch (_e) {
    // Fail-soft: skip persona but continue
    next();
  }
}

export default attachPersona;
