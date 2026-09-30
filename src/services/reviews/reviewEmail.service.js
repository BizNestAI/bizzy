import { log } from '../../utils/reviews/logger.js';

// Marketing-review helper only: prepares a mailto link and never connects to or sends through an inbox.
export async function prepareReviewEmail({ toEmail, subject, text }) {
  if (!toEmail) return { ok: false, fallback: 'No recipient email' };
  log.info('[reviews] prepared mailto draft for', toEmail);
  return {
    ok: true,
    fallback: `mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`,
  };
}
