# The PATCHES format

A project is any folder containing `PATCHES/`. Everything the built add-on contains beyond the engine's generic systems comes from there.

```
PATCHES/
  project.json          required
  characters/*.json     character types (species)
  classes/*.json        classes: stats, growth, positioning, skill tree
  abilities/*.json      abilities
  quests/*.json         quests
  scripts/**/*.js       content scripts (every file is imported once at startup)
  lang/<locale>.lang    translation strings, merged after the engine's
  bp/**                 files copied into the behavior pack as-is (override engine files at the same path)
  rp/**                 files copied into the resource pack as-is (textures, models, sounds, ...)
```

Text files in the engine templates may use placeholders that your `project.json` fills in: `{{ns}}` (namespace), `{{char}}` (character key), `{{Char}}`, `{{chars}}`, `{{Chars}}` (display nouns). Your own `bp/`/`rp/` files are copied verbatim.

## project.json

```jsonc
{
  "name": "My Heroes",                 // pack name
  "description": "...",
  "version": [1, 0, 0],
  "authors": ["you"],
  "minEngineVersion": [1, 21, 0],
  "engine": "../OpenChara",            // path to this repo, relative to the project folder

  "namespace": "mh",                   // every id: mh:hero, mh:hero:<id>:A, mh_hero ...
  "character": {
    "key": "hero",                     // entity id + storage key segment - never change after release
    "nouns": { "one": "hero", "many": "heroes" },   // player-facing text
    "geometry": "geometry.my_rig",     // shared rig for all characters
    "material": "entity_alphatest"
  },
  "chatTag": "MH",                     // optional, defaults to the namespace upper-cased

  "packs": {                           // generate fresh UUIDs once and never change them
    "behavior": { "folder": "My Heroes B", "uuid": "...", "dataModuleUuid": "...", "scriptModuleUuid": "..." },
    "resource": { "folder": "My Heroes R", "uuid": "...", "moduleUuid": "..." }
  },
  "scriptModules": { "@minecraft/server": "2.6.0", "@minecraft/server-ui": "2.0.0" },

  "navigationSlots": 10000,            // max simultaneous pathfinding moves across the whole world
  "devTools": false,                   // include the /scriptevent test harnesses
  "contentScripts": ["main.js"]        // optional: only these are entry points (default: every file)
}
```

> **`namespace`, `character.key`, character `index` values and pack UUIDs are stored in players' worlds.** Changing any of them after release orphans existing saves.

## characters/\<id\>.json

```json
{
  "id": "march7",
  "index": 0,
  "displayName": "March 7th",
  "class": "frost_marksman",
  "texture": "textures/entity/march7",
  "favoriteGifts": ["minecraft:cake"],
  "eidolonCost": [{ "item": "minecraft:amethyst_shard", "amount": 16 }]
}
```

`index` is written onto every spawned entity and picks the texture from the generated render controller. Give each character a unique, permanent number; gaps are fine. Put the texture file itself under `rp/`.

## classes/\<id\>.json

```json
{
  "id": "frost_marksman",
  "displayName": "Frost Marksman",
  "positioning": { "role": "ranged", "preference": "elevatedFlank", "flankBias": 0.4 },
  "baseStats": { "maxHp": 800, "atk": 90, "def": 40, "spd": 100, "critRate": 0.05, "critDmg": 0.5, "energyRegen": 1, "effectHitRate": 0, "effectRes": 0, "breakEffect": 0 },
  "perLevelGrowth": { "maxHp": 42, "atk": 5.5, "def": 2.2 },
  "defaultAbilities": ["frost_arrow"],
  "ultimate": null,
  "skillTree": { "nodes": {
    "deepfreeze_1": { "cost": 1, "prerequisites": [], "effect": { "atkPct": 0.05 }, "description": [{ "type": "text", "value": "+5% ATK" }] }
  } }
}
```

`positioning.role` (`"melee"` or `"ranged"`) also picks the entity's combat behavior. A class named `generalist` exists by default and is used when a character has no class.

## abilities/\<id\>.json and quests/\<id\>.json

Descriptions use the **rich content** block format, an array of `{ "type": "text" | "heading" | "bulletList" | "numberedList" | "checklist", ... }` blocks.

A quest's `conditions` use the shared condition registry:

| type | kind | params |
|---|---|---|
| `counterThreshold` | poll | `category`, `subject`, `target` |
| `relationshipLevel` | poll | `track`, `target` |
| `onKill` | event | `target`, optional `subject` (mob type) |
| `onDamageDealt` / `onDamageTaken` / `onHealingDone` | event | `target` |
| `onTimeInCombat` | tick | `target` (seconds) |

Event and tick conditions count from when the quest is started. A quest's optional `species` list restricts which characters can take it. `rewards` may contain `skillPoints`, `rank`, `eidolonLevel`, `cutsceneUnlock`.

## scripts/

Content scripts run after the engine starts. Import the engine through its public API only:

```js
import { world } from "@minecraft/server";
import { createCharacter, manifestCharacter, NS } from "../openchara/api.js";
```

Scripts in subfolders import it with an extra `../` (e.g. `../../openchara/api.js`). Anything not exported from `api.js` is internal and may change.
