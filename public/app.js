'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const SHAPE = { 1: 2, 2: 5, 3: 5, 4: 3 };
const STORE_KEY = 'fpl-assistant-v1';

const state = {
  players: [],
  byId: new Map(),
  gw: null,
  squad: { 1: [], 2: [], 3: [], 4: [] }, // arrays of ids
  sellPrices: {},
  chipsAvailable: null,
  lastResult: null,
};

// ---------- persistence ----------
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      squad: state.squad, sellPrices: state.sellPrices, chipsAvailable: state.chipsAvailable,
      bank: $('#bank').value, ft: $('#ft').value, horizon: $('#horizon').value, entryId: $('#entryId').value,
    }));
  } catch { /* storage unavailable */ }
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return;
    for (const k of [1, 2, 3, 4]) state.squad[k] = (s.squad?.[k] || []).filter((id) => state.byId.has(id));
    state.sellPrices = s.sellPrices || {};
    state.chipsAvailable = s.chipsAvailable ?? null;
    if (s.bank != null) $('#bank').value = s.bank;
    if (s.ft != null) $('#ft').value = s.ft;
    if (s.horizon != null) $('#horizon').value = s.horizon;
    if (s.entryId) $('#entryId').value = s.entryId;
  } catch { /* ignore */ }
}

// ---------- API ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function notice(msg, kind = '') {
  const n = $('#notice');
  if (!msg) return n.classList.add('hidden');
  n.className = `notice ${kind}`;
  n.innerHTML = msg;
}
function loading(on, text = 'Crunching numbers…') {
  $('#loading').classList.toggle('hidden', !on);
  $('#loadingText').textContent = text;
}

// ---------- squad editor ----------
const squadIds = () => [1, 2, 3, 4].flatMap((k) => state.squad[k]);
const clubCount = (teamId) => squadIds().filter((id) => state.byId.get(id).teamId === teamId).length;

function addPlayer(id, { silent } = {}) {
  const p = state.byId.get(id);
  if (!p) return false;
  if (squadIds().includes(id)) return false;
  if (state.squad[p.pos].length >= SHAPE[p.pos]) { if (!silent) notice(`You already have ${SHAPE[p.pos]} ${POS[p.pos]}s.`, 'bad'); return false; }
  if (clubCount(p.teamId) >= 3) { if (!silent) notice(`Max 3 players from ${esc(p.team)}.`, 'bad'); return false; }
  state.squad[p.pos].push(id);
  return true;
}

function renderSquad() {
  const ed = $('#squadEditor');
  ed.innerHTML = '';
  for (const pos of [1, 2, 3, 4]) {
    const row = document.createElement('div');
    row.className = 'pos-row';
    row.innerHTML = `<div class="pos-tag pos-${pos}">${POS[pos]}</div><div class="slots"></div>`;
    const slots = $('.slots', row);
    for (let i = 0; i < SHAPE[pos]; i++) {
      const id = state.squad[pos][i];
      const slot = document.createElement('div');
      slot.className = 'slot' + (id ? ' filled' : '');
      if (id) {
        const p = state.byId.get(id);
        const flag = p.status !== 'a' ? `<span class="flag ${p.status}" title="${esc(p.news)}"></span>` : '';
        const sp = state.sellPrices[id];
        slot.innerHTML = `<div><span class="nm">${esc(p.name)}${flag}</span><span class="meta">${esc(p.team)} · £${p.price.toFixed(1)}${sp != null && sp !== p.price ? ` (sell £${Number(sp).toFixed(1)})` : ''} · ${p.ep.toFixed(1)} xPts</span></div><button class="x" title="Remove" aria-label="Remove ${esc(p.name)}">×</button>`;
        $('.x', slot).onclick = () => { state.squad[pos].splice(i, 1); delete state.sellPrices[id]; afterSquadChange(); };
      } else {
        slot.innerHTML = `<input placeholder="Add ${POS[pos]}…" aria-label="Add ${POS[pos]}" />`;
        attachAutocomplete($('input', slot), pos);
      }
      slots.appendChild(slot);
    }
    ed.appendChild(row);
  }
  const n = squadIds().length;
  const value = squadIds().reduce((s, id) => s + state.byId.get(id).price, 0);
  $('#squadCount').textContent = `${n} / 15${n ? ` · £${value.toFixed(1)}m` : ''}`;
  $('#analyseBtn').disabled = n !== 15;
}

