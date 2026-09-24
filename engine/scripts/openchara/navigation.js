// Real native-pathfinding movement (plan Section 8.9), now load-bearing
// per Phase 5. This is the production version of Phase 0's proven spike
// (`pathfindTestSpike.js`, kept around unmodified as the historical record
// of how this was verified) - same slot-pool + follow_mob + anchor-puppet
// mechanism, wired onto the real `${NS}:${CHAR}` entity, with the spike's debug
// broadcast spam removed and a clean callback-based API in its place.
//
// Why this exists at all instead of a plain `entity.teleport()`: native
// Bedrock pathfinding actually walks around obstacles, uses stairs, and
// (per Section 8.9) can step up single blocks - a teleport can't do any of
// that. `minecraft:behavior.follow_mob`'s filter value is baked into the
// entity JSON at author time, so a slot pool of pre-authored component
// groups (`${NS}:navigating_slot_0..9999`, mirrored onto `${NS}:${CHAR}` from the
// same generator that built the proven spike) is what lets up to the
// per-player character cap navigate simultaneously without cross-talk.

import { world, system } from "@minecraft/server";
import { NS, CHAR, TAG } from "./ids.js";

const SLOT_COUNT = 10000;
const ARRIVAL_HORIZONTAL_DISTANCE = 1.5;
const ARRIVAL_VERTICAL_DISTANCE = 1.5;
const ARRIVAL_CHECK_INTERVAL_TICKS = 5;

const freeSlots = [];
for (let i = SLOT_COUNT - 1; i >= 0; i--) freeSlots.push(i);

// entityId -> { slot, anchorId, onArrive }
const activeNavigations = new Map();

function acquireSlot() {
    return freeSlots.length > 0 ? freeSlots.pop() : null;
}
function releaseSlot(slot) {
    if (slot !== null && slot !== undefined) freeSlots.push(slot);
}

function horizontalDist(a, b) {
    const dx = a.x - b.x, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Navigate `entity` (must be a `${NS}:${CHAR}`) to a coordinate via real native
 * pathfinding. Cancels any navigation already in progress for this entity
 * first. Returns false if the slot pool is exhausted (should never happen
 * at realistic scale - 10,000 slots against a 50-character/player cap
 * across 200 players). `onArrive` fires once, only on genuine arrival -
 * never on cancellation or the entity/anchor becoming invalid.
 */
export function navigateToCoordinate(entity, x, y, z, dimension, onArrive) {
    cancelNavigation(entity);

    const slot = acquireSlot();
    if (slot === null) {
        console.warn(`[${TAG}] navigateToCoordinate: slot pool exhausted.`);
        return false;
    }

    let anchor;
    try {
        anchor = dimension.spawnEntity(`${NS}:pathfind_anchor`, { x, y, z });
        anchor.addTag(`${NS}_anchor_slot_${slot}`);
    } catch (e) {
        console.warn(`[${TAG}] navigateToCoordinate: failed to spawn anchor: ${e}`);
        releaseSlot(slot);
        return false;
    }

    activeNavigations.set(entity.id, { slot, anchorId: anchor.id, onArrive });
    // Deferred one tick - Phase 0 found the anchor isn't always fully
    // registered in the world in the exact tick it's spawned, and a
    // follow_mob goal that evaluates its candidate list that same tick can
    // miss it and not retry for a while.
    system.run(() => {
        if (!entity.isValid) return;
        try { entity.triggerEvent(`${NS}:navigating_on_slot_${slot}`); } catch (e) { /* entity gone */ }
    });
    return true;
}

export function cancelNavigation(entity) {
    const nav = activeNavigations.get(entity.id);
    if (!nav) return;
    try { entity.triggerEvent(`${NS}:navigating_off_slot_${nav.slot}`); } catch (e) { /* fine */ }
    const anchor = world.getEntity(nav.anchorId);
    if (anchor && anchor.isValid) { try { anchor.remove(); } catch (e) { /* fine */ } }
    releaseSlot(nav.slot);
    activeNavigations.delete(entity.id);
}

export function isNavigating(entity) {
    return activeNavigations.has(entity.id);
}

// Arrival check: requires horizontal AND vertical proximity separately,
// not a blended 3D radius - Phase 0 found a blended check could report a
// false arrival across a floor (small horizontal offset + moderate
// vertical gap still under a combined threshold even with solid ground
// between them).
system.runInterval(() => {
    for (const [entityId, nav] of [...activeNavigations.entries()]) {
        const entity = world.getEntity(entityId);
        const anchor = world.getEntity(nav.anchorId);
        if (!entity || !entity.isValid || !anchor || !anchor.isValid) {
            releaseSlot(nav.slot);
            activeNavigations.delete(entityId);
            continue;
        }
        const hDist = horizontalDist(entity.location, anchor.location);
        const vDist = Math.abs(entity.location.y - anchor.location.y);
        if (hDist <= ARRIVAL_HORIZONTAL_DISTANCE && vDist <= ARRIVAL_VERTICAL_DISTANCE) {
            const onArrive = nav.onArrive;
            cancelNavigation(entity);
            try { onArrive?.(); } catch (e) { /* caller's problem, not ours */ }
        }
    }
}, ARRIVAL_CHECK_INTERVAL_TICKS);
