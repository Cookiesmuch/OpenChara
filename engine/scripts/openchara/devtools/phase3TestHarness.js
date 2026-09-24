// Manual inspection harness for Phase 3 (perception + individual FSM) and
// Phase 4 (coordination). There's no visible in-world effect yet (that's
// Phase 5's job) - this just prints the live axis/perception/coordination
// state so it's actually checkable.
//
//   /scriptevent <ns>:perceptioncheck <squadId|name> - prints each manifested member's axes/assignment, known-threat count, blind arcs, and squad posture

import { system } from "@minecraft/server";
import { getManifestedMembers, resolveSquadIdentifier } from "../squads.js";
import { getMemberAxes } from "../fsm.js";
import { getKnownThreats } from "../perception.js";
import { getLastBlindSpots, getCurrentTick } from "../perceptionTick.js";
import { getSquadPosture } from "../coordination.js";
import { NS, TAG } from "../ids.js";

function describeAssignment(assignment) {
    if (!assignment || assignment.type === "unassigned") return "unassigned";
    return `${assignment.type}(${assignment.targetId ?? assignment.memberId ?? ""})`;
}

system.afterEvents.scriptEventReceive.subscribe(event => {
    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    if (event.id !== `${NS}:perceptioncheck`) return;

    const arg = (event.message ?? "").trim();
    const squadId = resolveSquadIdentifier(player, arg);
    if (!squadId) { player.sendMessage(`§cNo squad found matching "${arg}" (id or name).`); return; }

    const members = getManifestedMembers(player, squadId);
    if (members.length === 0) { player.sendMessage("§cNo manifested members in that squad."); return; }

    for (const m of members) {
        const axes = getMemberAxes(m.characterId);
        player.sendMessage(`§b${m.record.nickname}: awareness=${axes.awareness} engagement=${axes.engagement} positioning=${axes.positioningStatus} assignment=${describeAssignment(axes.assignment)}`);
    }
    const threats = getKnownThreats(squadId, getCurrentTick());
    player.sendMessage(`§b[${TAG}] posture=${getSquadPosture(squadId)} knownThreats=${threats.length} blindArcs=[${getLastBlindSpots(squadId).join(", ")}]`);
});
