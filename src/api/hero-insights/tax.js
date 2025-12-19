// src/server/heroInsights/tax.js
import { selectHero } from "./shared/selectHero.js";

export async function taxHeroHandler(req, res) {
  try {
    const candidates = [
      {
        id: "tax-prepay-savings",
        title: "You could save $3,200 by prepaying your Q3 taxes",
        summary: "Estimate based on current YTD profit and quarterly schedule.",
        metric: "$3,200",
        severity: "warn", // nudges action
        impact: 0.75,
        confidence: 0.65,
        freshness: 0.85,
        relevance: 0.8,
      },
      {
        id: "tax-deadline-15th",
        title: "Quarterly estimate due Oct 15",
        summary: "Schedule now to avoid penalties and keep cash planning clean.",
        metric: "Oct 15",
        severity: "risk",
        impact: 0.8,
        confidence: 0.7,
        freshness: 0.9,
        relevance: 0.9,
      },
    ];

    const hero = selectHero(candidates);

    res.json({
      hero: hero
        ? {
            id: hero.id,
            title: hero.title,
            summary: hero.summary,
            metric: hero.metric,
            severity: hero.severity,
            cta: { label: "Open Tax Desk", href: "/dashboard/tax" },
            dismissible: true,
          }
        : null,
      suppressIds: hero ? [hero.id] : [],
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  } catch (e) {
    console.error("[hero:tax]", e);
    res.status(500).json({ hero: null, suppressIds: [] });
  }
}
