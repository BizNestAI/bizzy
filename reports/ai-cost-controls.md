# AI Cost Controls

## Summary

Main Bizzy chat is configured to use `gpt-5.6-terra` through `BIZZY_GPT_MODEL`, with the existing paid customer allowance preserved at 300 chat queries/month.

This phase adds token/cost observability and guardrails without changing the customer-facing chat limit, downgrading the primary model, adding model routing, or exposing cost analytics to browser clients.

## Changes

| Area | Result |
| --- | --- |
| Main chat model | `process.env.BIZZY_GPT_MODEL || 'gpt-5.6-terra'` |
| Query cap | Existing `PAID_CHAT_LIMIT = 300` preserved |
| Usage parsing | Captures authoritative OpenAI API usage metadata when returned |
| Cost model | Centralized in `src/api/gpt/brain/chatCostControls.js` |
| Monthly aggregate | `gpt_usage` retains `query_count` and adds server-only token/cost totals |
| Per-request events | New server-only `gpt_usage_events` table with user/business/month/model/tokens/cost |
| Telemetry duplicate guard | Unique `request_id` prevents accidental duplicate cost/query aggregation for the same recorded event |
| Browser exposure | Browser keeps `gpt_usage` access only to `user_id`, `month`, `query_count`, `last_used` |
| Internal warning | Server logs warning around `$20` and elevated warning around `$35` monthly estimated spend |
| Context guard | High-ceiling message budget trims optional historical messages first |

## Current Context Limits

Static limits in the current main-chat pipeline:

| Context source | Limit |
| --- | --- |
| `buildContext` arrays | 100 items |
| `buildContext` strings | 8,000 chars |
| Thread context via `contextBuilder` | last 6 messages |
| Fallback recent chat query | latest 12 messages, uses 6 recent turns |
| Older fallback summary | 600 chars |
| Prompt chat-history message content | 4,000 chars each |
| Financial metrics | latest 3 rows |
| Forecast rows | latest 6 rows |
| Suggested moves | latest 3 rows |
| Memory snippets | top 3, each summarized to short excerpts |
| Main response cap | `max_completion_tokens: 1400` |
| New safety guard | 120,000 input chars by default via `BIZZY_MAIN_CHAT_CONTEXT_CHAR_BUDGET` |

No live average token usage exists yet. The new telemetry will make real averages available after deployment.

## Usage Fields Recorded

Per request and monthly aggregate fields:

| Field | Source |
| --- | --- |
| `model` / `last_model` | OpenAI response model or configured fallback |
| `input_tokens` | `usage.input_tokens` or `usage.prompt_tokens` |
| `cached_input_tokens` | `input_tokens_details.cached_tokens` or `prompt_tokens_details.cached_tokens` |
| `cache_write_tokens` | cache creation/write fields if returned by the SDK |
| `output_tokens` | `usage.output_tokens` or `usage.completion_tokens` |
| `reasoning_tokens` | output/completion reasoning detail if returned |
| `estimated_openai_cost_usd` | calculated from centralized configured pricing |
| `query_count` | existing monthly count, still increments once per successful chat request |

Telemetry stores numeric usage and identifiers only. It does not store API keys, prompts, responses, tokens, or provider secrets.

## Cost Estimates

Configured `gpt-5.6-terra` rates:

| Token class | Rate |
| --- | ---: |
| Input | `$2.50 / 1M` |
| Cached input | `$0.25 / 1M` |
| Output | `$15.00 / 1M` |

Representative uncached estimates:

| Request shape | Estimated cost/request | 300-query month |
| --- | ---: | ---: |
| 3k input / 500 output | `$0.0150` | `$4.50` |
| 8k input / 800 output | `$0.0320` | `$9.60` |
| 20k input / 1.2k output | `$0.0680` | `$20.40` |
| 30k input / 1.4k output | `$0.0960` | `$28.80` |

The new 120,000-character guard roughly corresponds to the 30k-token estimate under a 4 chars/token planning approximation. Actual cost reporting uses OpenAI API usage metadata.

## Auxiliary OpenAI Calls

No auxiliary model changes were made.

| Area | Current model behavior | Launch note |
| --- | --- | --- |
| Follow-up suggestions | `FOLLOWUP_MODEL || 'gpt-4o-mini'` | Keep cheap |
| Docs summarizer | `OPENAI_MODEL || 'gpt-4o-mini'` | Keep cheap |
| Marketing insights | `OPENAI_MODEL_INSIGHTS || 'gpt-4o-mini'` | Keep cheap |
| Email campaign | `OPENAI_MODEL_EMAIL || 'gpt-4o-mini'` | Keep cheap |
| Social captions | `OPENAI_MODEL_CAPTIONS || 'gpt-4o-mini'` | Keep cheap |
| Gmail draft/summarize | hardcoded `gpt-4o-mini` | Keep cheap |
| Thread title | hardcoded `gpt-4o-mini` | Keep cheap |
| Memory embeddings | `text-embedding-3-small` | Keep cheap |
| Bookkeeping suggestions | `BIZZY_GPT_SUGGEST_MODEL || 'gpt-5.6-terra'` | Consider explicitly setting this to a cheaper model before launch if this route becomes high-volume |

## Tests

Focused checks passed:

- `node --test tests/aiCostControls.security.test.js`
- `node --check src/api/gpt/brain/chatCostControls.js`
- `node --check src/api/gpt/brain/generateBizzyResponse.js`
- `node --test tests/webhooksRateLimitsSensitiveWrites.security.test.js`

Full suite:

- `npm test`
- Result: 706 pass, 3 fail, 3 skipped
- Failing tests are unrelated pre-existing UI expectation drift:
  - `tests/sidebarNavigationUi.test.js`: `sidebar orders Jobs above Tax`
  - `tests/taxConfidenceExplanationUi.test.js`: `dashboard keeps confidence breakdown in the trajectory header pill and links tax surfaces to the workpaper route`
  - `tests/taxWorkpaperUi.test.js`: `workpaper rows recursively expand and show full traceability detail on hover`

## Launch Assessment

The changes preserve response quality and customer-visible behavior. They add server-only observability and internal warning thresholds, not customer-facing cost cutoffs. The existing 300-query paid limit remains the hard customer-facing cap.
