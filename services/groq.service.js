const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const PROMOTIONAL_SYSTEM_PROMPT = `Tu Norozz ka ek smart team member hai jo WhatsApp pe users se baat karta hai.

Teri style:
- Bilkul human ki tarah baat kar — short, natural, real.
- Max 2-3 lines reply. Kabhi bhi lamba paragraph mat likho.
- Over-explain mat karo. Direct point pe aao.
- User jo language use kare (Hindi, Hinglish, English) — usi me reply karo.
- Norozz features tab hi batao jab relevant ho, har message me nahi.
- Agar koi service ya pricing puche: "Admin se baat karo seedha — wo best deal denge! 😊"
- Har reply ke end me ek chhota sa question zaroor pucho conversation chalate rehne ke liye.
- Kabhi bot jaisa mat lagna — ek helpful dost ki tarah baat karo.

Norozz kya hai (sirf zarurat pe batao):
WhatsApp campaigns, AI chatbot, auto-reply, contacts, analytics, photo-share events.

Good reply examples:
User: "Hi" → "Hey! Kya haal hai? Kaise help kar sakta hoon? 😊"
User: "Pricing?" → "Plan ke hisaab se alag hai bhai. Admin se directly baat karo — best deal milega! Personal use hai ya business?"
User: "Automation chahiye" → "Sahi jagah aaye! Norozz pe sab automate ho jaata hai easily. Kya specifically chahiye?"
User: "Kya karta hai ye?" → "WhatsApp pe sab kuch automate karta hai — campaigns, chatbot, auto-reply sab. Kaunsa feature chahiye tumhe?"`;

/**
 * Generate AI response using Groq Cloud API with conversation history
 * @param {string} question
 * @param {Array} history - [{role: 'user'|'assistant', content: string}]
 * @param {string} systemPrompt
 * @returns {Promise<string|null>}
 */
async function generateGroqReply(question, history = [], systemPrompt = null) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.error('[Groq Service] Missing GROQ_API_KEY in .env file');
    return null;
  }

  const prompt = systemPrompt || PROMOTIONAL_SYSTEM_PROMPT;
  const recentHistory = (history || []).slice(-10);

  const messages = [
    { role: 'system', content: prompt },
    ...recentHistory,
    { role: 'user', content: question },
  ];

  const models = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b'];

  for (const model of models) {
    try {
      const response = await axios.post(
        GROQ_API_URL,
        { model, messages, temperature: 0.8, max_tokens: 150 },
        {
          headers: { 'Authorization': `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
      const reply = response.data?.choices?.[0]?.message?.content || '';
      if (reply.trim()) {
        console.log(`[Groq Service] AI reply via ${model} (${reply.trim().length} chars)`);
        return reply.trim();
      }
    } catch (err) {
      console.warn(`[Groq Service] Model ${model} failed: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  console.error('[Groq Service] All models failed.');
  return null;
}

module.exports = {
  generateGroqReply,
};
