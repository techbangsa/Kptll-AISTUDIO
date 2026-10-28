const crypto = require('crypto');

const PROXY_MAX_AGE_S = 5 * 60;
const CLOCK_LEEWAY_S = 10;

/**
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function secret() {
  const value = process.env.SHOPIFY_API_SECRET;
  if (!value) throw new Error('SHOPIFY_API_SECRET is not configured');
  return value;
}

/**
 * Verifies a request forwarded by a Shopify App Proxy.
 * Shopify signs every query param (sorted, `key=value`, no separator) with the app secret.
 * @param {Record<string, unknown>} query
 * @returns {{ shop: string, customerId: string | null } | null}
 */
function verifyAppProxy(query) {
  const { signature, ...params } = query || {};
  if (typeof signature !== 'string') return null;

  const message = Object.keys(params)
    .sort()
    .map((key) => {
      const value = params[key];
      return `${key}=${Array.isArray(value) ? value.join(',') : value}`;
    })
    .join('');

  const digest = crypto.createHmac('sha256', secret()).update(message).digest('hex');
  if (!safeEqual(digest, signature)) return null;

  const timestamp = Number(params.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > PROXY_MAX_AGE_S) return null;

  const customerId = String(params.logged_in_customer_id || '');
  return {
    shop: String(params.shop || ''),
    customerId: /^\d+$/.test(customerId) ? customerId : null,
  };
}

/**
 * Verifies a session token issued to a UI extension (HS256 JWT signed with the app secret).
 * @param {string | undefined} authorization `Bearer <token>` header
 * @returns {{ shop: string, customerId: string | null } | null}
 */
function verifySessionToken(authorization) {
  const token = String(authorization || '').replace(/^Bearer\s+/i, '');
  const [header, payload, sig] = token.split('.');
  if (!header || !payload || !sig) return null;

  const expected = crypto.createHmac('sha256', secret()).update(`${header}.${payload}`).digest('base64url');
  if (!safeEqual(expected, sig)) return null;

  let claims;
  try {
    if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') return null;
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }

  const now = Date.now() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_LEEWAY_S < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_LEEWAY_S > now) return null;
  if (process.env.SHOPIFY_API_KEY && claims.aud !== process.env.SHOPIFY_API_KEY) return null;

  const match = /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(String(claims.sub || ''));
  return {
    shop: String(claims.dest || '').replace(/^https?:\/\//, ''),
    customerId: match ? match[1] : null,
  };
}

module.exports = { verifyAppProxy, verifySessionToken };
