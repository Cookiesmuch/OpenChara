// OpenChara container screens: a chest-style screen whose slots script
// controls, hosted by a small "satchel" entity (<ns>:container,
// container_type "container", private false - the only combination that
// opens a chest screen; bedrock-core container facts, UI-0 spike g).
//
// Scripts can't force a container open, so openContainer() places the
// satchel right where the player is looking; their next right-click opens
// it. While it exists, a poll (every POLL_TICKS):
//   - LOCKED slots (fillers, page buttons) are restored the moment anything
//     moves them, the moved copy is reclaimed from the player's cursor and
//     inventory (so nothing duplicates), and onPress(slot) runs - that's how
//     a locked item works as a button;
//   - changes in the other slots go to onSync(items) - the owner of the
//     real data writes them back;
//   - it closes when the player walks away, leaves, isValid() turns false,
//     or after IDLE_TICKS with no changes. Closing does a last sync, empties
//     the satchel (so it can never drop anything) and removes it.
//
//   const handle = openContainer(player, {
//     title: "Yuki's Bag",
//     slots: [ItemStack | undefined] x 27,   // initial contents
//     locked: [6, 7, 8],                     // button / filler slots
//     onSync(items, handle) {},              // unlocked slots changed
//     onPress(slot, handle) {},              // a locked slot was clicked
//     isValid() { return true; },
//     onClose() {},
//   });
//   handle.set(slot, item) / handle.setAll(items) / handle.close()
//
// markerItem(typeId, name, lore) makes a locked-slot item; every marker is
// swept from players' inventories and cursors, wherever it ends up.

import { world, system, ItemStack } from "@minecraft/server";
import { NS, TAG } from "../ids.js";

const TYPE = `${NS}:container`;
const POLL_TICKS = 4;
const IDLE_TICKS = 20 * 60 * 5;
const MAX_DISTANCE = 7;
const MARKER = "§r§8oc:ui";
const SIZE = 27;

const open = new Map(); // playerId -> handle (one container per player)

export function markerItem(typeId, name, lore = []) {
    const item = new ItemStack(typeId, 1);
    try { item.nameTag = name; } catch (e) { /* fine */ }
    try { item.setLore([...lore, MARKER]); } catch (e) { /* fine */ }
    return item;
}
const isMarker = item => { try { return Boolean(item?.getLore?.().includes(MARKER)); } catch (e) { return false; } };

function sig(item) {
    if (!item) return "-";
    let extra = "";
    try { extra = `${item.nameTag ?? ""}|${item.getLore().join(",")}`; } catch (e) { /* fine */ }
    try { const d = item.getComponent("minecraft:durability"); if (d) extra += `|d${d.damage}`; } catch (e) { /* fine */ }
    try { const en = item.getComponent("minecraft:enchantable"); if (en) extra += `|e${en.getEnchantments().map(x => `${x.type.id}${x.level}`).join(",")}`; } catch (e) { /* fine */ }
    return `${item.typeId}x${item.amount}|${extra}`;
}

function sweepMarkers(player) {
    try {
        const cursor = player.getComponent("minecraft:cursor_inventory");
        if (cursor && isMarker(cursor.item)) cursor.clear();
    } catch (e) { /* fine */ }
    try {
        const inv = player.getComponent("minecraft:inventory")?.container;
        if (inv) for (let i = 0; i < inv.size; i++) if (isMarker(inv.getItem(i))) inv.setItem(i, undefined);
    } catch (e) { /* fine */ }
}

export function giveBack(player, item) {
    try {
        const left = player.getComponent("minecraft:inventory")?.container?.addItem(item);
        if (left) player.dimension.spawnItem(left, player.location);
    } catch (e) { try { player.dimension.spawnItem(item, player.location); } catch (err) { /* fine */ } }
}

function spawnPoint(player) {
    const head = player.getHeadLocation();
    const dir = player.getViewDirection();
    const flat = Math.hypot(dir.x, dir.z) || 1;
    return { x: head.x + (dir.x / flat) * 1.6, y: head.y - 0.9, z: head.z + (dir.z / flat) * 1.6 };
}

export function isContainerOpen(player) { return open.has(player.id); }
export function closeContainer(player) { open.get(player.id)?.close(); }

