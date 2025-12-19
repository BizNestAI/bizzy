// src/server/heroInsights/financials.js
import { selectHero } from "./shared/selectHero.js";

export async function financialsHeroHandler(req, res) {
  try {
    const mode = (req.headers["x-data-mode"] || req.query?.data_mode || "").toLowerCase();
    const isLiveish = mode === "live" || mode === "testing";

    // In live/testing, suppress mock hero until real insights exist
    if (isLiveish) {
      return res.json({
        hero: null,
        suppressIds: [],
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
    }

    // TODO: Replace with real computed insights when data is synced
    const candidates = [
      {
        id: "fin-rev-up-15",
        title: "Revenue up 15% vs last month",
        summary: "Growth driven by higher close rate across top clients.",
        metric: "$48,200",
        delta: "+15%",
        severity: "good",
        impact: 0.8,
        confidence: 0.7,
        freshness: 0.9,
        relevance: 0.8,
      },
      {
        id: "fin-margin-325",
        title: "Profit margin steady at 32.5%",
        summary: "Costs stayed flat; labor utilization within target.",
        metric: "32.5%",
        severity: "info",
        impact: 0.6,
        confidence: 0.8,
        freshness: 0.6,
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
            cta: { label: "View details", href: "/dashboard/financials?tab=insights" },
            dismissible: true,
          }
        : null,
      suppressIds: hero ? [hero.id] : [],
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30m
    });
  } catch (e) {
    console.error("[hero:financials]", e);
    res.status(500).json({ hero: null, suppressIds: [] });
  }
}
