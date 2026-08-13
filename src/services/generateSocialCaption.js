import { safeFetch } from '../utils/safeFetch.js';

export async function generateSocialCaption({ businessProfile, postType, notes, count = 1 }) {
  try {
    const requests = Array.from({ length: Math.max(1, Number(count) || 1) }, () =>
      safeFetch('/api/marketing/captions/generate', {
        method: 'POST',
        body: { businessProfile, postType, notes },
      })
    );
    const responses = await Promise.all(requests);
    const parsed = responses.map((response) => response?.data ?? response);

    if (count === 1) {
      const first = parsed[0] || {};
      return {
        caption: first.caption || '',
        category: first.category || '',
        cta: first.cta || '',
        imageIdea: first.imageIdea || '',
      };
    }
    return parsed;
  } catch (err) {
    console.error('Error generating caption(s):', err);
    return count === 1
      ? { caption: '', category: '', cta: '', imageIdea: '' }
      : [];
  }
}
