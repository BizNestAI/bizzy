// src/components/Marketing/MarketingAnalyticsDashboard.jsx
import React, { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  ArrowUpRight,
  Target,
  ListChecks,
  MessageSquareQuote,
  BarChart2,
  Play,
} from "lucide-react";
import { apiFetch } from "../../utils/api";
import CardHeader from "../UI/CardHeader";
import { useUser } from "@supabase/auth-helpers-react";
import { supabase } from "../../services/supabaseClient";
import { getMarketingSummary } from "./marketingSummaryData";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { __MOCK_POSTS__ } from "../../services/getRecentPosts.js";

const mockPosts = __MOCK_POSTS__;

const defaultPlaybook = [
  {
    title: "Turn the hero Before/After into a carousel",
    detail: "Carousel posts averaged 18% more taps last quarter.",
    impact: "+12% reach",
  },
  {
    title: "Schedule a promo email remix",
    detail: "Reuse the best-performing CTA from Tuesday's send.",
    impact: "+6% CTR",
  },
  {
    title: "Record a 30s onsite walkthrough",
    detail: "Short-form video drives 2x engagement on Instagram Reels.",
    impact: "2x comments",
  },
];

/* Local, deterministic fallback if the API is unavailable */
function buildLocalInsights(posts) {
  const best = posts[0];
  const totalReach = posts.reduce((s, p) => s + (p.reach || 0), 0);
  const interactions = posts.reduce(
    (s, p) => s + (p.likes || 0) + (p.comments || 0) + (p.shares || 0),
    0
  );
  const rate = totalReach ? ((interactions / totalReach) * 100).toFixed(1) : "0.0";
  return {
    summary: `Your recent posts reached ${totalReach.toLocaleString()} people with an average engagement of ${rate}%. Best performer: ${best.post_type} on ${best.platform}.`,
    postInsights: posts.map((p) => ({
      insight:
        p.gpt_insight ||
        `Solid ${p.post_type.toLowerCase()} result on ${p.platform}. Reuse this theme next week.`,
    })),
  };
}

