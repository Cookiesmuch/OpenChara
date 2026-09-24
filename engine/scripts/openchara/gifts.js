// Gifts - the growth trigger for the player-facing `love` and `playerBond`
// relationship tracks (Section 1.1). Right-click one of your own characters
// while holding a giftable item: one is consumed, bond xp is granted
// through the normal record write path. Favorites (speciesData.js) count
// triple. Diminishing returns per character per real day keep it from being a
// grind-by-spam - tracked in memory only (Section 8.11: an anti-spam
// window resetting on restart is harmless, not data).

import { world, system } from "@minecraft/server";
import { getCharacter, grantRelationshipXp } from "./characterRecord.js";
import { getSpeciesInfo } from "./speciesData.js";
import { NS, CHAR, TAG } from "./ids.js";

// typeId (or suffix match for families like *_tulip) -> base value
const GIFT_VALUES = [
    [/^minecraft:(cake)$/, 25],
    [/^minecraft:(golden_apple|enchanted_golden_apple)$/, 30],
    [/^minecraft:(diamond|emerald)$/, 15],
    [/^minecraft:(cookie|pumpkin_pie|honey_bottle|sweet_berries|glow_berries)$/, 8],
    [/^minecraft:(amethyst_shard|music_disc_.*)$/, 10],
    [/^minecraft:(poppy|dandelion|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|torchflower|pink_petals|cherry_leaves|wither_rose|spore_blossom)$/, 5],
];

const DAILY_FULL_VALUE = 5; // first 5 gifts a day count fully, then halve each time
const giftsToday = new Map(); // `${characterId}|${day}` -> count

export function giftValue(typeId) {
    for (const [re, v] of GIFT_VALUES) if (re.test(typeId)) return v;
    return 0;
}

function consumeHeld(player) {
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;
    const slot = player.selectedSlotIndex;
    const item = inv.getItem(slot);
    if (!item) return false;
    if (item.amount > 1) { item.amount -= 1; inv.setItem(slot, item); } else inv.setItem(slot, undefined);
    return true;
}

function giveGift(player, entity, characterId, typeId) {
    const record = getCharacter(player, characterId);
    if (!record) return;
    const favorite = getSpeciesInfo(record.species).favoriteGifts.includes(typeId);
    const day = Math.floor(Date.now() / 86400000);
    const key = `${characterId}|${day}`;
    const n = giftsToday.get(key) ?? 0;
    giftsToday.set(key, n + 1);
    const falloff = n < DAILY_FULL_VALUE ? 1 : Math.pow(0.5, n - DAILY_FULL_VALUE + 1);
    const amount = Math.max(1, Math.round(giftValue(typeId) * (favorite ? 3 : 1) * falloff));
    if (!consumeHeld(player)) return;

    const before = record.relationships;
    const after = grantRelationshipXp(player, characterId, { love: amount, playerBond: Math.ceil(amount / 2) });
    try { entity.dimension.spawnParticle("minecraft:heart_particle", { x: entity.location.x, y: entity.location.y + 2, z: entity.location.z }); } catch (e) { /* fine */ }
    const itemName = typeId.replace("minecraft:", "").replace(/_/g, " ");
    player.sendMessage(favorite ? `§d${record.nickname} loves the ${itemName}! (+${amount} love)` : `§d${record.nickname} happily accepts the ${itemName}. (+${amount} love)`);
    if (falloff < 1) player.sendMessage("§7(She's had a lot of gifts today - they mean a little less.)");
    for (const track of ["love", "playerBond"]) {
        const a = after?.relationships?.[track]?.level ?? 0, b = before?.[track]?.level ?? 0;
        if (a > b) player.sendMessage(`§d${record.nickname}'s ${track} rose to level ${a}!`);
    }
}

export function registerGifts() {
    world.beforeEvents.playerInteractWithEntity.subscribe(event => {
        const { player, target, itemStack } = event;
        if (target.typeId !== `${NS}:${CHAR}` || !itemStack || giftValue(itemStack.typeId) === 0) return;
        let characterId, ownerId;
        try { characterId = target.getDynamicProperty(`${NS}:${CHAR}Id`); ownerId = target.getDynamicProperty(`${NS}:ownerId`); } catch (e) { return; }
        if (!characterId || ownerId !== player.id) return;
        event.cancel = true;
        const typeId = itemStack.typeId;
        system.run(() => { try { giveGift(player, target, characterId, typeId); } catch (e) { console.warn(`[${TAG}] Gift failed: ${e}`); } });
    });
}
