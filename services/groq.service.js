const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const PROMOTIONAL_SYSTEM_PROMPT = `You are a friendly, engaging AI sales assistant for Norozz — a premium WhatsApp automation and marketing platform managed by our admin team.

Your goals:
1. Chat naturally and helpfully with users, answering their questions warmly.
2. Subtly promote Norozz and its features (WhatsApp campaigns, chatbots, AI auto-reply, contact management, analytics, photoshare events) in every conversation.
3. Encourage users to upgrade their plan, contact the admin, or try new features.
4. Keep conversations going — always end with a question or an engaging follow-up.
5. If a user seems interested in any service, guide them to contact the admin for more details.

Promotion style:
- Natural, not pushy. Weave promotions into helpful answers.
- Highlight Norozz benefits: "With Norozz, you can automate this easily!", "Our admin team can set this up for you!"
- Mention admin contact when relevant: "Feel free to reach out to our admin for a personalized demo!"

Tone: Friendly, professional, enthusiastic about Norozz. Keep replies concise (2-4 sentences max). Always respond in the same language the user writes in.`;

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

  // Keep last 10 messages for context (to avoid token limits)
  const recentHistory = (history || []).slice(-10);

  const messages = [
    { role: 'system', content: prompt },
    ...recentHistory,
    { role: 'user', content: question },
  ];

  try {
    const response = await axios.post(
      GROQ_API_URL,
      { model: 'groq/compound', messages, temperature: 0.75, max_tokens: 300 },
      {
        headers: { 'Authorization': `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content || '';
    console.log(`[Groq Service] Generated AI reply via groq/compound (${reply.length} chars)`);
    return reply.trim();
  } catch (err) {
    try {
      console.warn(`[Groq Service] Retrying with groq/compound-mini due to: ${err.response?.data?.error?.message || err.message}`);
      const fallbackResponse = await axios.post(
        GROQ_API_URL,
        { model: 'groq/compound-mini', messages, temperature: 0.75, max_tokens: 300 },
        {
          headers: { 'Authorization': `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
      const fallbackReply = fallbackResponse.data?.choices?.[0]?.message?.content || '';
      return fallbackReply.trim();
    } catch (fallbackErr) {
      console.error('[Groq Service] Failed to generate Groq AI reply:', fallbackErr.response?.data || fallbackErr.message);
      return null;
    }
  }
}

module.exports = {
  generateGroqReply,
};
