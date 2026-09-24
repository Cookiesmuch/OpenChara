// Hunting - Formation #26 "Cut Off and Corner" (plan Section 8.8). The
// squad never just walks up and starts a fight the target can run from:
//
//   1. STAGE  - escape routes are analyzed once (routeAnalysis.js), each
//               member is sent (real pathfinding) to a blocker position
//               covering a route, while the target is left untagged so
//               nobody engages early (Noise Discipline, Micro-Playbook #44).
//   2. ENGAGE - once every blocker reports in-position (or staging times
//               out, or the target starts to bolt), the target is tagged
//               cw_hunt_target; the entity JSON's nearest_attackable_target
//               picks it up and the net closes.
//   3. DONE   - target dead or hunt timed out: tag removed, locks released.
//
// If the target moves far during staging, routes are re-analyzed once and
// blockers re-sent - the "target is running" reactive re-trigger.

import { world, system } from "@minecraft/server";
import { detectEscapeRoutes, planBlockerPositions } from "./routeAnalysis.js";
import { navigateToCoordinate, cancelNavigation } from "./navigation.js";
import { setTaskLock, clearTaskLock, setPositioningStatus } from "./fsm.js";
import { NS, CHAR } from "./ids.js";

export const HUNT_TAG = `${NS}_hunt_target`;
const STAGE_TIMEOUT_TICKS = 300;
const HUNT_TIMEOUT_TICKS = 900;
const BOLT_DISTANCE = 6;
const LOCK_TICKS = HUNT_TIMEOUT_TICKS + 40;

const EXCLUDED_TYPES = new Set(["minecraft:player", `${NS}:${CHAR}`, `${NS}:pathfind_anchor`, "minecraft:villager_v2", "minecraft:villager",
    "minecraft:wandering_trader", "minecraft:iron_golem", "minecraft:snow_golem", "minecraft:armor_stand", "minecraft:allay"]);

const hunts = new Map(); // huntId -> state
let nextHuntId = 1;

function isHuntable(e) {
    try {
        if (!e?.isValid || EXCLUDED_TYPES.has(e.typeId) || e.typeId.startsWith(`${NS}:`)) return false;
        if (!e.getComponent("minecraft:health")) return false;
        if (e.nameTag) return false; // someone named it - leave it alone
        if (e.getComponent("minecraft:tameable")?.isTamed) return false;
        if (e.getComponent("minecraft:is_tamed")) return false;
        return true;
    } catch (err) { return false; }
}

// What the player is looking at, else the nearest huntable mob within 24.
export function pickHuntTarget(player) {
    try {
        const hit = player.getEntitiesFromViewDirection({ maxDistance: 32 })[0]?.entity;
        if (isHuntable(hit)) return hit;
    } catch (e) { /* fine */ }
    let candidates = [];
    try { candidates = player.dimension.getEntities({ location: player.location, maxDistance: 24, excludeFamilies: ["player", `${NS}_${CHAR}`] }); } catch (e) { return null; }
    return candidates.filter(isHuntable).sort((a, b) =>
        Math.hypot(a.location.x - player.location.x, a.location.z - player.location.z) -
        Math.hypot(b.location.x - player.location.x, b.location.z - player.location.z))[0] ?? null;
}

function stage(hunt) {
    const target = world.getEntity(hunt.targetId);
    if (!target?.isValid) return false;
    const { routes, openness } = detectEscapeRoutes(target.dimension, target.location);
    const positions = planBlockerPositions(target.dimension, target.location, routes, hunt.members.length);
    hunt.stageOrigin = { ...target.location };
    hunt.arrived = new Set();
    hunt.routesInfo = `${routes.length} escape route(s), ${Math.round(openness * 100)}% open`;

    // Nearest-member-to-position greedy assignment, so nobody crosses the
    // target's line of sight to reach the far side when a closer member
    // could.
    const free = [...hunt.members];
    for (const pos of positions) {
        free.sort((a, b) => Math.hypot(a.entity.location.x - pos.x, a.entity.location.z - pos.z) - Math.hypot(b.entity.location.x - pos.x, b.entity.location.z - pos.z));
        const m = free.shift();
        if (!m) break;
        setPositioningStatus(m.characterId, "moving");
        const ok = navigateToCoordinate(m.entity, pos.x, pos.y, pos.z, target.dimension, () => {
            hunt.arrived.add(m.characterId);
            setPositioningStatus(m.characterId, "in-position");
        });
        if (!ok) hunt.arrived.add(m.characterId); // couldn't path at all - don't block the engage forever
    }
    return true;
}

