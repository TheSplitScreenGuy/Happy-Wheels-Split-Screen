#!/usr/bin/env python3
"""Happy Wheels splitscreen mod (HWSS) installer for Steam Deck / Linux (also works on Windows).

  python3 install.py               install (or reinstall / update)
  python3 install.py --uninstall   remove the mod
  python3 install.py --game "/path/to/Happy Wheels"   use this game folder

What it changes (nothing inside app.asar, which the game checks):
  resources/webroot/js/dependencies.js   the mod is inserted between /*HWSS-BEGIN*/ and /*HWSS-END*/
  resources/webroot/hwss/config.json     mod settings
  resources/app.asar.unpacked/node_modules/steamworks.js/index.js
                                         steam guard appended (main process: 2-monitor window mode;
                                         Steam achievements / stats allowed unless config
                                         "blockSteamAchievements": true)
Steam's "Verify integrity of game files" also restores everything.
"""
import json
import os
import re
import sys

APPID = '4705510'
BEGIN, END = '/*HWSS-BEGIN*/', '/*HWSS-END*/\n'
HERE = os.path.dirname(os.path.abspath(__file__))


def steam_roots():
    home = os.path.expanduser('~')
    cands = [
        os.path.join(home, '.local/share/Steam'),
        os.path.join(home, '.steam/steam'),
        os.path.join(home, '.steam/root'),
        os.path.join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam'),
        r'C:\Program Files (x86)\Steam',
        r'C:\Program Files\Steam',
    ]
    seen, out = set(), []
    for c in cands:
        r = os.path.realpath(c)
        if os.path.isdir(r) and r not in seen:
            seen.add(r)
            out.append(r)
    return out


def find_game():
    for root in steam_roots():
        vdf = os.path.join(root, 'steamapps', 'libraryfolders.vdf')
        libs = [root]
        if os.path.isfile(vdf):
            with open(vdf, encoding='utf-8', errors='replace') as f:
                libs += [m.replace('\\\\', '\\') for m in re.findall(r'"path"\s+"([^"]+)"', f.read())]
        for lib in libs:
            manifest = os.path.join(lib, 'steamapps', 'appmanifest_%s.acf' % APPID)
            if not os.path.isfile(manifest):
                continue
            with open(manifest, encoding='utf-8', errors='replace') as f:
                m = re.search(r'"installdir"\s+"([^"]+)"', f.read())
            if m:
                d = os.path.join(lib, 'steamapps', 'common', m.group(1))
                if os.path.isdir(d):
                    return d
    return None


def read(p):
    with open(p, encoding='utf-8', newline='') as f:
        return f.read()


def write(p, text):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def strip(text, what):
    a = text.find(BEGIN)
    if a < 0:
        return text
    b = text.find(END, a)
    if b < 0:
        sys.exit('%s has a broken HWSS block. In Steam: Happy Wheels > Properties > Installed Files > '
                 'Verify integrity of game files, then run this again.' % what)
    return text[:a] + text[b + len(END):]


def main():
    args = sys.argv[1:]
    game = None
    if '--game' in args:
        i = args.index('--game')
        if i + 1 < len(args):
            game = args[i + 1]
    game = game or find_game()
    if not game or not os.path.isdir(game):
        sys.exit('Happy Wheels was not found. Run again with: python3 install.py --game "/path/to/Happy Wheels"')
    print('Game folder:', game)

    res = os.path.join(game, 'resources')
    webroot = os.path.join(res, 'webroot')
    deps = os.path.join(webroot, 'js', 'dependencies.js')
    hwss_dir = os.path.join(webroot, 'hwss')
    steam = os.path.join(res, 'app.asar.unpacked', 'node_modules', 'steamworks.js', 'index.js')
    for p in (deps, steam):
        if not os.path.isfile(p):
            sys.exit('Expected file is missing: %s\n(This installer was made for the Steam version of Happy Wheels.)' % p)

    deps_orig = strip(read(deps), 'dependencies.js')
    steam_orig = strip(read(steam), 'steamworks.js/index.js')

    if '--uninstall' in args:
        write(deps, deps_orig)
        write(steam, steam_orig)
        cfg = os.path.join(hwss_dir, 'config.json')
        if os.path.isfile(cfg):
            os.remove(cfg)
        if os.path.isdir(hwss_dir) and not os.listdir(hwss_dir):
            os.rmdir(hwss_dir)
        print('HWSS removed.')
        return

    bundle = read(os.path.join(HERE, 'files', 'hwss-bundle.js'))
    guard = read(os.path.join(HERE, 'files', 'steamguard.js'))
    with open(os.path.join(HERE, 'files', 'config.json'), encoding='utf-8') as f:
        cfg = json.load(f)

    # keep settings from an earlier install; always release mode (no dev server)
    os.makedirs(hwss_dir, exist_ok=True)
    cfg_path = os.path.join(hwss_dir, 'config.json')
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, encoding='utf-8') as f:
                old = json.load(f)
            for k, v in old.items():
                if k in cfg and k not in ('devServer', 'forceSplit', 'chunkGlobal'):
                    cfg[k] = v
        except Exception:
            pass
    cfg['devServer'] = ''
    cfg['forceSplit'] = False
    # webpack chunk array name of this game build (differs between builds and game versions)
    m = re.search(r'self\.(\w+)\s*=\s*self\.\1\s*\|\|\s*\[\]', deps_orig)
    if m:
        cfg['chunkGlobal'] = m.group(1)
    else:
        cfg.pop('chunkGlobal', None)
    with open(cfg_path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')

    # keep the "/*! license */" banner first; insert the mod right after it
    nl = deps_orig.find('\n')
    head = deps_orig[:nl + 1] if deps_orig.startswith('/*!') else ''
    write(deps, head + BEGIN + bundle + '\n' + END + deps_orig[len(head):])
    write(steam, steam_orig.rstrip() + '\n' + BEGIN + guard + '\n' + END)
    print('HWSS installed. Start Happy Wheels from Steam.')
    print('(After a game update, run this again. To remove: python3 install.py --uninstall)')


if __name__ == '__main__':
    main()
