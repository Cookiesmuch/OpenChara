// Generic "locked hotbar tool loadout" helper - give a player a fixed set
// of items in specific hotbar slots, each locked in its slot, immune to
// placing/breaking blocks, and routed to a handler on use. This is pure
// mechanism: it has no idea what the items ARE or what they're for. A
// project defines its own items (ids, icons, names, textures - all its
// own PATCHES content) and its own slot layout, and just tells this which
// item id does what; rts.js's command mode uses it for its hotbar, and any
// future locked-hotbar-tool feature can reuse it the same way.
//
//   registerControlItem("cw:rts_move", player => { ... });
//   setControlItems(player, { 1: "cw:rts_move", 8: "cw:rts_exit" });
//   clearControlItems(player);   // e.g. on exiting whatever mode gave them out

import { world, ItemStack, ItemLockMode } from "@minecraft/server";
import { TAG } from "../ids.js";

const handlers = new Map(); // itemTypeId -> (player) => void

export function registerControlItem(itemTypeId, handler) {
    handlers.set(itemTypeId, handler);
}

// `slots`: { [hotbarSlotIndex]: itemTypeId }.
export function setControlItems(player, slots) {
    const inv = player.getComponent("minecraft:inventory").container;
    for (const [slot, typeId] of Object.entries(slots)) {
        const item = new ItemStack(typeId, 1);
        try { item.lockMode = ItemLockMode.slot; } catch (e) { /* fine */ }
        try { item.keepOnDeath = true; } catch (e) { /* fine */ }
        inv.setItem(Number(slot), item);
    }
}

// Removes every currently-held item that's registered as a control item,
// wherever it ended up in the inventory (not just its original slot).
export function clearControlItems(player) {
    try {
        const inv = player.getComponent("minecraft:inventory").container;
        for (let i = 0; i < inv.size; i++) if (handlers.has(inv.getItem(i)?.typeId)) inv.setItem(i, undefined);
    } catch (e) { /* offline/invalid */ }
}

export function startControlItems() {
    world.afterEvents.itemUse.subscribe(ev => {
        const fn = handlers.get(ev.itemStack?.typeId);
        if (!fn) return;
        try { fn(ev.source); } catch (e) { console.warn(`[${TAG}] control item ${ev.itemStack.typeId}: ${e}`); }
    });
    // A control item is a tool for giving orders, never for building/mining.
    world.beforeEvents.playerInteractWithBlock.subscribe(ev => { if (handlers.has(ev.itemStack?.typeId)) ev.cancel = true; });
    world.beforeEvents.playerBreakBlock.subscribe(ev => { if (handlers.has(ev.itemStack?.typeId)) ev.cancel = true; });
}
