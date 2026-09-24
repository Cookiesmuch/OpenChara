// Manual test harness for Phase 1's data-model checkpoint. Not a spike to
// delete later - the scriptevents here are the actual way to exercise the
// data model in-game until real summon recipes / GUI exist to do it.
//
// Character ids are real UUIDs (characterId.js) - too long/unwieldy to type or
// copy in chat, so every command below accepts either a real id OR her
// nickname (case-insensitive), and omitting it entirely defaults to your
// first indexed character.
//
//   /scriptevent <ns>:testcreate                 - prompts for a nickname, creates a default-species character, manifests her at your position
//   /scriptevent <ns>:mycharacters                   - lists every character you own (id, nickname, species, manifested?)
//   /scriptevent <ns>:testdespawn [id|nickname]  - despawns a character back to data
//   /scriptevent <ns>:testmanifest [id|nickname] - re-manifests a stored (despawned) character at your position
//   /scriptevent <ns>:testinspect [id|nickname]  - prints her full record to chat
//   /scriptevent <ns>:testcorrupt [id|nickname]  - hand-corrupts her primary slot's checksum, to test mirror recovery (Section 1.5.5/1.5.6)
//   /scriptevent <ns>:testrollback [id|nickname] - flips the A/B active pointer back one generation, to test rollback (Section 1.5.1a)
//   /scriptevent <ns>:testrelease [id|nickname]  - soft-deletes her (Section 1.6.1)
//   /scriptevent <ns>:testrestore [id|nickname]  - restores her from trash

import { system } from "@minecraft/server";
import { createCharacter, getCharacter, releaseCharacter, restoreCharacter, reconcileCharacterIndex } from "../characterRecord.js";
import { manifestCharacter, despawnCharacter } from "../manifest.js";
import { promptNickname } from "../nicknameUI.js";
import { getSpeciesInfo, DEFAULT_SPECIES } from "../speciesData.js";
import { readIndex, resolveCharacterIdentifier } from "../characterIndex.js";
import { NS, CHAR, N, TAG } from "../ids.js";

// scriptEventReceive fires for EVERY cw: scriptevent, not just this file's
// own - every subscriber across every module gets called regardless of
// which one actually owns the id. Without this explicit allow-list, this
// handler was falling through to its generic "resolve a character from the
// whole message" logic for commands it doesn't own at all (cw:squadjoin,
// cw:breach, ...), printing a spurious "no character found" error alongside
// whichever file's handler actually processed the command correctly.
const OWNED_IDS = new Set([
    `${NS}:testcreate`, `${NS}:my${CHAR}s`, `${NS}:testdespawn`, `${NS}:testmanifest`,
    `${NS}:testinspect`, `${NS}:testcorrupt`, `${NS}:testrollback`, `${NS}:testrelease`,
    `${NS}:testrestore`, `${NS}:testreconcile`,
]);

system.afterEvents.scriptEventReceive.subscribe(event => {
    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    const id = event.id;
    if (!OWNED_IDS.has(id)) return;
    const arg = (event.message ?? "").trim();

    try {
        if (id === `${NS}:testcreate`) {
            promptNickname(player, getSpeciesInfo(DEFAULT_SPECIES).displayName, nickname => {
                const created = createCharacter(player, { nickname, species: DEFAULT_SPECIES });
                const entity = manifestCharacter(player, created.id, player.location, player.dimension);
                player.sendMessage(entity
                    ? `§d[${TAG} test] Created and manifested ${nickname} as ${created.id}.`
                    : `§c[${TAG} test] Created ${nickname} (${created.id}) but manifestation failed - see content log.`);
            });
            return;
        }

        if (id === `${NS}:my${CHAR}s`) {
            const list = readIndex(player);
            if (list.length === 0) { player.sendMessage(`§bYou have no ${N.many} yet - run ${NS}:testcreate.`); return; }
            for (const entry of list) {
                const record = getCharacter(player, entry.id);
                const manifested = record?.manifestedEntityId ? "§amanifested" : "§7stored";
                player.sendMessage(`§b${entry.nickname} (${entry.species}) - ${manifested}§b - ${entry.id}`);
            }
            return;
        }

        const wid = resolveCharacterIdentifier(player, arg);
        if (!wid && id !== `${NS}:testreconcile`) {
            player.sendMessage(arg
                ? `§cNo ${N.one} found matching "${arg}" (id or nickname).`
                : `§cNo ${N.one} id given, and you have none indexed yet - run ${NS}:testcreate first.`);
            return;
        }

        if (id === `${NS}:testdespawn`) {
            const ok = despawnCharacter(player, wid);
            player.sendMessage(ok ? `§d[${TAG} test] Despawned ${wid} back to data.` : `§c[${TAG} test] Despawn failed - check the id.`);
        } else if (id === `${NS}:testmanifest`) {
            const entity = manifestCharacter(player, wid, player.location, player.dimension);
            player.sendMessage(entity ? `§d[${TAG} test] Manifested ${wid}.` : `§c[${TAG} test] Manifest failed - check the id/state.`);
        } else if (id === `${NS}:testinspect`) {
            const record = getCharacter(player, wid);
            player.sendMessage(record ? `§b[${TAG} test] ${wid}: ${JSON.stringify(record)}` : `§c[${TAG} test] No record for ${wid}.`);
        } else if (id === `${NS}:testcorrupt`) {
            const active = player.getDynamicProperty(`${NS}:${CHAR}:${wid}:active`);
            if (active !== "A" && active !== "B") { player.sendMessage("§cNo active slot found."); return; }
            const raw = player.getDynamicProperty(`${NS}:${CHAR}:${wid}:${active}`);
            try {
                const obj = JSON.parse(raw);
                obj._checksum = "deadbeef"; // hand-corrupt without touching content, so verifyChecksum() must fail
                player.setDynamicProperty(`${NS}:${CHAR}:${wid}:${active}`, JSON.stringify(obj));
                player.sendMessage(`§e[${TAG} test] Corrupted slot ${active} for ${wid}. Now run ${NS}:testinspect ${wid} to confirm mirror recovery.`);
            } catch (e) { player.sendMessage(`§c[${TAG} test] Corrupt failed: ${e}`); }
        } else if (id === `${NS}:testrollback`) {
            const active = player.getDynamicProperty(`${NS}:${CHAR}:${wid}:active`);
            if (active !== "A" && active !== "B") { player.sendMessage("§cNo active slot found."); return; }
            const previous = active === "A" ? "B" : "A";
            player.setDynamicProperty(`${NS}:${CHAR}:${wid}:active`, previous);
            player.sendMessage(`§e[${TAG} test] Flipped active slot ${active} -> ${previous} for ${wid}. Run ${NS}:testinspect to confirm.`);
        } else if (id === `${NS}:testrelease`) {
            const ok = releaseCharacter(player, wid);
            player.sendMessage(ok ? `§e[${TAG} test] Released ${wid} to trash.` : `§c[${TAG} test] Release failed.`);
        } else if (id === `${NS}:testrestore`) {
            const ok = restoreCharacter(player, wid);
            player.sendMessage(ok ? `§a[${TAG} test] Restored ${wid} from trash.` : `§c[${TAG} test] Restore failed (already active, or doesn't exist).`);
        } else if (id === `${NS}:testreconcile`) {
            const clean = reconcileCharacterIndex(player);
            player.sendMessage(`§b[${TAG} test] Reconciled index - ${clean.length} live entries.`);
        }
    } catch (e) {
        player.sendMessage(`§c[${TAG} test] Error: ${e?.message ?? e}`);
        console.error(`[${TAG}] Test harness error on ${id}: ${e}`);
    }
});
