// Soul tokens (plan Section 1.3): a soul belongs to one specific,
// nicknamed character - never "a soul of that species". The item only carries her
// id; using it resolves her record and manifests *her*, subject to the
// same one-live-copy rule as every other manifest (Section 3.2). So extra
// or duplicated tokens are harmless references, never extra copies of her.
//
// The id is stored twice: as an item dynamic property (authoritative when
// the API supports it on this item) and as a dim lore line (survives
// anything that strips dynamic properties, and is visible for debugging).

import { world, ItemStack } from "@minecraft/server";
import { getCharacter } from "./characterRecord.js";
import { resolveCharacterOwnerId } from "./characterId.js";
import { manifestCharacter, getLastManifestFailure } from "./manifest.js";
import { NS, CHAR, N } from "./ids.js";

export const SOUL_ITEM = `${NS}:soul_token`;
const LORE_PREFIX = "§8soul:";

export function createSoulToken(player, characterId) {
    const record = getCharacter(player, characterId);
    if (!record) throw new Error(`No such ${N.one}.`);
    const stack = new ItemStack(SOUL_ITEM, 1);
    stack.nameTag = `§d${record.nickname}'s Soul`;
    stack.setLore([`§7Bound to ${record.nickname}`, "§7Use to call her to your side.", `${LORE_PREFIX}${characterId}`]);
    try { stack.setDynamicProperty(`${NS}:${CHAR}Id`, characterId); } catch (e) { /* lore fallback carries it */ }
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) throw new Error("No inventory.");
    const leftover = inv.addItem(stack);
    if (leftover) player.dimension.spawnItem(leftover, player.location);
    return true;
}

export function soulIdOf(itemStack) {
    try { const id = itemStack.getDynamicProperty(`${NS}:${CHAR}Id`); if (typeof id === "string") return id; } catch (e) { /* fall through */ }
    const line = (itemStack.getLore?.() ?? []).find(l => l.startsWith(LORE_PREFIX));
    return line ? line.slice(LORE_PREFIX.length) : null;
}

export function registerSouls() {
    world.afterEvents.itemUse.subscribe(event => {
        const { source: player, itemStack } = event;
        if (itemStack?.typeId !== SOUL_ITEM) return;
        const characterId = soulIdOf(itemStack);
        if (!characterId) { player.sendMessage("§7This soul is empty."); return; }
        const ownerId = resolveCharacterOwnerId(characterId);
        if (ownerId !== player.id) { player.sendMessage(`§cThis soul is bound to someone else's ${N.one}.`); return; }
        const record = getCharacter(player, characterId);
        if (!record) { player.sendMessage(`§cThe soul's ${N.one} no longer exists.`); return; }
        if (record.deletedAt !== null) { player.sendMessage(`§e${record.nickname} is in your Trash - restore her from the Codex first.`); return; }
        const entity = manifestCharacter(player, characterId, player.location, player.dimension);
        player.sendMessage(entity ? `§d${record.nickname} answers her soul's call!` : `§c${record.nickname} can't come: ${getLastManifestFailure(characterId)}.`);
    });
}
