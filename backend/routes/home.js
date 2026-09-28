const express = require('express');
const { buildHome, bucketDetail } = require('../homeFeed');

const router = express.Router();

router.get('/home', (req, res) => {
  res.json(buildHome(req.user));
});

// The full task set for one Home card, with grouping facets. Used when a card
// is expanded so the count and its sub-categories match the card exactly.
router.get('/home/bucket/:key', (req, res) => {
  const detail = bucketDetail(req.user, req.params.key);
  if (!detail) return res.status(404).json({ error: 'Unknown bucket' });
  res.json(detail);
});

module.exports = router;
