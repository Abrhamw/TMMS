'use strict';

const express = require('express');
const { db } = require('../util');
const { can, isGlobal } = require('../auth');
const { taskVisible } = require('../authority');
const tower = require('../controlTower');

const router = express.Router();

router.get('/control-tower', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: "Forbidden: requires 'task:read'" });
  const days = Number(req.query.days) > 0 ? Number(req.query.days) : 30;
  // Coarse visibility prefilter: every non-global role is bounded to its own
  // region, so scan only that slice and apply the exact scope rule in JS.
  const where = [];
  const params = [];
  if (!isGlobal(req.user) && req.user.region_id != null) {
    where.push('region_id = ?');
    params.push(Number(req.user.region_id));
  }
  const tasks = db.prepare(`SELECT * FROM task${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`)
    .all(...params)
    .filter((t) => taskVisible(req.user, t));
  const payload = tower.build(tasks, { days });
  const section = typeof req.query.section === 'string' ? req.query.section : '';
  if (section && payload[section] !== undefined) return res.json({ generated_at: payload.generated_at, window_days: payload.window_days, [section]: payload[section] });
  res.json(payload);
});

module.exports = router;
