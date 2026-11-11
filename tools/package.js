// Build release/HWSS.zip, ONE package for Windows and Steam Deck / Linux: Python installer (no Node
// needed), Windows .bat wrapper, the mod bundle, steam guard, release config (no dev server), README.
//   node tools/package.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'release');
const NAME = 'HWSS';
const stage = path.join(out, NAME);
for (const old of ['HWSS-SteamDeck', 'HWSS-SteamDeck.zip']) fs.rmSync(path.join(out, old), { recursive: true, force: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'files'), { recursive: true });

// same order as tools/install.js
const bundle = ['hwss.js', 'names.js', 'split.js', 'p2.js', 'audio.js', 'world2.js']
  .map(f => fs.readFileSync(path.join(root, 'mod', f), 'utf8')).join('\n');
fs.writeFileSync(path.join(stage, 'files', 'hwss-bundle.js'), bundle);
fs.copyFileSync(path.join(root, 'mod', 'steamguard.js'), path.join(stage, 'files', 'steamguard.js'));

// Release defaults (keep in sync with tools/install.js)
const cfg = {
  devServer: '',
  blockTotalJerkFace: true,
  blockSteamAchievements: false,   // true = no Steam achievement unlocks / stat writes (TheSplitScreenGuy's default: allowed)
  blockSentry: true,
  allowPostActions: ['get_featured', 'get_record', 'rate_level', 'get_all', 'search_by_name', 'set_favorite', 'get_favorites', 'delete_favorite'],
  onlineMode: 'blocklist',
  blockPostActions: [],
  blockPostActionsCoop: ['/replay.hw:create'],
  forceSplit: false,
  splitBandOffset: 0,
  ghosts: true,
  ghostAlpha: 0.4,
  splitBandTop: 170,
  splitBandLeft: 175,
  splitZoom: 0.7,
  splitOrientation: 'horizontal',
  p2Pad: 'auto',
  playersCollide: false,
  p1ShirtHue: 220,
  p2ShirtHue: 0,
  p3ShirtHue: 120,
  p4ShirtHue: 55,
  p2TintExtra: {
    Char2: ['pelvisMC', 'upperLeg1MC', 'upperLeg2MC', 'upperLeg3MC', 'upperLeg4MC', 'lowerLeg1MC', 'lowerLeg2MC'],
    Char3: ['frameMC', 'brokenFrameMC', 'forkMC'],
  },
};
fs.writeFileSync(path.join(stage, 'files', 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
fs.copyFileSync(path.join(__dirname, 'deck', 'install.py'), path.join(stage, 'install.py'));
fs.copyFileSync(path.join(__dirname, 'deck', 'README.txt'), path.join(stage, 'README.txt'));
fs.copyFileSync(path.join(__dirname, 'deck', 'Install (Windows).bat'), path.join(stage, 'Install (Windows).bat'));

// zip with forward-slash entry names (PowerShell 5's Compress-Archive writes backslashes, which break
// on Linux); Windows 10+ ships bsdtar
const zip = path.join(out, NAME + '.zip');
fs.rmSync(zip, { force: true });
execFileSync('tar', ['-a', '-c', '-f', zip, NAME], { cwd: out, stdio: 'inherit' });
console.log('built', zip, (fs.statSync(zip).size / 1024).toFixed(1) + ' KB');
