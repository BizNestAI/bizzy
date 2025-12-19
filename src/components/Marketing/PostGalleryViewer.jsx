import React, { useEffect, useState } from 'react';
import { useUser } from '@supabase/auth-helpers-react';
import { fetchPostGallery } from '../../services/fetchPostGallery';
import { fetchPublishedPosts } from '../../services/fetchPublishedPosts';
import EditPostModal from './EditPostModal';
import SchedulePostModal from './SchedulePostModal';
import PostCard from './PostCard';
import { toTitleCasePlatform } from '../../utils/formatters';

const platformOptions = ['All','Instagram','Facebook'];
const typeOptions = ['All','Tip','Promo','Testimonial','Before/After','Seasonal Offer'];
const statusOptions = ['All','Draft','Scheduled','Published'];

export default function PostGalleryViewer({ businessId }) {
  const user = useUser();
  const [gallery, setGallery] = useState([]);
  const [published, setPublished] = useState([]);
  const [filteredPosts, setFilteredPosts] = useState([]);
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [sortBy, setSortBy] = useState('date');
  const [editing, setEditing] = useState(null);
  const [scheduling, setScheduling] = useState(null);

  const loadPosts = async () => {
    const gRes = await fetchPostGallery(user?.id, businessId);
    const pRes = await fetchPublishedPosts(user?.id, businessId);
    const g = gRes?.data || []; const p = pRes || pRes?.data || [];
    setGallery(g); setPublished(p);
    setFilteredPosts([...g, ...p]);
  };

  useEffect(() => { if (user && businessId) loadPosts(); }, [user, businessId]);

  useEffect(() => {
    const all = [...gallery, ...published];
    let filtered = all.filter((post) => {
      const platformTitle = toTitleCasePlatform(post.platform || '');
      const matchesPlatform = platformFilter === 'All' || platformTitle === platformFilter;
      const matchesType = typeFilter === 'All' || post.category === typeFilter;
      const matchesStatus = statusFilter === 'All' || (post.status||'').toLowerCase() === statusFilter.toLowerCase();
      const q = search.toLowerCase();
      const matchesSearch = (post.caption||'').toLowerCase().includes(q) || (post.cta||'').toLowerCase().includes(q);
      return matchesPlatform && matchesType && matchesStatus && matchesSearch;
    });

    if (sortBy === 'engagement') {
      filtered.sort((a,b)=> ((b.metrics_json?.likes||0)+(b.metrics_json?.comments||0)) - ((a.metrics_json?.likes||0)+(a.metrics_json?.comments||0)));
    } else {
      filtered.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    }
    setFilteredPosts(filtered);
  }, [search, platformFilter, typeFilter, statusFilter, sortBy, gallery, published]);

  return (
    <div className="w-full max-w-6xl mx-auto p-4 text-white">
      <h2 className="text-2xl font-semibold text-blue-400 mb-4">Post Gallery</h2>

      <div className="flex flex-wrap gap-2 mb-4">
        <input type="text" placeholder="Search captions..." className="p-2 rounded bg-gray-800 border border-blue-500/30 w-full sm:w-auto flex-1" value={search} onChange={(e)=>setSearch(e.target.value)} />
        {[platformOptions, typeOptions, statusOptions].map((opts, i)=>(
          <select key={i} className="p-2 rounded bg-gray-800 border border-blue-500/30"
            value={i===0?platformFilter:i===1?typeFilter:statusFilter}
            onChange={(e)=>{ if(i===0) setPlatformFilter(e.target.value); if(i===1) setTypeFilter(e.target.value); if(i===2) setStatusFilter(e.target.value); }}>
            {opts.map((o)=>(<option key={o}>{o}</option>))}
          </select>
        ))}
        <select className="p-2 rounded bg-gray-800 border border-blue-500/30" value={sortBy} onChange={(e)=>setSortBy(e.target.value)}>
          <option value="date">Sort: Date</option><option value="engagement">Sort: Engagement</option>
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredPosts.map((post)=>(
          <PostCard
            key={post.id}
            post={post}
            onDelete={loadPosts}
            onEdit={()=>setEditing(post)}
            onSchedule={()=>setScheduling(post)}
          />
        ))}
      </div>

      {filteredPosts.length===0 && <p className="text-sm text-blue-300 mt-4">No posts match your filters.</p>}

      {editing && <EditPostModal post={editing} onClose={()=>setEditing(null)} onSave={loadPosts} />}
      {scheduling && <SchedulePostModal post={scheduling} onClose={()=>setScheduling(null)} onSave={loadPosts} />}
    </div>
  );
}
