// The squad-level perception cycle (plan Section 8.2): one shared hostile
// scan per squad, decaying threat memory, aggro-table updates, and
// awareness-axis updates for every manifested member - never a per-member
// scan. This is Phase 3's simplified single-tier version; full
// active/idle/dormant update-rate tiering (Section 4) is Phase 4's job
// once real coordination needs the cost savings.

import { world, system } from "@minecraft/server";
import { readSquads } from "./squads.js";
import {
    hasLineOfSight, findNearbyHostiles, updateThreatMemory, getKnownThreats,
    bumpAggro, decayAggro, computeBlindSpots,
} from "./perception.js";
import { setAwareness, getMemberAxes } from "./fsm.js";
import { centroidOf, headOf, gatherManifestedMembers } from "./squadContext.js";

const PERCEPTION_INTERVAL_TICKS = 10; // ~0.5s, matches this codebase's existing kite-pulse cadence

// Last-computed blind-spot arcs per squad - read by whichever coordination
// logic needs them (Phase 4); not persisted, recomputed every cycle.
const lastBlindSpots = new Map();

export function getLastBlindSpots(squadId) {
    return lastBlindSpots.get(squadId) ?? [];
}

function tickSquad(owner, squad, currentTick) {
    const members = gatherManifestedMembers(owner, squad);
    if (members.length === 0) return;

    const dimension = members[0].entity.dimension;
    const centroid = centroidOf(members.map(m => m.entity.location));
    const hostiles = findNearbyHostiles(dimension, centroid, 24);

    let anyVisible = false;
    for (const hostile of hostiles) {
        let canSee = false;
        const hostileHead = headOf(hostile);
        for (const member of members) {
            if (hasLineOfSight(dimension, headOf(member.entity), hostileHead)) {
                canSee = true;
                bumpAggro(squad.id, hostile.id, member.characterId, 1);
            }
        }
        updateThreatMemory(squad.id, hostile, canSee, currentTick);
        if (canSee) anyVisible = true;
    }
    decayAggro(squad.id);

    const knownThreats = getKnownThreats(squad.id, currentTick);
    for (const member of members) {
        const axes = getMemberAxes(member.characterId);
        if (anyVisible) setAwareness(member.characterId, "engaged");
        else if (knownThreats.length > 0) setAwareness(member.characterId, "alerted");
        else if (axes.awareness !== "unaware") setAwareness(member.characterId, "suspicious");
    }

    // Blind-spot coverage: alerted-or-higher members "watch" their current
    // facing direction. Consumed by whichever coordination logic needs it
    // (Phase 4's proactive blind-spot filling) - computed fresh every
    // cycle, never persisted.
    const watchers = members
        .filter(m => ["alerted", "engaged"].includes(getMemberAxes(m.characterId).awareness))
        .map(m => ({ location: m.entity.location, viewDirection: m.entity.getViewDirection() }));
    lastBlindSpots.set(squad.id, computeBlindSpots(watchers));
}

let tickCounter = 0;

export function getCurrentTick() {
    return tickCounter;
}

export function startPerceptionLoop() {
    system.runInterval(() => {
        tickCounter += PERCEPTION_INTERVAL_TICKS;
        for (const player of world.getAllPlayers()) {
            for (const squad of readSquads(player)) {
                tickSquad(player, squad, tickCounter);
            }
        }
    }, PERCEPTION_INTERVAL_TICKS);
}
