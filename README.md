# Travian Elephant Finder (userscript)

A Tampermonkey userscript that finds oases guarded by elephants around a point on the map, straight from your logged-in Travian tab.

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey.
2. Open the manager's dashboard, create a new script, and paste the contents of `travian-elephant-finder.user.js`. Or import the file from the Utilities tab.
3. Reload your Travian tab. A **🐘 Éléphants** button appears in the bottom-right corner.

The script runs on every `*.travian.com` game world. It only shows up on game pages, not in the lobby.

## Usage

1. Click **🐘 Éléphants** to open the panel.
2. The center is pre-filled with your active village's coordinates. Pick another one of your villages in the **Mes villages…** dropdown (the active village is marked with ●), or type any coordinates.
3. Pick a radius, then click **Lancer le scan**.
4. Elephant oases appear as map blocks come in, sorted by distance, each with a direct link to the map. Tick **Toutes les oasis** to also list oases without elephants.
5. **Exporter CSV** saves the current table.

Settings are remembered per game world. The log and the results start fresh on every scan.

| Radius | Tiles | Map requests | Typical duration |
|---|---|---|---|
| 15 | 709 | 5 | 6 s |
| 30 | 2,821 | 13 | 12 s |
| 50 | 7,845 | about 35 | 40 s |

## Settings

| Field | Default | Purpose |
|---|---|---|
| Centre X / Y | active village | Center of the search |
| Rayon | 15 | Maximum distance in tiles |
| Pause carte | 500 to 1500 ms | Random pause between two map blocks, same as adipiciu's crop finder |
| Pause détails | 3000 to 8000 ms | Pause between two tile lookups, only used when the map did not provide the animals |

## How it works

1. **Map phase.** The script calls `api/v1/map/position` at zoom level 2, the endpoint the game uses when you scroll the map. Each response covers a 21 × 17 block. The first block, centered on the search point, measures the block size and infers the world radius. The following blocks are laid out on a grid to cover the radius without overlap.
2. **Reading oases.** A free oasis is tagged `{k.fo}` and its text already lists the animals guarding it. Occupied oases (`{k.bt}`) are skipped. Results are displayed as soon as each block arrives.
3. **Details phase.** Only when the map did not provide an oasis's animals does the script open its details through `api/v1/map/tile-details`, with long pauses. If more than 40 tiles remain uncovered, the script stops and says so rather than piling up requests.

The script handles the world edge: the Travian map wraps around, and an oasis "on the other side" is found with its true distance.

On region-based worlds, zoom level 3 only returns a per-region overview. If zoom level 2 behaved the same way, the script automatically falls back to zoom level 1.

## Diagnostics

The **Diagnostic** button issues one map request around the center and copies to the clipboard a sample of the tiles returned, one per distinct shape. That is what to share if the script fails to recognize oases on some world.

## Disclaimer

Any automation is against Travian's terms of service and can get your account banned. This script greatly reduces the exposure compared with a standalone bot, but it does not remove it. Use it knowingly, preferably while you are playing normally, and avoid chaining wide-radius scans.

This script is provided for educational purposes only, "as is", without warranty of any kind. You use it at your own risk and under your sole responsibility. The author disclaims all liability for any consequence of its use, including but not limited to account suspension or banning, loss of game progress, or any other damage. By installing or running this script, you acknowledge that you have read this notice and accept these terms.

## Credits and license

- Original project: [tegos/travian-elephant-finder](https://github.com/tegos/travian-elephant-finder) by Ivan Mykhavko, MIT license. The tile-details parsing and the animal list come from it.
- Map scanning method inspired by the crop finder in [adipiciu/Travian-scripts](https://github.com/adipiciu/Travian-scripts), GPL-3.0 license.

This userscript is released under the MIT license.
