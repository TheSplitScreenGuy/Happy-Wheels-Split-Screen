HAPPY WHEELS SPLITSCREEN (HWSS)
===============================
by TheSplitScreenGuy

All of the code was written by Claude (Anthropic's AI) using Claude Code: the mod, the installers,
the tools and the docs. TheSplitScreenGuy came up with the idea and the features, made the design
calls, and play-tested everything on PC and Steam Deck.

Local co-op for the Steam version of Happy Wheels: up to 4 players on one screen.
One installer for Windows and Steam Deck / Linux (native or Proton). It needs Python 3
(SteamOS already has it; on Windows get it from python.org or the Microsoft Store).

INSTALL ON WINDOWS
  1. Extract HWSS.zip anywhere.
  2. Double-click "Install (Windows).bat"   (or in a terminal:  py install.py)
  3. Start Happy Wheels from Steam.

INSTALL ON STEAM DECK (Desktop Mode)
  1. Hold the power button > Switch to Desktop.
  2. Copy HWSS.zip to the Deck, right-click it > Extract > Extract archive here.
  3. Open the extracted HWSS folder, right-click an empty spot > Open Terminal Here, and type:
        python3 install.py
  4. Go back to Gaming Mode and start Happy Wheels.

  STEAM DECK SETUP (needed for controllers):
   - Use Proton Experimental: Happy Wheels > Properties > Compatibility > force Proton Experimental.
     (Proton GE showed no controllers at all to the game.)
   - Controller layout for Happy Wheels: the "Gamepad" template (not keyboard/mouse).
   - Playing with external controllers: reorder the controllers so the Steam Deck's own controller is
     LAST (Steam button > Controller settings > controller order). The first controller in Steam's
     order is P1; the Deck's built-in controls stay unused unless someone presses Start on them.

  The installer finds Happy Wheels by itself (any Steam library, SD card included) and prints
  "HWSS installed.". If it can't:  python3 install.py --game "/path/to/steamapps/common/Happy Wheels"
  After a Happy Wheels update (or switching Proton on/off), run the installer again.

UNINSTALL
  python3 install.py --uninstall      (Windows: py install.py --uninstall)
  or Steam > Happy Wheels > Properties > Installed Files > Verify integrity of game files

PLAYING
  - P1 uses the keyboard or the first controller in Steam's order.
  - Any other controller joins by pressing Start at the main menu (next free player: P2, P3, P4);
    Select+Start leaves. Controllers nobody pressed Start on are ignored.
  - Everyone uses P1's controller buttons (RT/LT, A, LB/RB, B to eject). Start pauses for anyone.
  - Back (on its own) in separate worlds: start over yourself, without restarting the others.
    This works for P1 too (then Back doesn't switch the camera; alone or in a shared world it still does).
  - Character select (levels that allow it): every player gets a cursor (stick/d-pad, A picks, B un-picks);
    the level starts once everyone has picked, and each player rides their own character.
    At the main menu LB/RB also cycle your character. The back button (top left) returns to the main menu.
  - Menus with controllers: every joined player gets a cursor in their colour (stick / d-pad moves it,
    A clicks); the player who paused gets one on the pause menu, everyone on the level-complete screen.
    The "Player Cursors" box on the main menu turns the menu cursors off (menus work as normal then).

SETTINGS
  Most settings are buttons in the pause menu during a co-op game, in a second column next to the
  game's own buttons. Click a button to switch to its next option. Choices are saved.

  >> RESTART THE LEVEL AFTER CHANGING A SETTING. Some settings only take effect when a level
  >> (re)starts (zoom, separate worlds), and some buttons appear or disappear depending on other
  >> settings (ghosts only in separate worlds, bars only in letterbox layouts).
  >> Pause > restart level after a change makes sure everything is applied.

  split - how the screen is divided
    With 2 players:
      horizontal     top / bottom; each player sees a wide band of their view that follows them,
                     zoomed out a bit so you see more
      vertical       side by side; a tall band per player, also zoomed out
      letterbox      each player's WHOLE normal view at half size, stacked top / bottom, bars at the
                     sides; normal zoom
      letterbox side the two whole views side by side, bars above and below
      stretch        each whole view squashed into half the screen: no bars, nothing cut off, but the
                     picture looks flattened
      shared screen  no split: ONE view that follows everyone and zooms out as players spread apart;
                     players far behind are left out of the shot until they catch up (shared worlds only)
      p1 only        only P1's view, full screen; the others still play
    With 3-4 players: zoomed (four zoomed-out quarters), full view (four whole views at half size),
      shared screen, p1 only. With 3 players the third view sits in the middle of the bottom row.
    With two monitors (monitors: 2) and 2 players: zoomed out / normal zoom / shared screen, one view
      per monitor. With 3-4 players a monitor holds two views: horizontal / vertical (cropped,
      stacked / side by side), letterbox / letterbox side (whole views), shared screen.

    Levels with cutscenes: USE LETTERBOX. Some levels (e.g. Ultimate Payback's ending) move the camera
      away from the player to show a cutscene. Only the whole-view modes (letterbox, letterbox side,
      full view with 3-4 players) keep the game's own camera, so the cutscene shows as intended. The
      zoomed / band modes and shared screen change the camera themselves and don't follow the game when
      it switches focus, so you may miss or only partly see the cutscene.

  world
      shared              same level, riders pass through each other; triggers and finishes react
                          to every player
      shared collide 2s   same level, riders can crash into each other after a 2-second grace period
      shared collide 10s  the same with a 10-second grace period (levels with long intros)
      separate            every player gets their OWN copy of the level; the others show as see-through
                          ghosts. Needed for levels whose "vehicle" is built into the level.
                          Takes effect when the level restarts.

  ghosts (separate worlds only)   on / off: the see-through copies of the other riders
  bars (letterbox layouts only)   what fills the space around a letterboxed view: black, blur (a blurred
                                  copy of that view), color (the player's colour), art (sky and hills)
  views                           smooth / fast: "fast" redraws P2-P4's views every other frame -
                                  choppier for them, but heavy levels run much faster (Steam Deck!)
  cache static art                on / off: draws level art that never moves once and reuses it; much
                                  faster on levels made of thousands of small pieces (pixel art levels)
  markers                         on / off: "P2"-style name tags above the other riders, and arrows at the
                                  screen edge pointing to players who are off-screen
  spectate                        off: your view stays where you died
                                  leader: dead for 5 seconds -> your view follows the player furthest along
                                  remove dead: dead for 2 seconds -> your view disappears and the others
                                  get the room; it comes back when you respawn (counts as off with 2 monitors)
  scoreboard                      on / off: the WINS list next to the pause / level-complete menu, with
                                  arrows to correct each count (see WHO WINS below)
  monitors (2+ monitors only)     1 / 2: "2" stretches the game over your main monitor and the one next to
                                  it: 2 players = P1 | P2, 3 = P1 | P2/P3, 4 = P1/P2 | P3/P4. Menus show on
                                  the main monitor, the other shows whose screen it is. Also on the main
                                  menu (bottom left). "1" puts the window back (fullscreen again if it was).

  On the main menu: "Player Cursors" (shown when a controller is connected) and "Monitors: 1 / 2".

  Keys:
    F5 / F3 / F4  add / remove a test rider as P2 / P3 / P4 (copies P1's controls with a short delay)
    F6 / F7       test rider P3 / P4 without the delay
    F8            delay P1's own controls by 0.5 s
    F9            P1 on keyboard + mouse only (every controller can join as P2-P4)
    F10           hand the controller to the next player (P1 > P2 > P3 > P4 > P1)
    F1            auto-ride on / off: everyone rides full throttle with random leaning and A presses
                  (handy for recording videos)
    F2            hide / show the hint text at the bottom of the main menu

WHO WINS (and why the scoreboard can be corrected)
  - The first player to finish wins: "P# Wins!" on the level-complete screen, +1 on the scoreboard.
    In separate worlds this is always exact (everyone finishes in their own copy of the level).
  - In a SHARED world it can't always be told. Happy Wheels levels were made for one player, and many
    don't end with the player touching the finish: some are completed by an NPC character (for example
    the level's villain reaching a spot after you chased it there) or by a scripted ending (a cutscene,
    a chain of triggers). No player touched anything, so the game never says who caused it.
  - Then the win goes to the player who is still alive (if several are, the one who got furthest), and
    to nobody if everyone is dead.
  - Some levels still credit the wrong player (an ending set off by an object one player pushed, or
    every rider dying in the final scene). That's why each count on the scoreboard has arrows: click
    them (mouse or a controller cursor) to fix the tally.

SAFETY
  - Steam achievements and stats work normally, in co-op too. In co-op the game can credit P1 for
    what other players (or test riders) do, e.g. a win by P2 can unlock a victory achievement.
    To block all achievement unlocks and stat writes, set "blockSteamAchievements": true in
    Happy Wheels/resources/webroot/hwss/config.json and restart the game.
  - Featured-level check marks save normally (Steam Cloud).
  - Co-op runs never upload replays or leaderboard times. Solo runs (nobody joined) work like the
    normal game, uploads included.
