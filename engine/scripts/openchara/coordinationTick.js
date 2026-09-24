// The squad-level coordination cycle (plan Section 8.2, Coordination):
// target assignment with saturation caps, protect-priority, health-weighted
// reassignment, and posture derivation - run right after perception each
// cycle so it always sees this tick's freshly-updated awareness axes.

import { world, system } from "@minecraft/server";
import { readSquads } from "./squads.js";
import { findNearbyHostiles } from "./perception.js";
import { assignTargets, applyHealthReassignment, computePosture } from "./coordination.js";
import { setAssignment } from "./fsm.js";
import { centroidOf, gatherManifestedMembers } from "./squadContext.js";

const COORDINATION_INTERVAL_TICKS = 10; // ~0.5s, same cadence as perception

function tickSquad(owner, squad) {
    const members = gatherManifestedMembers(owner, squad);
    if (members.length === 0) return;

    const dimension = members[0].entity.dimension;
    const centroid = centroidOf(members.map(m => m.entity.location));
    const hostiles = findNearbyHostiles(dimension, centroid, 24);

    const assignments = assignTargets(members, hostiles);
    for (const member of members) {
        const hostileId = assignments.get(member.characterId);
        setAssignment(member.characterId, hostileId ? { type: "attacker", targetId: hostileId } : { type: "unassigned" });
    }

    applyHealthReassignment(members);
    computePosture(squad.id, owner, members, hostiles, centroid);
}

export function startCoordinationLoop() {
    system.runInterval(() => {
        for (const player of world.getAllPlayers()) {
            for (const squad of readSquads(player)) {
                tickSquad(player, squad);
            }
        }
    }, COORDINATION_INTERVAL_TICKS);
}
