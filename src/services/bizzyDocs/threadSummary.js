import { safeFetch, apiUrl } from '../../utils/safeFetch';

export async function generateThreadSummary({ threadId, businessName, text }) {
  try {
    const data = await safeFetch(apiUrl('/api/docs/thread-summary'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, business_name: businessName, snippet: text }),
    });
    return data?.summary || null;
  } catch (e) {
    console.warn('[threadSummary] failed', e);
    return null;
  }
}
