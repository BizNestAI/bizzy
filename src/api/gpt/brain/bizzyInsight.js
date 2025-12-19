// File: src/api/gpt/bizzyInsight.js
import express from 'express';
import { config } from 'dotenv';
import OpenAI from 'openai';

config(); // Load .env

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

router.post('/', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt.' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content:
            "You are Bizzi, an emotionally intelligent AI business assistant for home service and construction founders. When asked about financial metrics, you explain in clear, human language what may be causing the result and offer 1–2 smart suggestions to improve. Avoid sounding generic or robotic.",
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.7,
    });

    const reply = response.choices[0].message.content;
    res.json({ reply });
  } catch (err) {
    console.error('[Bizzy Insight Error]', err);
    res.status(500).json({ error: 'Failed to fetch GPT insight.' });
  }
});

export default router;
