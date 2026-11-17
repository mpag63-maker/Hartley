// Expected-points model built purely from official FPL data:
//  * team attack/defence ratings from finished fixtures (blend of xG and goals, recency weighted)
//  * player minutes, per-90 attacking/defensive/bonus rates from gameweek "live" data
//  * per-fixture projections that adjust for opponent strength and home/away.
'use strict';

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

// Defaults mirror current FPL scoring; overwritten by game_config.scoring when available.
const DEFAULT_SCORING = {
  goals: { 1: 10, 2: 6, 3: 5, 4: 4 },
  cs: { 1: 4, 2: 4, 3: 1, 4: 0 },
  gc: { 1: -1, 2: -1, 3: 0, 4: 0 },
  dc: { 1: 0, 2: 2, 3: 2, 4: 2 },
  assist: 3,
  saves: 1,
  yellow: -1,
  red: -3,
};

function readScoring(bs) {
  const s = bs.game_config && bs.game_config.scoring;
  if (!s) return DEFAULT_SCORING;
  const byPos = (obj, fallback) => {
    if (!obj || typeof obj !== 'object') return fallback;
    return { 1: obj.GKP ?? fallback[1], 2: obj.DEF ?? fallback[2], 3: obj.MID ?? fallback[3], 4: obj.FWD ?? fallback[4] };
  };
  return {
    goals: byPos(s.goals_scored, DEFAULT_SCORING.goals),
    cs: byPos(s.clean_sheets, DEFAULT_SCORING.cs),
    gc: byPos(s.goals_conceded, DEFAULT_SCORING.gc),
    dc: byPos(s.defensive_contribution, DEFAULT_SCORING.dc),
    assist: s.assists ?? 3,
    saves: s.saves ?? 1,
    yellow: s.yellow_cards ?? -1,
    red: s.red_cards ?? -3,
  };
}

