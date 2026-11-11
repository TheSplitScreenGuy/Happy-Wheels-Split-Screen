// HWSS control CLI.
//   node tools/hwctl.js eval "<js expression>"   run JS in the game page, print result
//   node tools/hwctl.js launch                   start the game through Steam
//   node tools/hwctl.js close                    close the game
const { execSync, spawn } = require('child_process');
const http = require('http');

// Minimal JSON request helper (works on Node 16, which has no global fetch).
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 8737, path, method }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad response: ' + d)); } });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function evalInGame(code) {
  const { id } = await req('POST', '/enqueue', JSON.stringify({ code }));
  const r = await req('GET', '/wait?id=' + id);
  console.log(JSON.stringify(r, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'eval') evalInGame(rest.join(' ')).catch(e => { console.error(e.message); process.exit(1); });
else if (cmd === 'shot') {
  // Grab what is on screen (split composite if active) at 900x500 and save a PNG.
  const out = rest[0] || require('path').join(__dirname, '..', 'logs', 'shot.png');
  // Render exactly the 900x500 screen (split composite if active) into a texture and grab that
  // (extracting the stage directly uses its content bounds, which can be huge).
  const code = `(function(){var H=__HWSS__,R=H.renderer,P=H.P,t=(H.split&&H.split.active&&H.split.comp)||H.stage;
    var rt=P.RenderTexture.create({width:900,height:500,resolution:1});
    R.render(t,{renderTexture:rt,clear:true});
    var c=R.plugins.extract.canvas(rt);rt.destroy(true);return c.toDataURL('image/png');})()`;
  (async () => {
    const { id } = await req('POST', '/enqueue', JSON.stringify({ code }));
    const r = await req('GET', '/wait?id=' + id);
    if (!r.ok) { console.error(r.error); process.exit(1); }
    require('fs').writeFileSync(out, Buffer.from(r.value.split(',')[1], 'base64'));
    console.log('saved', out);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
else if (cmd === 'evalfile') evalInGame(require('fs').readFileSync(rest[0], 'utf8')).catch(e => { console.error(e.message); process.exit(1); });
else if (cmd === 'launch') spawn('cmd', ['/c', 'start', '', 'steam://rungameid/4705510'], { detached: true, stdio: 'ignore' }).unref();
else if (cmd === 'close') { try { execSync('taskkill /IM "Happy Wheels.exe" /F', { stdio: 'inherit' }); } catch {} }
else console.log('usage: hwctl.js eval <js> | launch | close');
