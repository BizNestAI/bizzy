// src/components/Marketing/RecentPostsCard.jsx
import React, { useEffect, useState } from "react";
import { useUser } from "@supabase/auth-helpers-react";
import { useNavigate } from "react-router-dom";
import CardHeader from "../UI/CardHeader";
import Banner from "../UI/Banner";
import SampleDataRibbon from "../ui/SampleDataRibbon";
import { getRecentPosts, __MOCK_POSTS__ } from "../../services/getRecentPosts";

// tiny badge (neutral)
function PlatformBadge({ p }) {
  const txt = (p || "").charAt(0).toUpperCase() + (p || "").slice(1).toLowerCase();
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/6 ring-1 ring-inset ring-white/12 text-white/80">
      {txt || "—"}
    </span>
  );
}

function MetricRow({ m = {} }) {
  const likes = m.likes ?? 0, comments = m.comments ?? 0;
  return (
    <div className="text-[11px] text-white/65 flex items-center gap-3 tabular-nums">
      <span>👍 {likes}</span>
      <span>💬 {comments}</span>
    </div>
  );
}

function PostTile({ post, onAsk, onOpen }) {
  const caption = post.caption || "";
  const date = post.created_at ? new Date(post.created_at).toLocaleDateString() : "—";
  const metrics = post.metrics_json || {};
  const interactions = (metrics.likes || 0) + (metrics.comments || 0) + (metrics.shares || 0);
  const engagementRate = metrics.reach
    ? `${((interactions / metrics.reach) * 100).toFixed(1)}%`
    : "—";

  return (
    <div className="relative rounded-[26px] border border-white/10 bg-white/5 p-4 flex flex-col gap-3 min-w-0 shadow-none">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PlatformBadge p={post.platform} />
          <span className="text-xs text-white/55">{date}</span>
        </div>
        <div className="text-right text-sm text-emerald-300 font-semibold">
          {engagementRate} engagement
        </div>
      </div>

      <div className="flex gap-4">
        <div className="w-[80px] h-[80px] rounded-2xl bg-black/30 flex items-center justify-center overflow-hidden shrink-0">
          {post.image_url ? (
            <img src={post.image_url} alt="post" className="w-full h-full object-cover" />
          ) : (
            <div className="text-[11px] text-white/60 text-center px-2 leading-tight">
              {post.imageIdea || "No image"}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-white font-semibold text-sm line-clamp-2">{caption}</p>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-white/70">
            <MetricRow m={metrics} />
            <Pill label="Clicks" value={metrics.clicks || 0} />
            <Pill label="Saves" value={metrics.saves || 0} />
            <Pill label="Reach" value={metrics.reach || 0} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <button
          onClick={() => onAsk?.(post)}
          className="inline-flex items-center gap-1 rounded-full bg-white/12 px-3 py-1 text-white/85"
        >
          Ask Bizzi
        </button>
        <button
          onClick={() => onOpen?.(post)}
          className="inline-flex items-center gap-1 rounded-full border border-white/20 px-3 py-1 text-white/75"
        >
          Open
        </button>
        {post.url && (
          <a
            href={post.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-white/20 px-3 py-1 text-white/75"
          >
            View Live
          </a>
        )}
      </div>
    </div>
  );
}

const Pill = ({ label, value }) => (
  <div className="rounded-full border border-white/12 bg-white/8 px-2 py-0.5 text-white/80 flex items-center gap-1">
    <span className="text-white/55">{label}</span>
    <span className="font-semibold tabular-nums">{value}</span>
  </div>
);

export default function RecentPostsCard({ businessId, limit = 4 }) {
  const user = useUser();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let stop = false;

    async function load() {
      setLoading(true);
      setError("");

      // 👇 robust IDs (don’t bail if user missing)
      const uid =
        user?.id ||
        localStorage.getItem("user_id") ||
        "anon-user"; // safe placeholder

      // If businessId is missing, just show mocks instead of returning early.
      if (!businessId) {
        if (!stop) {
          setRows(__MOCK_POSTS__.slice(0, limit));
          setIsMock(true);
          setLoading(false);
        }
        return;
      }

      try {
        const { data, is_mock } = await getRecentPosts(uid, businessId, { limit });
        if (stop) return;
        // Even if service returns [], still show mocks for a better first-run experience
        if (!data || data.length === 0) {
          setRows(__MOCK_POSTS__.slice(0, limit));
          setIsMock(true);
        } else {
          setRows(data);
          setIsMock(Boolean(is_mock));
        }
      } catch (e) {
        if (!stop) {
          // On error, show mocks rather than empty card
          setRows(__MOCK_POSTS__.slice(0, limit));
          setIsMock(true);
          setError(""); // hide error banner when showing mocks
        }
      } finally {
        if (!stop) setLoading(false);
      }
    }

    load();
    return () => {
      stop = true;
    };
  }, [user?.id, businessId, limit]);

  const onAsk = (post) => {
    window.dispatchEvent(
      new CustomEvent("bizzy:toast", {
        detail: { title: "Asked Bizzy", body: "Analyzing this post…", severity: "info" },
      })
    );
  };

  const onOpen = () => navigate("/dashboard/marketing/gallery");

  const empty = !loading && !error && rows.length === 0;

  return (
    <div className="relative rounded-2xl p-0 bg-transparent text-white min-w-0">
      {/* cross-browser scrollbar hide */}
      <style>{`
        .no-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>

      {/* Header */}
      <div className="px-4 pt-4 sm:px-6 sm:pt-5">
        <CardHeader
          title="RECENT POSTS"
          size="sm"
          dense
          className="mb-2"
          titleClassName="text-[13px]"
          
    
          
        />
      </div>

      <div className="px-4 pb-4 sm:px-6 sm:pb-5 bg-transparent">
        {loading && (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px,1fr))" }}>
            {Array.from({ length: limit }).map((_, i) => (
              <div key={i} className="rounded-xl ring-1 ring-inset ring-white/10 bg-white/5 h-[92px] animate-pulse" />
            ))}
          </div>
        )}

        {error && <Banner variant="error" title="Recent posts unavailable">{error}</Banner>}

        {empty && !error && (
          <Banner variant="info" title="No recent posts">
            Connect your social accounts or publish a post to see it here.
          </Banner>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="space-y-3 bg-transparent">
            {rows.map((p) => (
              <PostTile key={p.id} post={p} onAsk={onAsk} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
