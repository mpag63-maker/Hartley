// Monte Carlo simulation of a gameweek for a 15-man squad, including FPL auto-subs and captaincy.
// Produces worst / base / best case points as percentiles of the simulated distribution.
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda, rnd) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L && k < 30);
  return k - 1;
}

function pct(sorted, q) {
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * @param lineup   output of bestLineup (xi, bench ordered, captain, vice)
 * @param proj     Map(id -> model.project(...) result for the gameweek)
 * @param scoring  model.scoring
 * @param opts     { sims, hitCost, seed, chip: 'bboost'|'3xc'|null }
 */
function simulate(lineup, proj, scoring, team, opts = {}) {
  const sims = opts.sims || 10000;
  const rnd = mulberry32(opts.seed || 12345);
  const hitCost = opts.hitCost || 0;
  const capMult = opts.chip === '3xc' ? 3 : 2;
  const benchBoost = opts.chip === 'bboost';

  const xi = lineup.xi.map((p) => p.id);
  const bench = lineup.bench.map((p) => p.id);
  const all = [...xi, ...bench];
  const posOf = {};
  for (const p of [...lineup.xi, ...lineup.bench]) posOf[p.id] = p.pos;

  const totals = new Float64Array(sims);
  const perPlayer = Object.fromEntries(all.map((id) => [id, new Float64Array(sims)]));
  let capBlank = 0, subsUsed = 0;

  for (let s = 0; s < sims; s++) {
    const conceded = {}; // `${team}:${fixture}` -> goals conceded, shared by team-mates
    const pts = {}, played = {};
    for (const id of all) {
      const pos = posOf[id];
      const pr = proj.get(id);
      let total = 0, any = false;
      for (const fx of pr.fixtures) {
        const m = fx.sim;
        const u = rnd();
        let mins = 0;
        if (u < m.ps) mins = rnd() < m.p60GivenStart ? 88 : 50;
        else if (u < m.ps + m.pSubApp) mins = 20;
        if (!mins) continue;
        any = true;
        const key = team(id) + ':' + fx.id;
        if (conceded[key] == null) conceded[key] = poisson(m.la, rnd);
        const gc = conceded[key];
        let p = mins >= 60 ? 2 : 1;
        const g = poisson((m.gRate * mins) / 90, rnd);
        const a = poisson((m.aRate * mins) / 90, rnd);
        p += g * scoring.goals[pos] + a * scoring.assist;
        const cs = mins >= 60 && gc === 0;
        if (mins >= 60) {
          if (cs) p += scoring.cs[pos];
          if (scoring.gc[pos]) p += scoring.gc[pos] * Math.floor(gc / 2);
          if (pos === 1) p += scoring.saves * Math.floor(poisson(m.savesRate, rnd) / 3);
          if (pos !== 1 && rnd() < m.dcP) p += scoring.dc[pos];
        }
        if (rnd() < (m.yc90 * mins) / 90) p += scoring.yellow;
        if (rnd() < (m.rc90 * mins) / 90) p += scoring.red;
        // Bonus is concentrated on players who return; keep the overall mean equal to the rate.
        const bExp = (m.bonusRate * mins) / 90;
        const pRet = 1 - Math.exp(-((m.gRate + m.aRate) * mins) / 90) * (pos <= 2 ? 1 - Math.exp(-m.la) : 1);
        const returned = g + a > 0 || (pos <= 2 && cs);
        const kLo = 0.25, kHi = (1 - kLo * (1 - pRet)) / Math.max(pRet, 0.12);
        p += Math.min(3, poisson(bExp * (returned ? kHi : kLo), rnd));
        total += p;
      }
      pts[id] = total;
      played[id] = any;
      perPlayer[id][s] = total;
    }

    // Auto-subs
    let counted;
    if (benchBoost) counted = all.slice();
    else {
      counted = xi.slice();
      const used = new Set();
      const count = (arr, pos) => arr.filter((id) => posOf[id] === pos).length;
      for (let i = 0; i < counted.length; i++) {
        const id = counted[i];
        if (played[id]) continue;
        for (const b of bench) {
          if (used.has(b) || !played[b]) continue;
          if ((posOf[id] === 1) !== (posOf[b] === 1)) continue;
          const trial = counted.slice();
          trial[i] = b;
          // The resulting XI must still be a legal formation (3+ DEF, 2+ MID, 1+ FWD).
          if (posOf[b] !== 1 && !(count(trial, 2) >= 3 && count(trial, 3) >= 2 && count(trial, 4) >= 1)) continue;
          counted[i] = b;
          used.add(b);
          subsUsed++;
          break;
        }
      }
    }
    let t = 0;
    for (const id of counted) t += pts[id];
    const cap = lineup.captain.id, vice = lineup.vice && lineup.vice.id;
    if (played[cap]) t += pts[cap] * (capMult - 1);
    else if (vice && played[vice]) { t += pts[vice] * (capMult - 1); capBlank++; }
    else capBlank++;
    totals[s] = t - hitCost;
  }

  const sorted = Array.from(totals).sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sims;
  const lo = Math.floor(sorted[0]), hi = Math.ceil(sorted[sims - 1]);
  const bins = [];
  const width = Math.max(2, Math.ceil((hi - lo + 1) / 30));
  for (let x = lo; x <= hi; x += width) bins.push({ from: x, to: x + width - 1, n: 0 });
  for (const v of sorted) bins[Math.min(bins.length - 1, Math.floor((v - lo) / width))].n++;

  const players = {};
  for (const id of all) {
    const arr = Array.from(perPlayer[id]).sort((a, b) => a - b);
    players[id] = {
      mean: arr.reduce((a, b) => a + b, 0) / sims,
      p10: pct(arr, 0.1), p50: pct(arr, 0.5), p90: pct(arr, 0.9),
      pBlank: arr.filter((v) => v <= 2).length / sims,
      pHaul: arr.filter((v) => v >= 10).length / sims,
    };
  }

  return {
    sims,
    worst: pct(sorted, 0.1),
    base: mean,
    median: pct(sorted, 0.5),
    best: pct(sorted, 0.9),
    p5: pct(sorted, 0.05), p25: pct(sorted, 0.25), p75: pct(sorted, 0.75), p95: pct(sorted, 0.95),
    histogram: bins,
    captainFailRate: capBlank / sims,
    avgAutoSubs: subsUsed / sims,
    players,
  };
}

module.exports = { simulate };
