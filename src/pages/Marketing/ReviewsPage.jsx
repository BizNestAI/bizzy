// /src/pages/Marketing/ReviewsPage.jsx
import React, { useEffect, useMemo, useState, useId } from 'react';
import ReviewsFilters from './ReviewsFilters.jsx';
import ReviewItem from './ReviewItem.jsx';
import ReplyDrawer from './ReplyDrawer.jsx';
import CSVImportDialog from './ReviewsCsvImport.jsx';
import Banner from '../../components/ui/Banner';
import { apiFetch } from '../../utils/api';
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { useBusiness } from "../../context/BusinessContext";
import { getDemoData, shouldUseDemoData } from '../../services/demo/demoClient.js';

// ✅ Publish AgendaWidget to the right rail
import { useRightExtras } from '../../insights/RightExtrasContext';
import AgendaWidget from '../calendar/AgendaWidget.jsx';
import { useNavigate } from 'react-router-dom';

/** ---------- simple mock data used ONLY when the API returns nothing ---------- */
const MOCK_ITEMS = [
  { id: 'mock_1', source: 'google', rating: 5, author_name: 'John S.', body: 'Crew was fast and cleaned up perfectly.', created_at_utc: new Date(Date.now() - 2 * 86400e3).toISOString(), owner_replied: false, themes: ['cleanup', 'punctuality'] },
  { id: 'mock_2', source: 'facebook', rating: 5, author_name: 'Emily R.', body: 'Very professional and the communication was great!', created_at_utc: new Date(Date.now() - 6 * 86400e3).toISOString(), owner_replied: false, themes: ['communication', 'quality'] },
  { id: 'mock_3', source: 'google', rating: 4, author_name: 'Miguel P.', body: 'Good price and quick turnaround. Happy with the results.', created_at_utc: new Date(Date.now() - 10 * 86400e3).toISOString(), owner_replied: true, themes: ['price', 'timeliness'] },
];

const MOCK_STATS = {
  range: '30d',
  avg_rating: 4.6,
  count_reviews: 6,
  unreplied_count: 2,
  response_median_hours: 18,
  pos_pct: 83,
  neg_pct: 0,
};

/** compute minimal stats if server doesn’t return stats */
function computeStatsFromItems(items = []) {
  if (!items.length) return null;
  const count = items.length;
  const avg = items.reduce((a, r) => a + (r.rating || 0), 0) / count;
  const unreplied = items.filter((r) => !r.owner_replied).length;
  return {
    range: '30d',
    avg_rating: Number(avg.toFixed(2)),
    count_reviews: count,
    unreplied_count: unreplied,
    response_median_hours: null,
    pos_pct: Math.round((items.filter((r) => r.rating >= 4).length / count) * 100),
    neg_pct: Math.round((items.filter((r) => r.rating <= 2).length / count) * 100),
  };
}

