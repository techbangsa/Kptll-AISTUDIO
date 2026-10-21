const crypto = require('crypto');
const express = require('express');
const { recommend } = require('../lib/gemini');

const router = express.Router();

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;

// In-memory only: survives while the serverless instance is warm. Good enough to absorb repeats.
/** @type {Map<string, { at: number, result: object }>} */
const cache = new Map();
/** @type {Map<string, { start: number, count: number }>} */
const rateLimits = new Map();

/**
 * @param {unknown} value
 * @param {number} max
 */
function str(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * @param {unknown} value
 */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * @param {unknown} list
 * @param {number} max
 */
function arr(list, max) {
  return Array.isArray(list) ? list.slice(0, max) : [];
}

/**
 * Whitelists and trims the payload so the endpoint can't be used as a generic prompt proxy.
 * @param {any} body
 */
function sanitize(body) {
  const interests = body?.interests || {};

  const candidates = arr(body?.candidates, 60)
    .map((c) => ({
      id: str(c?.id, 20),
      title: str(c?.title, 150),
      vendor: str(c?.vendor, 60),
      type: str(c?.type, 60),
      price: num(c?.price),
      tags: arr(c?.tags, 5).map((tag) => str(tag, 40)),
      found_via: str(c?.found_via, 80),
    }))
    .filter((c) => /^\d+$/.test(c.id) && c.title);

  return {
    model: str(body?.model, 40),
    language: str(body?.language, 30) || 'Bahasa Indonesia',
    shopName: str(body?.shopName, 60) || 'KAPITALL',
    currency: str(body?.currency, 5) || 'IDR',
    maxProducts: Math.min(Math.max(parseInt(body?.maxProducts, 10) || 4, 1), 12),
    interests: {
      searches: arr(interests.searches, 5).map((s) => ({ term: str(s?.term, 60), score: num(s?.score) })),
      collections: arr(interests.collections, 5).map((c) => ({ name: str(c?.name, 80), score: num(c?.score) })),
      viewed_products: arr(interests.viewed_products, 5).map((p) => ({
        title: str(p?.title, 150),
        type: str(p?.type, 60),
        vendor: str(p?.vendor, 60),
        score: num(p?.score),
      })),
      filters: arr(interests.filters, 5).map((f) => ({ filter: str(f?.filter, 80), score: num(f?.score) })),
    },
    candidates,
  };
}

/**
 * @param {import('express').Request} req
 */
function isRateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rateLimits.set(ip, { start: now, count: 1 });
    if (rateLimits.size > 5000) rateLimits.clear();
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_MAX;
}

router.get('/', (req, res) => {
  res.json({ status: 'ok', configured: Boolean(process.env.GEMINI_API_KEY) });
});

router.post('/', async (req, res) => {
  const input = sanitize(req.body);
  if (input.candidates.length === 0) {
    return res.status(400).json({ error: 'No valid candidates' });
  }

  const key = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.json({ ...cached.result, cached: true });
  }

  if (isRateLimited(req)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const result = await recommend(input);

    cache.set(key, { at: Date.now(), result });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);

    res.json(result);
  } catch (error) {
    console.error('[recommendations]', error);
    res.status(502).json({ error: 'AI recommendation failed' });
  }
});

module.exports = router;
