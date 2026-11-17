// Line-up selection (formation, captain, bench order) and transfer search.
'use strict';

const MIN_BY_POS = { 1: 1, 2: 3, 3: 2, 4: 1 };
const SQUAD_SHAPE = { 1: 2, 2: 5, 3: 5, 4: 3 };

/**
 * Best starting XI for one gameweek. Because a 15-man squad is always 2/5/5/3, the optimal valid
 * XI is: best GK + the positional minimums (3 DEF, 2 MID, 1 FWD) + the best 4 remaining outfielders.
 * @param players [{id, pos, ep, reliability}] reliability (0..1) breaks ties and orders the bench.
 */
function bestLineup(players) {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  const key = (a, b) => b.ep - a.ep || b.reliability - a.reliability;
  for (const p of players) byPos[p.pos].push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort(key);

  const xi = [byPos[1][0]];
  const rest = [];
  for (const pos of [2, 3, 4]) {
    xi.push(...byPos[pos].slice(0, MIN_BY_POS[pos]));
    rest.push(...byPos[pos].slice(MIN_BY_POS[pos]));
  }
  rest.sort(key);
  xi.push(...rest.slice(0, 4));
  const benchOutfield = rest.slice(4); // already ordered best-first
  const bench = [byPos[1][1], ...benchOutfield].filter(Boolean);

  // Captain: highest EP; vice: next highest, preferring nailed-on starters.
  const capOrder = xi.slice().sort((a, b) => b.ep - a.ep || b.reliability - a.reliability);
  const captain = capOrder[0];
  const vice = capOrder.slice(1).sort((a, b) => b.ep * (0.5 + 0.5 * b.reliability) - a.ep * (0.5 + 0.5 * a.reliability))[0];

  const order = { 1: 0, 2: 1, 3: 2, 4: 3 };
  xi.sort((a, b) => order[a.pos] - order[b.pos] || b.ep - a.ep);
  const formation = [2, 3, 4].map((p) => xi.filter((x) => x.pos === p).length).join('-');
  const xiEp = xi.reduce((s, p) => s + p.ep, 0);
  return { xi, bench, captain, vice, formation, xiEp, totalEp: xiEp + (captain ? captain.ep : 0) };
}

/** Fast scalar used inside the transfer search: XI EP + captain EP + a little bench value. */
function lineupValue(eps, poss) {
  // eps/poss: arrays of length 15
  let gk1 = -1e9, gk2 = -1e9;
  const out = { 2: [], 3: [], 4: [] };
  for (let i = 0; i < eps.length; i++) {
    const e = eps[i];
    if (poss[i] === 1) {
      if (e > gk1) { gk2 = gk1; gk1 = e; } else if (e > gk2) gk2 = e;
    } else out[poss[i]].push(e);
  }
  let total = gk1, best = gk1;
  const rest = [];
  for (const pos of [2, 3, 4]) {
    const arr = out[pos].sort((a, b) => b - a);
    for (let i = 0; i < arr.length; i++) {
      if (i < MIN_BY_POS[pos]) { total += arr[i]; if (arr[i] > best) best = arr[i]; }
      else rest.push(arr[i]);
    }
  }
  rest.sort((a, b) => b - a);
  let bench = Math.max(0, gk2) * 0.03;
  for (let i = 0; i < rest.length; i++) {
    if (i < 4) { total += rest[i]; if (rest[i] > best) best = rest[i]; }
    else bench += rest[i] * (i === 4 ? 0.15 : i === 5 ? 0.08 : 0.04);
  }
  return total + best + bench;
}

/**
 * Search single, double and triple transfers.
 * @param ctx { squad:[id], bank, freeTransfers, sellPrice:{id:price}, horizonEp: Map(id -> [ep per gw]),
 *              weights:[w per gw], elements: Map, maxTransfers }
 */