export default function ReviewsPage({ businessId: propBusinessId }) {
  const { currentBusiness } = useBusiness?.() || {};
  const businessId = propBusinessId || currentBusiness?.id || localStorage.getItem("currentBusinessId");
  if (!shouldUseDemoData(currentBusiness)) {
    return <LiveModePlaceholder title="Connect review platforms to view customer feedback" />;
  }
  const [filters, setFilters] = useState({ limit: 50, offset: 0 });
  const [data, setData] = useState({ items: [], count: 0 });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [replying, setReplying] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [usingMock, setUsingMock] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const isDemo = !businessId || shouldUseDemoData();
  const demoReviews = useMemo(() => (isDemo ? getDemoData()?.marketing?.reviewsData || null : null), [isDemo]);

  const { setRightExtras } = useRightExtras();
  const navigate = useNavigate();

  // Publish the Agenda widget on the right rail
  useEffect(() => {
    if (!businessId) return;
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="marketing"
        onOpenCalendar={() => navigate('/dashboard/calendar')}
      />,
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  const query = useMemo(() => {
    const p = new URLSearchParams({
      business_id: businessId,
      limit: String(filters.limit),
      offset: String(filters.offset),
    });
    if (filters.source) p.set('source', filters.source);
    if (filters.rating_min) p.set('rating_min', filters.rating_min);
    if (filters.rating_max) p.set('rating_max', filters.rating_max);
    if (typeof filters.replied === 'boolean') p.set('replied', String(filters.replied));
    if (filters.sentiment) p.set('sentiment', filters.sentiment);
    if (filters.since) p.set('since', filters.since);
    if (filters.until) p.set('until', filters.until);
    if (filters.q) p.set('q', filters.q);
    return p.toString();
  }, [businessId, filters]);

  useEffect(() => {
    let cancelled = false;
    if (!businessId && !isDemo) return;

    async function load() {
      setLoading(true);
      setErrorMsg('');
      setUsingMock(false);

      try {
        if (isDemo) {
          if (cancelled) return;
          const payload = demoReviews || { items: MOCK_ITEMS, stats: MOCK_STATS };
          setData({ items: payload.items || MOCK_ITEMS, count: (payload.items || MOCK_ITEMS).length });
          setStats(payload.stats || computeStatsFromItems(payload.items || MOCK_ITEMS));
          setUsingMock(true);
          setLoading(false);
          return;
        }

        // List + Stats (unified envelopes)
        const [listRes, statsRes] = await Promise.all([
          apiFetch(`/api/reviews?${query}`),
          apiFetch(`/api/reviews/stats?business_id=${businessId}&range=${filters.range || '30d'}`),
        ]);

        if (cancelled) return;

        if (listRes.error) throw listRes.error;

        // listRes.data is { data: [...], count: n }
        const listPayload = listRes.data || {};
        const items = listPayload.data || [];
        const count = listPayload.count || 0;

        const statsPayload = statsRes.error ? null : (statsRes.data || null);

        if (items.length === 0) {
          setUsingMock(true);
          setData({ items: MOCK_ITEMS, count: MOCK_ITEMS.length });
          setStats(statsPayload || computeStatsFromItems(MOCK_ITEMS) || MOCK_STATS);
        } else {
          setData({ items, count });
          setStats(statsPayload || computeStatsFromItems(items));
        }

        if (statsRes?.meta?.is_mock || listRes?.meta?.is_mock) setUsingMock(true);
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err?.message || 'Failed to load reviews.');
        setUsingMock(true);
        setData({ items: MOCK_ITEMS, count: MOCK_ITEMS.length });
        setStats(MOCK_STATS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [businessId, query, filters.range, isDemo, demoReviews]);

  // Fallback avg from the items if stats is missing (e.g., mock or stats call failed)
  const avgFromItems = useMemo(
    () => (data?.items?.length ? computeStatsFromItems(data.items)?.avg_rating ?? null : null),
    [data?.items]
  );

  // Prefer stats.avg_rating; else compute from items; else null
  const avg = (typeof stats?.avg_rating === 'number' ? stats.avg_rating : avgFromItems);

  return (
    <div className="max-w-6xl mx-auto px-4 pt-2 pb-6 text-white">
      {/* Header */}
      <div className="mb-5 rounded-[28px] border border-white/12 bg-gradient-to-r from-[#1b2030] via-[#111522] to-[#0a0d14] px-5 py-4 shadow-[0_20px_50px_rgba(0,0,0,0.45)] flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.35em] text-white/55">Customer Voice</p>
          <h1 className="text-[30px] font-semibold text-white">Reviews</h1>
          <p className="text-sm text-white/70 max-w-xl">
            Monitor Google and Facebook feedback, prioritize follow-ups, and keep a polished public reputation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          
          <button
            onClick={() => setImportOpen(true)}
            className="text-xs px-3 py-1.5 rounded-full bg-white/90 text-black font-semibold shadow-[0_10px_25px_rgba(0,0,0,0.35)]"
          >
            Import CSV
          </button>
        </div>
      </div>

      {/* Summary band */}
      <div className="relative rounded-[32px] border border-white/12 bg-gradient-to-br from-[#1f2840] via-[#0f1420] to-[#07090f] p-4 mb-4 shadow-[0_25px_65px_rgba(0,0,0,0.45)]">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <StarGauge value={avg} size={120} color="#facc15" />
            <div>
              <p className="text-3xl font-semibold text-white">{avg ? `${avg.toFixed?.(1) ?? avg}/5` : '—'}</p>
              <p className="text-sm text-white/65">Average rating · last {stats?.range || '30 days'}</p>
              {usingMock && (
                <span className="inline-flex mt-2 items-center gap-1 rounded-full bg-amber-500/20 px-3 py-1 text-[11px] text-amber-200">
                  Showing sample data — connect Google/Facebook
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 min-w-[260px]">
            <Chip label="Reviews" value={stats?.count_reviews ?? '—'} />
            <Chip label="Unreplied" value={stats?.unreplied_count ?? '—'} />
            <Chip label="Reply Time (h)" value={stats?.response_median_hours ?? '—'} />
          </div>
        </div>
      </div>

      <ReviewsFilters value={filters} onChange={setFilters} />

      {loading ? (
        <Banner variant="info" title="Loading" className="mt-4">
          Fetching reviews…
        </Banner>
      ) : (
        <div className="mt-4 space-y-3">
          {data.items.length === 0 && (
            <Banner variant="info" title="No reviews found">
              Try adjusting your filters or date range.
            </Banner>
          )}
          {data.items.map((r) => (
            <ReviewItem key={r.id} review={r} onReply={() => setReplying(r)} />
          ))}
        </div>
      )}

      {/* Pass tenant guard via prop */}
      <ReplyDrawer
        open={!!replying}
        review={replying}
        onClose={() => setReplying(null)}
        onSent={() => setReplying(null)}
        businessId={businessId}
      />

      <CSVImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        businessId={businessId}
      />
    </div>
  );
}

/* ---------- tiny UI helpers ---------- */

function Chip({ label, value }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-3 py-1 text-xs">
      <span className="text-white/60">{label}</span>
      <span className="font-semibold">{value ?? '—'}</span>
    </div>
  );
}

/** Large single-star gauge (mask-based) with customizable color and slightly rounded edges */
function StarGauge({ value = 0, size = 112, color = '#facc15' }) {
  const v = Number.isFinite(Number(value)) ? Number(value) : 0;
  const pct = Math.max(0, Math.min(1, v / 5));
  const maskId = useId(); // unique per instance

  // Build a centered 5-point star polygon
  const points = React.useMemo(() => {
    const outer = size * 0.48;
    const inner = outer * 0.5;
    const cx = size / 2;
    const cy = size / 2;
    const spikes = 5;
    const step = Math.PI / spikes;
    let rot = (Math.PI / 2) * 3;
    const pts = [];
    for (let i = 0; i < spikes; i++) {
      let x = cx + Math.cos(rot) * outer;
      let y = cy + Math.sin(rot) * outer;
      pts.push(`${x},${y}`);
      rot += step;
      x = cx + Math.cos(rot) * inner;
      y = cy + Math.sin(rot) * inner;
      pts.push(`${x},${y}`);
      rot += step;
    }
    pts.push(pts[0]);
    return pts.join(' ');
  }, [size]);

  return (
    <div className="relative" style={{ width: size, height: size + 18 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          {/* white star area = visible part of the colored rect */}
          <mask id={maskId}>
            <rect x="0" y="0" width={size} height={size} fill="black" />
            <polygon points={points} fill="white" />
          </mask>
        </defs>

        {/* outline with rounded joins to soften the corners */}
        <polygon
          points={points}
          fill="rgba(255,255,255,0.08)"
          stroke="rgba(255,255,255,0.15)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {/* colored fill, cropped by the star mask and width = pct */}
        <rect
          x="0"
          y="0"
          width={size * pct}
          height={size}
          fill={color}
          mask={`url(#${maskId})`}
        />
      </svg>

      <div className="absolute left-1/2 -translate-x-1/2 -bottom-0.5 text-xs text-white/80">
        {Number.isFinite(v) ? v.toFixed(2) : '—'} / 5
      </div>
    </div>
  );
}
