// Server-side port of the candidate collection in the theme's assets/ai-personalized-recommendations.js.
// Uses the Storefront API (tokenless, or with SHOPIFY_STOREFRONT_TOKEN when set): unlike the
// storefront's /search/suggest.json and /products.json endpoints, it isn't bot-blocked for
// requests coming from server IPs such as Vercel's.

const API_VERSION = '2026-10';
const MAX_CANDIDATES = 60;
const TIMEOUT_MS = 6000;

const FIELDS = `fragment CandidateFields on Product {
  id
  handle
  title
  vendor
  productType
  tags
  availableForSale
  onlineStoreUrl
  featuredImage {
    url(transform: { maxWidth: 480, maxHeight: 480 })
  }
  priceRange {
    minVariantPrice {
      amount
    }
  }
  compareAtPriceRange {
    minVariantPrice {
      amount
    }
  }
}`;

const SEARCH_QUERY = `${FIELDS}
query CandidateSearch($query: String!) {
  search(query: $query, first: 10, types: PRODUCT, unavailableProducts: HIDE) {
    nodes {
      ... on Product {
        ...CandidateFields
      }
    }
  }
}`;

const COLLECTION_QUERY = `${FIELDS}
query CandidateCollection($handle: String!) {
  collection(handle: $handle) {
    products(first: 30) {
      nodes {
        ...CandidateFields
      }
    }
  }
}`;

const RELATED_QUERY = `${FIELDS}
query CandidateRelated($productId: ID!) {
  productRecommendations(productId: $productId, intent: RELATED) {
    ...CandidateFields
  }
}`;

/**
 * @typedef {{ id: string, handle: string, title: string, vendor: string, type: string, price: number, compare_at: number, image: string, url: string, tags: string[], found_via: string, unlisted: boolean }} Candidate
 */

/**
 * @param {any} product Storefront API product
 * @param {string} foundVia
 * @returns {Candidate}
 */
function toCandidate(product, foundVia) {
  const tags = Array.isArray(product.tags) ? product.tags : [];
  return {
    id: String(product.id).split('/').pop() || '',
    handle: String(product.handle || ''),
    title: String(product.title || ''),
    vendor: product.vendor || '',
    type: product.productType || '',
    price: Number(product.priceRange?.minVariantPrice?.amount) || 0,
    compare_at: Number(product.compareAtPriceRange?.minVariantPrice?.amount) || 0,
    image: product.featuredImage?.url || '',
    url: product.onlineStoreUrl || '',
    tags: tags.slice(0, 5),
    found_via: foundVia,
    unlisted: tags.some((/** @type {string} */ tag) => String(tag).toLowerCase() === 'unlisted'),
  };
}

/**
 * @param {string} shop myshopify domain
 */
function storefront(shop) {
  /**
   * @param {string} query
   * @param {Record<string, unknown>} variables
   */
  async function gql(query, variables) {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.SHOPIFY_STOREFRONT_TOKEN) {
      headers['X-Shopify-Storefront-Access-Token'] = process.env.SHOPIFY_STOREFRONT_TOKEN;
    }

    const response = await fetch(`https://${shop}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Storefront API ${response.status}: ${(await response.text()).slice(0, 120)}`);

    const json = await response.json();
    if (json.errors?.length) throw new Error(`Storefront API: ${json.errors[0].message}`);
    return json.data;
  }

  /**
   * @param {any[] | undefined} products
   * @param {string} foundVia
   */
  const available = (products, foundVia) =>
    (products || []).filter((p) => p?.availableForSale).map((p) => toCandidate(p, foundVia));

  return {
    /** @param {string} term */
    async search(term) {
      const data = await gql(SEARCH_QUERY, { query: term });
      return available(data?.search?.nodes, `search "${term}"`);
    },

    /**
     * @param {string} handle
     * @param {string} title
     */
    async collection(handle, title) {
      const data = await gql(COLLECTION_QUERY, { handle });
      return available(data?.collection?.products?.nodes, `collection "${title || handle}"`);
    },

    /**
     * @param {string} productId numeric id
     * @param {string} label
     */
    async related(productId, label) {
      const data = await gql(RELATED_QUERY, { productId: `gid://shopify/Product/${productId}` });
      return available(data?.productRecommendations, label).slice(0, 8);
    },
  };
}

/**
 * @param {string} shop
 * @param {ReturnType<typeof import('./signals').topSignals>} signals
 * @param {{ id: string, title: string }[]} purchased
 * @returns {Promise<{ candidates: Candidate[], errors: string[] }>}
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
  /** @type {string[]} */
  const errors = [];

  /** @type {Map<string, Candidate>} */
  const unique = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      errors.push(String(result.reason?.message || result.reason).slice(0, 160));
      continue;
    }
    for (const candidate of result.value) {
      if (!candidate.unlisted && !unique.has(candidate.id)) unique.set(candidate.id, candidate);
    }
  }
  if (errors.length) console.warn('[candidates]', shop, errors);

  // Prefer products the customer has not viewed or bought yet, but keep those as backup.
  const list = [...unique.values()];
  const fresh = list.filter((c) => !seen.has(c.id));
  const known = list.filter((c) => seen.has(c.id));
  return { candidates: [...fresh, ...known].slice(0, MAX_CANDIDATES), errors };
}

module.exports = { fetchCandidates };