function afterSquadChange() {
  renderSquad();
  save();
}

const norm = (s) => String(s || '').replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function attachAutocomplete(input, pos) {
  let box = null, items = [], hl = 0;
  const close = () => { box?.remove(); box = null; };
  const choose = (p) => {
    close();
    if (addPlayer(p.id)) { notice(''); afterSquadChange(); }
  };
  const render = () => {
    const q = norm(input.value);
    if (!q) return close();
    const taken = new Set(squadIds());
    items = state.players
      .filter((p) => p.pos === pos && !taken.has(p.id) && (norm(p.name).includes(q) || norm(p.fullName).includes(q) || norm(p.team) === q))
      .sort((a, b) => b.selectedBy - a.selectedBy)
      .slice(0, 12);
    if (!box) { box = document.createElement('div'); box.className = 'ac'; input.parentElement.appendChild(box); }
    hl = 0;
    box.innerHTML = items.length
      ? items.map((p, i) => `<div data-i="${i}" class="${i === hl ? 'hl' : ''}"><span>${esc(p.name)} <small>${esc(p.team)}</small></span><small>£${p.price.toFixed(1)} · ${p.ep.toFixed(1)} xPts</small></div>`).join('')
      : '<div><small>No matches</small></div>';
    $$('[data-i]', box).forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(items[+el.dataset.i]); }));
  };
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (!box || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      $$('[data-i]', box).forEach((el, i) => el.classList.toggle('hl', i === hl));
    } else if (e.key === 'Enter') { e.preventDefault(); choose(items[hl]); }
    else if (e.key === 'Escape') close();
  });
}

// ---------- import by team ID ----------
async function importTeam(e) {
  e.preventDefault();
  const id = $('#entryId').value.trim();
  if (!/^\d+$/.test(id)) return notice('Enter your numeric FPL team ID.', 'bad');
  loading(true, 'Importing your team…');
  try {
    const d = await api(`/api/entry/${id}`);
    state.squad = { 1: [], 2: [], 3: [], 4: [] };
    for (const pid of d.squad) addPlayer(pid, { silent: true });
    state.sellPrices = d.sellPrices;
    state.chipsAvailable = d.chipsAvailable;
    $('#bank').value = d.bank.toFixed(1);
    $('#ft').value = String(Math.min(5, d.freeTransfers));
    afterSquadChange();
    notice(`Imported <b>${esc(d.teamName)}</b> (${esc(d.manager)}) — squad from GW${d.picksGw}, £${d.bank.toFixed(1)}m in the bank, ${d.freeTransfers} free transfer${d.freeTransfers === 1 ? '' : 's'}${d.chipsAvailable.length ? `, chips: ${d.chipsAvailable.map(chipName).join(', ')}` : ''}.<br><span class="small muted">${esc(d.note)}</span>`, 'good');
  } catch (err) {
    notice(esc(err.message), 'bad');
  } finally {
    loading(false);
  }
}
const chipName = (c) => ({ wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' }[c] || c);

// ---------- screenshot OCR ----------
let workerPromise = null;
let ocrLogger = () => {};
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the OCR engine.'));
    document.head.appendChild(s);
  });
}
/** Self-hosted Tesseract worker (engine, WASM core and English model are served by our server). */
function getOcrWorker() {
  workerPromise ??= (async () => {
    if (!window.Tesseract) await loadScript('/vendor/tesseract/tesseract.min.js');
    return window.Tesseract.createWorker('eng', 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract-core/',
      langPath: '/vendor/lang',
      logger: (m) => ocrLogger(m),
    }).then(async (w) => {
      // Sparse-text mode: player names are scattered labels, not paragraphs.
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      return w;
    });
  })().catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

/**
 * Two OCR-friendly versions of the screenshot, both upscaled:
 *  - 'neutral': strongly coloured pixels (pitch, shirts, badges) are blanked so only black/white text
 *    labels remain, then binarised. Works best on FPL pitch views.
 *  - 'gray': plain grayscale, as a fallback for list views and dark themes.
 */
