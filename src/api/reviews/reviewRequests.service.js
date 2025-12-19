// Queue & (optionally) send customer review requests.
// Uses admin client because this is invoked server-side from controllers/cron.
import { supabase } from '../../services/supabaseAdmin.js';
import { addAgendaItem } from '../../services/reviews/reviewsCalendar.service.js';
import { sendOwnerReplyEmail } from '../../services/reviews/gmail.service.js';

/**
 * @typedef {Object} ReviewRequestPayload
 * @property {string} business_id
 * @property {string} customer_email
 * @property {string} [customer_name]
 * @property {'google'|'facebook'|'generic'} [destination]  // where to leave review
 * @property {string} [notes]
 * @property {string} [scheduled_at] // ISO
 * @property {boolean} [send_now]    // send immediately by email (stub)
 */

/**
 * Create a queued review request (and optionally insert an agenda item).
 */
export async function queueReviewRequest(payload /** @type {ReviewRequestPayload} */) {
  const {
    business_id,
    customer_email,
    customer_name = null,
    destination = 'google',
    notes = '',
    scheduled_at = new Date().toISOString(),
  } = payload || {};

  if (!business_id || !customer_email) {
    return { data: null, error: new Error('business_id and customer_email are required') };
  }

  const insert = {
    business_id,
    customer_email,
    customer_name,
    destination,
    notes,
    status: 'queued',
    scheduled_at,
    created_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('review_requests')
    .insert(insert)
    .select('id')
    .single();

  // Agenda side-effect (best-effort)
  try {
    await addAgendaItem({
      business_id,
      title: `Send review request to ${customer_email}`,
      due_at: scheduled_at,
      kind: 'review_request',
      meta: { destination, notes },
    });
  } catch (_) { /* non-fatal */ }

  return { data, error };
}

/**
 * Optional immediate send (stubbed via mailto using gmail.service.js)
 * Updates status if "sent".
 */
export async function sendReviewRequestNow({ business_id, request_id }) {
  if (!business_id || !request_id) {
    return { data: null, error: new Error('business_id and request_id required') };
  }
  const { data: reqRow, error: getErr } = await supabase
    .from('review_requests')
    .select('*')
    .eq('id', request_id)
    .eq('business_id', business_id)
    .single();
  if (getErr || !reqRow) return { data: null, error: getErr || new Error('Request not found') };

  // Simple email body
  const link = reqRow.destination === 'google'
    ? 'https://g.page/r/CUSTOM_GOOGLE_REVIEW_LINK' // TODO: store per business
    : reqRow.destination === 'facebook'
      ? 'https://www.facebook.com/pg/yourpage/reviews/'
      : '#';

  const body = `Hi${reqRow.customer_name ? ' ' + reqRow.customer_name : ''},\n\nWe’d love your feedback! Please leave a quick review here:\n${link}\n\nThank you!\n—Your Contractor`;

  const send = await sendOwnerReplyEmail({
    toEmail: reqRow.customer_email,
    subject: 'Quick favor: your feedback',
    text: body,
    tokens: null,
  });

  if (send?.ok) {
    await supabase
      .from('review_requests')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', request_id)
      .eq('business_id', business_id);
  }

  return { data: { fallback: send?.fallback || null }, error: null };
}
