# Happy Wheels Splitscreen (HWSS)

**by TheSplitScreenGuy**

Local co-op for the Steam version of Happy Wheels: up to **4 players on one PC or Steam Deck**, each with
their own controller, character and view.

## Features

- **2–4 players** joining with Start at the main menu; everyone uses the game's controller buttons.
- **Split views:** top/bottom, side by side, letterbox, stretch, P1-only, and **shared screen** (one view
  that zooms out to keep everyone in shot). 3–4 players use quarters.
- **World modes:** shared world (riders pass through each other), shared with collisions, or
  **separate worlds** (every player gets their own copy of the level, with ghosts of the others).
- **Two monitors:** stretch the game over two screens, players split between them.
- Per-player characters on the character select screen, player colours, name tags and off-screen
  arrows, spectate modes, a win scoreboard, controller cursors in menus, and per-player sound.
- Works with user levels and the campaign; triggers and finishes react to every player.

The full player guide is in [`tools/deck/README.txt`](tools/deck/README.txt) (it ships in the download).

## Install (players)

1. Download **HWSS.zip** from the [Releases](../../releases) page and extract it.
2. **Windows:** double-click `Install (Windows).bat` (needs Python 3).
   **Steam Deck / Linux:** in the extracted folder, run `python3 install.py`.
3. Start Happy Wheels from Steam.

Uninstall: `python3 install.py --uninstall` (or Steam › Verify integrity of game files).
After a Happy Wheels update, run the installer again.

Steam Deck notes (Proton Experimental, Gamepad controller layout, controller order) are in the player guide.

## What it changes

Nothing inside the game's `app.asar`. The installer adds the mod to `resources/webroot/js/dependencies.js`
(between `/*HWSS-BEGIN*/` and `/*HWSS-END*/`), writes `resources/webroot/hwss/config.json`, and appends a
small main-process part to `resources/app.asar.unpacked/node_modules/steamworks.js/index.js` (two-monitor
window mode, optional Steam achievement blocking). No game files are included in this repository.

Online: co-op runs never upload replays or leaderboard times; solo play works like the normal game.

## Building from source

Requires [Node.js](https://nodejs.org/).

```bash
node tools/package.js
```

builds `release/HWSS.zip` (installer, README, `files/hwss-bundle.js`, `files/steamguard.js`, `files/config.json`).

Developer install straight into the game (with the local dev server for logs and live testing):

```bash
node tools/install.js --dev
```

```bash
node tools/devserver.js
```

`node tools/install.js --uninstall` removes it again.

## Layout

| Path | What |
|---|---|
| `mod/hwss.js` | loader: config, network filter, dev logging |
| `mod/names.js` | name layer for Happy Wheels 1.99.3 (maps the renamed game members back to readable names) |
| `mod/split.js` | split views, layouts, cameras, monitor mode, winner logic |
| `mod/p2.js` | extra players, controllers, menus, character select, scoreboard |
| `mod/audio.js` | per-player sound |
| `mod/world2.js` | separate worlds |
| `mod/steamguard.js` | main-process part (window spanning, Steam achievement option) |
| `tools/` | installers, packager, dev server and helpers, tests |
| `docs/PORT.md` | development notes for the 1.99.3 port (mentions some analysis tools that are not part of this repository) |

## License

[MIT](LICENSE) © 2026 TheSplitScreenGuy. The license covers this mod's code only, not Happy Wheels itself.

## Disclaimer

Fan-made mod, not affiliated with or endorsed by the makers of Happy Wheels. You need your own copy of
the game on Steam. Use at your own risk; game updates can break the mod until it is updated.