function preprocess(img, mode) {
  const scale = Math.min(3, Math.max(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight)));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let v = lum;
    if (mode === 'neutral') {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      v = sat > 0.3 && mx > 50 ? 255 : lum < 140 ? 0 : 255;
    }
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const STOP = new Set(['pick', 'team', 'bench', 'points', 'transfers', 'captain', 'vice', 'home', 'away', 'gameweek', 'save', 'auto', 'free', 'hit', 'bank', 'fixtures', 'status', 'leagues', 'deadline', 'average', 'highest', 'chips', 'wildcard', 'boost', 'triple', 'list', 'view', 'pitch', 'reset', 'make', 'confirm']);

/** Match OCR text to players. Returns ids in confidence order respecting squad rules. */
function matchPlayers(text) {
  const lines = text.split(/\n+/).map(norm).filter(Boolean);
  const tokens = [];
  lines.forEach((ln, li) => ln.split(' ').forEach((t, ti) => { if (t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)) tokens.push({ t, li, ti }); }));
  const full = ' ' + lines.join(' ') + ' ';

  const cands = [];
  for (const p of state.players) {
    const wn = norm(p.name);
    const surname = wn.split(' ').pop();
    let score = 0, tokenKey = null;
    if (wn.length >= 3 && full.includes(' ' + wn + ' ')) { score = 3; tokenKey = surname; }
    else if (surname.length >= 4) {
      for (const tk of tokens) {
        if (tk.t === surname) { score = Math.max(score, 2); tokenKey = tk.t; }
        else if (surname.length >= 5 && score < 1) {
          const d = lev(tk.t, surname);
          if (d <= (surname.length >= 8 ? 2 : 1)) { score = 1; tokenKey = tk.t; }
        }
      }
    }
    if (score) cands.push({ p, score, tokenKey });
  }
  // Prefer exact matches, then popular players (resolves namesakes like two "Wilson"s).
  cands.sort((a, b) => b.score - a.score || b.p.selectedBy - a.p.selectedBy);
  return cands;
}

async function handleImage(file) {
  if (!file || !file.type.startsWith('image/')) return notice('Please choose an image file.', 'bad');
  const url = URL.createObjectURL(file);
  const img = $('#preview');
  img.src = url;
  img.classList.remove('hidden');
  $('#dropText').classList.add('hidden');
  await img.decode().catch(() => {});
  const bar = $('#ocrProgress');
  bar.classList.remove('hidden');
  notice('Reading names from your screenshot… (the first run loads the OCR engine, ~5 MB)');
  try {
    ocrLogger = (m) => { if (m.status === 'recognizing text') $('div', bar).style.width = `${Math.round(m.progress * 100)}%`; };
    const worker = await getOcrWorker();
    const raw = [];
    for (const mode of ['neutral', 'gray']) {
      const { data } = await worker.recognize(preprocess(img, mode));
      raw.push(data.text);
    }
    const passes = raw.map(norm);
    window.__lastOcrText = raw.join('\n'); // handy for debugging matches
    const cands = matchPlayers(raw.join('\n'));
    state.squad = { 1: [], 2: [], 3: [], 4: [] };
    state.sellPrices = {};
    state.chipsAvailable = null;
    const usedTokens = new Map();
    const added = [];
    for (const c of cands) {
      // Each recognised word can identify at most as many players as times it appears.
      // Counted per OCR pass, so a name read by both passes still only counts once.
      const re = new RegExp(`\\b${c.tokenKey.replace(/[^a-z0-9]/g, '.')}\\b`, 'g');
      const occurrences = Math.max(1, ...passes.map((t) => (t.match(re) || []).length));
      if ((usedTokens.get(c.tokenKey) || 0) >= occurrences) continue;
      if (addPlayer(c.p.id, { silent: true })) {
        usedTokens.set(c.tokenKey, (usedTokens.get(c.tokenKey) || 0) + 1);
        added.push(c.p);
      }
      if (squadIds().length === 15) break;
    }
    afterSquadChange();
    const missing = 15 - added.length;
    notice(`Recognised <b>${added.length}</b> player${added.length === 1 ? '' : 's'}${missing ? ` — add the remaining ${missing} manually below` : ''}. Please double-check the matches, then set your bank and free transfers.`, missing ? '' : 'good');
  } catch (err) {
    notice(esc(err.message || 'OCR failed'), 'bad');
  } finally {
    bar.classList.add('hidden');
    $('div', bar).style.width = '0';
  }
}

