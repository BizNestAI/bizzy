import { getDemoData } from "../../services/demo/demoClient.js";

function buildDemoSummary() {
  const demo = getDemoData();
  const summary = demo?.marketing?.summary || {};
  return {
    total_reach: summary.total_reach ?? 0,
    total_engagements: summary.total_engagements ?? 0,
    avg_engagement_rate: summary.avg_engagement_rate || "0%",
    best_post: summary.best_post || "",
    change: summary.change || "",
    best_post_delta: summary.best_post_delta || summary.change || "",
  };
}

export const marketingSummaryFallback = buildDemoSummary();

export const getMarketingSummary = (source) => ({
  ...marketingSummaryFallback,
  ...(source || {}),
});
