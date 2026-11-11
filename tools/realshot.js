// Save the REAL game canvas (full resolution) as a PNG: node tools/realshot.js [out.png]
const http = require('http'), fs = require('fs'), path = require('path');
const out = process.argv[2] || path.join(__dirname, '..', 'logs', 'now.png');
const code = fs.readFileSync(path.join(__dirname, 'probes', '91_realshot.js'), 'utf8');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: 8737, method: m, path: p, headers: { 'content-type': 'application/json' } },
      x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res(JSON.parse(d.replace(/^﻿/, '')))); });
    r.on('error', rej); if (b) r.write(b); r.end();
  });
}
(async () => {
  const { id } = await req('POST', '/enqueue', JSON.stringify({ code }));
  const r = await req('GET', '/wait?id=' + id);
  if (!r.ok || !r.value) { console.error('failed', r.error); process.exit(1); }
  fs.writeFileSync(out, Buffer.from(r.value.split(',')[1], 'base64'));
  console.log('saved', out);
})();
