// Install / uninstall HWSS (developer installer; players use the release package's install.py).
// Puts the bundle (mod/hwss.js, names.js, split.js, p2.js, audio.js, world2.js) at the top of
// webroot/js/dependencies.js, writes webroot/hwss/config.json, and appends mod/steamguard.js to
// app.asar.unpacked/node_modules/steamworks.js/index.js (main process). Both additions sit between
// /*HWSS-BEGIN*/ and /*HWSS-END*/ markers: reinstalling replaces them, --uninstall strips them.
//   node tools/install.js            install (or reinstall); keeps an existing dev server setting
//   node tools/install.js --dev      same, with the dev server enabled in config
//   node tools/install.js --release  release-like config (no dev server, forceSplit off)
//   node tools/install.js --uninstall
// Game folder: env HW_DIR, else found through Steam's libraryfolders.vdf.
const fs = require('fs');
const path = require('path');

const APPID = '4705510';
const BEGIN = '/*HWSS-BEGIN*/', END = '/*HWSS-END*/\n';

function findGameDir() {
  if (process.env.HW_DIR) return process.env.HW_DIR;
  const steamRoots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  for (const root of steamRoots) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    const text = fs.readFileSync(vdf, 'utf8');
    const libs = [...text.matchAll(/"path"\s+"([^"]+)"/g)].map(m => m[1].replace(/\\\\/g, '\\'));
    for (const lib of libs) {
      const manifest = path.join(lib, 'steamapps', `appmanifest_${APPID}.acf`);
      if (!fs.existsSync(manifest)) continue;
      const dir = /"installdir"\s+"([^"]+)"/.exec(fs.readFileSync(manifest, 'utf8'));
      if (dir) return path.join(lib, 'steamapps', 'common', dir[1]);
    }
  }
  throw new Error('Happy Wheels not found; set HW_DIR to the game folder');
}

function strip(text) {
  const a = text.indexOf(BEGIN);
  if (a < 0) return text;
  const b = text.indexOf(END, a);
  if (b < 0) throw new Error('dependencies.js has a broken HWSS block; restore from Steam (Verify files)');
  return text.slice(0, a) + text.slice(b + END.length);
}

const args = process.argv.slice(2);
const gameDir = findGameDir();
const webroot = path.join(gameDir, 'resources', 'webroot');
const depsPath = path.join(webroot, 'js', 'dependencies.js');
const hwssDir = path.join(webroot, 'hwss');
const original = strip(fs.readFileSync(depsPath, 'utf8'));
// Main-process Steam guard (app.asar.unpacked is outside the asar integrity check).
const steamPath = path.join(gameDir, 'resources', 'app.asar.unpacked', 'node_modules', 'steamworks.js', 'index.js');
const steamOriginal = strip(fs.readFileSync(steamPath, 'utf8'));

if (args.includes('--uninstall')) {
  fs.writeFileSync(depsPath, original);
  fs.writeFileSync(steamPath, steamOriginal);
  fs.rmSync(hwssDir, { recursive: true, force: true });
  console.log('HWSS removed from', gameDir);
  process.exit(0);
}