function engage(hunt, reason) {
    const target = world.getEntity(hunt.targetId);
    if (!target?.isValid) return;
    hunt.phase = "engage";
    hunt.engagedAt = system.currentTick;
    try { target.addTag(HUNT_TAG); } catch (e) { /* fine */ }
    for (const m of hunt.members) { try { if (m.entity.isValid) cancelNavigation(m.entity); } catch (e) { /* fine */ } }
    hunt.notify?.(`§6Hunt: net closed (${reason}) - engaging!`);
}

function finish(huntId, hunt, message) {
    hunts.delete(huntId);
    const target = world.getEntity(hunt.targetId);
    try { if (target?.isValid) target.removeTag(HUNT_TAG); } catch (e) { /* fine */ }
    for (const m of hunt.members) clearTaskLock(m.characterId);
    if (message) hunt.notify?.(message);
}

/**
 * members: [{ characterId, entity }] (manifested). notify(msg) for player feedback.
 * Returns a short description, or null if nothing could be hunted.
 */
export function startHunt(members, target, notify) {
    if (!target?.isValid || members.length === 0) return null;
    // Only one hunt per member at a time: release them from any other.
    for (const [id, h] of hunts) {
        if (h.members.some(m => members.some(n => n.characterId === m.characterId))) finish(id, h, null);
    }
    const hunt = { targetId: target.id, targetType: target.typeId, members, notify, phase: "stage", startedAt: system.currentTick, restaged: false };
    const lockUntil = system.currentTick + LOCK_TICKS;
    for (const m of members) setTaskLock(m.characterId, "hunt", lockUntil);
    const id = nextHuntId++;
    hunts.set(id, hunt);
    if (!stage(hunt)) { finish(id, hunt, null); return null; }
    return `${target.typeId.replace("minecraft:", "")} - ${hunt.routesInfo}, ${members.length} blocker(s) moving into place`;
}

export function startHuntLoop() {
    system.runInterval(() => {
        const now = system.currentTick;
        for (const [id, hunt] of [...hunts]) {
            const target = world.getEntity(hunt.targetId);
            if (!target?.isValid) { finish(id, hunt, `§aHunt complete - ${hunt.targetType.replace("minecraft:", "")} down.`); continue; }
            hunt.members = hunt.members.filter(m => m.entity?.isValid);
            if (hunt.members.length === 0) { finish(id, hunt, "§cHunt abandoned - no hunters left."); continue; }
            if (now - hunt.startedAt > HUNT_TIMEOUT_TICKS) { finish(id, hunt, "§eHunt timed out - the prey got away."); continue; }

            if (hunt.phase === "stage") {
                const moved = Math.hypot(target.location.x - hunt.stageOrigin.x, target.location.z - hunt.stageOrigin.z);
                if (moved > BOLT_DISTANCE) {
                    if (!hunt.restaged) { hunt.restaged = true; stage(hunt); hunt.notify?.("§eHunt: prey moved - re-reading its escape routes."); }
                    else engage(hunt, "prey is bolting");
                } else if (hunt.arrived.size >= hunt.members.length) {
                    engage(hunt, "all blockers in position");
                } else if (now - hunt.startedAt > STAGE_TIMEOUT_TICKS) {
                    engage(hunt, `${hunt.arrived.size}/${hunt.members.length} in position, out of time`);
                }
            }
        }
    }, 10);
}
