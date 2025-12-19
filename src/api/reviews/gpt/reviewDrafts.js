export function buildReplyDraft({ rating, themes = [], body, author_name }) {
  const name = author_name || 'there';
  const mention = themes?.length ? ` We appreciate your note about ${themes.slice(0,2).join(' & ')}.` : '';
  if (rating >= 5) return `Hi ${name}, thanks so much for the 5-star review!${mention} We loved working with you—reach out anytime.`;
  if (rating === 4) return `Hi ${name}, thank you for the great review!${mention} If there’s anything we can improve next time, we’re all ears.`;
  if (rating === 3) return `Hi ${name}, thanks for the feedback.${mention} We’d like to make this right—could we connect to learn more?`;
  return `Hi ${name}, we’re sorry to hear about your experience.${mention} Please contact us directly so we can address this immediately.`;
}

