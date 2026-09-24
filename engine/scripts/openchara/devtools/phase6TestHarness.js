// Manual test harness for Phase 6 (choke-point detection, Room Safety,
// Breach Stack, Room-Clear Cross Pattern, Slice the Pie). All of this is
// genuinely novel, untested spatial/choreography logic per the plan's own
// framing - these commands are how it gets exercised at all before real
// combat/auto-triggering exists.
//
//   /scriptevent <ns>:choketest                    - flood-fills from your position, prints detected choke points
//   /scriptevent <ns>:roomdefine <roomId>          - flood-fills a room from your position
//   /scriptevent <ns>:roomcheck <roomId>           - prints coverage% and safe status
//   /scriptevent <ns>:breach <squadId|name>             - stacks + breaches the squad through the nearest detected choke point
//   /scriptevent <ns>:roomclear <squadId|name> <roomId> - runs Room-Clear Cross Pattern using that room's corners
//   /scriptevent <ns>:slicepie <roomId> [characterId|nickname] - one manifested character slice-pies a doorway at your position, facing your view direction
//
// A multi-word name/nickname needs double-quotes: cw:breach "Alpha Squad".

import { system, world } from "@minecraft/server";
import { getManifestedMembers, resolveSquadIdentifier } from "../squads.js";
import { getCharacter } from "../characterRecord.js";
import { resolveCharacterIdentifier } from "../characterIndex.js";
import { detectChokePoints } from "../chokePoints.js";
import { defineRoom, getRoom, getRoomCorners, coveragePercent, updateRoomSafety } from "../roomSafety.js";
import { findNearbyHostiles } from "../perception.js";
import { breachStack, roomClearCross, slicePie } from "../playbooks.js";
import { parseArgs } from "../cmdArgs.js";
import { NS, N, TAG } from "../ids.js";

function findEntity(entityId) {
    try { return world.getEntity(entityId); } catch (e) { return null; }
}

function resolveManifestedMember(player, characterId) {
    const record = getCharacter(player, characterId);
    if (!record?.manifestedEntityId) return null;
    const entity = findEntity(record.manifestedEntityId);
    if (!entity) return null;
    return { characterId, record, entity };
}

system.afterEvents.scriptEventReceive.subscribe(event => {
    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    const id = event.id;
    const args = parseArgs(event.message);

    try {
        if (id === `${NS}:choketest`) {
            const points = detectChokePoints(player.dimension, player.location, 200);
            player.sendMessage(`§b[${TAG}] Flood-fill found ${points.length} candidate choke point(s) near you.`);
            if (points.length > 0) {
                const p = points[0];
                player.sendMessage(`§b[${TAG}] Nearest candidate: (${p.x}, ${p.y}, ${p.z})`);
            }
        } else if (id === `${NS}:roomdefine`) {
            const roomId = args[0];
            if (!roomId) { player.sendMessage(`§cUsage: ${NS}:roomdefine <roomId>`); return; }
            const room = defineRoom(roomId, player.dimension, player.location, 400);
            player.sendMessage(`§d[${TAG}] Room "${roomId}" defined - ${room.bounds.size} cells.`);
        } else if (id === `${NS}:roomcheck`) {
            const roomId = args[0];
            const room = getRoom(roomId);
            if (!room) { player.sendMessage(`§cNo such room - run ${NS}:roomdefine first.`); return; }
            const hostiles = findNearbyHostiles(player.dimension, player.location, 24)
                .filter(h => room.bounds.has(`${Math.floor(h.location.x / 2)},${Math.floor(h.location.y)},${Math.floor(h.location.z / 2)}`));
            const safe = updateRoomSafety(roomId, hostiles.length);
            player.sendMessage(`§b[${TAG}] Room "${roomId}": coverage=${(coveragePercent(roomId) * 100).toFixed(0)}% hostilesInBounds=${hostiles.length} safe=${safe}`);
        } else if (id === `${NS}:breach`) {
            const squadId = resolveSquadIdentifier(player, args[0]);
            if (!squadId) { player.sendMessage(`§cNo squad found matching "${args[0]}" (id or name).`); return; }
            const members = getManifestedMembers(player, squadId)
                .map(m => ({ ...m, entity: findEntity(m.record.manifestedEntityId) }))
                .filter(m => m.entity);
            if (members.length === 0) { player.sendMessage("§cNo manifested members in that squad."); return; }
            const points = detectChokePoints(player.dimension, player.location, 200);
            if (points.length === 0) { player.sendMessage("§cNo choke point detected near you."); return; }
            const chokePoint = points[0];
            const dir = player.getViewDirection();
            breachStack(members, chokePoint, dir, player.dimension, () => player.sendMessage(`§a[${TAG}] Breach complete.`));
            player.sendMessage(`§d[${TAG}] Breaching ${members.length} member(s) through (${chokePoint.x}, ${chokePoint.y}, ${chokePoint.z}).`);
        } else if (id === `${NS}:roomclear`) {
            const [squadIdArg, roomId] = args;
            const squadId = resolveSquadIdentifier(player, squadIdArg);
            if (!squadId) { player.sendMessage(`§cNo squad found matching "${squadIdArg}" (id or name).`); return; }
            const members = getManifestedMembers(player, squadId)
                .map(m => ({ ...m, entity: findEntity(m.record.manifestedEntityId) }))
                .filter(m => m.entity);
            if (members.length === 0) { player.sendMessage("§cNo manifested members in that squad."); return; }
            const corners = getRoomCorners(roomId);
            if (corners.length === 0) { player.sendMessage(`§cNo such room - run ${NS}:roomdefine first.`); return; }
            roomClearCross(members, roomId, corners, player.dimension, () => player.sendMessage(`§a[${TAG}] Room-clear cross pattern complete.`));
            player.sendMessage(`§d[${TAG}] Clearing room "${roomId}" with ${members.length} member(s).`);
        } else if (id === `${NS}:slicepie`) {
            const [roomId, characterIdArg] = args;
            if (!roomId) { player.sendMessage(`§cUsage: ${NS}:slicepie <roomId> [characterId]`); return; }
            const characterId = resolveCharacterIdentifier(player, characterIdArg);
            const member = characterId ? resolveManifestedMember(player, characterId) : null;
            if (!member) { player.sendMessage(`§cNo manifested ${N.one} found for that id.`); return; }

            const pivot = player.location;
            const facingAngle = Math.atan2(player.getViewDirection().z, player.getViewDirection().x);
            slicePie(member, roomId, pivot, facingAngle, player.dimension, {},
                () => player.sendMessage(`§a[${TAG}] Slice complete - no threats found.`),
                (visible) => player.sendMessage(`§e[${TAG}] Slice halted - ${visible.length} threat(s) spotted.`));
            player.sendMessage(`§d[${TAG}] ${member.record.nickname} is slicing the pie at (${pivot.x.toFixed(1)}, ${pivot.y.toFixed(1)}, ${pivot.z.toFixed(1)}).`);
        }
    } catch (e) {
        player.sendMessage(`§c[${TAG} test] Error: ${e?.message ?? e}`);
        console.error(`[${TAG}] Phase 6 harness error on ${id}: ${e}`);
    }
});
