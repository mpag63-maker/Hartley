// Thin, cached client for the official Fantasy Premier League API.
'use strict';

const BASE = 'https://fantasy.premierleague.com/api';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (FPL assistant)', Accept: 'application/json' };

const cache = new Map(); // key -> { at, ttl, promise }

async function get(path, ttlMs) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const promise = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(BASE + path, { headers: HEADERS });
        if (res.status === 404) {
          const err = new Error(`Not found: ${path}`);
          err.status = 404;
          throw err;
        }
        if (!res.ok) throw new Error(`FPL API ${res.status} for ${path}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (e.status === 404) break;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    cache.delete(path);
    throw lastErr;
  })();
  cache.set(path, { at: Date.now(), ttl: ttlMs, promise });
  promise.catch(() => cache.delete(path));
  return promise;
}

const MIN = 60 * 1000;

const bootstrap = () => get('/bootstrap-static/', 10 * MIN);
const fixtures = () => get('/fixtures/', 10 * MIN);
// Finished gameweeks never change once bonus is confirmed; cache them for long.
const live = (gw, finished) => get(`/event/${gw}/live/`, finished ? 360 * MIN : 5 * MIN);
const entry = (id) => get(`/entry/${id}/`, 2 * MIN);
const entryHistory = (id) => get(`/entry/${id}/history/`, 2 * MIN);
const entryTransfers = (id) => get(`/entry/${id}/transfers/`, 2 * MIN);
const entryPicks = (id, gw) => get(`/entry/${id}/event/${gw}/picks/`, 2 * MIN);

/** Everything the model needs, gathered in parallel. */
async function loadSeason() {
  const [bs, fx] = await Promise.all([bootstrap(), fixtures()]);
  const finishedGws = bs.events.filter((e) => e.finished || e.data_checked || e.is_current).map((e) => e.id);
  const lives = await Promise.all(
    finishedGws.map((gw) => {
      const ev = bs.events.find((e) => e.id === gw);
      return live(gw, ev.finished && ev.data_checked).then((l) => ({ gw, elements: l.elements }));
    })
  );
  return { bootstrap: bs, fixtures: fx, lives };
}

module.exports = { loadSeason, bootstrap, fixtures, entry, entryHistory, entryTransfers, entryPicks };
