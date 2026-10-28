const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const webhookRoutes = require('./routes/webhook');
const recommendationRoutes = require('./routes/recommendations');
const proxyRoutes = require('./routes/proxy');
const accountRoutes = require('./routes/account');
const { cors } = require('./lib/cors');

const app = express();
const port = process.env.PORT || 3000;


app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '100kb' }));

// Routes
app.get("/", (req, res) => {
  res.send("kptllin Aja Proxy API running 🚀");
});

// Use the webhook routes
app.use('/api/webhook', webhookRoutes);
app.use('/api/recommendations', cors, recommendationRoutes);
// Storefront → Shopify App Proxy (/apps/kptll-reco/*) → here. Signed by Shopify, no CORS needed.
app.use('/api/proxy', proxyRoutes);
// Customer account UI extension, authenticated with a bearer session token.
app.use('/api/account', accountRoutes);

// Vercel imports the exported app; only listen when run directly (npm run dev / start).
if (require.main === module) {
  app.listen(port, () => {
    console.log(`EXPRESS API IS RUNNING ON PORT ${port}`)
  })
}

module.exports = app;
