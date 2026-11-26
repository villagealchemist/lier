import test from 'node:test';
import assert from 'node:assert/strict';
import { cents, calculateScenario } from '../public/app.mjs';

test('money inputs retain cent precision and reject ambiguous or unsupported amounts', () => {
  assert.equal(cents('0.29'), 29);
  assert.equal(cents('12.5'), 1250);
  assert.equal(cents('0'), 0);
  for (const input of ['-1', '1.001', '1e3', 'Infinity', '1,000.00', '', '10000000.01']) assert.equal(cents(input), null);
});

test('break-even subtracts variable costs and rounds up to whole paid tickets', () => {
  const result = calculateScenario({ fee: '900', other: '100', price: '30', variable: '3', capacity: '100' });
  assert.deepEqual(result, { tickets: 38, fixed: 100000, contribution: 2700, capacity: 100, atCapacity: 170000, share: 0.38 });
});

test('zero fixed costs need zero tickets and do not become missing costs', () => {
  const result = calculateScenario({ fee: '0', other: '0', price: '10', variable: '1', capacity: '50' });
  assert.equal(result.tickets, 0);
  assert.equal(result.fixed, 0);
  assert.equal(result.atCapacity, 45000);
});

test('insufficient room capacity remains visible instead of clipping the break-even target', () => {
  const result = calculateScenario({ fee: '1000', other: '0', price: '10', variable: '0', capacity: '50' });
  assert.equal(result.tickets, 100);
  assert.equal(result.share, 2);
  assert.equal(result.atCapacity, -50000);
});

test('non-positive contribution and invalid capacity cannot produce a forecast', () => {
  for (const variable of ['10', '12']) assert.ok(calculateScenario({ fee: '10', other: '0', price: '10', variable, capacity: '100' }).error);
  for (const capacity of ['0', '-1', '1.5', 'NaN', '1000001']) assert.ok(calculateScenario({ fee: '10', other: '0', price: '20', variable: '1', capacity }).error);
});

test('cent-boundary ticket revenue is calculated without floating-point money drift', () => {
  const result = calculateScenario({ fee: '0.58', other: '0', price: '0.29', variable: '0', capacity: '10' });
  assert.equal(result.tickets, 2);
  assert.equal(result.atCapacity, 232);
});
