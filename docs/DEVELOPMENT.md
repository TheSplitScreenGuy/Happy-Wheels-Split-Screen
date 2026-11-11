# Developing HWSS

Notes for anyone who wants to change or fix the mod. Players only need the [README](../README.md).

## How the mod hooks the game

Happy Wheels on Steam is the old Flash game ported to JavaScript, running in an Electron app. Its scripts sit
unpacked in `resources/webroot/`. The mod is plain JavaScript in two places:

- **Renderer (the game page):** the bundle `hwss.js + names.js + split.js + p2.js + audio.js + world2.js` is
  inserted at the top of `webroot/js/dependencies.js`, so it runs before any game code.
- **Main process:** `steamguard.js` is appended to `app.asar.unpacked/node_modules/steamworks.js/index.js`
  (outside `app.asar`, which the game integrity-checks).

Both additions sit between `/*HWSS-BEGIN*/` and `/*HWSS-END*/`, so reinstalling replaces them and uninstalling
strips them. Settings come from `webroot/hwss/config.json`; choices made in the game's menus are saved in
`localStorage` under `hwss.*` keys and win over the config.

At run time the mod finds what it needs **by shape, not by name**: it pushes a chunk onto the game's webpack
array to get `__webpack_require__` (`H.req`), then finds the Pixi renderer, Box2D world, the level session, the
camera and so on by the members they have. Everything is reached through the global `window.__HWSS__` (`H`).

What each file does:

| File | Role |
|---|---|
| `mod/hwss.js` | loader: config, network filter (`verdict()`), dev-server logging, webpack chunk name |
| `mod/names.js` | name layer for 1.99.3 (see below) |
| `mod/split.js` | discovery, render hook, split layouts, extra cameras, shared screen, monitor mode, markers, spectate, the level-complete winner, art cache |
| `mod/p2.js` | extra players: pads, spawning, input, contact dispatch ("run as player n"), character select, menus and cursors, colours, scoreboard, F-keys |
| `mod/audio.js` | per-player sound (loudest of all listeners wins) |
| `mod/world2.js` | separate worlds: a full copy of the level per extra player |
| `mod/steamguard.js` | main process: two-monitor window spanning, optional Steam achievement/stat blocking |

### Extra players in one world

An extra player is another instance of P1's character class, built the way the session builds P1. P1's
per-step calls (`preActions`, `checkKeyStates`, `actions`, contact handling, `paint`, ...) are wrapped and
repeated for every extra rider. While a rider's code or one of its physics contacts runs, the session's
"current character" is switched to that rider (`asPlayer` in p2.js), because level triggers, finish flags and
sub-objects (like the dad's kid) all look at the session's character. A body→player map (`bodyOwner`) is
filled at spawn and by a `CreateBody` hook; the Box2D contact filter uses it to keep riders from colliding.

### Drawing

The renderer's `render` is wrapped. In a co-op level each view is drawn into a render texture (the level
moved by that player's camera, culled for it), then the textures are laid out (bands, letterbox, quarters,
monitors). P1's view is drawn last so the stage ends the frame in P1's real view (mouse hit tests rely on it).
Errors in the split switch it off for the rest of that attempt; the game's own rendering keeps going.

## The 1.99.3 name layer

Game version 1.99.3 shipped its code obfuscated: most member names became tokens such as `$$Vq`. Instead of
rewriting the mod, `names.js` holds a table **old name → token** and adds the old names back as accessors on
the objects that own the tokens (`H.N.alias(obj)`, `H.N.aliasChar`, `H.N.aliasClass`, `H.N.aliasModules`).
Most of the mod therefore still reads like the 1.99.2 code.

Rules learned the hard way:

- **Writing an old name only works where an alias accessor exists.** On an object that never got aliased,
  `obj.oldName = x` silently creates a new, unused property while the game keeps using its token. When you
  replace or set a game member, write `H.N.real('oldName')` (or alias the object first). Several bugs were
  exactly this (a weapon hook, the Box2D shape limit, a stand-in camera target).
- **Wrapping a getter** with `defineProperty` must use the real (token) name.
- **Never read properties on game prototypes directly** while exploring: some are lazy getters with side
  effects (one blanked every level until a restart). Read descriptors (`H.N.desc` /
  `Object.getOwnPropertyDescriptor`) instead.
- Objects created by Box2D during a step (contact points etc.) are not aliased: read their fields with
  `H.N.real(...)` as a fallback (see `ptShape` in p2.js).

