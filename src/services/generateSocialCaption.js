import { openai } from './openaiClient'; // Ensure OpenAI client is securely wrapped

export async function generateSocialCaption({ businessProfile, postType, notes, count = 1 }) {
  const { business_type, target_audience, services, location } = businessProfile;

  const prompt = `
You are Bizzy, a social media strategist for a ${business_type} company based in ${location}. 
The business serves ${target_audience} and offers services like ${services.join(', ')}.

Generate ${count} high-performing social media post ${count === 1 ? 'caption' : 'captions'} for a "${postType || 'general'}" post.
${notes ? `Here’s a note from the user: "${notes}". Incorporate it into the post(s).` : ''}

Respond with:
- Caption: The full post caption. Make it emotionally compelling, friendly, and direct.
- Category: One-word post type category (e.g., Tip, Promo, Testimonial)
- CTA: A clear call to action like “Call now”, “Book today”, or “DM us for a free quote”
- Image Idea: A description of what kind of image should accompany this post.

Respond as ${count === 1 ? 'a single JSON object' : 'an array of JSON objects'} in this format:

${count === 1 ? `
{
  "caption": "...",
  "category": "...",
  "cta": "...",
  "imageIdea": "..."
}` : `
[
  {
    "caption": "...",
    "category": "...",
    "cta": "...",
    "imageIdea": "..."
  },
  {
    "caption": "...",
    "category": "...",
    "cta": "...",
    "imageIdea": "..."
  },
  {
    "caption": "...",
    "category": "...",
    "cta": "...",
    "imageIdea": "..."
  }
]
`}
`;

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
    });

    const content = res.choices[0].message.content;

    const parsed = JSON.parse(content);

    if (count === 1) {
      return {
        caption: parsed.caption || '',
        category: parsed.category || '',
        cta: parsed.cta || '',
        imageIdea: parsed.imageIdea || '',
      };
    } else {
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error('Error generating caption(s):', err);
    return count === 1
      ? { caption: '', category: '', cta: '', imageIdea: '' }
      : [];
  }
}