// ---------- analysis ----------
async function analyse() {
  const squad = squadIds();
  if (squad.length !== 15) return;
  loading(true, 'Simulating 10,000 gameweeks…');
  try {
    const body = {
      squad,
      bank: Number($('#bank').value) || 0,
      freeTransfers: Number($('#ft').value),
      horizon: Number($('#horizon').value),
      sellPrices: Object.fromEntries(Object.entries(state.sellPrices).filter(([id]) => squad.includes(+id))),
      chipsAvailable: state.chipsAvailable,
    };
    const r = await api('/api/analyse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    state.lastResult = r;
    renderResults(r);
    $('#results').classList.remove('hidden');
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    notice(esc(err.message), 'bad');
  } finally {
    loading(false);
  }
}

const fmt = (x, d = 1) => (x >= 0 ? '' : '−') + Math.abs(x).toFixed(d);
const signed = (x, d = 1) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(d);
const fxLabel = (f) => `${f.opp} (${f.home ? 'H' : 'A'})`;

function renderResults(r) {
  const rec = r.recommended, cur = r.current;
  const P = rec.projection;
  $('#projGw').textContent = `· GW${r.gw}`;
  $('#projNote').textContent = `Based on data through GW${r.dataThroughGw}${P.hitCost ? ` · includes −${P.hitCost} hit` : ''}`;
  const changed = r.options[r.recommendedOption].n > 0;
  const cmp = (k) => changed ? `<div class="cmp">no transfers: ${cur.projection[k].toFixed(0)}</div>` : '';
  $('#scenarios').innerHTML = `
    <div class="scen worst"><div class="lbl">Worst case</div><div class="val">${P.worst.toFixed(0)}</div><div class="cmp">1-in-10 bad week</div>${cmp('worst')}</div>
    <div class="scen base"><div class="lbl">Base case</div><div class="val">${P.base.toFixed(0)}</div><div class="cmp">expected (avg)</div>${cmp('base')}</div>
    <div class="scen best"><div class="lbl">Best case</div><div class="val">${P.best.toFixed(0)}</div><div class="cmp">1-in-10 good week</div>${cmp('best')}</div>`;
  $('#histogram').innerHTML = histogramSvg(P);
  $('#scenarioExplain').textContent = `Range from 10,000 simulated gameweeks with the recommended XI, captain and bench order (auto-subs applied). 50% of outcomes fall between ${P.p25.toFixed(0)} and ${P.p75.toFixed(0)} points.`;

  // transfers
  $('#tfMeta').textContent = `${r.freeTransfers} FT · £${r.bank.toFixed(1)}m ITB · planning GW${r.horizon[0]}${r.horizon.length > 1 ? `–${r.horizon[r.horizon.length - 1]}` : ''}`;
  $('#options').innerHTML = r.options.map((o, i) => optionHtml(o, i === r.recommendedOption, r)).join('');
  const alts = [...r.alternatives.singles, ...r.alternatives.doubles];
  $('#alternatives').innerHTML = alts.length
    ? `<div class="options" style="margin-top:10px">${alts.map((o) => optionHtml(o, false, r, true)).join('')}</div>`
    : '<p class="muted small">No other affordable upgrades found.</p>';

  // pitch
  const newIds = new Set(r.options[r.recommendedOption].in.map((p) => p.id));
  $('#formation').textContent = `Formation ${rec.formation}`;
  const rows = [1, 2, 3, 4].map((pos) => rec.xi.filter((p) => p.pos === pos));
  $('#pitch').innerHTML = rows.map((row) => `<div class="prow">${row.map((p) => playerCard(p, newIds)).join('')}</div>`).join('');
  $('#bench').innerHTML = `<div class="lbl">Bench (sub order)</div><div class="prow">${rec.bench.map((p, i) => `<div><div class="ord" style="text-align:center">${i === 0 ? 'GK' : i}</div>${playerCard(p, newIds)}</div>`).join('')}</div>`;

  // tips
  $('#tips').innerHTML = r.tips.map((t) => `<li class="${t.level}"><span class="tt">${esc(t.type)}</span>${esc(t.text)}</li>`).join('');
  $('#chips').innerHTML = r.chips.length
    ? r.chips.map((c) => `<span class="chip">${esc(c.label)}: ${signed(c.gain)} pts this GW</span>`).join('')
    : '';

  renderTable(rec);
}

function optionHtml(o, isRec, r, compact = false) {
  const title = o.n === 0 ? 'Roll / no transfers' : `${o.n} transfer${o.n > 1 ? 's' : ''}`;
  const moves = o.n === 0
    ? `<div class="muted small">Keep your squad${r.freeTransfers < 5 ? ` and bank the free transfer (${Math.min(5, r.freeTransfers + 1)} FTs next week)` : ''}.</div>`
    : o.out.map((out, i) => {
      const inn = o.in[i];
      return `<div class="move"><span class="out">${esc(out.name)}</span> <span class="muted small">${esc(out.team)} £${out.sell.toFixed(1)} · ${out.horizonEp.toFixed(1)} xPts</span> → <span class="in">${esc(inn.name)}</span> <span class="muted small">${esc(inn.team)} £${inn.price.toFixed(1)} · ${inn.horizonEp.toFixed(1)} xPts${inn.status !== 'a' ? ' ⚠' : ''}</span></div>`;
    }).join('');
  const span = r.horizon.length;
  return `<div class="opt ${isRec ? 'rec' : ''}">
    <div>
      <h3>${compact ? '' : esc(title)} ${isRec ? '<span class="badge">Recommended</span>' : ''} ${o.hit ? `<span class="badge hit">−${o.hit} hit</span>` : ''}</h3>
      <div class="moves">${moves}</div>
      ${o.n ? `<div class="muted small" style="margin-top:4px">Bank after: £${o.bankAfter.toFixed(1)}m · next GW ${signed(o.gainNext)} pts</div>` : ''}
    </div>
    <div class="gain">${o.n ? `<b>${signed(o.net)}</b><span class="muted small">net xPts over ${span} GW${span > 1 ? 's' : ''}</span>` : '<b>±0</b><span class="muted small">baseline</span>'}</div>
  </div>`;
}

function playerCard(p, newIds) {
  const fx = p.fixtures.length ? p.fixtures.map(fxLabel).join(', ') : 'No fixture';
  const flag = p.status !== 'a' ? `<span class="warnf ${p.chance === 0 || ['i', 's', 'u', 'n'].includes(p.status) && !p.chance ? 'bad' : ''}" title="${esc(p.news)}">!</span>` : '';
  const cap = p.captain ? '<span class="cap">C</span>' : p.vice ? '<span class="cap v">V</span>' : '';
  return `<div class="pl ${newIds.has(p.id) ? 'new' : ''}" title="${esc(p.fullName)} · ${esc(p.team)} · 10th–90th pct: ${p.sim?.p10 ?? '-'}–${p.sim?.p90 ?? '-'} pts">
    ${cap}${flag}<div class="shirt" style="background:${teamColor(p.teamId)}"></div>
    <div class="name">${esc(p.name)}</div><div class="fx">${esc(fx)}</div><div class="xp">${p.ep.toFixed(1)}</div></div>`;
}

// Distinct but generic per-club hues (not official kits).
function teamColor(id) {
  const hue = (id * 137.508) % 360;
  return `hsl(${hue} 70% 52%)`;
}

function renderTable(rec) {
  const rows = [...rec.xi.map((p) => ({ ...p, bench: false })), ...rec.bench.map((p) => ({ ...p, bench: true }))];
  const maxEp = Math.max(...rows.map((p) => p.ep), 1);
  const head = ['Player', 'Pos', 'Next fixture(s)', 'xPts', 'Range (10–90%)', '60+ min', 'Clean sheet', 'Blank %', 'Haul %', 'xPts horizon', 'Upcoming'];
  $('#ptable').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((p) => `
    <tr class="${p.bench ? 'benchrow' : ''}">
      <td><b>${esc(p.name)}</b>${p.captain ? ' (C)' : p.vice ? ' (V)' : ''} <span class="muted">${esc(p.team)}</span>${p.status !== 'a' ? ` <span title="${esc(p.news)}">⚠</span>` : ''}</td>
      <td>${POS[p.pos]}${p.bench ? ' · bench' : ''}</td>
      <td>${p.fixtures.map((f) => `<span class="fdr fdr-${f.fdr}">${esc(fxLabel(f))}</span>`).join('') || '<span class="muted">blank</span>'}</td>
      <td><span class="bar" style="width:${Math.max(2, (p.ep / maxEp) * 40)}px"></span>${p.ep.toFixed(1)}</td>
      <td>${p.sim ? `${p.sim.p10.toFixed(0)}–${p.sim.p90.toFixed(0)}` : '-'}</td>
      <td>${Math.round(p.reliability * 100)}%</td>
      <td>${p.pos <= 3 && p.fixtures.length ? Math.round(p.fixtures[0].pCS * 100) + '%' : '-'}</td>
      <td>${p.sim ? Math.round(p.sim.pBlank * 100) + '%' : '-'}</td>
      <td>${p.sim ? Math.round(p.sim.pHaul * 100) + '%' : '-'}</td>
      <td>${p.horizonEp.toFixed(1)}</td>
      <td>${p.nextFixtures.map((g) => g.map((f) => `<span class="fdr fdr-${f.fdr}">${esc(f.opp)}${f.home ? '' : ' a'}</span>`).join('') || '<span class="fdr">–</span>').join('')}</td>
    </tr>`).join('')}</tbody>`;
}

function histogramSvg(P) {
  const bins = P.histogram;
  const W = 640, H = 130, pad = 22;
  const maxN = Math.max(...bins.map((b) => b.n));
  const lo = bins[0].from, hi = bins[bins.length - 1].to + 1;
  const x = (v) => pad + ((v - lo) / (hi - lo)) * (W - 2 * pad);
  const bw = (W - 2 * pad) / bins.length;
  const bars = bins.map((b, i) => {
    const h = (b.n / maxN) * (H - 40);
    const mid = (b.from + b.to) / 2;
    const fill = mid < P.worst ? 'var(--bad)' : mid > P.best ? 'var(--accent)' : 'var(--brand-2)';
    return `<rect x="${pad + i * bw + 1}" y="${H - 22 - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2" fill="${fill}" opacity="0.8"><title>${b.from}–${b.to} pts: ${(b.n / 100).toFixed(1)}%</title></rect>`;
  }).join('');
  const marker = (v, label) => `<line x1="${x(v)}" x2="${x(v)}" y1="8" y2="${H - 22}" stroke="var(--ink)" stroke-dasharray="3 3" opacity=".6"/><text x="${x(v)}" y="10" text-anchor="middle" font-size="11" fill="var(--muted)">${label}</text>`;
  const ticks = [];
  const step = Math.max(5, Math.round((hi - lo) / 8 / 5) * 5);
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(`<text x="${x(t)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${t}</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of simulated points">${bars}${marker(P.worst, 'worst')}${marker(P.base, 'base')}${marker(P.best, 'best')}${ticks.join('')}</svg>`;
}

// ---------- wiring ----------
function initTabs() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab));
  }));
}

function initDrop() {
  const drop = $('#drop'), input = $('#imageInput');
  input.addEventListener('change', () => handleImage(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleImage(e.dataTransfer.files[0]));
  document.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { $('.tab[data-tab="image"]').click(); handleImage(f); }
  });
}

function countdown(deadline) {
  const ms = Date.parse(deadline) - Date.now();
  if (ms <= 0) return 'deadline passed';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

async function init() {
  initTabs();
  initDrop();
  $('#idForm').addEventListener('submit', importTeam);
  $('#analyseBtn').addEventListener('click', analyse);
  $('#clearBtn').addEventListener('click', () => { state.squad = { 1: [], 2: [], 3: [], 4: [] }; state.sellPrices = {}; state.chipsAvailable = null; notice(''); afterSquadChange(); });
  ['#bank', '#ft', '#horizon'].forEach((s) => $(s).addEventListener('change', save));
  try {
    const d = await api('/api/players');
    state.players = d.players;
    state.byId = new Map(d.players.map((p) => [p.id, p]));
    state.gw = d.gw;
    const dl = new Date(d.deadline);
    $('#gwPill').innerHTML = `Next: <b>GW${d.gw}</b> · deadline ${dl.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (${countdown(d.deadline)})`;
    restore();
    renderSquad();
  } catch (err) {
    $('#gwPill').textContent = 'FPL data unavailable';
    notice(`Couldn't load live FPL data: ${esc(err.message)}`, 'bad');
  }
}

init();
