// Manual test harness for Phase 2 (squads + manual formation invocation)
// and Phase 5 (real terrain-aware movement). Scriptevents stand in for the
// real RTS command interface (Phase 12) - per Section 10's own sequencing,
// the dispatch mechanism gets proven manually invocable first, before any
// auto-trigger logic or a real UI exists on top of it.
//
//   /scriptevent <ns>:squadcreate <name>                        - creates a squad, prints its id
//   /scriptevent <ns>:squadjoin <squadId|name> [characterId|nickname] - adds a character to a squad (omit character to default to your first indexed character)
//   /scriptevent <ns>:squadlist                                 - lists your squads and members
//   /scriptevent <ns>:formation <squadId|name> <type>           - resolves (real terrain: elevation/cover/LOS) + navigates manifested members
//   /scriptevent <ns>:teleporttome [characterId|nickname]           - despawn+manifest at your position (Section 5's shared primitive)
//
// Squad and character identifiers everywhere below accept either the real id
// or its display name/nickname (case-insensitive) - typing "Alpha"
// instead of "sq1" works exactly the same. A multi-word name/nickname
// needs double-quotes: cw:squadjoin sq1 "March 7th".

import { world, system } from "@minecraft/server";
import { createSquad, joinSquad, readSquads, getManifestedMembers, MAX_MEMBERS_PER_SQUAD, resolveSquadIdentifier } from "../squads.js";
import { executeFormation, FORMATION_TYPES } from "../formations.js";
import { teleportToMe } from "../manifest.js";
import { resolveCharacterIdentifier } from "../characterIndex.js";
import { parseArgs } from "../cmdArgs.js";
import { NS, N, TAG } from "../ids.js";

function findEntity(entityId) {
    try { return world.getEntity(entityId); } catch (e) { return null; }
}

system.afterEvents.scriptEventReceive.subscribe(event => {
    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    const id = event.id;
    const args = parseArgs(event.message);

    try {
        if (id === `${NS}:squadcreate`) {
            const name = args.join(" ") || "New Squad";
            const squad = createSquad(player, name);
            player.sendMessage(`§d[${TAG}] Created squad "${squad.name}" (${squad.id}).`);
        } else if (id === `${NS}:squadjoin`) {
            const [squadIdArg, characterIdArg] = args;
            const squadId = resolveSquadIdentifier(player, squadIdArg);
            if (!squadId) { player.sendMessage(`§cNo squad found matching "${squadIdArg}" (id or name).`); return; }
            const characterId = resolveCharacterIdentifier(player, characterIdArg);
            if (!characterId) { player.sendMessage(`§cNo ${N.one} found (id/nickname), and none indexed.`); return; }
            const squad = joinSquad(player, squadId, characterId);
            player.sendMessage(`§d[${TAG}] ${characterId} joined "${squad.name}" (${squad.id}) - ${squad.memberIds.length}/${MAX_MEMBERS_PER_SQUAD} members.`);
        } else if (id === `${NS}:squadlist`) {
            const squads = readSquads(player);
            if (squads.length === 0) { player.sendMessage(`§b[${TAG}] No squads yet.`); return; }
            for (const s of squads) {
                player.sendMessage(`§b[${TAG}] ${s.id} "${s.name}" captain=${s.captainId ?? "-"} members=[${s.memberIds.join(", ")}]`);
            }
        } else if (id === `${NS}:formation`) {
            const [squadIdArg, type] = args;
            const squadId = resolveSquadIdentifier(player, squadIdArg);
            if (!squadId) { player.sendMessage(`§cNo squad found matching "${squadIdArg}" (id or name).`); return; }
            if (!FORMATION_TYPES.includes(type)) {
                player.sendMessage(`§c[${TAG}] Unknown formation "${type}". Known: ${FORMATION_TYPES.join(", ")}`);
                return;
            }
            const members = getManifestedMembers(player, squadId);
            if (members.length === 0) { player.sendMessage(`§c[${TAG}] No manifested members in that squad.`); return; }

            const entityMembers = members
                .map(m => ({ characterId: m.characterId, record: m.record, entity: findEntity(m.record.manifestedEntityId) }))
                .filter(m => m.entity);

            const heading = player.getViewDirection();
            const started = executeFormation(type, player.dimension, player.location, heading, player.location, entityMembers);
            player.sendMessage(`§d[${TAG}] ${type} formation resolved - ${started}/${entityMembers.length} member(s) navigating.`);
        } else if (id === `${NS}:teleporttome`) {
            const characterId = resolveCharacterIdentifier(player, args[0]);
            if (!characterId) { player.sendMessage(`§cNo ${N.one} found (id/nickname), and none indexed.`); return; }
            const entity = teleportToMe(player, characterId, player.location, player.dimension);
            player.sendMessage(entity ? `§d[${TAG}] Teleported ${characterId} to you.` : `§c[${TAG}] Teleport failed.`);
        }
    } catch (e) {
        player.sendMessage(`§c[${TAG} test] Error: ${e?.message ?? e}`);
        console.error(`[${TAG}] Phase 2 harness error on ${id}: ${e}`);
    }
});
