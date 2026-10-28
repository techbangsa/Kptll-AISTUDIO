// Tiny Redis client over the Upstash REST API (Vercel Marketplace → Upstash Redis).
// Falls back to an in-memory map for local dev when no KV is configured.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

/** @type {Map<string, { value: string, expiresAt: number }>} */
const memory = new Map();

/** @param {(string | number)[]} command */
async function exec(command) {
  const response = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`KV ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()).result;
}

/**
 * @param {string} key
 * @returns {Promise<any>}
 */
async function get(key) {
  let raw;
  if (KV_URL && KV_TOKEN) {
    raw = await exec(['GET', key]);
  } else {
    const entry = memory.get(key);
    raw = entry && entry.expiresAt > Date.now() ? entry.value : null;
  }

  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {number} ttlSeconds
 */
async function set(key, value, ttlSeconds) {
  const raw = JSON.stringify(value);
  if (KV_URL && KV_TOKEN) return exec(['SET', key, raw, 'EX', ttlSeconds]);

  memory.set(key, { value: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
  if (memory.size > 1000) memory.delete(memory.keys().next().value);
}

/** @param {string} key */
async function del(key) {
  if (KV_URL && KV_TOKEN) return exec(['DEL', key]);
  memory.delete(key);
}

module.exports = { get, set, del };
