// src/api/marketing/mock/captions.mock.js
export function mockCaption({ postType = 'Before/After', platform = 'instagram', notes = '' } = {}) {
  return {
    caption: `🔨 ${postType}: Ready for a fresh look? ${notes || 'Book a free estimate today.'}`,
    category: 'Before/After',
    cta: 'Get a Free Quote',
    imageIdea: 'Split-image before/after of the job site with logo watermark',
    hashtags: ['#homeservice', '#beforeandafter', '#remodel'],
  };
}
