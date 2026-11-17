// Zero-dependency HTTP server: static front-end + JSON API backed by the official FPL API.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyse, importEntry, playersList } = require('./lib/analyse');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
// OCR engine files are served from node_modules so screenshot reading works without a CDN.
const VENDOR = {
  '/vendor/tesseract/': path.join(__dirname, 'node_modules/tesseract.js/dist'),
  '/vendor/tesseract-core/': path.join(__dirname, 'node_modules/tesseract.js-core'),
  '/vendor/lang/': path.join(__dirname, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int'),
};
const TYPES = { '.wasm': 'application/wasm', '.gz': 'application/gzip', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/players') return send(res, 200, await playersList());
  const m = url.pathname.match(/^\/api\/entry\/(\d+)$/);
  if (req.method === 'GET' && m) return send(res, 200, await importEntry(m[1]));
  if (req.method === 'POST' && url.pathname === '/api/analyse') return send(res, 200, await analyse(await readBody(req)));
  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  let root = PUBLIC;
  for (const [prefix, dir] of Object.entries(VENDOR)) {
    if (p.startsWith(prefix)) { root = dir; p = p.slice(prefix.length - 1); break; }
  }
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
    if (root !== PUBLIC) headers['Cache-Control'] = 'public, max-age=604800';
    res.writeHead(200, headers);
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    const status = e.status && e.status < 500 ? e.status : 502;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || 'Something went wrong' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`FPL Assistant running on http://localhost:${PORT}`));
}

module.exports = server;
