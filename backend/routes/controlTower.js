'use strict';

const express = require('express');
const { db } = require('../util');
const { can } = require('../auth');
const { taskVisible } = require('../authority');
const tower = require('../controlTower');

const router = express.Router();

router.get('/control-tower', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const days = Number(req.query.days) > 0 ? Number(req.query.days) : 30;
  const tasks = db.prepare('SELECT * FROM task').all().filter((t) => taskVisible(req.user, t));
  const payload = tower.build(tasks, { days });
  const section = typeof req.query.section === 'string' ? req.query.section : '';
  if (section && payload[section] !== undefined) return res.json({ generated_at: payload.generated_at, window_days: payload.window_days, [section]: payload[section] });
  res.json(payload);
});

module.exports = router;
