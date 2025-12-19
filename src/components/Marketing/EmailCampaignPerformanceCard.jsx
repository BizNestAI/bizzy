import React, { useEffect, useMemo, useState } from 'react';
import { Mail, Info, Loader2 } from 'lucide-react';
import dayjs from 'dayjs';

const mockEmailCampaigns = [
  { id: 1, title: 'August Newsletter', date: '2025-08-02', open_rate: 42, ctr: 8.1, unsubscribes: 2 },
  { id: 2, title: 'Summer Promo Blast', date: '2025-07-27', open_rate: 33, ctr: 5.6, unsubscribes: 5 },
  { id: 3, title: 'Testimonial Request', date: '2025-07-19', open_rate: 51, ctr: 11.2, unsubscribes: 0 },
];

export default function EmailCampaignPerformanceCard() {
  const [filter, setFilter] = useState('30d');
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [campaignInsights, setCampaignInsights] = useState([]);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');

  const filtered = useMemo(()=> {
    const now = dayjs();
    if (filter==='7d') return mockEmailCampaigns.filter(c=>dayjs(c.date).isAfter(now.subtract(7,'day')));
    if (filter==='30d') return mockEmailCampaigns.filter(c=>dayjs(c.date).isAfter(now.subtract(30,'day')));
    if (filter==='qtd') return mockEmailCampaigns.filter(c=>dayjs(c.date).isAfter(dayjs().quarter(dayjs().quarter()).startOf('quarter')));
    return mockEmailCampaigns;
  }, [filter]);

  useEffect(()=> {
    const fetchInsights = async () => {
      if (!filtered.length) { setCampaignInsights([]); setSummary(''); return; }
      setLoadingInsights(true); setError('');
      try {
        const res = await fetch('/api/generate-marketing-insights', {
          method: 'POST', headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ posts: [], campaigns: filtered }),
        });
        const json = await res.json();
        if (!res.ok || json?.error) throw new Error(json?.error?.message || `HTTP ${res.status}`);
        const data = json?.data || json; // support both during transition
        setCampaignInsights(Array.isArray(data.campaignInsights)? data.campaignInsights : []);
        setSummary(typeof data.summary === 'string' ? data.summary : '');
      } catch (e) {
        setError('Could not load AI insights right now.'); setCampaignInsights([]); setSummary('');
      } finally { setLoadingInsights(false); }
    };
    fetchInsights();
  }, [filtered]);

  const getInsightForIndex = (idx) => campaignInsights.find(ci=>ci.id===idx)?.insight || '';

  return (
    <div className="bg-gray-900 rounded-xl border border-blue-500/30 p-4 shadow text-white">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-lg font-semibold text-blue-400 flex items-center gap-2"><Mail size={18}/> Email Campaigns</h3>
        <select value={filter} onChange={e=>setFilter(e.target.value)} className="bg-gray-800 text-sm border border-blue-500/20 rounded px-2 py-1 text-blue-200">
          <option value="7d">Last 7 Days</option><option value="30d">Last 30 Days</option><option value="qtd">QTD</option>
        </select>
      </div>

      <div className="min-h-[24px] mb-3">
        {loadingInsights ? <div className="text-sm text-blue-300 italic flex items-center gap-2"><Loader2 className="animate-spin" size={14}/> Generating insights…</div>
          : error ? <div className="text-sm text-red-300 italic">{error}</div>
          : summary ? <div className="text-sm text-blue-300 italic flex items-center gap-1"><Info size={14}/> {summary}</div> : null}
      </div>

      <div className="text-sm divide-y divide-blue-500/10">
        {filtered.map((c, idx)=>(
          <div key={c.id} className="py-3">
            <div className="flex justify-between items-center">
              <div className="flex flex-col"><span className="font-medium text-white">{c.title}</span><span className="text-xs text-blue-300">{dayjs(c.date).format('MMM D, YYYY')}</span></div>
              <div className="flex gap-4 text-right text-blue-200 text-xs">
                <div><span className="block font-medium">{c.open_rate}%</span><span>Open</span></div>
                <div><span className="block font-medium">{c.ctr}%</span><span>CTR</span></div>
                <div><span className="block font-medium">{c.unsubscribes}</span><span>Unsubs</span></div>
              </div>
            </div>
            {getInsightForIndex(idx) && <p className="mt-2 text-xs italic text-indigo-300">{getInsightForIndex(idx)}</p>}
          </div>
        ))}
        {!filtered.length && <div className="py-6 text-center text-blue-300 text-sm">No campaigns in this range.</div>}
      </div>
    </div>
  );
}
