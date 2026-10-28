const crypto = require('crypto');
const express = require('express');
const kv = require('../lib/kv');
const { recommend } = require('../lib/gemini');
const { fetchCandidates } = require('../lib/candidates');
const { verifySessionToken } = require('../lib/shopify-auth');
const { topSignals } = require('../lib/signals');

const router = express.Router();

const RECO_TTL_S = 6 * 60 * 60;
const LANGUAGES = { id: 'Bahasa Indonesia', en: 'English' };

/**
 * @param {unknown} value
 * @param {number} max
 */
function str(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * Customer account extensions run on a Shopify CDN origin and authenticate with a bearer
 * session token (no cookies), so any origin may call these routes.
 * @type {import('express').RequestHandler}
 */
function tokenCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

/** @param {any} body */
function sanitizePurchased(body) {
  const seen = new Set();
  return (Array.isArray(body?.purchased) ? body.purchased.slice(0, 20) : [])
    .map((/** @type {any} */ p) => ({
      id: str(p?.id, 40).replace(/^gid:\/\/shopify\/Product\//, ''),
      title: str(p?.title, 150),
      type: str(p?.type, 60),
      vendor: str(p?.vendor, 60),
    }))
    .filter((/** @type {any} */ p) => /^\d+$/.test(p.id) && p.title && !seen.has(p.id) && seen.add(p.id))
    .slice(0, 10);
}

router.use(tokenCors);

/**
 * Personalized picks for the signed-in customer, from storefront browsing synced through the
 * App Proxy plus the purchase history the extension sends along.
 */
router.post('/recommendations', async (req, res) => {
  let auth;
  try {
    auth = verifySessionToken(req.headers.authorization);
  } catch (error) {
    console.error('[account/recommendations]', error);
    return res.status(500).json({ error: 'Server not configured' });
  }
  if (!auth) return res.status(401).json({ error: 'Invalid session token' });
  if (!auth.customerId) return res.status(403).json({ error: 'Customer not identified' });

  const maxProducts = Math.min(Math.max(parseInt(req.body?.maxProducts, 10) || 8, 1), 12);
  const locale = str(req.body?.locale, 10).toLowerCase().split('-')[0];
  const language = LANGUAGES[/** @type {keyof typeof LANGUAGES} */ (locale)] || 'English';
  const purchased = sanitizePurchased(req.body);
  const customerKey = `${auth.shop}:${auth.customerId}`;

  try {
    const behavior = await kv.get(`behavior:${customerKey}`).catch(() => null);
    const signals = topSignals(behavior, 5);
    const hasSignals =
      signals.searches.length + signals.collections.length + signals.products.length + purchased.length > 0;
    if (!hasSignals) return res.json({ headline: '', subheading: '', items: [], ai: false });

    const signature = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          locale,
          maxProducts,
          signals.collections.map((c) => c.key),
          signals.searches.map((s) => s.key),
          signals.products.map((p) => p.key),
          signals.filters.map((f) => f.key),
          purchased.map((p) => p.id),
        ])
      )
      .digest('hex');

    const cached = await kv.get(`reco:${customerKey}`).catch(() => null);
    if (cached?.signature === signature) return res.json({ ...cached.result, cached: true });

    const candidates = await fetchCandidates(auth.shop, signals, purchased);
    if (candidates.length === 0) return res.json({ headline: '', subheading: '', items: [], ai: false });

    const byId = new Map(candidates.map((c) => [c.id, c]));
    let result;
    try {
      const ai = await recommend({
        model: '',
        language,
        shopName: str(req.body?.shopName, 60) || 'KAPITALL',
        currency: str(req.body?.currency, 5) || 'IDR',
        maxProducts,
        interests: {
          searches: signals.searches.map((s) => ({ term: s.term, score: s.score })),
          collections: signals.collections.map((c) => ({ name: c.title || c.handle, score: c.score })),
          viewed_products: signals.products.map((p) => ({ title: p.title, type: p.type, vendor: p.vendor, score: p.score })),
          filters: signals.filters.map((f) => ({ filter: f.label, score: f.score })),
          purchased_products: purchased.map((p) => ({ title: p.title, type: p.type, vendor: p.vendor })),
        },
        candidates: candidates.map(({ unlisted, handle, ...candidate }) => candidate),
      });
      result = { headline: ai.headline, subheading: ai.subheading, items: ai.items, ai: true };
    } catch (error) {
      console.warn('[account/recommendations] AI failed, using fallback.', error);
      result = { headline: '', subheading: '', items: [], ai: false };
    }

    // Top up with the remaining candidates when the AI returns fewer products than requested.
    const used = new Set(result.items.map((/** @type {any} */ item) => item.id));
    for (const candidate of candidates) {
      if (result.items.length >= maxProducts) break;
      if (!used.has(candidate.id)) result.items.push({ id: candidate.id, reason: '' });
    }
    result.items = result.items.map((/** @type {any} */ item) => ({
      id: item.id,
      handle: byId.get(item.id)?.handle || '',
      reason: item.reason,
    }));

    await kv.set(`reco:${customerKey}`, { signature, result }, RECO_TTL_S).catch((error) => {
      console.warn('[account/recommendations] cache write failed', error);
    });
    res.json(result);
  } catch (error) {
    console.error('[account/recommendations]', error);
    res.status(502).json({ error: 'Recommendation failed' });
  }
});

module.exports = router;
