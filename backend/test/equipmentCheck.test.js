const test = require('node:test');
const assert = require('node:assert');

const { missingEquipmentNames } = require('../readiness');

test('missingEquipmentNames returns [] when nothing is required', () => {
  assert.deepStrictEqual(missingEquipmentNames([], ['A']), []);
  assert.deepStrictEqual(missingEquipmentNames(null, []), []);
});

test('missingEquipmentNames returns [] when every required item is recorded', () => {
  assert.deepStrictEqual(missingEquipmentNames(['A', 'B'], ['B', 'A']), []);
});

test('missingEquipmentNames lists the unanswered required items, sorted', () => {
  assert.deepStrictEqual(missingEquipmentNames(['B', 'A', 'C'], ['A']), ['B', 'C']);
});

test('missingEquipmentNames ignores recorded names that are not required', () => {
  assert.deepStrictEqual(missingEquipmentNames(['A'], ['A', 'Z']), []);
  assert.deepStrictEqual(missingEquipmentNames(['A', 'B'], ['Z']), ['A', 'B']);
});
