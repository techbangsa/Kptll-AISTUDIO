const express = require('express');
const kv = require('../lib/kv');
const { verifyAppProxy } = require('../lib/shopify-auth');
const { sanitizeBehavior, mergeBehavior } = require('../lib/signals');

const router = express.Router();

const BEHAVIOR_TTL_S = 30 * 24 * 60 * 60;

/**
 * Storefront → App Proxy (/apps/kptll-reco/behavior) → here.
 * Shopify signs the request and adds `logged_in_customer_id`, so the customer id can be trusted.
 */
router.post('/behavior', async (req, res) => {
  const auth = verifyAppProxy(req.query);
  if (!auth) return res.status(401).json({ error: 'Invalid signature' });
  // Guest (no storefront customer session): nothing to store.
  if (!auth.customerId) return res.status(200).json({ stored: false, reason: 'guest' });

  try {
    // Customer ids are unique across Shopify, so the key doesn't depend on which shop domain
    // the proxy or the session token reports.
    const key = `behavior:${auth.customerId}`;
    const stored = await kv.get(key);
    const merged = mergeBehavior(stored, sanitizeBehavior(req.body));
    await kv.set(key, { ...merged, shop: auth.shop || stored?.shop || '' }, BEHAVIOR_TTL_S);
    res.status(200).json({ stored: true });
  } catch (error) {
    console.error('[proxy/behavior]', error);
    res.status(500).json({ error: 'Could not save behavior' });
  }
});

module.exports = router;
