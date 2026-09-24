// Standing orders (schema v2 `order` field): follow / stay / wander / home.
// The order itself is a stored player choice (it survives despawn, relog,
// restarts); everything it implies moment-to-moment is derived live here
// each cycle, never stored (Section 8.11).
//
//   follow - sticks with her player: no idle wandering, walks (real
//            pathfinding) to catch up past FOLLOW_RANGE, snaps to them past
//            CATCHUP_TELEPORT.
//            Only "follow" characters come along through portals (Section 5).
//   stay   - wandering switched off; she holds where she was told.
//   wander - free roam wherever she is.
//   home   - returns to her homeLocation and wanders there.
//
// A formation/playbook move in progress (navigation.js) always wins: the
// order loop never interrupts an active navigation except for a
// cross-map catch-up teleport.

import { world, system } from "@minecraft/server";
import { readIndex } from "./characterIndex.js";
import { getCharacter, getOrder } from "./characterRecord.js";
import { navigateToCoordinate, isNavigating, cancelNavigation } from "./navigation.js";
import { getClass } from "./classData.js";
import { getTaskLock } from "./fsm.js";
import { NS, TAG } from "./ids.js";

const ORDER_INTERVAL_TICKS = 20;
const FOLLOW_RANGE = 5;
const CATCHUP_TELEPORT = 40;
const HOME_ARRIVE = 6;

// Navigations this loop itself started: entity id -> { target, startedAt }.
// Only these are ever re-issued (stale target / stuck); a formation or
// playbook move started elsewhere is never overridden.
const followNavs = new Map();
const RENAV_AFTER_TICKS = 200;

function findEntity(entityId) {
    try { const e = world.getEntity(entityId); return e?.isValid ? e : null; } catch (e) { return null; }
}

// Applies an order's entity-side switches right away (wander on/off), so
// changing an order in the Codex takes effect without waiting a cycle.
// Only "wander" and "home" (wander around home) keep idle strolling on -
// a following or staying character must never drift off on her own.
export function wandersUnder(order) { return order === "wander" || order === "home"; }

export function applyOrderToEntity(entity, order) {
    try { entity.triggerEvent(wandersUnder(order) ? `${NS}:wander_on` : `${NS}:wander_off`); } catch (e) { /* entity gone */ }
}

// Entities that existed before a pack update (or a /reload) never got
// their spawn-time component groups re-applied - so the first time this
// session sees each one, re-assert her order and combat role.
const initialized = new Set();
function ensureInitialized(entity, record, order) {
    if (initialized.has(entity.id)) return;
    initialized.add(entity.id);
    applyOrderToEntity(entity, order);
    const ranged = getClass(record.class).positioning?.role === "ranged";
    try { entity.triggerEvent(ranged ? `${NS}:role_ranged` : `${NS}:role_melee`); } catch (e) { /* fine */ }
}

function offsetAround(center, radius) {
    const a = Math.random() * Math.PI * 2;
    return { x: center.x + Math.cos(a) * radius, y: center.y, z: center.z + Math.sin(a) * radius };
}

function tickPlayer(player) {
    for (const entry of readIndex(player)) {
        const record = getCharacter(player, entry.id);
        if (!record?.manifestedEntityId) continue;
        const entity = findEntity(record.manifestedEntityId);
        if (!entity) continue;
        const order = getOrder(record);
        ensureInitialized(entity, record, order);
        if (getTaskLock(entry.id, system.currentTick)) continue; // mid-maneuver (hunt/army) - hands off

        if (order === "follow") {
            if (entity.dimension.id !== player.dimension.id) continue; // dimensionFollow handles portals
            const d = Math.hypot(entity.location.x - player.location.x, entity.location.z - player.location.z);
            if (d > CATCHUP_TELEPORT) {
                try { entity.teleport(offsetAround(player.location, 2), { dimension: player.dimension }); } catch (e) { /* unloaded */ }
            } else if (d > FOLLOW_RANGE) {
                const mine = followNavs.get(entity.id);
                const navigating = isNavigating(entity);
                if (navigating && !mine) continue; // someone else's move (formation/playbook) - leave it
                const stale = mine && (system.currentTick - mine.startedAt > RENAV_AFTER_TICKS ||
                    Math.hypot(mine.target.x - player.location.x, mine.target.z - player.location.z) > FOLLOW_RANGE);
                if (!navigating || stale) {
                    const t = offsetAround(player.location, 2);
                    const target = { x: t.x, y: player.location.y, z: t.z };
                    followNavs.set(entity.id, { target, startedAt: system.currentTick });
                    navigateToCoordinate(entity, target.x, target.y, target.z, player.dimension, () => followNavs.delete(entity.id));
                }
            } else if (followNavs.has(entity.id)) {
                followNavs.delete(entity.id); // close enough - stop walking to the old target
                cancelNavigation(entity);
            }
        } else if (order === "home") {
            const home = record.homeLocation;
            if (!home || home.dimension !== entity.dimension.id || isNavigating(entity)) continue;
            const d = Math.hypot(entity.location.x - home.x, entity.location.z - home.z);
            if (d > CATCHUP_TELEPORT * 2) {
                try { entity.teleport({ x: home.x, y: home.y, z: home.z }); } catch (e) { /* unloaded */ }
            } else if (d > HOME_ARRIVE) {
                navigateToCoordinate(entity, home.x, home.y, home.z, entity.dimension);
            }
        }
        // stay / wander: nothing to drive - the wander component group
        // (toggled by applyOrderToEntity at manifest/order-change time)
        // is the whole behavior.
    }
}

export function startOrderLoop() {
    system.runInterval(() => {
        for (const player of world.getAllPlayers()) {
            try { tickPlayer(player); } catch (e) { console.warn(`[${TAG}] Order tick failed for ${player.name}: ${e}`); }
        }
    }, ORDER_INTERVAL_TICKS);
}
