// Server-side copy of the scoring in the theme's assets/customer-behavior.js, so signals synced
// from the storefront rank the same way here.

const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 30 * DAY;
const HALF_LIFE = 7 * DAY;

const LIMITS = { collections: 12, searches: 12, products: 20, filters: 15 };
const LISTS = /** @type {const} */ (['collections', 'searches', 'products', 'filters']);

/**
 * @typedef {{ key: string, count: number, lastAt: number, [field: string]: any }} Entry
 * @typedef {{ collections: Entry[], searches: Entry[], products: Entry[], filters: Entry[] }} Behavior
 */

/** @returns {Behavior} */
function empty() {
  return { collections: [], searches: [], products: [], filters: [] };
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function str(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * @param {Entry} entry
 * @param {number} now
 */
function score(entry, now) {
  return entry.count * Math.pow(0.5, (now - entry.lastAt) / HALF_LIFE);
}

/**
 * Whitelists a behavior payload coming from the storefront (localStorage JSON).
 * @param {any} body
 * @returns {Behavior}
 */
function sanitizeBehavior(body) {
  const now = Date.now();
  const data = empty();

  /** @param {any} raw */
  const base = (raw) => ({
    count: Math.min(Math.max(parseInt(raw?.count, 10) || 1, 1), 999),
    lastAt: Math.min(Number(raw?.lastAt) || 0, now),
  });

  /** @param {any[]} list @param {(raw: any) => Entry | null} map */
  const take = (list, map) =>
    (Array.isArray(list) ? list.slice(0, 50) : []).map(map).filter((e) => e && now - e.lastAt < MAX_AGE);

  data.collections = take(body?.collections, (raw) => {
    const handle = str(raw?.handle || raw?.key, 120);
    return handle ? { key: handle, handle, title: str(raw?.title, 120), ...base(raw) } : null;
  });
  data.searches = take(body?.searches, (raw) => {
    const term = str(raw?.term || raw?.key, 60).toLowerCase();
    return term ? { key: term, term, ...base(raw) } : null;
  });
  data.products = take(body?.products, (raw) => {
    const id = str(raw?.id || raw?.key, 20);
    if (!/^\d+$/.test(id)) return null;
    return {
      key: id,
      id,
      handle: str(raw?.handle, 120),
      title: str(raw?.title, 150),
      type: str(raw?.type, 60),
      vendor: str(raw?.vendor, 60),
      ...base(raw),
    };
  });
  data.filters = take(body?.filters, (raw) => {
    const label = str(raw?.label || raw?.key, 80);
    return label ? { key: label, label, ...base(raw) } : null;
  });

  return data;
}

/**
 * Merges two behavior snapshots (e.g. two devices). Per key the higher count and latest
 * timestamp win, then each list is trimmed to its limit by score.
 * @param {Behavior | null} stored
 * @param {Behavior} incoming
 * @returns {Behavior}
 */
function mergeBehavior(stored, incoming) {
  const now = Date.now();
  const result = empty();

  for (const list of LISTS) {
    /** @type {Map<string, Entry>} */
    const byKey = new Map();
    for (const entry of [...(stored?.[list] || []), ...incoming[list]]) {
      if (now - entry.lastAt >= MAX_AGE) continue;
      const existing = byKey.get(entry.key);
      byKey.set(
        entry.key,
        existing
          ? {
              ...existing,
              ...(entry.lastAt >= existing.lastAt ? entry : {}),
              count: Math.max(existing.count, entry.count),
              lastAt: Math.max(existing.lastAt, entry.lastAt),
            }
          : entry
      );
    }
    result[list] = [...byKey.values()].sort((a, b) => score(b, now) - score(a, now)).slice(0, LIMITS[list]);
  }

  return result;
}

/**
 * Strongest signals per list, highest score first.
 * @param {Behavior | null} data
 * @param {number} [limit=5]
 */
function topSignals(data, limit = 5) {
  const now = Date.now();
  /** @param {Entry[] | undefined} list */
  const top = (list) =>
    [...(list || [])]
      .filter((entry) => now - entry.lastAt < MAX_AGE)
      .sort((a, b) => score(b, now) - score(a, now))
      .slice(0, limit)
      .map((entry) => ({ ...entry, score: Math.round(score(entry, now) * 100) / 100 }));

  return {
    collections: top(data?.collections),
    searches: top(data?.searches),
    products: top(data?.products),
    filters: top(data?.filters),
  };
}

module.exports = { sanitizeBehavior, mergeBehavior, topSignals };