const mod = ['hwss.js', 'names.js', 'split.js', 'p2.js', 'audio.js', 'world2.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'mod', f), 'utf8')).join('\n');
fs.mkdirSync(hwssDir, { recursive: true });
const cfgPath = path.join(hwssDir, 'config.json');
let cfg = {};
if (fs.existsSync(cfgPath)) { try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {} }
cfg.devServer = args.includes('--dev') ? 'http://127.0.0.1:8737' : (cfg.devServer && !args.includes('--release') ? cfg.devServer : '');
delete cfg.blockOnlineWrites; delete cfg.readActions;   // old keys
// webpack chunk array name of this game build (differs between the Windows and Linux builds)
{ const m = /self\.(\w+)\s*=\s*self\.\1\s*\|\|\s*\[\]/.exec(original); if (m) cfg.chunkGlobal = m[1]; else delete cfg.chunkGlobal; }
if (cfg.blockTotalJerkFace === undefined) cfg.blockTotalJerkFace = true;
// Steam achievements + stats: allowed by default, co-op included (TheSplitScreenGuy's choice 2026-11-08); true blocks them.
// (Replaces the old blockAchievements key, which defaulted to true.)
delete cfg.blockAchievements;
if (cfg.blockSteamAchievements === undefined) cfg.blockSteamAchievements = false;
if (cfg.blockSentry === undefined) cfg.blockSentry = true;
if (!Array.isArray(cfg.allowPostActions)) cfg.allowPostActions = [];
// Online mode (TheSplitScreenGuy's choice 2026-11-06): allow everything except the replay/leaderboard upload.
if (cfg.onlineMode === undefined) cfg.onlineMode = 'blocklist';
// Replay upload: allowed solo, blocked for co-op attempts (TheSplitScreenGuy's choice 2026-11-06).
cfg.blockPostActions = (Array.isArray(cfg.blockPostActions) ? cfg.blockPostActions : []).filter(a => a !== '/replay.hw:create');
if (!Array.isArray(cfg.blockPostActionsCoop)) cfg.blockPostActionsCoop = ['/replay.hw:create'];
// Split view: --force-split turns it on without P2 (testing); --no-force-split turns it off.
if (args.includes('--force-split')) cfg.forceSplit = true;
if (args.includes('--no-force-split') || args.includes('--release')) cfg.forceSplit = false;
if (cfg.forceSplit === undefined) cfg.forceSplit = false;
if (cfg.splitBandOffset === undefined) cfg.splitBandOffset = 0;
delete cfg.autoLetterbox;   // feature removed at TheSplitScreenGuy's request
if (cfg.ghosts === undefined) cfg.ghosts = true;            // separate worlds: show the other rider as a ghost
if (cfg.ghostAlpha === undefined) cfg.ghostAlpha = 0.4;
if (cfg.splitBandTop === undefined) cfg.splitBandTop = 170;   // horizontal split: first row of each player's view shown
if (cfg.splitBandLeft === undefined) cfg.splitBandLeft = 175; // vertical split: first column shown
if (cfg.splitZoom === undefined) cfg.splitZoom = 0.7;   // <1 = zoomed out in the cropped split modes
// default 2-player view mode: horizontal | vertical | fit | fitv | stretch | shared | p1; the pause-menu
// toggle overrides it (localStorage)
if (cfg.splitOrientation === undefined) cfg.splitOrientation = 'horizontal';
if (cfg.p2Pad === undefined) cfg.p2Pad = 'auto';            // "auto" or a pad index
if (cfg.playersCollide === undefined) cfg.playersCollide = false;
if (cfg.p2ShirtHue === undefined) cfg.p2ShirtHue = 0;          // degrees (0 red, 120 green, 240 blue); false = off
// TheSplitScreenGuy's colours (2026-11-06): P1 blue (co-op only), P2 red, P3 green, P4 yellow
if (cfg.p3ShirtHue === 220 && cfg.p4ShirtHue === 120) { cfg.p3ShirtHue = 120; cfg.p4ShirtHue = 55; }   // old defaults
if (cfg.p1ShirtHue === undefined) cfg.p1ShirtHue = 220;        // P1 blue
if (cfg.p3ShirtHue === undefined) cfg.p3ShirtHue = 120;        // P3 green
if (cfg.p4ShirtHue === undefined) cfg.p4ShirtHue = 55;         // P4 yellow
// Extra clips tinted in each player's colour per character tag (besides torso/arms; the key name is
// historical). Char2 = segway guy: suit pants.
if (!cfg.p2TintExtra || typeof cfg.p2TintExtra !== 'object') cfg.p2TintExtra = {};
if (!cfg.p2TintExtra.Char2) cfg.p2TintExtra.Char2 = ['pelvisMC', 'upperLeg1MC', 'upperLeg2MC', 'upperLeg3MC', 'upperLeg4MC', 'lowerLeg1MC', 'lowerLeg2MC'];
// Char3 = Irresponsible Dad: bike frame (also the snapped frame) and fork in the player's colour
if (!cfg.p2TintExtra.Char3) cfg.p2TintExtra.Char3 = ['frameMC', 'brokenFrameMC', 'forkMC'];
// Read-only POST actions TheSplitScreenGuy approved (see docs/HANDOFF.md).
for (const a of ['get_featured', 'get_record', 'rate_level', 'get_all', 'search_by_name', 'set_favorite', 'get_favorites', 'delete_favorite']) if (!cfg.allowPostActions.includes(a)) cfg.allowPostActions.push(a);
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

// Keep the "/*! license */" banner first; insert our block right after it.
const nl = original.indexOf('\n');
const head = original.startsWith('/*!') ? original.slice(0, nl + 1) : '';
const rest = original.slice(head.length);
fs.writeFileSync(depsPath, head + BEGIN + mod + '\n' + END + rest);
const guard = fs.readFileSync(path.join(__dirname, '..', 'mod', 'steamguard.js'), 'utf8');
fs.writeFileSync(steamPath, steamOriginal.replace(/\s*$/, '\n') + BEGIN + guard + '\n' + END);
console.log('Steam guard installed into', steamPath);
console.log('HWSS installed into', gameDir);
console.log('config:', JSON.stringify(cfg));
