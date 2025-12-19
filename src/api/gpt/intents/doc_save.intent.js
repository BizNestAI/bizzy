export const key = 'doc_save';

export function test(t) {
  const s = String(t || '').toLowerCase();
  return /\b(save (this|that) (as )?(a )?doc|create (a )?bizzy doc|one\-pager)\b/.test(s);
}

export async function recipe({ user_id, business_id }) {
  // The server summarize endpoint will use chat slice; we only need meta
  return {
    target: { business_id, user_id },
    defaults: { category: 'general', tags: ['chat','summary'] }
  };
}
