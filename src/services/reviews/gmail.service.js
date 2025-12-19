import { log } from '../../utils/reviews/logger.js';
export async function sendOwnerReplyEmail({ toEmail, subject, text, tokens }) {
  if (!toEmail) return { ok: false, fallback: 'No recipient email' };
  log.info('[gmail] (stub) would send email to', toEmail);
  return {
    ok: true,
    fallback: `mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`
  };
}
