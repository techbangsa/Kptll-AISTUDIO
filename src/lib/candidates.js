// Server-side port of the candidate collection in the theme's assets/ai-personalized-recommendations.js.
// Uses the storefront's public JSON endpoints, so no API token is needed.

const MAX_CANDIDATES = 60;
const TIMEOUT_MS = 5000;

/**
 * @typedef {{ id: string, handle: string, title: string, vendor: string, type: string, price: number, compare_at: number, image: string, tags: string[], found_via: string, unlisted: boolean }} Candidate
 */

/** @param {unknown} tags */
function tagList(tags) {
  return (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map((tag) => String(tag).trim())
    .filter(Boolean);
}

/** @param {unknown} price */
function normalizePrice(price) {
  // Recommendations API returns cents as integers; products.json / suggest.json return strings in major units.
  if (typeof price === 'number') return price / 100;
  return Number.parseFloat(String(price || '0')) || 0;
}

/** @param {any} product */
function imageOf(product) {
  const raw =
    product.featured_image?.url ||
    (typeof product.featured_image === 'string' ? product.featured_image : '') ||
    product.image ||
    product.images?.[0]?.src ||
    (typeof product.images?.[0] === 'string' ? product.images[0] : '') ||
    '';
  return String(raw).replace(/^\/\//, 'https://');
}

/**
 * @param {any} product
 * @param {unknown} price
 * @param {string} foundVia
 * @param {unknown} [compareAt]
 * @returns {Candidate}
 */
function toCandidate(product, price, foundVia, compareAt = product.compare_at_price) {
  const tags = tagList(product.tags);
  return {
    id: String(product.id),
    handle: String(product.handle || ''),
    title: String(product.title || ''),
    vendor: product.vendor || '',
    type: product.product_type || product.type || '',
    price: normalizePrice(price),
    compare_at: normalizePrice(compareAt),
    image: imageOf(product),
    tags: tags.slice(0, 5),
    found_via: foundVia,
    unlisted: tags.some((tag) => tag.toLowerCase() === 'unlisted'),
  };
}

/**
 * @param {string} shop myshopify domain
 */
function storefront(shop) {
  const base = `https://${shop}`;

  /** @param {string} path */
  async function json(path) {
    const response = await fetch(`${base}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${response.status} ${path}`);
    return response.json();
  }

  return {
    /** @param {string} term */
    async search(term) {
      const params = new URLSearchParams({
        q: term,
        'resources[type]': 'product',
        'resources[limit]': '10',
        'resources[options][unavailable_products]': 'hide',
      });
      const data = await json(`/search/suggest.json?${params}`);
      return (data?.resources?.results?.products || [])
        .filter((/** @type {any} */ p) => p.available !== false)
        .map((/** @type {any} */ p) => toCandidate(p, p.price, `search "${term}"`));
    },

    /**
     * @param {string} handle
     * @param {string} title
     */
    async collection(handle, title) {
      const data = await json(`/collections/${encodeURIComponent(handle)}/products.json?limit=30`);
      return (data?.products || [])
        .filter((/** @type {any} */ p) => p.variants?.some((/** @type {any} */ v) => v.available))
        .map((/** @type {any} */ p) => {
          const variant = p.variants.find((/** @type {any} */ v) => v.available) || p.variants[0];
          return toCandidate(p, variant?.price, `collection "${title || handle}"`, variant?.compare_at_price);
        });
    },

    /**
     * @param {string} productId
     * @param {string} label
     */
    async related(productId, label) {
      const params = new URLSearchParams({ product_id: productId, limit: '8', intent: 'related' });
      const data = await json(`/recommendations/products.json?${params}`);
      return (data?.products || [])
        .filter((/** @type {any} */ p) => p.available !== false)
        .map((/** @type {any} */ p) => toCandidate(p, p.price, label));
    },
  };
}

/**
 * @param {string} shop
 * @param {ReturnType<typeof import('./signals').topSignals>} signals
 * @param {{ id: string, title: string }[]} purchased
 * @returns {Promise<Candidate[]>}
 */
async function fetchCandidates(shop, signals, purchased) {
  const api = storefront(shop);
  /** @type {Promise<Candidate[]>[]} */
  const requests = [];

  for (const search of signals.searches.slice(0, 2)) requests.push(api.search(search.term));
  for (const collection of signals.collections.slice(0, 2)) {
    requests.push(api.collection(collection.handle, collection.title));
  }
  for (const product of signals.products.slice(0, 2)) {
    requests.push(api.related(product.id, `similar to "${product.title}"`));
  }
  for (const product of purchased.slice(0, 3)) {
    requests.push(api.related(product.id, `goes well with purchased "${product.title}"`));
  }

  const results = await Promise.allSettled(requests);
  const seen = new Set([...signals.products.map((p) => p.id), ...purchased.map((p) => p.id)]);

  /** @type {Map<string, Candidate>} */
  const unique = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.warn('[candidates]', result.reason?.message || result.reason);
      continue;
    }
    for (const candidate of result.value) {
      if (!candidate.unlisted && !unique.has(candidate.id)) unique.set(candidate.id, candidate);
    }
  }

  // Prefer products the customer has not viewed or bought yet, but keep those as backup.
  const list = [...unique.values()];
  const fresh = list.filter((c) => !seen.has(c.id));
  const known = list.filter((c) => seen.has(c.id));
  return [...fresh, ...known].slice(0, MAX_CANDIDATES);
}

module.exports = { fetchCandidates };
