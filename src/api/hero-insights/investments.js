// src/server/heroInsights/investments.js
import { selectHero } from "./shared/selectHero.js";

export async function investmentsHeroHandler(req, res) {
  try {
    const candidates = [
      {
        id: "inv-portfolio-up-5",
        title: "Portfolio up 5.4% this month",
        summary: "Growth driven by tech holdings. Consider rebalancing if drift exceeds 5%.",
        metric: "+5.4%",
        severity: "good",
        impact: 0.7,
        confidence: 0.6,
        freshness: 0.9,
        relevance: 0.8,
      },
      {
        id: "inv-cash-drag",
        title: "Cash drag: $12,000 not allocated",
        summary: "Parked cash reduces performance. Review allocation.",
        metric: "$12,000",
        severity: "warn",
        impact: 0.75,
        confidence: 0.55,
        freshness: 0.8,
        relevance: 0.8,
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
            cta: { label: "View Wealth View", href: "/dashboard/investments" },
            dismissible: true,
          }
        : null,
      suppressIds: hero ? [hero.id] : [],
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  } catch (e) {
    console.error("[hero:investments]", e);
    res.status(500).json({ hero: null, suppressIds: [] });
  }
}