// ---------- maths helpers ----------
function poissonPmf(lambda, kMax) {
  const out = new Array(kMax + 1);
  let p = Math.exp(-lambda);
  out[0] = p;
  for (let k = 1; k <= kMax; k++) {
    p = (p * lambda) / k;
    out[k] = p;
  }
  return out;
}
/** E[floor(X / d)] for X ~ Poisson(lambda). */
function expFloorDiv(lambda, d) {
  const kMax = Math.max(20, Math.ceil(lambda * 3 + 10));
  const pmf = poissonPmf(lambda, kMax);
  let e = 0;
  for (let k = d; k <= kMax; k++) e += pmf[k] * Math.floor(k / d);
  return e;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (v) => (v == null ? 0 : Number(v) || 0);

// ---------- model ----------
function buildModel({ bootstrap: bs, fixtures, lives }) {
  const scoring = readScoring(bs);
  const events = bs.events;
  const nextEvent = events.find((e) => e.is_next) || events.find((e) => e.is_current && !e.finished);
  if (!nextEvent) throw new Error('No upcoming gameweek found – the season may be over.');
  const nextGw = nextEvent.id;
  const latestGw = Math.max(0, ...lives.map((l) => l.gw));

  const teams = new Map(bs.teams.map((t) => [t.id, t]));
  const elements = new Map(bs.elements.map((e) => [e.id, e]));

  // Fixtures played per team per gameweek (for splitting double-gameweek aggregates).
  const playedCount = {}; // gw -> team -> n
  const played = fixtures.filter((f) => f.event && (f.finished || f.finished_provisional || f.started));
  for (const f of played) {
    playedCount[f.event] ??= {};
    for (const t of [f.team_h, f.team_a]) playedCount[f.event][t] = (playedCount[f.event][t] || 0) + 1;
  }

  // ----- team xG per gameweek, from player-level live data -----
  const teamXg = {}; // gw -> team -> xG
  for (const { gw, elements: els } of lives) {
    teamXg[gw] = {};
    for (const el of els) {
      const p = elements.get(el.id);
      if (!p) continue;
      teamXg[gw][p.team] = (teamXg[gw][p.team] || 0) + num(el.stats.expected_goals);
    }
  }

  // ----- team ratings -----
  const HALF_LIFE_TEAM = 8;
  const acc = new Map(bs.teams.map((t) => [t.id, { f: 0, a: 0, w: 0, n: 0 }]));
  let homeGoals = 0, awayGoals = 0, nMatches = 0;
  const finished = fixtures.filter((f) => f.event && (f.finished || f.finished_provisional) && f.team_h_score != null);
  for (const f of finished) {
    const gw = f.event;
    const w = Math.pow(0.5, (latestGw - gw) / HALF_LIFE_TEAM);
    const nh = playedCount[gw]?.[f.team_h] || 1;
    const na = playedCount[gw]?.[f.team_a] || 1;
    const xgH = teamXg[gw]?.[f.team_h] != null ? teamXg[gw][f.team_h] / nh : f.team_h_score;
    const xgA = teamXg[gw]?.[f.team_a] != null ? teamXg[gw][f.team_a] / na : f.team_a_score;
    const sh = 0.65 * xgH + 0.35 * f.team_h_score;
    const sa = 0.65 * xgA + 0.35 * f.team_a_score;
    const H = acc.get(f.team_h), A = acc.get(f.team_a);
    if (!H || !A) continue;
    H.f += w * sh; H.a += w * sa; H.w += w; H.n++;
    A.f += w * sa; A.a += w * sh; A.w += w; A.n++;
    homeGoals += sh; awayGoals += sa; nMatches++;
  }
  const leagueAvg = nMatches ? (homeGoals + awayGoals) / (2 * nMatches) : 1.4;
  const homeF = nMatches >= 20 ? clamp(homeGoals / nMatches / leagueAvg, 1.0, 1.3) : 1.12;
  const awayF = 2 - homeF;
  const PRIOR_GAMES = 4;
  const rating = new Map();
  for (const [id, r] of acc) {
    const att = (r.f + PRIOR_GAMES * leagueAvg) / (r.w + PRIOR_GAMES) / leagueAvg;
    const def = (r.a + PRIOR_GAMES * leagueAvg) / (r.w + PRIOR_GAMES) / leagueAvg;
    rating.set(id, { attack: att, defence: def, games: r.n });
  }
  const lambda = (team, opp, isHome) =>
    leagueAvg * rating.get(team).attack * rating.get(opp).defence * (isHome ? homeF : awayF);

  // ----- per-player history from live data -----
  const hist = new Map(); // id -> [{gw, ...}]
  for (const { gw, elements: els } of lives.slice().sort((a, b) => a.gw - b.gw)) {
    for (const el of els) {
      const p = elements.get(el.id);
      if (!p) continue;
      const teamGames = playedCount[gw]?.[p.team] || 0;
      if (!teamGames) continue; // blank gameweek for the team
      const s = el.stats;
      let dcPts = 0;
      for (const ex of el.explain || []) for (const st of ex.stats || []) if (st.identifier === 'defensive_contribution') dcPts += st.points;
      const row = {
        gw, teamGames,
        minutes: num(s.minutes), starts: num(s.starts),
        xg: num(s.expected_goals), xa: num(s.expected_assists),
        goals: num(s.goals_scored), assists: num(s.assists),
        bonus: num(s.bonus), saves: num(s.saves),
        yc: num(s.yellow_cards), rc: num(s.red_cards),
        dcPts, points: num(s.total_points),
      };
      if (!hist.has(el.id)) hist.set(el.id, []);
      hist.get(el.id).push(row);
    }
  }

  // ----- positional priors (per 90) -----
  const prior = {};
  for (const pos of [1, 2, 3, 4]) {
    let m = 0, xg = 0, xa = 0, g = 0, a = 0, b = 0, sv = 0, yc = 0, dcH = 0, app60 = 0;
    for (const p of bs.elements) {
      if (p.element_type !== pos) continue;
      for (const r of hist.get(p.id) || []) {
        m += r.minutes; xg += r.xg; xa += r.xa; g += r.goals; a += r.assists; b += r.bonus; sv += r.saves; yc += r.yc;
        if (r.minutes >= 60) { app60 += 1; dcH += r.dcPts / 2; }
      }
    }
    const n90 = m / 90 || 1;
    // Fringe/low-minute players are usually below average, so priors are shaded down.
    prior[pos] = {
      g: (0.7 * xg + 0.3 * g) / n90 * 0.75,
      a: (0.7 * xa + 0.3 * a) / n90 * 0.75,
      bonus: b / n90 * 0.6,
      saves: sv / n90,
      yc: yc / n90,
      dc: app60 ? dcH / app60 * 0.8 : 0.1,
    };
  }

  const PER90_K = 2; // shrinkage strength, in 90-minute units
  const HALF_LIFE_PLAYER = 10;

  function playerParams(p) {
    const rows = hist.get(p.id) || [];
    const pos = p.element_type;
    const pr = prior[pos];

    // per-90 rates, recency weighted, shrunk to positional prior
    let wm = 0, wg = 0, wa = 0, wb = 0, wsv = 0, wyc = 0, wrc = 0, wdc = 0, wapp60 = 0;
    for (const r of rows) {
      const w = Math.pow(0.5, (latestGw - r.gw) / HALF_LIFE_PLAYER);
      wm += w * r.minutes;
      wg += w * (0.7 * r.xg + 0.3 * r.goals);
      wa += w * (0.7 * r.xa + 0.3 * r.assists);
      wb += w * r.bonus; wsv += w * r.saves; wyc += w * r.yc; wrc += w * r.rc;
      if (r.minutes >= 60) { wapp60 += w * Math.min(r.teamGames, Math.max(1, Math.floor(r.minutes / 60))); wdc += w * r.dcPts / 2; }
    }
    const n90 = wm / 90;
    const shrink = (x, pri) => (x + pri * PER90_K) / (n90 + PER90_K);
    const rates = {
      g90: shrink(wg, pr.g),
      a90: shrink(wa, pr.a),
      bonus90: shrink(wb, pr.bonus),
      saves90: pos === 1 ? shrink(wsv, pr.saves) : 0,
      yc90: shrink(wyc, pr.yc),
      rc90: (wrc + 0.01 * PER90_K) / (n90 + PER90_K),
      dcP: pos === 1 ? 0 : clamp((wdc + pr.dc * 3) / (wapp60 + 3), 0, 0.95),
    };

    // minutes model: recent team-fixtures, decaying weights
    const news = (p.news || '').trim();
    const newsAge = p.news_added ? (Date.now() - Date.parse(p.news_added)) / 86400000 : Infinity;
    let window = rows.slice(-8);
    // A recent run of zero-minute weeks caused by a (now flagged / recently flagged) injury
    // shouldn't erase a regular starter's role.
    let trailingZeros = 0;
    for (let i = window.length - 1; i >= 0 && window[i].minutes === 0; i--) trailingZeros++;
    let returningFromInjury = false;
    if (trailingZeros > 0 && trailingZeros < window.length && (p.status !== 'a' || (news && newsAge < 28) || newsAge < 21)) {
      const before = rows.slice(0, rows.length - trailingZeros).slice(-6);
      const st = before.reduce((s, r) => s + r.starts, 0) / Math.max(1, before.reduce((s, r) => s + r.teamGames, 0));
      if (st >= 0.5) { window = before; returningFromInjury = true; }
    }
    window = window.slice(-6);
    let sw = 0, sStart = 0, sSub = 0, sNon = 0;
    window.forEach((r, i) => {
      const w = Math.pow(0.8, window.length - 1 - i);
      const starts = Math.min(r.starts, r.teamGames);
      sw += w * r.teamGames;
      sStart += w * starts;
      const nonStarts = r.teamGames - starts;
      sNon += w * nonStarts;
      if (nonStarts > 0 && r.minutes > starts * 60) sSub += w * Math.min(nonStarts, 1);
      else if (nonStarts > 0 && starts === 0 && r.minutes > 0) sSub += w;
    });
    let pStart = sw ? sStart / sw : 0;
    if (returningFromInjury) pStart *= 0.85;
    const pSub = sNon ? clamp(sSub / sNon, 0, 0.9) : 0.3;
    let s60 = 0, sAll = 0;
    for (const r of rows) {
      if (!r.starts) continue;
      sAll += r.starts;
      s60 += r.minutes >= 60 * r.starts ? r.starts : r.minutes >= 60 ? 1 : 0;
    }
    const p60GivenStart = (s60 + 0.8 * 3) / (sAll + 3);

    return { pos, rates, pStart, pSub, p60GivenStart, returningFromInjury, gamesInWindow: window.length };
  }

  /** Probability the player is available for a gameweek `offset` weeks after the next one. */
  function availability(p, offset) {
    let chance;
    if (p.chance_of_playing_next_round != null) chance = p.chance_of_playing_next_round / 100;
    else chance = p.status === 'a' ? 1 : p.status === 'd' ? 0.75 : 0;
    if (p.status === 'u' || p.status === 'n') return chance;
    // Flagged players tend to recover; ramp availability for later weeks.
    return chance + (1 - chance) * Math.min(1, offset * 0.3);
  }

  const paramCache = new Map();
  const params = (p) => {
    if (!paramCache.has(p.id)) paramCache.set(p.id, playerParams(p));
    return paramCache.get(p.id);
  };

  const fixturesByGw = {};
  for (const f of fixtures) {
    if (!f.event) continue;
    (fixturesByGw[f.event] ??= []).push(f);
  }
  const teamFixtures = (team, gw) =>
    (fixturesByGw[gw] || [])
      .filter((f) => f.team_h === team || f.team_a === team)
      .map((f) => {
        const home = f.team_h === team;
        const opp = home ? f.team_a : f.team_h;
        return { id: f.id, opp, home, kickoff: f.kickoff_time, fdr: home ? f.team_h_difficulty : f.team_a_difficulty };
      });

  /** Per-fixture simulation parameters + analytic expected points for player p in gameweek gw. */
  function project(p, gw) {
    const pp = params(p);
    const avail = availability(p, gw - nextGw);
    const { pos, rates } = pp;
    const fxs = teamFixtures(p.team, gw);
    const out = { ep: 0, fixtures: [], avail };
    for (const fx of fxs) {
      const lf = lambda(p.team, fx.opp, fx.home);
      const la = lambda(fx.opp, p.team, !fx.home);
      const attRatio = lf / (leagueAvg * rating.get(p.team).attack);
      const oppAttRatio = la / (leagueAvg * rating.get(p.team).defence);
      const pCS = Math.exp(-la);
      const csRatio = pCS / Math.exp(-leagueAvg * rating.get(p.team).defence);

      const ps = pp.pStart * avail;
      const p60 = ps * pp.p60GivenStart;
      const pShort = ps - p60;
      const pSubApp = avail * (1 - pp.pStart) * pp.pSub;
      const expMins = p60 * 86 + pShort * 45 + pSubApp * 20;

      const gRate = rates.g90 * attRatio; // per 90 in this fixture
      const aRate = rates.a90 * attRatio;
      const bonusMult = clamp(Math.sqrt(pos <= 2 ? csRatio : attRatio), 0.5, 2);
      const bonusRate = rates.bonus90 * bonusMult;

      const comp = {
        appearance: 2 * p60 + 1 * (pShort + pSubApp),
        goals: scoring.goals[pos] * gRate * expMins / 90,
        assists: scoring.assist * aRate * expMins / 90,
        cleanSheet: scoring.cs[pos] * p60 * pCS,
        conceded: scoring.gc[pos] ? scoring.gc[pos] * p60 * expFloorDiv(la, 2) : 0,
        saves: pos === 1 ? scoring.saves * p60 * expFloorDiv(rates.saves90 * oppAttRatio, 3) : 0,
        bonus: bonusRate * expMins / 90,
        defensive: scoring.dc[pos] * rates.dcP * p60,
        cards: (scoring.yellow * rates.yc90 + scoring.red * rates.rc90) * expMins / 90,
      };
      const ep = Object.values(comp).reduce((a, b) => a + b, 0);
      out.ep += ep;
      out.fixtures.push({
        ...fx,
        oppName: teams.get(fx.opp).short_name,
        lambdaFor: lf, lambdaAgainst: la, pCS, expMins, ep, comp,
        sim: { ps, p60GivenStart: pp.p60GivenStart, pSubApp, gRate, aRate, la, bonusRate, savesRate: rates.saves90 * oppAttRatio, dcP: rates.dcP, yc90: rates.yc90, rc90: rates.rc90 },
      });
    }
    return out;
  }

  return {
    scoring, nextGw, nextEvent, latestGw, leagueAvg, homeF, events,
    teams, elements, rating, hist, params, project, teamFixtures, availability,
    POS,
    chipsMeta: bs.chips || [],
  };
}

module.exports = { buildModel, POS, poissonPmf, expFloorDiv };
