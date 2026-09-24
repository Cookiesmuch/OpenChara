// Auto-trigger conditions layered on top of the now-proven manually-
// invocable playbooks/formations (Section 10's own explicit "build manual
// first, then auto-trigger" sequencing). Deliberately bespoke procedural
// heuristics per trigger, NOT folded into the CONDITION_TYPES registry
// (Section 12a) - that registry is for "has X happened against already-
// stored data" (a counter threshold, a relationship level); these are live
// spatial/tactical judgments computed fresh from the world every cycle,
// which is exactly the distinction Section 12a's own design note already
// drew when it kept playbook triggers out of that registry on purpose.
//
// Starts DISABLED by default - toggle with /scriptevent cw:autotrigger on
// (or `off`) - so it never starts moving a squad around mid-testing
// without being asked to.

import { world, system } from "@minecraft/server";
import { readSquads } from "./squads.js";
import { gatherManifestedMembers, centroidOf } from "./squadContext.js";
import { getSquadPosture } from "./coordination.js";
import { detectChokePoints } from "./chokePoints.js";
import { breachStack } from "./playbooks.js";
import { executeFormation } from "./formations.js";
import { getTaskLock } from "./fsm.js";

const TRIGGER_INTERVAL_TICKS = 20; // ~1s - slower than perception/coordination, since a fired trigger commits a squad to several seconds of scripted movement
const COOLDOWN_TICKS = 200; // ~10s - once a trigger fires for a squad, don't re-fire immediately

let enabled = false;
export function setAutoTriggerEnabled(value) { enabled = value; }
export function isAutoTriggerEnabled() { return enabled; }

const cooldownUntil = new Map(); // squadId -> tick
let tickCounter = 0;

function onCooldown(squadId) {
    return tickCounter < (cooldownUntil.get(squadId) ?? 0);
}
function startCooldown(squadId) {
    cooldownUntil.set(squadId, tickCounter + COOLDOWN_TICKS);
}

// Trigger 1 (Section 8.4's own worked example, verbatim): squad posture is
// "alert" (suspects something beyond a choke point) but not yet actually
// engaged, and a choke point is genuinely near the squad's own position -
// not just anywhere the flood-fill happened to reach.
function tryAutoBreach(owner, squad, members, centroid, dimension) {
    if (getSquadPosture(squad.id) !== "alert") return false;
    const points = detectChokePoints(dimension, centroid, 150);
    if (points.length === 0) return false;
    const chokePoint = points[0];
    const dist = Math.hypot(chokePoint.x - centroid.x, chokePoint.z - centroid.z);
    if (dist > 20) return false;

    const heading = { x: chokePoint.x - centroid.x, z: chokePoint.z - centroid.z };
    breachStack(members, chokePoint, heading, dimension);
    return true;
}

// Trigger 2: squad just became engaged/protecting - falls back to a
// defensive circle around its own centroid as a sane default combat
// stance when nothing more specific (a choke point) applies.
function tryAutoCircle(owner, squad, members, centroid, dimension) {
    if (!["engaged", "protecting"].includes(getSquadPosture(squad.id))) return false;
    executeFormation("circle", dimension, centroid, { x: 1, z: 0 }, centroid, members);
    return true;
}

// Order matters: a specific, situational trigger (breach) is checked
// before a generic fallback (circle) - only one fires per squad per cycle.
const TRIGGERS = [tryAutoBreach, tryAutoCircle];

function tickSquad(owner, squad) {
    if (onCooldown(squad.id)) return;
    const members = gatherManifestedMembers(owner, squad);
    if (members.length === 0) return;
    // A hunt or army maneuver already owns this squad's movement.
    if (members.some(m => getTaskLock(m.characterId, system.currentTick))) return;
    const dimension = members[0].entity.dimension;
    const centroid = centroidOf(members.map(m => m.entity.location));

    for (const trigger of TRIGGERS) {
        if (trigger(owner, squad, members, centroid, dimension)) {
            startCooldown(squad.id);
            break;
        }
    }
}

export function startPlaybookTriggerLoop() {
    system.runInterval(() => {
        if (!enabled) return;
        tickCounter += TRIGGER_INTERVAL_TICKS;
        for (const player of world.getAllPlayers()) {
            for (const squad of readSquads(player)) {
                tickSquad(player, squad);
            }
        }
    }, TRIGGER_INTERVAL_TICKS);
}
