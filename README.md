# OpenChara

An open character framework for Minecraft Bedrock add-ons. OpenChara is the *systems*: a crash-safe character database, squads and tactical AI, pathfinding, stats/leveling/relationships/quests, and a UI base. What those characters actually *are*, including names, classes, abilities, quests, UI layouts and art, comes from a separate **project** made of patch files.

You write a project's `PATCHES/` folder. OpenChara builds it, together with the engine, into a normal behavior pack + resource pack.

```
OpenChara (this repo, public)          Your project (any repo, public or private)
  engine/   systems + templates  ─┐      PATCHES/
  tools/    build / dev / export  ├──►     project.json   namespace, packs, nouns
                                  │        characters/    one JSON per character
                                  │        classes/  abilities/  quests/
                                  │        scripts/       your own JS (uses the engine API)
                                  │        lang/          translations
                                  │        bp/  rp/       raw files + assets, overlaid last
                                  └──► build/  →  a ready add-on (.mcaddon or dev folders)
```

## What's in the engine

- **Character database:** each character is data the player owns, not an entity. It uses A/B rollback slots, a checksummed world-scoped mirror copy, copy-validate-commit writes, schema migrations, an integrity scan/repair that runs on join, soft-delete with a trash bin, export/import backups, ownership transfer, and gameplay counters.
- **Characters in the world:** the in-world entity is a disposable avatar that can be manifested, recalled or teleported at any time. Characters follow their player across dimensions, and duplicate avatars clean themselves up. A heavily damaged character is knocked out rather than killed.
- **Progression:** levels/XP, skill trees, eidolons, relationship tracks, character-to-character bonds, quests (with a shared condition registry), gifts, and soul tokens.
- **Squads and tactics:**
  - Standing orders (follow/stay/wander/home) and real native pathfinding to any coordinate.
  - Terrain-aware formations and perception (line of sight, threat memory, blind spots).
  - Squad coordination: target saturation and posture.
  - CQB playbooks: breach, room clear, slice the pie.
  - Hunting that cuts off the prey's escape routes first, and multi-squad army coordination.
- **UI base:** the Codex menu (placeholder forms, to be replaced by the custom UI system).

## Using it

Requires [Node.js](https://nodejs.org) 18+ (no npm packages needed).

```bash
node tools/openchara.js dev    "../My Project"   # build + deploy to Minecraft's dev folders, then auto-redeploy on every change
node tools/openchara.js check  "../My Project"   # build + validate only
node tools/openchara.js build  "../My Project"   # write the packs to <project>/build/
node tools/openchara.js export "../My Project"   # write <project>/dist/<Name> <version>.mcaddon
```

`dev` watches both your project's `PATCHES/` and this engine folder, so a `git pull` here is picked up automatically too. Every build is validated before it's deployed: JSON is parsed, JS is syntax-checked, and every import is resolved. A broken build never reaches your game; one bad import would otherwise silently kill the whole script pack.

After a script change, run `/reload` in-game. New entities, items or textures need you to rejoin the world.

## Writing a project

See [docs/PATCHES.md](docs/PATCHES.md) for the full patch format.
