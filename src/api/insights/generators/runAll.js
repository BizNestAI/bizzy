// src/api/gpt/insights/generators/runAll.js

// ✉️ Email (account-scoped)
import {
  genEmailUnreplied,
  genEmailUnreadAging,
  genEmailDailyDigest,
} from './email.generators.js';

// 🧠 Bizzi (home dashboard)
import { generateBizziInsights } from './bizzi.generators.js';

// 📅 Calendar (aggregator)
import { generateCalendarInsights } from './calendar.generators.js';

// 💰 Financials (aggregator)
import { generateFinancialsInsights } from './financials.generators.js';

// 📣 Marketing (aggregator)
import { generateMarketingInsights } from './marketing.generators.js';

// 🧾 Tax (aggregator)
import { generateTaxInsights } from './tax.generators.js';

// 📈 Investments (aggregator)
import { generateInvestmentsInsights } from './investments.generators.js';

/**
 * Normalize return values from generators:
 * - arrays         -> length
 * - { inserted }   -> inserted
 * - number         -> number
 * - anything else  -> 0
 */
function toCount(result) {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result.inserted === 'number') return result.inserted;
  if (typeof result === 'number') return result;
  return 0;
}

/**
 * Run all generators concurrently for a user/business (and optional email account).
 *
 * @param {object} cfg
 * @param {string} cfg.userId
 * @param {string} [cfg.businessId]
 * @param {string} [cfg.accountId]    // email account id (scopes email insights)
 * @param {object} [cfg.opts]         // thresholds and module-specific knobs
 */
export async function generateAllInsights({
  userId,
  businessId,
  accountId,
  opts = {},
}) {
  const tasks = [];

  // === BIZZI (home) ======================================================
  tasks.push(
    generateBizziInsights({
      userId,
      businessId,
      // pass per-user overrides from opts if desired
    })
  );

  // === EMAIL (account-scoped) ============================================
  if (accountId) {
    tasks.push(
      genEmailUnreplied({
        userId,
        accountId,
        agingDays: opts.emailAgingDays ?? 2,
      }),
      genEmailUnreadAging({
        userId,
        accountId,
        minAgeDays: opts.emailUnreadMin ?? 3,
      }),
      genEmailDailyDigest({
        userId,
        accountId,
      })
    );
  }

  // === CALENDAR ==========================================================
  tasks.push(
    generateCalendarInsights({
      userId,
      // e.g., { hoursAhead: 48, daysAhead: 7 } via opts if you expose them
    })
  );

  // === FINANCIALS ========================================================
  tasks.push(
    generateFinancialsInsights({
      userId,
      businessId,
      // e.g., { arMinDays, cashThreshold, ... } via opts
    })
  );

  // === MARKETING =========================================================
  tasks.push(
    generateMarketingInsights({
      userId,
      // e.g., { windowDays, thresholds } via opts
    })
  );

  // === TAX ===============================================================
  tasks.push(
    generateTaxInsights({
      userId,
      // e.g., { windowDays, warnUnderPct } via opts
    })
  );

  // === INVESTMENTS =======================================================
  tasks.push(
    generateInvestmentsInsights({
      userId,
      // e.g., { pctThresh, weightPct, cashThreshPct } via opts
    })
  );

  // Run all concurrently and normalize counts
  const counts = await Promise.all(
    tasks.map((p) =>
      Promise.resolve(p)
        .then((v) => toCount(v))
        .catch(() => 0)
    )
  );

  const inserted = counts.reduce((a, b) => a + b, 0);
  return { ok: true, inserted };
}

export default generateAllInsights;