export function openContainer(player, spec) {
    closeContainer(player);
    const entity = player.dimension.spawnEntity(TYPE, spawnPoint(player));
    try { entity.nameTag = spec.title ?? ""; } catch (e) { /* fine */ }
    try { entity.setRotation({ x: 0, y: player.getRotation().y + 180 }); } catch (e) { /* fine */ }
    const container = entity.getComponent("minecraft:inventory").container;
    const locked = new Set(spec.locked ?? []);
    const expected = new Array(SIZE).fill(undefined);  // what we last put in each slot
    let sigs = new Array(SIZE).fill("-");              // signatures of the last seen contents
    let lastChange = system.currentTick;
    let away = 0;
    let closed = false;

    const handle = {
        entity, player,
        set(slot, item) {
            expected[slot] = item;
            try { container.setItem(slot, item?.clone?.() ?? item); } catch (e) { /* fine */ }
            sigs[slot] = sig(item);
        },
        setAll(items) { for (let i = 0; i < SIZE; i++) handle.set(i, items[i]); },
        items() { const out = []; for (let i = 0; i < SIZE; i++) out.push(container.getItem(i)); return out; },
        close() {
            if (closed) return;
            closed = true;
            system.clearRun(run);
            open.delete(player.id);
            try { if (entity.isValid) spec.onSync?.(handle.items(), handle); } catch (e) { console.warn(`[${TAG}] container final sync: ${e}`); }
            try { if (entity.isValid) { container.clearAll(); entity.remove(); } } catch (e) { /* fine */ }
            try { sweepMarkers(player); } catch (e) { /* offline */ }
            try { spec.onClose?.(handle); } catch (e) { console.warn(`[${TAG}] container onClose: ${e}`); }
        },
    };
    handle.setAll(spec.slots ?? []);

    const run = system.runInterval(() => {
        try {
            if (!entity.isValid || !player.isValid || (spec.isValid && !spec.isValid())) { handle.close(); return; }
            const d = Math.hypot(player.location.x - entity.location.x, player.location.y - entity.location.y, player.location.z - entity.location.z);
            away = d > MAX_DISTANCE || player.dimension.id !== entity.dimension.id ? away + 1 : 0;
            if (away > 10 || system.currentTick - lastChange > IDLE_TICKS) { handle.close(); return; }

            const now = handle.items();
            let pressed = null, changed = false;
            for (let i = 0; i < SIZE; i++) {
                const s = sig(now[i]);
                if (s === sigs[i]) continue;
                if (locked.has(i)) {
                    pressed ??= i;
                    // A player's own item swapped onto a button goes back to them.
                    if (now[i] && !isMarker(now[i])) giveBack(player, now[i]);
                    handle.set(i, expected[i]); // put the button/filler back
                } else {
                    sigs[i] = s;
                    changed = true;
                }
            }
            sweepMarkers(player);
            if (changed || pressed !== null) lastChange = system.currentTick;
            if (changed) spec.onSync?.(now, handle);
            if (pressed !== null) spec.onPress?.(pressed, handle);
        } catch (e) { console.warn(`[${TAG}] container poll: ${e}`); }
    }, POLL_TICKS);

    open.set(player.id, handle);
    return handle;
}

// A satchel never holds anything real (the data lives in records), so any
// satchel this session didn't open - left over from a crash or a reload,
// or in a chunk that just loaded - is emptied and removed on sight, and
// only the player a satchel was opened for may open it.
function isLive(entity) {
    for (const h of open.values()) if (h.entity.id === entity.id) return h;
    return null;
}
function discard(entity) {
    try { entity.getComponent("minecraft:inventory")?.container?.clearAll(); entity.remove(); } catch (e) { /* fine */ }
}

export function startContainers() {
    system.runTimeout(() => {
        for (const dim of ["overworld", "nether", "the_end"]) {
            try { for (const e of world.getDimension(dim).getEntities({ type: TYPE })) if (!isLive(e)) discard(e); } catch (err) { /* fine */ }
        }
    }, 40);
    try {
        world.afterEvents.entityLoad.subscribe(ev => {
            if (ev.entity?.typeId === TYPE && !isLive(ev.entity)) system.run(() => discard(ev.entity));
        });
    } catch (e) { /* older API */ }
    world.beforeEvents.playerInteractWithEntity.subscribe(ev => {
        if (ev.target.typeId !== TYPE) return;
        const h = isLive(ev.target);
        if (h && h.player.id === ev.player.id) return;
        ev.cancel = true;
        if (!h) system.run(() => discard(ev.target));
    });
    world.afterEvents.playerLeave.subscribe(ev => { open.get(ev.playerId)?.close(); });
}