function searchTransfers(ctx) {
  const { squad, bank, freeTransfers, sellPrice, horizonEp, weights, elements } = ctx;
  const H = weights.length;
  const pos = (id) => elements.get(id).element_type;
  const team = (id) => elements.get(id).team;
  const price = (id) => elements.get(id).now_cost;
  const sell = (id) => (sellPrice && sellPrice[id] != null ? sellPrice[id] : price(id));

  const squadSet = new Set(squad);
  const poss = squad.map(pos);

  const scoreOf = (ids) => {
    let s = 0;
    for (let k = 0; k < H; k++) {
      const eps = ids.map((id) => horizonEp.get(id)[k]);
      s += weights[k] * lineupValue(eps, poss);
    }
    return s;
  };
  const nextOf = (ids) => lineupValue(ids.map((id) => horizonEp.get(id)[0]), poss);

  const base = scoreOf(squad);
  const baseNext = nextOf(squad);

  const teamCount = {};
  for (const id of squad) teamCount[team(id)] = (teamCount[team(id)] || 0) + 1;

  const wEp = (id) => horizonEp.get(id).reduce((s, e, k) => s + e * weights[k], 0);

  // Candidate pool per position: best by weighted horizon EP plus best value-for-money picks.
  const pool = { 1: [], 2: [], 3: [], 4: [] };
  const all = [...elements.values()].filter(
    (p) => !squadSet.has(p.id) && p.can_select !== false && p.status !== 'u' && p.status !== 'n' && horizonEp.has(p.id)
  );
  for (const P of [1, 2, 3, 4]) {
    const list = all.filter((p) => p.element_type === P).map((p) => ({ id: p.id, w: wEp(p.id), cost: p.now_cost }));
    const byEp = list.slice().sort((a, b) => b.w - a.w).slice(0, P === 1 ? 8 : 22);
    const byValue = list.filter((x) => x.w > 0.5).sort((a, b) => b.w / b.cost - a.w / a.cost).slice(0, P === 1 ? 4 : 8);
    const seen = new Set();
    for (const x of [...byEp, ...byValue]) if (!seen.has(x.id)) { seen.add(x.id); pool[P].push(x.id); }
  }

  const feasible = (outs, ins) => {
    let money = bank;
    const tc = { ...teamCount };
    for (const o of outs) { money += sell(o); tc[team(o)]--; }
    for (const i of ins) { money -= price(i); tc[team(i)] = (tc[team(i)] || 0) + 1; }
    if (money < 0) return false;
    for (const i of ins) if (tc[team(i)] > 3) return false;
    return true;
  };
  const apply = (outs, ins) => squad.map((id) => { const j = outs.indexOf(id); return j >= 0 ? ins[j] : id; });
  const bankAfter = (outs, ins) => bank + outs.reduce((s, o) => s + sell(o), 0) - ins.reduce((s, i) => s + price(i), 0);

  const mk = (outs, ins) => {
    const ids = apply(outs, ins);
    return { outs, ins, gain: scoreOf(ids) - base, gainNext: nextOf(ids) - baseNext, bankAfter: bankAfter(outs, ins) };
  };

  // Singles
  const singles = [];
  for (const o of squad) {
    for (const i of pool[pos(o)]) {
      if (!feasible([o], [i])) continue;
      singles.push(mk([o], [i]));
    }
  }
  singles.sort((a, b) => b.gain - a.gain);

  // Doubles: every pair of outgoing players x candidate pairs (pruned to each out's best options).
  const maxT = ctx.maxTransfers ?? 3;
  const doubles = [];
  if (maxT >= 2) {
    const topInsFor = {};
    for (const o of squad) {
      topInsFor[o] = pool[pos(o)]
        .map((i) => ({ i, g: wEp(i) - wEp(o) }))
        .sort((a, b) => b.g - a.g)
        .slice(0, 12)
        .map((x) => x.i);
    }
    for (let a = 0; a < squad.length; a++) {
      for (let b = a + 1; b < squad.length; b++) {
        const oa = squad[a], ob = squad[b];
        for (const ia of topInsFor[oa]) {
          for (const ib of topInsFor[ob]) {
            if (ia === ib) continue;
            if (!feasible([oa, ob], [ia, ib])) continue;
            const ids = apply([oa, ob], [ia, ib]);
            const gain = scoreOf(ids) - base;
            if (doubles.length < 60 || gain > doubles[doubles.length - 1].gain) {
              doubles.push({ outs: [oa, ob], ins: [ia, ib], gain });
              doubles.sort((x, y) => y.gain - x.gain);
              if (doubles.length > 60) doubles.pop();
            }
          }
        }
      }
    }
    for (const d of doubles) Object.assign(d, mk(d.outs, d.ins));
  }

  // Triples: extend the best doubles greedily with a third move.
  const triples = [];
  if (maxT >= 3) {
    for (const d of doubles.slice(0, 15)) {
      for (const o of squad) {
        if (d.outs.includes(o)) continue;
        for (const i of pool[pos(o)].slice(0, 14)) {
          if (d.ins.includes(i)) continue;
          const outs = [...d.outs, o], ins = [...d.ins, i];
          if (!feasible(outs, ins)) continue;
          triples.push(mk(outs, ins));
        }
      }
    }
    triples.sort((a, b) => b.gain - a.gain);
  }

  const hit = (n) => 4 * Math.max(0, n - freeTransfers);
  // Using a free transfer forfeits the option to roll it (worth roughly a point and a half later on),
  // unless you're already at the 5-transfer cap.
  const rollValue = freeTransfers >= 5 ? 0 : 1.5;
  const options = [{ n: 0, outs: [], ins: [], gain: 0, gainNext: 0, hit: 0, net: 0, adjusted: rollValue, bankAfter: bank }];
  const bestOf = { 1: singles[0], 2: doubles[0], 3: triples[0] };
  for (const n of [1, 2, 3]) {
    const b = bestOf[n];
    if (!b) continue;
    const h = hit(n);
    options.push({ n, ...b, hit: h, net: b.gain - h, adjusted: b.gain - h });
  }
  let rec = options[0];
  for (const o of options) if (o.adjusted > rec.adjusted + 0.25) rec = o;

  return {
    base, baseNext,
    options,
    recommended: options.indexOf(rec),
    singles: singles.slice(0, 12),
    doubles: doubles.slice(0, 6),
    triples: triples.slice(0, 4),
  };
}

module.exports = { bestLineup, lineupValue, searchTransfers, SQUAD_SHAPE };