**After a game update** that re-randomises the tokens, the table has to be rebuilt. That was done with private
analysis tools that are not part of this repository; without a new table, readable names keep working but
the renamed members (physics steps, contact methods, character input...) won't be found.

The webpack chunk array name also changes between builds; the installers read it from `dependencies.js` into
`cfg.chunkGlobal`, and `hwss.js` can find it at run time as a fallback.

## Development setup (Windows)

Requires [Node.js](https://nodejs.org/) and the game installed through Steam.

1. Install with the dev server enabled:
   ```bash
   node tools/install.js --dev
   ```
2. Start the dev server (log file `logs/hwss.log`, command channel on `127.0.0.1:8737`) and leave it running:
   ```bash
   node tools/devserver.js
   ```
3. Restart the game through Steam:
   ```bash
   node tools/hwctl.js close
   ```
   ```bash
   node tools/hwctl.js launch
   ```

Don't reload the game page from the command channel (`location.reload()`): the game's audio comes back
muted. Reinstall and restart the game instead.

### Talking to the running game

- `node tools/hwctl.js eval "<js>"` runs an expression in the game page and prints the result
  (`__HWSS__` is the mod's object).
- `node tools/hwctl.js evalfile <file.js>` runs a file (handy for longer probes).
- `node tools/hwctl.js shot [out.png]` saves a 900×500 render of the stage; `node tools/realshot.js [out.png]`
  saves the real canvas at full resolution (catches seams the re-render misses). DOM overlays (hints,
  scoreboard, cursors) are not in either; use a normal screenshot for those.
- `tools/probes/hwtest.js` installs `window.HWT` for driving the game: `HWT.clickText('^PLAY$')`,
  `HWT.clickAt(x, y)` (900×500 coordinates), `HWT.key('F5')`, `HWT.texts(/re/)`.

Example: start a featured level from the main menu with a test rider:

```bash
node tools/hwctl.js evalfile tools/probes/hwtest.js
```
```bash
node tools/hwctl.js eval "HWT.key('F5'); HWT.clickText('^PLAY$')"
```

Note: `HWT.key('Escape')` doesn't reach the game's pause handler in 1.99.3;
`__HWSS__.PL.pressKey('Escape', 27)` (which dispatches on `document`) does.

### Testing without controllers

- **Test riders:** F5 / F3 / F4 add P2 / P3 / P4, copying P1's controls with a delay (F6 / F7: no delay for
  P3 / P4, F8: delay P1). F1 = auto-ride for everyone.
- **Fake pads:** `__HWSS__.testPads = { 1: pad }` merges fake gamepads into what the mod reads, e.g. a pad
  object `{ id, index, connected: true, mapping: 'standard', axes: [0,0,0,0], buttons: [{ pressed, value }, ...] }`.
  Press Start (`buttons[9]`) on it at the main menu to join. Set `testPads = null` to remove them.

### Tests

- `node tools/tests/steamguard_test.js`: the main-process Steam guard (achievement blocking).
- `tools/tests/shim_test.html`: browser test of the network filter; serve the repo with
  `node tools/static.js` and open `http://127.0.0.1:8738/tools/tests/shim_test.html`.

## Releasing

```bash
node tools/package.js
```

builds `release/HWSS.zip`: `install.py` (Python 3, Windows / Linux / Steam Deck), `Install (Windows).bat`,
the player README (`tools/deck/README.txt`), and `files/` (bundle, steam guard, release config with no dev
server). When you add a config setting, add its default to **both** `tools/install.js` and `tools/package.js`.
Upload the zip to a GitHub Release; `release/` is git-ignored.

## Things to know

- **Network:** with the shipped config (`onlineMode: "blocklist"`) everything goes through except the
  replay/leaderboard upload (`/replay.hw:create`) during a co-op attempt, and Sentry crash reports.
  `"allowlist"` mode blocks every POST except `allowPostActions`.
- **Two monitors (1.99.3):** the game shows its frames in its own native window, which has no resize API;
  `steamguard.js` places it with Win32 calls through a small PowerShell helper. Older builds / `--classic-window`
  use a normal BrowserWindow.
- **Box2D** allows a fixed number of shapes per world; p2.js raises it from 1024 to 4096 at start-up so four
  riders fit into busy levels.
- **Winners:** first finisher wins; for "level complete" triggers the mod remembers which player set the
  trigger (or a chain of triggers) off; an ending set off by no player (an NPC, a script) goes to the living
  player furthest along, or to nobody if all are dead. Players can correct the scoreboard with its arrows.
