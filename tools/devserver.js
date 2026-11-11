// HWSS dev server: receives logs from the mod and serves the eval command channel.
//   node tools/devserver.js            (listens on 127.0.0.1:8737, logs to logs/hwss.log)
// Command queue: POST /enqueue {code}  -> {id};  GET /wait?id=  -> result (long-poll)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8737;
const logDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'hwss.log');

const pending = [];          // commands waiting for the game to pick up
const results = new Map();   // id -> result
const waiters = new Map();   // id -> [res]
let nextId = 1;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}
function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
}
function send(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (url.pathname === '/log' && req.method === 'POST') {
    let lines = [];
    try { lines = JSON.parse(await readBody(req)); } catch {}
    const text = lines.map(l => `${new Date(l.t).toISOString()} [${l.type}] ${typeof l.data === 'string' ? l.data : JSON.stringify(l.data)}`).join('\n');
    if (text) { fs.appendFileSync(logFile, text + '\n'); process.stdout.write(text + '\n'); }
    return send(res, 200, {});
  }
  if (url.pathname === '/cmd') return send(res, 200, pending.shift() || {});
  if (url.pathname === '/result' && req.method === 'POST') {
    try {
      const { id, result } = JSON.parse(await readBody(req));
      results.set(id, result);
      for (const w of waiters.get(id) || []) send(w, 200, result);
      waiters.delete(id);
    } catch {}
    return send(res, 200, {});
  }
  if (url.pathname === '/enqueue' && req.method === 'POST') {
    const { code } = JSON.parse(await readBody(req));
    const id = nextId++;
    pending.push({ id, code });
    return send(res, 200, { id });
  }
  if (url.pathname === '/wait') {
    const id = Number(url.searchParams.get('id'));
    if (results.has(id)) return send(res, 200, results.get(id));
    const list = waiters.get(id) || []; list.push(res); waiters.set(id, list);
    setTimeout(() => { if ((waiters.get(id) || []).includes(res)) send(res, 504, { ok: false, error: 'timeout (game not polling?)' }); }, 15000);
    return;
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`HWSS dev server on http://127.0.0.1:${PORT}, log: ${logFile}`));
