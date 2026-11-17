'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bestLineup, lineupValue } = require('../lib/optimizer');
const { simulate } = require('../lib/simulate');
const { expFloorDiv } = require('../lib/model');

const squad = () => {
  const shape = [[1, 2], [2, 5], [3, 5], [4, 3]];
  const out = [];
  let id = 1;
  for (const [pos, n] of shape) for (let i = 0; i < n; i++) out.push({ id: id++, pos, ep: 2 + ((id * 7) % 5), reliability: 0.9 });
  return out;
};

test('bestLineup always yields a legal XI with GK sub first on the bench', () => {
  for (let k = 0; k < 50; k++) {
    const s = squad().map((p) => ({ ...p, ep: Math.random() * 8 }));
    const lu = bestLineup(s);
    const c = (pos) => lu.xi.filter((p) => p.pos === pos).length;
    assert.strictEqual(lu.xi.length, 11);
    assert.strictEqual(c(1), 1);
    assert.ok(c(2) >= 3 && c(3) >= 2 && c(4) >= 1);
    assert.strictEqual(lu.bench[0].pos, 1);
    const benchEp = lu.bench.slice(1).map((p) => p.ep);
    assert.deepStrictEqual(benchEp, benchEp.slice().sort((a, b) => b - a));
    assert.strictEqual(lu.captain.ep, Math.max(...lu.xi.map((p) => p.ep)));
    assert.notStrictEqual(lu.captain.id, lu.vice.id);
  }
});

test('lineupValue matches bestLineup total (plus small bench weight)', () => {
  const s = squad();
  const lu = bestLineup(s);
  const v = lineupValue(s.map((p) => p.ep), s.map((p) => p.pos));
  assert.ok(v >= lu.totalEp && v < lu.totalEp + 3);
});

test('E[floor(X/2)] for Poisson is sensible', () => {
  assert.ok(Math.abs(expFloorDiv(0, 2)) < 1e-12);
  const l = 1.5;
  assert.ok(expFloorDiv(l, 2) > 0.4 && expFloorDiv(l, 2) < l / 2);
});

test('simulation: certain starters, no attacking returns -> 2 pts each, captain doubled', () => {
  const s = squad();
  const lu = bestLineup(s);
  const proj = new Map(s.map((p) => [p.id, { fixtures: [{ id: 1, sim: { ps: 1, p60GivenStart: 1, pSubApp: 0, gRate: 0, aRate: 0, la: 50, bonusRate: 0, savesRate: 0, dcP: 0, yc90: 0, rc90: 0 } }] }]));
  const scoring = { goals: { 1: 10, 2: 6, 3: 5, 4: 4 }, cs: { 1: 4, 2: 4, 3: 1, 4: 0 }, gc: { 1: -1, 2: -1, 3: 0, 4: 0 }, dc: { 1: 0, 2: 2, 3: 2, 4: 2 }, assist: 3, saves: 1, yellow: -1, red: -3 };
  // Huge "la" means GK/DEF concede lots; use team per player so it is deterministic enough to bound.
  const r = simulate(lu, proj, scoring, () => 1, { sims: 500 });
  assert.ok(r.best <= 24, `appearance-only XI cannot exceed 24, got ${r.best}`);
  assert.ok(r.worst <= r.base && r.base <= r.best);
});

test('simulation: non-playing starter is auto-subbed', () => {
  const s = squad();
  const lu = bestLineup(s);
  const missing = lu.xi.find((p) => p.pos === 3 && p.id !== lu.captain.id && p.id !== lu.vice.id);
  const base = { p60GivenStart: 1, pSubApp: 0, gRate: 0, aRate: 0, la: 0, bonusRate: 0, savesRate: 0, dcP: 0, yc90: 0, rc90: 0 };
  const proj = new Map(s.map((p) => [p.id, { fixtures: [{ id: 1, sim: { ...base, ps: p.id === missing.id ? 0 : 1 } }] }]));
  const z = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const scoring = { goals: z, cs: z, gc: z, dc: z, assist: 0, saves: 0, yellow: 0, red: 0 };
  const r = simulate(lu, proj, scoring, () => 1, { sims: 50 });
  assert.strictEqual(r.base, 24); // 11 players x 2 + captain 2
  assert.strictEqual(r.avgAutoSubs, 1);
});
