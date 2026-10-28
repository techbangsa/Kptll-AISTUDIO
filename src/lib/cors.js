// Origins allowed to call the API. Add the live storefront domain via ALLOWED_ORIGINS
// (comma separated), e.g. ALLOWED_ORIGINS=https://shop.example.com
const DEFAULT_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.myshopify\.com$/,
  /^https:\/\/[a-z0-9-]+\.shopifypreview\.com$/,
  /^https:\/\/(www\.)?kptll\.com$/,
  /^https:\/\/([a-z0-9-]+\.)*kapitall[a-z0-9-]*(\.[a-z]+)+$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

/**
 * @param {string | undefined} origin
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;

  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return extra.includes(origin) || DEFAULT_PATTERNS.some((pattern) => pattern.test(origin));
}

/** @type {import('express').RequestHandler} */
function cors(req, res, next) {
  const origin = req.headers.origin;

  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = { cors };
