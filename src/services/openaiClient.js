import OpenAI from 'openai';

if (typeof window !== 'undefined') {
  throw new Error('openaiClient.js is server-only. Browser code must call Bizzi backend APIs.');
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required to initialize the server OpenAI client.');
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
