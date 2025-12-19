// File: /src/api/gpt/middlewares/attachStyle.js
// -----------------------------------------------------------------------------
// Purpose
//  - Attach Bizzy's presentation "style layer" to each GPT request.
//  - Computes a style spec (global style guide + intent template + depth hint)
//    and exposes ready-to-append **system** messages so downstream code can
//    include them in the OpenAI `messages` array.
//  - Fail-soft: if anything goes wrong, defaults to { intent:'general', depth:'standard' }.
//
// How it’s used
//  - Mount in your GPT router chain *before* the LLM step:
//      normalizeRequest → attachIntent → attachContext → attachStyle → runLLM → postProcess → finalize
//  - Downstream (runLLM or generateBizzyResponse) should prepend
//    `req.bizzy.systemMessages` to the messages array:
//
//      const base = [{ role:'system', content: BASE_SYSTEM }];
//      const styleMsgs = req.bizzy?.systemMessages || [];
//      const messages = [...base, ...styleMsgs, { role:'system', content: businessPrompt }, ...history, { role:'user', content: message }];
//
// -----------------------------------------------------------------------------

import { buildStyleSystemMessages, getStyleSpec, isKnownIntent } from '../brain/styleSpec.js';

const SUPPORTED_DEPTHS = new Set(['brief', 'standard', 'deep']);

/**
 * Read an optional depth from body/headers and normalize.
 * Order of precedence:
 *   req.body.opts.depth  >  header 'x-bizzy-depth'  > 'standard'
 */
function pickDepth(req) {
  const raw =
    (req.body && req.body.opts && req.body.opts.depth) ||
    req.headers['x-bizzy-depth'] ||
    'standard';

  const d = String(raw).toLowerCase().trim();
  return SUPPORTED_DEPTHS.has(d) ? d : 'standard';
}

/**
 * Read the intent resolved upstream (attachIntent), or accept user-provided
 * fallback (`intent` / `type`). If we don’t recognize it, use 'general'.
 */
function pickIntent(req) {
  const raw =
    (req.bizzy && req.bizzy.intent) ||
    (req.body && (req.body.intent || req.body.type)) ||
    'general';

  const key = String(raw).trim();
  return isKnownIntent(key) ? key : 'general';
}

/**
 * Express middleware: attaches style spec and ready-to-append system messages.
 *
 * Attaches to req.bizzy:
 *   - style: { intent, depth, version, spec, systemMessages }
 *   - systemMessages: []  // (also merged at root for convenience)
 */
export async function attachStyle(req, _res, next) {
  try {
    req.bizzy = req.bizzy || {};

    const intent = pickIntent(req);
    const depth = pickDepth(req);

    // Build spec + messages for this (intent, depth) pair
    const { spec, systemMessages } = buildStyleSystemMessages({ intent, depth });

    // Store full spec + messages under req.bizzy.style
    req.bizzy.style = {
      intent,
      depth,
      version: spec.version,
      spec,             // { styleGuide, templateForIntent, depthGuide, version }
      systemMessages,   // array of { role:'system', content:string }
    };

    // Also expose messages on a common property so downstream can just spread it
    req.bizzy.systemMessages = [
      ...(req.bizzy.systemMessages || []),
      ...systemMessages,
    ];

    next();
  } catch (err) {
    // Fail-soft default: general + standard
    try {
      const { spec, systemMessages } = buildStyleSystemMessages({ intent: 'general', depth: 'standard' });
      req.bizzy = req.bizzy || {};
      req.bizzy.style = { intent: 'general', depth: 'standard', version: spec.version, spec, systemMessages };
      req.bizzy.systemMessages = [
        ...(req.bizzy.systemMessages || []),
        ...systemMessages,
      ];
    } catch {}
    next(err && process.env.NODE_ENV === 'development' ? err : undefined);
  }
}

export default attachStyle;
