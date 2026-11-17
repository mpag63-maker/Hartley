// Orchestrates model -> transfer search -> line-up -> simulation -> tips.
'use strict';

const fpl = require('./fpl');
const { buildModel } = require('./model');
const { bestLineup, searchTransfers, SQUAD_SHAPE } = require('./optimizer');
const { simulate } = require('./simulate');

let modelCache = { at: 0, model: null, promise: null };
async function getModel() {
  if (modelCache.model && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.model;
  if (!modelCache.promise) {
    modelCache.promise = fpl
      .loadSeason()
      .then((s) => {
        modelCache = { at: Date.now(), model: buildModel(s), promise: null };
        return modelCache.model;
      })
      .catch((e) => {
        modelCache.promise = null;
        throw e;
      });
  }
  return modelCache.promise;
}

const HORIZON_WEIGHTS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

function playerSummary(m, p) {
  return {
    id: p.id,
    name: p.web_name,
    fullName: `${p.first_name} ${p.second_name}`,
    team: m.teams.get(p.team).short_name,
    teamId: p.team,
    pos: p.element_type,
    posName: m.POS[p.element_type],
    price: p.now_cost / 10,
    status: p.status,
    chance: p.chance_of_playing_next_round,
    news: p.news,
    selectedBy: Number(p.selected_by_percent),
    form: Number(p.form),
    totalPoints: p.total_points,
    code: p.code,
  };
}

async function playersList() {
  const m = await getModel();
  const list = [...m.elements.values()].map((p) => ({ ...playerSummary(m, p), ep: round(m.project(p, m.nextGw).ep, 2) }));
  return {
    gw: m.nextGw,
    deadline: m.nextEvent.deadline_time,
    teams: [...m.teams.values()].map((t) => ({ id: t.id, name: t.name, short: t.short_name })),
    players: list,
  };
}

const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function validateSquad(m, squad) {
  if (!Array.isArray(squad) || squad.length !== 15) throw badRequest('Squad must contain exactly 15 players.');
  const ids = squad.map(Number);
  if (new Set(ids).size !== 15) throw badRequest('Squad contains duplicate players.');
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const clubs = {};
  for (const id of ids) {
    const p = m.elements.get(id);
    if (!p) throw badRequest(`Unknown player id ${id}.`);
    counts[p.element_type]++;
    clubs[p.team] = (clubs[p.team] || 0) + 1;
  }
  for (const k of [1, 2, 3, 4]) {
    if (counts[k] !== SQUAD_SHAPE[k]) {
      throw badRequest(`Squad needs 2 GKP, 5 DEF, 5 MID, 3 FWD (you have ${counts[1]}/${counts[2]}/${counts[3]}/${counts[4]}).`);
    }
  }
  const over = Object.entries(clubs).find(([, n]) => n > 3);
  if (over) throw badRequest(`Max 3 players per club (${m.teams.get(Number(over[0])).short_name} has ${over[1]}).`);
  return ids;
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

async function analyse(body) {
  const m = await getModel();
  const squad = validateSquad(m, body.squad);
  const horizon = Math.min(6, Math.max(1, Number(body.horizon) || 3));
  const weights = HORIZON_WEIGHTS.slice(0, horizon);
  const freeTransfers = Math.min(5, Math.max(0, Number(body.freeTransfers ?? 1)));
  const bank = Math.round(Math.max(0, Number(body.bank ?? 0)) * 10); // £m -> tenths
  const sellPrice = {};
  for (const [id, v] of Object.entries(body.sellPrices || {})) sellPrice[id] = Math.round(Number(v) * 10);
  const chipsAvailable = Array.isArray(body.chipsAvailable) ? body.chipsAvailable : null;

  const gws = [];
  for (let k = 0; k < horizon; k++) if (m.events.find((e) => e.id === m.nextGw + k)) gws.push(m.nextGw + k);

  // Projections for every player across the horizon.
  const projByGw = gws.map(() => new Map());
  const horizonEp = new Map();
  for (const p of m.elements.values()) {
    const eps = gws.map((gw, k) => {
      const pr = m.project(p, gw);
      projByGw[k].set(p.id, pr);
      return pr.ep;
    });
    while (eps.length < weights.length) eps.push(0);
    horizonEp.set(p.id, eps);
  }

  const search = searchTransfers({
    squad, bank, freeTransfers, sellPrice, horizonEp, weights, elements: m.elements, maxTransfers: 3,
  });

  const reliability = (id) => {
    const pp = m.params(m.elements.get(id));
    return pp.pStart * pp.p60GivenStart * m.availability(m.elements.get(id), 0);
  };
  const toLineupPlayers = (ids) =>
    ids.map((id) => ({ id, pos: m.elements.get(id).element_type, ep: projByGw[0].get(id).ep, reliability: reliability(id) }));

  const describeLineup = (ids, hitCost, chip) => {
    const lu = bestLineup(toLineupPlayers(ids));
    const team = (id) => m.elements.get(id).team;
    const sim = simulate(lu, projByGw[0], m.scoring, team, { sims: 10000, hitCost, chip });
    const decorate = (p) => {
      const el = m.elements.get(p.id);
      const pr = projByGw[0].get(p.id);
      return {
        ...playerSummary(m, el),
        ep: round(p.ep, 2),
        horizonEp: round(horizonEp.get(p.id).reduce((s, e) => s + e, 0), 1),
        reliability: round(p.reliability, 2),
        fixtures: pr.fixtures.map((f) => ({ opp: f.oppName, home: f.home, fdr: f.fdr, pCS: round(f.pCS, 2), xMins: Math.round(f.expMins) })),
        nextFixtures: gws.slice(1).map((gw) =>
          m.teamFixtures(el.team, gw).map((f) => ({ gw, opp: m.teams.get(f.opp).short_name, home: f.home, fdr: f.fdr }))
        ),
        breakdown: Object.fromEntries(
          Object.keys(pr.fixtures[0]?.comp || {}).map((k) => [k, round(pr.fixtures.reduce((s, f) => s + f.comp[k], 0), 2)])
        ),
        sim: sim.players[p.id] && {
          p10: round(sim.players[p.id].p10, 1), p90: round(sim.players[p.id].p90, 1),
          pBlank: round(sim.players[p.id].pBlank, 2), pHaul: round(sim.players[p.id].pHaul, 2),
        },
        captain: p.id === lu.captain.id,
        vice: lu.vice && p.id === lu.vice.id,
      };
    };
    return {
      formation: lu.formation,
      xi: lu.xi.map(decorate),
      bench: lu.bench.map(decorate),
      captain: lu.captain.id,
      vice: lu.vice && lu.vice.id,
      projection: {
        worst: round(sim.worst), base: round(sim.base), best: round(sim.best), median: round(sim.median),
        p5: round(sim.p5), p25: round(sim.p25), p75: round(sim.p75), p95: round(sim.p95),
        histogram: sim.histogram, captainFailRate: round(sim.captainFailRate, 3), avgAutoSubs: round(sim.avgAutoSubs, 2),
        hitCost,
      },
    };
  };

  const decorateMove = (o) => ({
    n: o.n,
    out: o.outs.map((id) => ({ ...playerSummary(m, m.elements.get(id)), sell: (sellPrice[id] ?? m.elements.get(id).now_cost) / 10, ep: round(horizonEp.get(id)[0], 2), horizonEp: round(horizonEp.get(id).reduce((s, e) => s + e, 0), 1) })),
    in: o.ins.map((id) => ({ ...playerSummary(m, m.elements.get(id)), ep: round(horizonEp.get(id)[0], 2), horizonEp: round(horizonEp.get(id).reduce((s, e) => s + e, 0), 1) })),
    gain: round(o.gain, 2),
    gainNext: round(o.gainNext, 2),
    hit: o.hit ?? 0,
    net: round(o.net ?? o.gain, 2),
    bankAfter: round(o.bankAfter / 10, 1),
  });

  const options = search.options.map(decorateMove);
  const rec = search.options[search.recommended];
  const finalSquad = squad.map((id) => { const j = rec.outs.indexOf(id); return j >= 0 ? rec.ins[j] : id; });

  const current = describeLineup(squad, 0);
  const recommended = rec.n ? describeLineup(finalSquad, rec.hit, null) : current;

  // Chip what-ifs on the recommended squad.
  const chips = [];
  const canUse = (name) => !chipsAvailable || chipsAvailable.includes(name);
  if (canUse('bboost')) {
    const bb = describeLineup(finalSquad, rec.hit, 'bboost').projection;
    chips.push({ chip: 'bboost', label: 'Bench Boost', base: bb.base, gain: round(bb.base - recommended.projection.base, 1) });
  }
  if (canUse('3xc')) {
    const tc = describeLineup(finalSquad, rec.hit, '3xc').projection;
    chips.push({ chip: '3xc', label: 'Triple Captain', base: tc.base, gain: round(tc.base - recommended.projection.base, 1) });
  }

  const tips = buildTips({ m, squad, finalSquad, current, recommended, rec, options, chips, gws, projByGw, freeTransfers, search, horizonEp });

  return {
    gw: m.nextGw,
    deadline: m.nextEvent.deadline_time,
    dataThroughGw: m.latestGw,
    horizon: gws,
    freeTransfers,
    bank: bank / 10,
    options,
    recommendedOption: search.recommended,
    alternatives: {
      singles: search.singles.slice(0, 8).map((o) => decorateMove({ ...o, n: 1, hit: Math.max(0, 1 - freeTransfers) * 4, net: o.gain - Math.max(0, 1 - freeTransfers) * 4 })),
      doubles: search.doubles.slice(0, 4).map((o) => decorateMove({ ...o, n: 2, hit: Math.max(0, 2 - freeTransfers) * 4, net: o.gain - Math.max(0, 2 - freeTransfers) * 4 })),
    },
    current,
    recommended,
    chips,
    tips,
    model: {
      leagueAvgGoals: round(m.leagueAvg, 2),
      homeAdvantage: round(m.homeF, 2),
    },
  };
}

function buildTips({ m, squad, finalSquad, current, recommended, rec, chips, gws, projByGw, freeTransfers }) {
  const tips = [];
  const name = (id) => m.elements.get(id).web_name;

  // Transfers
  if (rec.n === 0) {
    tips.push({ type: 'transfer', level: 'info', text: freeTransfers >= 5
      ? 'No transfer clears the bar, but you are at the 5 free-transfer cap — use one rather than waste it (see the alternatives list).'
      : `Roll your transfer: no move adds enough projected points to beat banking it (you'd carry ${Math.min(5, freeTransfers + 1)} FTs into GW${m.nextGw + 1}).` });
  } else {
    const moves = rec.outs.map((o, i) => `${name(o)} → ${name(rec.ins[i])}`).join(', ');
    tips.push({ type: 'transfer', level: 'good', text: `Make ${rec.n} transfer${rec.n > 1 ? 's' : ''}: ${moves}. Projected +${rec.gain.toFixed(1)} pts over the next ${gws.length} GW${gws.length > 1 ? 's' : ''}${rec.hit ? ` (−${rec.hit} hit included: net +${(rec.gain - rec.hit).toFixed(1)})` : ''}.` });
  }

  // Flags in the current squad
  for (const id of squad) {
    const p = m.elements.get(id);
    if (p.status !== 'a' || (p.chance_of_playing_next_round != null && p.chance_of_playing_next_round < 100)) {
      const chance = p.chance_of_playing_next_round;
      tips.push({ type: 'flag', level: chance === 0 || ['i', 's', 'u', 'n'].includes(p.status) && chance == null ? 'bad' : 'warn',
        text: `${p.web_name}: ${p.news || 'flagged'}${chance != null && !/%/.test(p.news || '') ? ` (${chance}% chance of playing)` : ''}.` });
    }
  }

  // Blanks / doubles in the next GW
  for (const id of finalSquad) {
    const n = projByGw[0].get(id).fixtures.length;
    if (n === 0) tips.push({ type: 'fixture', level: 'bad', text: `${name(id)} has no fixture in GW${m.nextGw} (blank).` });
    if (n >= 2) tips.push({ type: 'fixture', level: 'good', text: `${name(id)} has a double gameweek in GW${m.nextGw}.` });
  }

  // Captaincy
  const all = [...recommended.xi].sort((a, b) => b.ep - a.ep);
  const cap = all[0], alt = all[1];
  if (cap) {
    const margin = cap.ep - (alt ? alt.ep : 0);
    tips.push({ type: 'captain', level: 'good', text: `Captain ${cap.name} (${cap.ep.toFixed(1)} xPts vs ${cap.fixtures.map((f) => `${f.opp} ${f.home ? 'H' : 'A'}`).join(', ') || 'no fixture'}). ` +
      (alt ? (margin < 0.4 ? `Very close call with ${alt.name} (${alt.ep.toFixed(1)}) — either is defensible.` : `Vice: ${recommended.xi.find((x) => x.vice)?.name}.`) : '') });
  }

  // Bench
  const benchOut = recommended.bench.slice(1);
  if (benchOut.length) {
    tips.push({ type: 'bench', level: 'info', text: `Bench order: ${recommended.bench[0]?.name} (GK), then ${benchOut.map((b, i) => `${i + 1}. ${b.name}`).join(', ')}. Ordered by projected points so the strongest sub comes on first.` });
  }
  const risky = recommended.xi.filter((x) => x.reliability < 0.6);
  if (risky.length) {
    tips.push({ type: 'bench', level: 'warn', text: `Rotation/minutes risk in your XI: ${risky.map((r) => `${r.name} (${Math.round(r.reliability * 100)}% to play 60+)`).join(', ')}. Your bench order matters this week.` });
  }

  // Chips
  for (const c of chips) {
    if (c.chip === 'bboost' && c.gain >= 12) tips.push({ type: 'chip', level: 'good', text: `Bench Boost would add ~${c.gain} pts this week — worth considering.` });
    if (c.chip === '3xc' && cap && cap.ep >= 8.5) tips.push({ type: 'chip', level: 'good', text: `Triple Captain on ${cap.name} projects +${c.gain} pts — a strong week for it.` });
  }

  // Fixture swing over the horizon
  if (gws.length > 1) {
    const weak = finalSquad
      .map((id) => ({ id, h: projByGw.reduce((s, mp) => s + mp.get(id).ep, 0) / gws.length, price: m.elements.get(id).now_cost }))
      .filter((x) => x.price >= 60 && x.h < 3)
      .map((x) => name(x.id));
    if (weak.length) tips.push({ type: 'plan', level: 'warn', text: `Under-performing for their price over the next ${gws.length} GWs: ${weak.join(', ')}. Future transfer targets.` });
  }

  return tips;
}

// ---------- import from FPL team ID ----------
async function importEntry(entryId) {
  const id = Number(entryId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Team ID must be a positive number.');
  const m = await getModel();
  const [entry, history, transfers] = await Promise.all([fpl.entry(id), fpl.entryHistory(id), fpl.entryTransfers(id)]).catch((e) => {
    if (e.status === 404) throw badRequest(`No FPL team with ID ${id}.`);
    throw e;
  });
  const gw = entry.current_event;
  if (!gw) throw badRequest('This team has not played a gameweek yet.');
  const chipsUsed = history.chips || [];
  const fhEvents = new Set(chipsUsed.filter((c) => c.name === 'freehit').map((c) => c.event));

  // A Free Hit squad reverts, so read the squad from the gameweek before it.
  let picksGw = gw;
  let picks = await fpl.entryPicks(id, picksGw);
  while (picks.active_chip === 'freehit' && picksGw > 1) {
    picksGw--;
    picks = await fpl.entryPicks(id, picksGw);
  }

  const squad = picks.picks.slice().sort((a, b) => a.position - b.position).map((p) => p.element);
  const bank = (picks.entry_history?.bank ?? entry.last_deadline_bank ?? 0) / 10;

  // Selling prices: 50% of any rise since purchase (rounded down), full drop.
  const sellPrices = {};
  for (const pid of squad) {
    const el = m.elements.get(pid);
    const t = transfers
      .filter((tr) => tr.element_in === pid && !fhEvents.has(tr.event))
      .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
    const buy = t ? t.element_in_cost : el.now_cost - el.cost_change_start;
    const now = el.now_cost;
    sellPrices[pid] = (now > buy ? buy + Math.floor((now - buy) / 2) : now) / 10;
  }

  // Free transfers: +1 per gameweek (max 5), consumed by transfers, kept when WC/FH is played.
  const chipByGw = Object.fromEntries(chipsUsed.map((c) => [c.event, c.name]));
  let ft = 0;
  const cur = history.current.slice().sort((a, b) => a.event - b.event);
  cur.forEach((h, i) => {
    if (i === 0) { ft = 1; return; } // after the first gameweek you get 1 FT
    const chip = chipByGw[h.event];
    if (chip === 'wildcard' || chip === 'freehit') { ft = Math.min(5, ft + 1); return; }
    ft = Math.min(5, Math.max(0, ft - h.event_transfers) + 1);
  });

  // Chips still available in the upcoming gameweek's window.
  const next = m.nextGw;
  const windows = (m.chipsMeta || []).length ? m.chipsMeta : [];
  const chipsAvailable = [];
  for (const c of windows) {
    if (next < c.start_event || next > c.stop_event) continue;
    const used = chipsUsed.some((u) => u.name === c.name && u.event >= c.start_event && u.event <= c.stop_event);
    if (!used && !chipsAvailable.includes(c.name)) chipsAvailable.push(c.name);
  }

  return {
    entryId: id,
    teamName: entry.name,
    manager: `${entry.player_first_name} ${entry.player_last_name}`,
    overallRank: entry.summary_overall_rank,
    picksGw,
    squad,
    bank,
    freeTransfers: ft,
    sellPrices,
    chipsAvailable,
    note: 'Transfers made since the last deadline are not visible through the public FPL API — edit the squad below if you have already made moves.',
  };
}

module.exports = { analyse, importEntry, playersList, getModel };
