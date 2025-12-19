// File: /src/hooks/useChatThreads.js
import { useEffect, useRef, useState, useCallback } from 'react';

const DEBOUNCE_MS        = 300;
const INITIAL_PAGE_SIZE  = 20;   // first page
const PAGE_SIZE          = 10;   // subsequent pages
const SOFT_CAP           = 100;  // stop after this many rows (or when API says no more)

export default function useChatThreads(businessId) {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0); // offset we've attempted to consume
  const [total, setTotal] = useState(0);   // total from API (if provided)

  // keep a live ref of threads for cursor fallback
  const threadsRef = useRef([]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);

  // hasMore stops once we hit either the server total or our soft cap
  const effectiveTotal = Math.min(total || Infinity, SOFT_CAP);
  const hasMore = threads.length < effectiveTotal;

  const API_BASE = import.meta.env?.VITE_API_BASE || '';
  const userIdRef = useRef(localStorage.getItem('user_id') || '');
  const abortRef = useRef(null);
  const debounceRef = useRef(null);

  // merge + de-dupe by id
  const mergeUnique = (prev, incoming) => {
    if (!incoming?.length) return prev;
    const seen = new Set(prev.map(r => r.id));
    const appended = [];
    for (const r of incoming) {
      if (r?.id && !seen.has(r.id)) {
        seen.add(r.id);
        appended.push(r);
      }
    }
    return prev.concat(appended);
  };

  const fetchList = useCallback(async ({ reset = false, customOffset, limitOverride } = {}) => {
    if (!businessId) return;

    // Determine next offset and limit
    const nextOffset = typeof customOffset === 'number'
      ? customOffset
      : (reset ? 0 : offset);

    // Remaining capacity based on soft cap
    const remainingCap = SOFT_CAP - nextOffset;
    if (remainingCap <= 0) return;

    const intendedLimit = limitOverride ?? (reset ? INITIAL_PAGE_SIZE : PAGE_SIZE);
    const limit = Math.max(0, Math.min(intendedLimit, remainingCap));
    if (limit === 0) return;

    setLoading(true);
    setError('');

    // Abort any in-flight call
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const url = new URL(`${API_BASE}/api/chats`);
      url.searchParams.set('business_id', businessId);
      url.searchParams.set('limit',  String(limit));
      url.searchParams.set('offset', String(nextOffset)); // prefer offset when server supports it
      if (q) url.searchParams.set('q', q);

      // 👇 Cursor fallback: many APIs use "before=<timestamp>" for older pages
      if (!reset && nextOffset > 0) {
        const last = threadsRef.current[threadsRef.current.length - 1];
        if (last?.updated_at) {
          url.searchParams.set('before', new Date(last.updated_at).toISOString());
        }
      }

      const res = await fetch(url.toString(), {
        headers: { 'x-business-id': businessId, 'x-user-id': userIdRef.current },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (typeof data.total === 'number') setTotal(data.total);

      const list = Array.isArray(data.threads) ? data.threads : [];

      // When server returns nothing new, treat as end-of-list
      if (!list.length) {
        // if server didn't send total, lock it to what we already have to disable hasMore
        if (!data.total) setTotal(threadsRef.current.length);
        setLoading(false);
        return;
      }

      // Update offset by what we *attempted* to consume (keeps math consistent)
      setOffset(nextOffset + list.length);

      setThreads(prev => reset ? list : mergeUnique(prev, list));
    } catch (e) {
      if (e.name !== 'AbortError') setError('Failed to load chats.');
    } finally {
      setLoading(false);
    }
  }, [API_BASE, businessId, q, offset]);

  // Initial load / when business or search query changes
  const refresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => fetchList({ reset: true, customOffset: 0 }),
      DEBOUNCE_MS
    );
  }, [fetchList]);

  useEffect(() => {
    refresh();
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [businessId, q, refresh]);

  // Load next page (10) while respecting soft cap & API total
  const loadMore = useCallback(async () => {
    if (loading) return;
    // if we've already revealed everything the server says exists or we hit soft cap, stop
    if (!hasMore) return;
    await fetchList({ customOffset: offset });
  }, [fetchList, loading, hasMore, offset]);

  const patch = useCallback(async (id, body) => {
    if (!id) return;
    const prev = threads;

    let next = prev.map((t) =>
      (t.id === id ? { ...t, ...body, updated_at: new Date().toISOString() } : t)
    );

    if ('pinned' in body) {
      next = next.sort((a, b) => {
        if (a.pinned === b.pinned) {
          return new Date(b.updated_at) - new Date(a.updated_at);
        }
        return a.pinned ? -1 : 1;
      });
    }

    setThreads(next);

    try {
      const res = await fetch(`${API_BASE}/api/chats/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-business-id': businessId,
          'x-user-id': userIdRef.current
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setThreads(prev);
    }
  }, [API_BASE, businessId, threads]);

  return {
    threads,
    loading,
    error,
    q, setQ,
    refresh,
    hasMore,
    loadMore,
    rename  : (id, title)    => patch(id, { title: String(title || '').trim() || 'Untitled' }),
    pin     : (id, pinned)   => patch(id, { pinned: !!pinned }),
    archive : (id, archived) => patch(id, { archived: !!archived }),
  };
}
