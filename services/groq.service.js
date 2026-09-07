const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Generate AI response using Groq Cloud API
 * @param {string} question 
 * @param {string} systemPrompt 
 * @returns {Promise<string|null>}
 */
async function generateGroqReply(question, systemPrompt = null) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.error('[Groq Service] Missing GROQ_API_KEY in .env file');
    return null;
  }

  const prompt = systemPrompt || 'You are an intelligent, polite, and helpful AI customer assistant responding to user queries on WhatsApp. Provide concise, accurate, and professional answers.';

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: question }
        ],
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content || '';
    console.log(`[Groq Service] Generated AI reply via llama-3.3-70b (${reply.length} chars)`);
    return reply.trim();
  } catch (err) {
    try {
      console.warn(`[Groq Service] Retrying with llama3-8b-8192 due to: ${err.response?.data?.error?.message || err.message}`);
      const fallbackResponse = await axios.post(
        GROQ_API_URL,
        {
          model: 'llama3-8b-8192',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: question }
          ],
          temperature: 0.7,
          max_tokens: 500,
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
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
