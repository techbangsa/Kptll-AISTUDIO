const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const ALLOWED_MODELS = new Set(['gemini-flash-lite-latest', 'gemini-flash-latest', DEFAULT_MODEL]);
const TIMEOUT_MS = 12000;

/**
 * @param {object} input validated request payload
 */
function buildPrompt(input) {
  const { language, shopName, maxProducts } = input;

  const systemPrompt = [
    `You are an expert sommelier and spirits personal shopper for "${shopName}", an online liquor store in Indonesia.`,
    `Pick up to ${maxProducts} products from CANDIDATES that best match the customer's current interests.`,
    'Rules:',
    '- Only use ids that exist in CANDIDATES. Never invent products.',
    '- Interests with a higher score are stronger and more recent; focus on them first.',
    '- When the customer browsed or searched a category (e.g. wine), recommend the best products of that category: well regarded, great value, popular styles.',
    '- Keep some variety in price and style while staying relevant. Order from best match to least.',
    `- "reason": max 12 words in ${language}, friendly and specific (style, taste, occasion). Do not mention price.`,
    `- "headline": max 6 words in ${language}, referencing the main interest (e.g. "Wine Terbaik Pilihan Untukmu").`,
    `- "subheading": max 14 words in ${language}.`,
  ].join('\n');

  const userPrompt = JSON.stringify({
    interests: input.interests,
    currency: input.currency,
    CANDIDATES: input.candidates,
  });

  return { systemPrompt, userPrompt };
}

/**
 * @param {object} body
 * @param {string} model
 */
function callGemini(body, model) {
  return fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Ranks the candidates with Gemini.
 * @param {object} input validated request payload
 * @returns {Promise<{ headline: string, subheading: string, items: { id: string, reason: string }[], model: string }>}
 */
async function recommend(input) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');

  const { systemPrompt, userPrompt } = buildPrompt(input);
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          headline: { type: 'STRING' },
          subheading: { type: 'STRING' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { id: { type: 'STRING' }, reason: { type: 'STRING' } },
              required: ['id', 'reason'],
            },
          },
        },
        required: ['headline', 'items'],
      },
      // Deep thinking adds a lot of latency (20s+) and is not needed for ranking a short list.
      thinkingConfig: { thinkingLevel: 'low' },
    },
  };

  let model = ALLOWED_MODELS.has(input.model) ? input.model : DEFAULT_MODEL;
  let response = await callGemini(body, model);

  if (response.status === 400) {
    // Some models reject the thinking config — retry with the model default.
    delete body.generationConfig.thinkingConfig;
    response = await callGemini(body, model);
  }
  if (response.status === 429 || response.status === 503) {
    // Overloaded / rate limited — retry once on the lighter model.
    await new Promise((resolve) => setTimeout(resolve, 800));
    model = 'gemini-flash-lite-latest';
    response = await callGemini(body, model);
  }
  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const json = await response.json();
  const text = (json?.candidates?.[0]?.content?.parts || [])
    .filter((part) => !part.thought && part.text)
    .map((part) => part.text)
    .join('')
    .replace(/^```(?:json)?\s*|\s*```$/g, '');

  const parsed = JSON.parse(text);
  const candidateIds = new Set(input.candidates.map((c) => c.id));
  const used = new Set();

  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .map((item) => ({ id: String(item.id), reason: String(item.reason || '').slice(0, 160) }))
    .filter((item) => candidateIds.has(item.id) && !used.has(item.id) && used.add(item.id))
    .slice(0, input.maxProducts);

  return {
    headline: String(parsed.headline || '').slice(0, 80),
    subheading: String(parsed.subheading || '').slice(0, 160),
    items,
    model: json?.modelVersion || model,
  };
}

module.exports = { recommend };
