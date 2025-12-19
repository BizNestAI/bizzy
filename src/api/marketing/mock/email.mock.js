// src/api/marketing/mock/email.mock.js
export function mockEmailCampaign(campaignType = 'Spring Promo', notes = '') {
  return {
    subject: `${campaignType}: Save on your next project`,
    body: `<p>Hi there! ${notes || 'This month only, enjoy special pricing on our most requested services.'}</p>
<p>Reply to this email or click the button below to lock your spot.</p>`,
    cta: 'Book Now',
  };
}