export default function MarketingAnalyticsDashboard({ businessId, summary }) {
  const user = useUser();

  const [insights, setInsights] = useState(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [insightsError, setInsightsError] = useState(null);
  const usingDemo = shouldUseDemoData();
  const demoMarketing = useMemo(() => {
    if (!usingDemo) return null;
    const demo = getDemoData();
    return demo?.marketing || null;
  }, [usingDemo]);
  const postsForApi = useMemo(() => {
    if (demoMarketing?.recentPosts?.length) {
      return demoMarketing.recentPosts.map((p, idx) => ({
        platform: p.platform || "instagram",
        post_type: p.post_type || p.type || "Post",
        date: p.date || p.created_at || new Date().toISOString(),
        reach: p.reach ?? 0,
        likes: p.likes ?? 0,
        comments: p.comments ?? 0,
        shares: p.shares ?? 0,
        clicks: p.clicks ?? 0,
        gpt_insight: p.gpt_insight,
        imageIdea: p.imageIdea,
      }));
    }
    return mockPosts;
  }, [demoMarketing]);

  const playbook = demoMarketing?.playbook || defaultPlaybook;

  useEffect(() => {
    let abort = false;

    (async () => {
      if (usingDemo) {
        setLoadingInsights(false);
        setInsights(buildLocalInsights(postsForApi));
        setInsightsError(null);
        return;
      }

      setLoadingInsights(true);
      setInsightsError(null);

      const userId = user?.id || localStorage.getItem("user_id") || "anon-user";

      // 🔐 get Supabase access token for Authorization header
      let accessToken = "";
      try {
        const { data } = await supabase.auth.getSession();
        accessToken = data?.session?.access_token || "";
      } catch {
        // ignore; we'll still try—server may accept x-user-id/x-business-id for dev
      }

      try {
        const { data, error } = await apiFetch("/api/marketing/insights", {
          method: "POST",
          body: { posts: postsForApi, campaigns: [] },
          userId,
          businessId,
          // Most apiFetch helpers merge these into the outgoing fetch headers
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        });

        if (abort) return;

        if (error) {
          // API failed (e.g., 401 missing token) → fallback locally
          setInsights(buildLocalInsights(postsForApi));
          setInsightsError(error.message || "Unavailable");
        } else if (data) {
          setInsights(data);
        } else {
          setInsights(buildLocalInsights(postsForApi));
        }
      } catch (e) {
        if (abort) return;
        setInsights(buildLocalInsights(postsForApi));
        setInsightsError(e?.message || "Unavailable");
      } finally {
        if (!abort) setLoadingInsights(false);
      }
    })();

    return () => {
      abort = true;
    };
  }, [postsForApi, businessId, user?.id, usingDemo]);

  const summaryData = getMarketingSummary(summary);

  return (
    <div className="w-full flex flex-col gap-4">

      {/* ───────────────── Hero highlight ───────────────── */}
      <section
        className="rounded-[30px] border border-white/10 px-5 sm:px-7 py-5 text-white"
        style={{
          background: "linear-gradient(180deg, rgba(17,24,39,0.86), rgba(15,23,42,0.82))",
          boxShadow: "none",
        }}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.35em] text-white/60">Best performing creative</p>
            <h3 className="mt-2 text-2xl font-semibold">{summaryData.best_post}</h3>
            <p className="mt-1 text-sm text-white/75">
              CTR is {summaryData.change}. Bizzi recommends doubling down on similar content while the lift holds.
            </p>
            <div className="mt-3 flex gap-2">
              <button className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/15">
                Duplicate post
              </button>
              <button className="inline-flex items-center gap-1 rounded-full border border-white/25 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/5">
                View campaign <ArrowUpRight size={13} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <HighlightCard label="Reach lift" value="+14%" sub="vs last week" />
            <HighlightCard label="Top Channel" value="Instagram" sub="Before/After" />
            <HighlightCard label="Next post" value="Thu · 7:30am" sub="Peak engagement window" />
            <HighlightCard label="Audience sentiment" value="4.6 / 5" sub="Avg review score" />
          </div>
        </div>
      </section>

      {/* ───────────────── Bizzi Insights ───────────────── */}
      {(loadingInsights || insights?.summary || insightsError) && (
        <section className="rounded-[28px] border border-white/10 bg-white/5 px-5 py-5 text-white">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-2xl bg-white/10 flex items-center justify-center">
                <MessageSquareQuote size={22} className="text-white" />
              </div>
              <div>
                <CardHeader
                  title="COMMENTS FROM BIZZI"
                  size="sm"
                  dense
                  className="mb-0"
                  titleClassName="text-[13px]"
                />
                <p className="text-xs uppercase tracking-[0.3em] text-white/55">What Bizzi noticed this week</p>
              </div>
            </div>
            <div className="flex gap-2 text-xs text-white/70">
              {loadingInsights && <span>Analyzing performance…</span>}
              {insightsError && <span className="text-rose-300">Fallback summary (API offline)</span>}
            </div>
          </div>
          {insights?.summary && (
            <p className="mt-4 text-base text-white/85 leading-relaxed">{insights.summary}</p>
          )}
          <div className="mt-4 grid gap-2 md:grid-cols-3">
            {(insights?.postInsights || []).slice(0, 3).map((tip, idx) => (
              <div key={idx} className="rounded-2xl bg-white/5 px-3 py-2 text-sm text-white/80 flex items-center gap-2">
                <Target size={16} className="text-white/70" />
                <span>{tip.insight}</span>
              </div>
            ))}
            {!insights?.postInsights && (
              <div className="rounded-2xl bg-white/5 px-3 py-2 text-sm text-white/80">
                Add more Instagram Reels—short form video doubled tap-throughs.
              </div>
            )}
          </div>
        </section>
      )}

      {/* ───────────────── Social Post Performance ───────────────── */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] text-white">
        <div className="px-4 pt-3 sm:px-6 sm:pt-4">
          <CardHeader
            title="SOCIAL POST PERFORMANCE"
            size="sm"
            dense
            className="mb-1"
            titleClassName="text-[13px]"
          />
        </div>

        <div className="px-4 pb-3 sm:px-6 sm:pb-4">
          <div className="grid gap-3">
            {postsForApi.map((post, idx) => (
              <PostRow
                key={`${post.platform}-${post.date}-${idx}`}
                post={post}
                insight={insights?.postInsights?.[idx]?.insight}
                withDivider={idx < postsForApi.length - 1}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ───────────────── Optimization Playbook ───────────────── */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-white">
        <CardHeader
          title="Optimization Playbook"
          size="sm"
          dense
          className="mb-3"
          titleClassName="text-[13px]"
        />
        <div className="grid gap-3 md:grid-cols-3">
          {playbook.map((play, idx) => (
            <PlayCard key={idx} index={idx + 1} play={play} />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ───────────────────────── helpers/ui ───────────────────────── */


function PostRow({ post, insight }) {
  const interactions = (post.likes || 0) + (post.comments || 0) + (post.shares || 0);
  const engagementRate = post.reach ? ((interactions / post.reach) * 100).toFixed(1) : "0.0";
  const rateNumber = parseFloat(engagementRate);
  return (
    <div className="rounded-[22px] border border-white/10 bg-gradient-to-r from-white/[0.04] to-white/[0.01] p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">{post.post_type} · {post.platform}</p>
          <p className="text-xs text-white/60">{post.date}</p>
        </div>
        <div className="text-right">
          <span className="text-xs text-white/60">Engagement</span>
          <p className="text-lg font-semibold text-white">{engagementRate}%</p>
          <div className="mt-1 h-1.5 w-28 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-emerald-400" style={{ width: `${Math.min(rateNumber, 20) / 20 * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-[12px] text-white/75">
        <MetricBadge label="Reach" value={post.reach} />
        <MetricBadge label="Likes" value={post.likes} />
        <MetricBadge label="Comments" value={post.comments} />
        <MetricBadge label="Shares" value={post.shares} />
        <MetricBadge label="Clicks" value={post.clicks} />
        <MetricBadge label="Saves" value={post.saves || 0} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12px] text-white/70">
        <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-white/80">
          <BarChart2 size={12} /> {post.reach} reach
        </span>
        <button className="inline-flex items-center gap-1 rounded-full border border-white/20 px-2 py-1 text-white/75 text-xs">
          Ask Bizzi <ArrowUpRight size={12} />
        </button>
        <button className="inline-flex items-center gap-1 rounded-full border border-white/20 px-2 py-1 text-white/75 text-xs">
          View Post
        </button>
      </div>

      <p className="text-[12px] text-white/80 italic leading-relaxed">
        {insight ?? post.gpt_insight}
      </p>
    </div>
  );
}

function MetricBadge({ label, value }) {
  return (
    <div className="rounded-full border border-white/10 px-2 py-0.5 text-white/80 flex items-center gap-1 justify-center">
      <span className="text-white/55">{label}</span>
      <span className="font-medium text-white tabular-nums">{value}</span>
    </div>
  );
}

function PlayCard({ play, index }) {
  return (
    <div className="rounded-[22px] border border-white/10 bg-gradient-to-br from-white/[0.05] via-white/[0.02] to-white/[0.01] p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.35em] text-white/50">
          <Play size={14} className="text-white/65" />
          <span>Step {index}</span>
        </div>
        <span className="text-emerald-300 text-xs font-semibold">{play.impact}</span>
      </div>
      <div className="text-white font-semibold text-sm">{play.title}</div>
      <div className="text-[13px] text-white/70 flex-1">{play.detail}</div>
      <div className="flex gap-2">
        <button className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs text-white">
          Automate
        </button>
        <button className="inline-flex items-center gap-1 rounded-full border border-white/15 px-3 py-1 text-xs text-white/85">
          Create Task
        </button>
      </div>
    </div>
  );
}

function HighlightCard({ label, value, sub }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.08] px-3 py-2 text-sm flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-[0.3em] text-white/55">{label}</span>
      <span className="text-lg font-semibold text-white">{value}</span>
      <span className="text-[11px] text-white/65">{sub}</span>
    </div>
  );
}
