// Lightweight web search helper using SerpAPI
// Reads API key from process.env.SERPAPI_API_KEY

const SERP_ENDPOINT = 'https://serpapi.com/search';

const safeFetch = (...args) => {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available in this environment.');
  }
  return fetch(...args);
};

export async function webLookup(query) {
  if (!query || typeof query !== 'string') return null;
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) return null;

  try {
    const url = new URL(SERP_ENDPOINT);
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('gl', 'us');
    url.searchParams.set('hl', 'en');
    url.searchParams.set('num', '5'); // request up to 5; we’ll trim to top 3

    const resp = await safeFetch(url.toString());
    if (!resp.ok) {
      console.error('[webLookup]', 'SerpAPI failed', resp.status, resp.statusText);
      return null;
    }

    const data = await resp.json();
    const forLog = {
      sports: data?.sports_results ? true : false,
      organicCount: Array.isArray(data?.organic_results) ? data.organic_results.length : 0,
    };

    const snippets = [];

    // Sports-specific payload (common for teams/records/scores)
    if (data?.sports_results) {
      const s = data.sports_results;
      const title = s.title || s.league || 'Sports result';
      const descParts = [];
      if (s.game_spotlight) descParts.push(s.game_spotlight);
      if (s.description) descParts.push(s.description);
      if (Array.isArray(s.games) && s.games.length) {
        // pick the most recent game with a score (prefer completed)
        const scored = s.games.filter(g => g?.teams?.some(t => t?.score != null));
        const g = (scored[0] || s.games[0]) || {};
        const teams = [g.teams?.[0]?.name, g.teams?.[1]?.name].filter(Boolean).join(' vs ');
        const score = g.teams?.map(t => t.score).filter(v => v != null).join(' - ');
        const when = g.when || g.status || '';
        const opponent = g?.teams?.find(t => t?.name && !/panthers/i.test(t.name))?.name || '';
        const line = [teams, score, when].filter(Boolean).join(' | ');
        if (line) descParts.push(line);
        if (opponent && score) {
          descParts.push(`Most recent listed game vs ${opponent}: ${score}${when ? ` (${when})` : ''}`);
        }

        // also include a brief list of the last few games with scores
        const recentGames = scored.slice(0, 3);
        if (recentGames.length) {
          const gameLines = recentGames
            .map((game) => {
              const t0 = game?.teams?.[0];
              const t1 = game?.teams?.[1];
              const vs = [t0?.name, t1?.name].filter(Boolean).join(' vs ');
              const sc = [t0?.score, t1?.score].filter(v => v != null).join(' - ');
              const status = game?.when || game?.status || '';
              return [vs, sc, status].filter(Boolean).join(' | ');
            })
            .filter(Boolean);
          if (gameLines.length) {
            descParts.push(`Recent games: ${gameLines.join(' • ')}`);
          }
        }
      }
      const displayUrl = s.link || s.source || '';
      let entry = `${title} — ${descParts.join(' • ')}`.trim();
      if (displayUrl) entry += ` (source: ${String(displayUrl).replace(/^https?:\/\//, '')})`;
      snippets.push(entry.slice(0, 300));
    }

    // General organic results
    const organic = Array.isArray(data?.organic_results) ? data.organic_results.slice(0, 3) : [];
    for (const r of organic) {
      const title = r.title || 'Result';
      const snippet = r.snippet || r.snippet_highlighted_words?.join(' ') || '';
      const displayUrl = r.displayed_link || r.link || '';
      let entry = `${title} — ${snippet}`.trim();
      if (displayUrl) entry += ` (source: ${String(displayUrl).replace(/^https?:\/\//, '')})`;
      if (entry.length > 300) entry = entry.slice(0, 300) + '…';
      snippets.push(entry);
      if (snippets.length >= 3) break;
    }

    if (!snippets.length) return null;

    // Keep overall text under ~1800 chars
    let totalLen = 0;
    const limited = [];
    for (const s of snippets) {
      if (totalLen + s.length > 1800) break;
      limited.push(s);
      totalLen += s.length;
    }

    if (!limited.length) return null;

    const today = new Date().toISOString().slice(0, 10);
    const out = [`Web search results as of ${today}:`, ...limited.map((s, i) => `${i + 1}) ${s}`)].join('\n');
    console.log('[webLookup]', 'serpapi ok', { ...forLog, snippetPreview: out.slice(0, 180) });
    return out;
  } catch (e) {
    console.error('[webLookup]', e?.message || e);
    return null;
  }
}

export default webLookup;
