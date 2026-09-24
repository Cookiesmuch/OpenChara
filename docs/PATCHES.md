# The PATCHES format

A project is any folder containing `PATCHES/`. Everything the built add-on contains beyond the engine's generic systems comes from there.

```
PATCHES/
  project.json          required
  database/schema.json  what each character's record stores (the engine only stores it)
  characters/*.json     character types (species)
  classes/*.json        classes: stats, growth, positioning, skill tree
  abilities/*.json      abilities
  quests/*.json         quests
  scripts/**/*.js       content scripts (every file is imported once at startup)
  ui/*.ui.html, *.ui.css   custom screens, HUDs and styles (see UI.md)
  lang/<locale>.lang    translation strings over the engine's; any locale id works (see UI.md, Languages)
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

## The database: engine system, project data

OpenChara's database *system* covers storage with A/B rollback slots, a checksummed mirror, integrity repair, the trash, backups, transfer, migrations, counters, bonds and quests. What each character *stores*, and how it grows, is the project's:

**`database/schema.json`** declares the project's record fields. The engine builds blank records and validates stored ones from it, and never names a project field itself.

```json
{
  "version": 1,
  "fields": {
    "level": { "type": "number", "default": 1 },
    "relationships": { "type": "object", "default": { "trust": { "level": 0, "xp": 0 } } },
    "stats": { "type": "object", "default": null }
  },
  "bondTracks": ["friendship", "rivalry"]
}
```

Types are `string`, `number`, `boolean`, `object`, `array` or `any`, plus optional `"nullable"` and `"optional"`. The engine's core fields can't be redefined: identity, gear, inventory, squad, order, locations, quests and bond partners. Bump `version` and register a migration whenever the fields change.

**`rules`** in `project.json` tune the engine's own mechanisms: `maxRoster`, `trashGraceDays`, `maxSquads`, `maxSquadMembers`, `knockoutHp`, `knockoutSeconds`, `combatWindowSeconds`.

**Project scripts** plug the game design in through `api.js`:

| Hook | Use |
|---|---|
| `registerDerivedField(field, fn)` | cached values the engine recomputes after every write (e.g. `stats`) |
| `registerRecordInitializer(fn)` | adjust a brand-new record (starting abilities...) |
| `registerTrackCurve(fn)` | xp needed per level for every `{ level, xp }` track |
| `registerQuestReward(key, fn)` | what a quest `rewards` key does |
| `registerConditionType(type, def)` | new quest/meter condition types |
| `registerProjectMigration(fromVersion, fn)` | upgrade records when `schema.json` changes |
| `on(event, fn)` | character events: `kill`, `damageDealt`, `damageTaken`, `knockedOut`, `death`, `second`, `manifest`, `despawn`, `flush` |

Writes go through `updateCharacter(owner, id, mutate)`, `grantTracksXp(owner, id, { "path.to.track": xp })`, `grantBondXp(...)` and `queueStat(...)` / `incrementStat(...)` for counters.

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

A quest's `conditions` use the shared condition registry. The engine ships only generic types:

| type | kind | params |
|---|---|---|
| `counterThreshold` | poll | `category`, `subject`, `target`: reads a counter the project records |
| `recordValue` | poll | `path` (dotted, into the record), `target` |
| `custom` | poll | `fn(ctx)`: JS-authored conditions only |

Everything else is registered by the project with `registerConditionType`. For example, Claude Waifus adds `onKill`, `onDamageDealt`, `onTimeInCombat` (event/tick types over its own counters) and `relationshipLevel`. Event and tick conditions count from when the quest is started. A quest's optional `species` list restricts which characters can take it. Each key in `rewards` needs a handler the project registered with `registerQuestReward`.

## scripts/

Content scripts run after the engine starts. Import the engine through its public API only:

```js
import { world } from "@minecraft/server";
import { createCharacter, manifestCharacter, NS } from "../openchara/api.js";
```

Scripts in subfolders import it with an extra `../` (e.g. `../../openchara/api.js`). Anything not exported from `api.js` is internal and may change.

## ui/

Screens, HUDs and container screens are written in OpenChara's UI language. See [UI.md](UI.md) for the full reference.
