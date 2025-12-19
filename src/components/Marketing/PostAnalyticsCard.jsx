// /components/Marketing/PostAnalyticsCard.jsx
import React from 'react';
import { Info } from 'lucide-react';

export default function PostAnalyticsCard({ post, gptInsight }) {
  const interactions = post.likes + post.comments + post.shares;
  const rate = post.reach ? ((interactions / post.reach) * 100).toFixed(1) : '0.0';

  return (
    <div className="border border-blue-500/20 rounded p-3 text-white">
      <div className="flex justify-between items-center mb-1">
        <p className="font-medium">{post.post_type} on {post.platform}</p>
        <span className="text-xs text-blue-300">{post.date}</span>
      </div>
      <div className="grid grid-cols-3 text-xs text-blue-300 gap-2 mb-2">
        <p>Reach: <span className="text-white font-medium">{post.reach}</span></p>
        <p>Likes: <span className="text-white font-medium">{post.likes}</span></p>
        <p>Comments: <span className="text-white font-medium">{post.comments}</span></p>
        <p>Shares: <span className="text-white font-medium">{post.shares}</span></p>
        <p>Clicks: <span className="text-white font-medium">{post.clicks}</span></p>
        <p>Engagement: <span className="text-white font-medium">{rate}%</span></p>
      </div>
      {gptInsight && (
        <p className="text-xs italic text-blue-300 flex items-center gap-1">
          <Info size={14} /> {gptInsight}
        </p>
      )}
    </div>
  );
}
