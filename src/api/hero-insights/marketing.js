// src/server/heroInsights/marketing.js
import { selectHero } from "./shared/selectHero.js";

export async function marketingHeroHandler(req, res) {
  try {
    const candidates = [
      {
        id: "mkt-eng-up-8",
        title: "Engagement up 8% vs last week",
        summary: "CTR improved after launching Tuesday's campaign.",
        metric: "+8%",
        severity: "good",
        impact: 0.7,
        confidence: 0.6,
        freshness: 0.9,
        relevance: 0.8,
      },
      {
        id: "mkt-3-new-reviews",
        title: "3 new Google reviews this week",
        summary: "Average rating 4.7/5. Reply soon to boost ranking.",
        metric: "⭐ 4.7",
        severity: "info",
        impact: 0.55,
        confidence: 0.7,
        freshness: 0.8,
        relevance: 0.7,
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
            delta: hero.delta,
            severity: hero.severity,
            cta: { label: "Open Marketing Insights", href: "/dashboard/marketing" },
            dismissible: true,
          }
        : null,
      suppressIds: hero ? [hero.id] : [],
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  } catch (e) {
    console.error("[hero:marketing]", e);
    res.status(500).json({ hero: null, suppressIds: [] });
  }
}
