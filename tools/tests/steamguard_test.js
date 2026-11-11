// Offline test for mod/steamguard.js with a fake Steamworks client: default (allowed) and blockSteamAchievements.
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hwss-'));
const src = fs.readFileSync(path.join(__dirname, '../../mod/steamguard.js'), 'utf8');
const R = [], ok = (n, c) => R.push((c ? 'PASS ' : 'FAIL ') + n);

function run(cfgJson) {
  const calls = [];
  const fakeApi = {
    achievement: { activate: n => (calls.push('activate ' + n), true), isActivated: n => (calls.push('isActivated'), false), clear: () => calls.push('clear') },
    stats: { getInt: n => (calls.push('getInt'), 7), setInt: () => (calls.push('setInt'), true), store: () => (calls.push('store'), true), resetAll: () => calls.push('resetAll') },
    cloud: { writeFile: (n) => (calls.push('write ' + n), true), readFile: () => 'x', fileExists: () => true },
    localplayer: { getName: () => 'me' },
  };
  const cfgPath = path.join(process.env.APPDATA, 'config-' + R.length + '.json');
  if (cfgJson !== null) fs.writeFileSync(cfgPath, cfgJson);
  process.env.HWSS_CONFIG = cfgPath;
  const mod = { exports: { init: () => fakeApi } };
  vm.runInNewContext(src, { module: mod, require, process, __dirname: '/nowhere' });
  return { b: mod.exports.init(4705510), calls };
}

// default: no config key → everything reaches Steam
let { b, calls } = run('{}');
ok('default: activate passes', b.achievement.activate('ACH') === true && calls.includes('activate ACH'));
ok('default: setInt + store pass', b.stats.setInt('s', 5) === true && b.stats.store() === true && calls.includes('setInt') && calls.includes('store'));
ok('default: cloud write passes', b.cloud.writeFile('achievement_progress.json', '{}') && calls.includes('write achievement_progress.json'));
({ b, calls } = run(null));
ok('no config file: allowed', b.achievement.activate('ACH') === true && calls.includes('activate ACH'));

// blockSteamAchievements: true → no achievement/stat write reaches Steam; reads + cloud pass
({ b, calls } = run('{"blockSteamAchievements": true}'));
ok('block: activate blocked', b.achievement.activate('ACH') === false);
ok('block: isActivated passes', b.achievement.isActivated('ACH') === false && calls.includes('isActivated'));
ok('block: setInt/store blocked', b.stats.setInt('s', 5) === true && b.stats.store() === true);
ok('block: getInt passes', b.stats.getInt('s') === 7);
ok('block: cloud write passes', b.cloud.writeFile('achievement_progress.json', '{}') && calls.includes('write achievement_progress.json'));
ok('block: localplayer passes', b.localplayer.getName() === 'me');
ok('block: no achievement/stat write reached Steam', !calls.some(c => /^(activate|setInt|store|clear|resetAll)/.test(c)));

const log = fs.readFileSync(path.join(process.env.APPDATA, 'HappyWheels', 'hwss-steamguard.log'), 'utf8');
ok('log written', /achievements \+ stats allowed/.test(log) && /BLOCKED achievement.activate ACH/.test(log));
console.log(R.join('\n') + '\n' + (R.every(r => r.startsWith('PASS')) ? 'ALL PASS' : 'SOME FAILED'));
