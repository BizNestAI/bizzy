import { getDemoData, shouldUseDemoData } from "./demo/demoClient.js";

const API_BASE = import.meta.env?.VITE_API_BASE || "";

function buildDemoPosts() {
  const demo = getDemoData();
  const posts = demo?.marketing?.recentPosts || [];
  return posts.map((post, idx) => ({
    id: post.id || `demo-post-${idx}`,
    platform: post.platform || "instagram",
    caption: post.caption || post.text || "",
    created_at: post.date ? new Date(post.date).toISOString() : new Date().toISOString(),
    image_url: post.image_url || "",
    imageIdea: post.imageIdea || "",
    metrics_json: {
      likes: post.likes ?? 0,
      comments: post.comments ?? 0,
      shares: post.shares ?? 0,
      clicks: post.clicks ?? 0,
      reach: post.reach ?? 0,
    },
    gpt_insight: post.gpt_insight,
  }));
}

export const __MOCK_POSTS__ = buildDemoPosts();

async function getJson(url, opts = {}) {
  const r = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const ct = r.headers.get("content-type") || "";
  const raw = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 200)}`);
  if (!ct.includes("application/json"))
    throw new Error(`Non-JSON (${ct}): ${raw.slice(0, 200)}`);
  return JSON.parse(raw);
}

export async function getRecentPosts(userId, businessId, { limit = 4, forceMock = false } = {}) {
  const demoPosts = __MOCK_POSTS__;
  if (forceMock || !businessId || !userId || shouldUseDemoData(businessId) || shouldUseDemoData()) {
    return { data: demoPosts.slice(0, limit), is_mock: true };
  }

  try {
    const conns = await getJson(
      `${API_BASE}/api/social/connections?business_id=${encodeURIComponent(
        businessId
      )}&user_id=${encodeURIComponent(userId)}`
    );
    const connected = Array.isArray(conns?.providers) && conns.providers.length > 0;
    if (!connected) {
      return { data: demoPosts.slice(0, limit), is_mock: true };
    }
  } catch {
    // ignore
  }

  try {
    const feed = await getJson(
      `${API_BASE}/api/marketing/recent-posts?business_id=${encodeURIComponent(
        businessId
      )}&user_id=${encodeURIComponent(userId)}&limit=${encodeURIComponent(limit)}`
    );
    const arr = Array.isArray(feed?.data) ? feed.data : Array.isArray(feed) ? feed : [];
    if (arr.length > 0) {
      const normalized = arr
        .map((p) => ({
          id: p.id || `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
          platform: p.platform || p.source || "instagram",
          caption: p.caption || p.text || "",
          created_at: p.created_at || p.timestamp || new Date().toISOString(),
          image_url: p.image_url || p.media_url || "",
          imageIdea: p.imageIdea || "",
          metrics_json: p.metrics_json || {
            likes: p.likes ?? 0,
            comments: p.comments ?? 0,
            reach: p.reach ?? 0,
          },
        }))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limit);

      return { data: normalized, is_mock: false };
    }
  } catch {
    // fall through
  }

  return { data: demoPosts.slice(0, limit), is_mock: true };
}
