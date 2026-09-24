// Character event bus. The engine turns raw world events into
// character-level ones (it already knows which entity is which character
// and who owns her), so a project's tracking scripts never re-implement
// entity identification - they only decide what to count.
//
//   on("kill", fn)         { owner, ownerId, characterId, entity, victim, victimType }
//   on("damageDealt", fn)  { owner, ownerId, characterId, entity, target, damage }
//   on("damageTaken", fn)  { owner, ownerId, characterId, entity, source, cause, damage }
//   on("knockedOut", fn)   { owner, ownerId, characterId }
//   on("death", fn)        { owner, ownerId, characterId, cause }
//   on("second", fn)       { owner, ownerId, characterId, entity, distance, mode, inCombat }
//                          (once a second per manifested character; mode is "walked" or "swam")
//   on("manifest", fn)     { owner, characterId, entity }
//   on("despawn", fn)      { owner, characterId }
//   on("flush", fn)        { owner, characterId, deltas }  (after queued counters are written)
//
// `owner` is the online Player, or null when they're offline.

import { TAG } from "./ids.js";

const listeners = new Map();

export function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {
        const list = listeners.get(event);
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    };
}

export function emit(event, payload) {
    for (const fn of listeners.get(event) ?? []) {
        try { fn(payload); } catch (e) { console.warn(`[${TAG}] "${event}" listener failed: ${e}`); }
    }
}
