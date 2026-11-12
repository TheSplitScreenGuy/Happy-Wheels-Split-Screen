# Happy Wheels Splitscreen (HWSS)

**by TheSplitScreenGuy**

> 🤖 **All of the code in this project was written by Claude** (Anthropic's AI) using
> [Claude Code](https://claude.com/claude-code): the mod itself, the installers, the tools and the docs.
> TheSplitScreenGuy came up with the idea and the features, made the design calls, and play-tested
> everything on PC and Steam Deck.

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

## Settings

Most settings are buttons in the **pause menu** during a co-op game (anyone besides P1 has joined), in a
second column next to the game's own buttons. Click a button to switch to its next option. Your choices are
saved and stay set after restarting the game.

> **Restart the level after changing a setting.** Some settings only take effect when a level (re)starts
> (zoom, separate worlds), and some buttons appear or disappear depending on other settings (for example
> **ghosts** only shows in separate worlds, **bars** only in letterbox layouts). Pause › **restart level**
> after a change makes sure everything is applied and the menu shows the right buttons.

### split (view mode)

How the screen is divided. The options depend on how many players there are.

**2 players**

| Option | What it does |
|---|---|
| `split: horizontal` | Top / bottom: each player gets a wide band of their view that follows their rider. The camera is zoomed out a bit so you see more. |
| `split: vertical` | Side by side: each player gets a tall band that follows their rider, also zoomed out. |
| `split: letterbox` | Each player sees their **whole** normal view at half size (stacked top / bottom), with bars at the sides. Normal zoom. |
| `split: letterbox side` | Same, but the two whole views sit side by side, with bars above and below. |
| `split: stretch` | Each player's whole view squashed into half the screen (top / bottom). No bars, nothing cut off, but the picture looks flattened. |
| `split: shared screen` | No split: **one** view that follows everyone and zooms out as players spread apart. Players who fall too far behind are left out of the shot until they catch up. Shared worlds only (skipped in separate worlds). |
| `view: p1 only` | Only P1's view, full screen. The other players still play, they just aren't shown. |

**3–4 players**

| Option | What it does |
|---|---|
| `split: zoomed` | The screen in four quarters; each shows a zoomed-out part of that player's view that follows their rider. With 3 players the third view sits in the middle of the bottom row. |
| `split: full view` | Four quarters, each showing that player's whole normal view at half size. |
| `split: shared screen` | One view for everyone (see above). |
| `view: p1 only` | Only P1's view (see above). |

**Two monitors** (`monitors: 2`): with 2 players each player gets a monitor and the options are
`split: zoomed out`, `split: normal zoom` and `split: shared screen` (one view per monitor). With 3–4 players
a monitor can hold two views: `split: horizontal` / `vertical` (cropped, zoomed out, stacked / side by side),
`split: letterbox` / `letterbox side` (whole views with bars) and `split: shared screen`.

> **Levels with cutscenes: use letterbox.** Some levels (for example *Ultimate Payback*'s ending) move the
> camera away from the player to show a cutscene. Only the whole-view modes (`letterbox`, `letterbox side`,
> and `full view` with 3–4 players) keep the game's own camera, so the cutscene shows the way the level maker
> intended. The zoomed / band modes and `shared screen` change the camera themselves and don't follow the
> game when it switches focus, so you may miss or only partly see the cutscene.

### world

| Option | What it does |
|---|---|
| `world: shared` | Everyone rides in the same level and riders pass through each other. Triggers, finishes and objects react to every player. |
| `world: shared collide 2s` | Same level, but riders can crash into each other after a 2-second grace period at the start. |
| `world: shared collide 10s` | Same, with a 10-second grace period (for levels with long intros). |
| `world: separate` | Every player gets their **own copy** of the level, so nobody can wreck anyone else's run. The other riders show as see-through ghosts. Needed for levels where the "vehicle" is built into the level. Takes effect when the level restarts. |

### ghosts *(separate worlds only)*

`ghosts: on / off`: show or hide the see-through copies of the other riders in your view.

### bars *(letterbox layouts only)*

What fills the empty space around a letterboxed view: `bars: black`, `blur` (a blurred copy of that view),
`color` (a gradient in the player's colour) or `art` (sky and hills from the game's backgrounds).

### views

`views: smooth / fast`: **fast** redraws P2–P4's views every other frame. Their views look a little choppier,
but heavy levels run much faster, especially on the Steam Deck.

### cache static art

`cache static art: on / off`: draws level art that never moves once and reuses the picture. Much faster on
levels built from thousands of small pieces (pixel art levels); no difference on simple levels.

### markers

`markers: on / off`: "P2"-style name tags above the other riders, and arrows at the edge of the screen
pointing to players who are off-screen.

### spectate

| Option | What it does |
|---|---|
| `spectate: off` | When you die, your view stays where you died. |
| `spectate: leader` | Dead for 5 seconds: your view follows the player who is furthest along. |
| `spectate: remove dead` | Dead for 2 seconds: your view disappears and the remaining players get the space. It comes back when you respawn or the level restarts. (Counts as off in two-monitor mode.) |

### scoreboard

`scoreboard: on / off`: the **WINS** list next to the pause and level-complete menus, counting each player's
wins for the session. Each count has ◀ ▶ arrows so you can correct it (see below).

#### Who wins? (and why the scoreboard is adjustable)

The first player to finish wins, and the level-complete screen shows "P# Wins!". In separate worlds this is
always exact: each player finishes in their own copy of the level.

In a **shared world** it is not always possible to tell. Happy Wheels levels were made for one player, and
many of them don't end with the player touching the finish:

- Some levels are completed by an **NPC character** (for example, the level's villain reaching a spot after
  you chase it there) or by a **scripted ending**, such as a cutscene or a chain of triggers. No player
  touched anything, so the game never says who caused it.
- In those cases the mod gives the win to the **player who is still alive** (if several are, the one who got
  furthest), and to **nobody** if everyone is dead.
- Some levels still credit the wrong player, for example when an ending is set off by an object one player
  pushed, or when every rider dies in the final scene.

That's why each count on the scoreboard has ◀ ▶ arrows: click them (mouse or a controller cursor) to fix the
tally whenever a level gets it wrong.

### monitors *(only with two or more monitors)*

`monitors: 1 / 2`: **2** stretches the game window over your main monitor and the one next to it. Players are
split between them (2 players: P1 | P2, 3: P1 | P2/P3, 4: P1/P2 | P3/P4). Menus show on the main monitor; the
other one shows whose screen it is. The same switch is on the main menu (bottom left).

### On the main menu

- **P1: Keyboard + Mouse** (checkbox, shown when a controller is connected): P1 plays with the keyboard and
  mouse, and **every** controller can join as P2, P3, P4 (press Start at the main menu). Handy when you have
  exactly one controller per extra player. Saved; F9 switches it too.
- **Player Cursors** (checkbox, shown when a controller is connected): every joined player gets their own
  cursor in menus (stick / d-pad moves it, A clicks). Untick it to use the menus the normal way. The player who
  paused always gets a cursor on the pause menu, and everyone on the level-complete screen.
- **Monitors: 1 / 2**: the two-monitor switch (see above).

### Keyboard shortcuts

| Key | What it does |
|---|---|
| F5 / F3 / F4 | Add or remove a test rider as P2 / P3 / P4 (copies P1's controls with a short delay; handy for trying things alone). |
| F6 / F7 | Test rider P3 / P4 without the delay. |
| F8 | Delay P1's own controls by 0.5 s. |
| F9 | P1 uses keyboard + mouse only (every controller can join as P2–P4); same as the main-menu checkbox, saved. |
| F10 | Hand the controller to the next player (P1 › P2 › P3 › P4). |
| F1 | Auto-ride on / off: every player rides full throttle with random leaning and A presses (for recording videos). |
| F2 | Hide / show the hint text at the bottom of the main menu. |

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
| `docs/DEVELOPMENT.md` | how the mod works, the 1.99.3 name layer, dev setup, testing, releasing |

## License

[MIT](LICENSE) © 2026 TheSplitScreenGuy. The license covers this mod's code only, not Happy Wheels itself.

## Disclaimer

Fan-made mod, not affiliated with or endorsed by the makers of Happy Wheels. You need your own copy of
the game on Steam. Use at your own risk; game updates can break the mod until it is updated.
