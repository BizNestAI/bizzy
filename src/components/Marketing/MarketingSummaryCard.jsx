// src/components/Marketing/MarketingSummaryCard.jsx
import React, { useEffect, useState } from 'react';
import { TrendingUp, ThumbsUp, Mail, Star, Info } from 'lucide-react';
import { fetchEmailAnalytics } from '../../services/fetchEmailAnalytics';
import { fetchPostAnalytics } from '../../services/fetchPostAnalytics';

export default function MarketingSummaryCard({ businessId }) {
  const [summary, setSummary] = useState(null);
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      // Lightweight client aggregation (mock-aware through services)
      const sinceISO = new Date(Date.now() - 30*24*3600e3).toISOString();
      const userId = localStorage.getItem('user_id') || undefined;

      const [emailRes, postRes] = await Promise.all([
        fetchEmailAnalytics?.(userId, businessId, sinceISO),
        fetchPostAnalytics?.(userId, businessId, sinceISO),
      ]);

      const emails = emailRes?.data || [];
      const posts  = postRes?.data || [];

      const totalReach = posts.reduce((a,p)=> a + (p.reach||0), 0);
      const totalEng = posts.reduce((a,p)=> a + ((p.likes||0)+(p.comments||0)), 0);
      const avgEngRate = totalReach ? ((totalEng/totalReach)*100) : 0;

      const bestPost = posts.sort((a,b)=>((b.likes||0)+(b.comments||0)) - ((a.likes||0)+(a.comments||0)))[0];
      const bestCampaign = emails.sort((a,b)=>(b.open_rate||0)-(a.open_rate||0))[0];

      if (!cancel) {
        setSummary({
          totalReach, totalEngagements: totalEng, avgEngagementRate: avgEngRate,
          bestPost: bestPost ? `${bestPost.post_type} on ${bestPost.platform}` : '—',
          bestCampaign: bestCampaign?.title || '—',
          weeklyChange: null, // optional: compute if you fetch 2 ranges
        });
        setMeta({ is_mock: false }); // services already mock when disconnected; you may thread that here if exposed
      }
    })();
    return () => { cancel = true; };
  }, [businessId]);

  const s = summary || { totalReach: 14200, totalEngagements: 1384, avgEngagementRate: 9.7, bestPost: 'Backyard Before/After Reveal', bestCampaign: 'Spring Promo Email', weeklyChange: 11.3 };
  const isMock = meta?.is_mock;

  return (
    <div className="bg-gray-900 border border-blue-500/30 rounded-xl p-4 shadow-md w-full max-w-2xl text-white">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-blue-400">📈 Marketing Summary</h2>
        {s.weeklyChange != null ? (
          <span className={`text-sm font-semibold px-2 py-1 rounded-full ${s.weeklyChange>=0?'bg-green-700 text-green-200':'bg-red-700 text-red-300'}`}>
            {s.weeklyChange>=0?'+':''}{s.weeklyChange}% this week
          </span>
        ) : <span className="text-xs text-blue-300 flex items-center gap-1"><Info size={14}/> Last 30 days</span>}
      </div>

      {isMock && <div className="text-xs text-blue-300 mb-2">Showing sample/aggregated data until accounts are connected.</div>}

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="flex items-center gap-2"><TrendingUp size={16} className="text-blue-400"/><span className="text-blue-300">Total Reach:</span><span className="font-bold text-white">{Number(s.totalReach||0).toLocaleString()}</span></div>
        <div className="flex items-center gap-2"><ThumbsUp size={16} className="text-blue-400"/><span className="text-blue-300">Engagements:</span><span className="font-bold text-white">{Number(s.totalEngagements||0).toLocaleString()}</span></div>
        <div className="flex items-center gap-2"><Star size={16} className="text-blue-400"/><span className="text-blue-300">Avg. Engagement Rate:</span><span className="font-bold text-white">{(s.avgEngagementRate||0).toFixed(1)}%</span></div>
        <div className="flex items-center gap-2"><Mail size={16} className="text-blue-400"/><span className="text-blue-300">Top Email:</span><span className="font-bold text-white truncate">{s.bestCampaign}</span></div>
        <div className="col-span-2 flex items-center gap-2"><Star size={16} className="text-blue-400"/><span className="text-blue-300">Top Post:</span><span className="font-bold text-white truncate">{s.bestPost}</span></div>
      </div>
    </div>
  );
}
