const express = require('express');
const { list } = require('../util');
const { can } = require('../auth');
const { readCrewIds } = require('../authority');
const { crewPerformanceRows, personPerformanceRows, crewRosterPersonIds } = require('../readiness');

const router = express.Router();

router.get('/performance', (req, res) => {
  if (!can(req, 'report:write')) return res.status(403).json({ error: 'Forbidden: requires report:write' });
  const scope = req.query.scope === 'person' ? 'person' : 'crew';
  const { status, date_from, date_to } = req.query;
  // Crew universe follows the caller's read scope: a region manager sees every
  // crew in the region, a department manager their own crews, admin all.
  const visibleCrewIds = readCrewIds(req.user);
  const crews = list('crew').filter((c) => visibleCrewIds.has(c.id));
  const crewIds = new Set(crews.map((c) => c.id));
  let tasks = list('task').filter((t) => t.crew_id != null && crewIds.has(t.crew_id));
  if (status) tasks = tasks.filter((t) => t.status === status);
  // Scope by the date the work actually happened (completion, then start),
  // falling back to creation for work that has not begun — not merely when the
  // task row was created.
  const activityDate = (t) => t.actual_end || t.actual_start || t.created_at;
  if (date_from) tasks = tasks.filter((t) => activityDate(t) >= date_from);
  if (date_to) tasks = tasks.filter((t) => activityDate(t) <= date_to);

  const rows = scope === 'crew'
    ? crewPerformanceRows(crews, tasks)
    : personPerformanceRows(tasks, crewRosterPersonIds(crews));
  res.json({ scope, rows });
});

module.exports = router;
