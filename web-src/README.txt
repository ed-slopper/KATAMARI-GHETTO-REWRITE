Source for katamari.html

Built on noclip.website (https://github.com/magcius/noclip.website, MIT) at commit 4cb7471.

To rebuild:
  git clone https://github.com/magcius/noclip.website && cd noclip.website
  git apply path/to/noclip-katamari.patch
  mkdir src/KatamariGame   and copy game.ts, main.ts, rust_shim.ts, index.html, build.mjs into it
  npm install --legacy-peer-deps && npm install --no-save esbuild
  node src/KatamariGame/build.mjs        -> dist-game/katamari.html

game.ts   - ball physics, level collision, pickup/growth, camera, area switching
main.ts   - boots straight into the "Make the Moon" world map
Tuning knobs are the constants at the top of game.ts (PICKUP_RATIO, GROWTH, AREA_THRESHOLDS, START_DIAMETER).

ADDING STUFF TO THE MAP
-----------------------
In the game:
  B            build mode on/off (a preview of the object appears in front of the ball)
  Q / E        previous / next object type (hold Shift to jump 10). Types are sorted small to big.
  F or Enter   place it where the preview is
  Z            undo the last thing placed
  C            copy everything placed so far as a MAP_ADDITIONS list
Things placed this way are remembered by the browser and come back when you reload.

By hand:
  Open katamari.html in a text editor. Near the top of the scripts is

      window.MAP_ADDITIONS = [
        // { id: 123, x: 14200, y: 95, z: 7600, yaw: 0 },
      ];

  One line per object: id = object type, x/y/z = position in centimetres (y is height),
  yaw = facing in radians. Press C in build mode and paste to fill this in.
  Things listed here are part of the file itself, so they go with it if you share it.

Only object types this level already uses can be placed (456 of them).
In code, everything goes through KatamariGame.addToMap() in game.ts.
