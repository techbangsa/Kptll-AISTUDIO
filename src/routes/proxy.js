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
  if (!auth.customerId) return res.status(204).end();

  try {
    const key = `behavior:${auth.shop}:${auth.customerId}`;
    const stored = await kv.get(key);
    await kv.set(key, mergeBehavior(stored, sanitizeBehavior(req.body)), BEHAVIOR_TTL_S);
    res.status(204).end();
  } catch (error) {
    console.error('[proxy/behavior]', error);
    res.status(500).json({ error: 'Could not save behavior' });
  }
});

module.exports = router;
