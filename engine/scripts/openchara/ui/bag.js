// A character's bag: her gear and inventory as a container screen
// (container.js). Works whether she's out in the world (edits her live
// avatar, and her record at once) or resting in the Codex (edits her
// record).
//
//   slot  0-5   gear: head, chest, legs, feet, main hand, off hand
//   slot  6     info (locked)
//   slot  7/8   previous / next page (locked buttons)
//   slot  9-26  one page (18 slots) of her inventory
//
// An item put in a gear slot it can't go in (a sword on her head) moves to
// her first free inventory slot, or back to the player if she's full.

import { world } from "@minecraft/server";
import { openContainer, markerItem, giveBack } from "./container.js";
import { getCharacter, updateCharacter } from "../characterRecord.js";
import { serializeItem, deserializeItem, serializeGear, serializeInventory } from "../itemSerializer.js";
import { N } from "../ids.js";

const GEAR = [["head", "Head"], ["chest", "Chest"], ["legs", "Legs"], ["feet", "Feet"], ["mainhand", "Mainhand"], ["offhand", "Offhand"]];
const PAGE = 18;
const FIRST = 9;
const INFO = 6, PREV = 7, NEXT = 8;

const FITS = {
    head: t => /helmet|_head$|_skull$|carved_pumpkin/.test(t),
    chest: t => /chestplate|elytra/.test(t),
    legs: t => /leggings/.test(t),
    feet: t => /boots/.test(t),
    mainhand: () => true,
    offhand: () => true,
};

function liveEntity(id) {
    try { const e = id && world.getEntity(id); return e?.isValid ? e : null; } catch (e) { return null; }
}

// Where her items live right now: her avatar, or her record.
function sourceFor(player, id) {
    const rec = getCharacter(player, id);
    if (!rec || rec.deletedAt) return null;
    const entity = liveEntity(rec.manifestedEntityId);
    if (entity) {
        const eq = entity.getComponent("minecraft:equippable");
        const inv = entity.getComponent("minecraft:inventory").container;
        return {
            size: inv.size,
            valid: () => entity.isValid && getCharacter(player, id)?.manifestedEntityId === entity.id,
            read() {
                const gear = {};
                for (const [k, slot] of GEAR) { try { gear[k] = eq.getEquipment(slot); } catch (e) { gear[k] = undefined; } }
                const items = [];
                for (let i = 0; i < inv.size; i++) items.push(inv.getItem(i));
                return { gear, items };
            },
            write(gear, items) {
                for (const [k, slot] of GEAR) { try { eq.setEquipment(slot, gear[k]); } catch (e) { /* fine */ } }
                for (let i = 0; i < inv.size; i++) { try { inv.setItem(i, items[i]); } catch (e) { /* fine */ } }
                // Record too, right away, so derived stats follow the new gear.
                updateCharacter(player, id, old => ({ ...old, gear: serializeGear(eq), inventory: serializeInventory(inv) }));
            },
        };
    }
    const size = Math.max(36, rec.inventory?.length ?? 0);
    return {
        size,
        valid: () => { const r = getCharacter(player, id); return Boolean(r && !r.deletedAt && !r.manifestedEntityId); },
        read() {
            const r = getCharacter(player, id);
            const gear = {};
            for (const [k] of GEAR) gear[k] = r.gear?.[k] ? deserializeItem(r.gear[k]) : undefined;
            const items = [];
            for (let i = 0; i < size; i++) items.push(r.inventory?.[i] ? deserializeItem(r.inventory[i]) : undefined);
            return { gear, items };
        },
        write(gear, items) {
            const g = {};
            for (const [k] of GEAR) g[k] = gear[k] ? serializeItem(gear[k]) : null;
            updateCharacter(player, id, old => ({ ...old, gear: g, inventory: items.map(it => (it ? serializeItem(it) : null)) }));
        },
    };
}

export function openBag(player, id, { title } = {}) {
    const src = sourceFor(player, id);
    if (!src) throw new Error(`That ${N.one} can't be found.`);
    const rec = getCharacter(player, id);
    const cur = src.read();
    const pages = Math.max(1, Math.ceil(src.size / PAGE));
    let page = 0;

    const render = () => {
        const slots = new Array(27).fill(undefined);
        GEAR.forEach(([k], i) => { slots[i] = cur.gear[k]; });
        slots[INFO] = markerItem("minecraft:paper", `§e${rec.nickname}`, ["§7Gear: head, chest, legs, feet,", "§7main hand, off hand", `§7Bag page ${page + 1}/${pages} below`]);
        slots[PREV] = page > 0 ? markerItem("minecraft:arrow", `§f<< Page ${page}`) : markerItem("minecraft:gray_stained_glass_pane", " ");
        slots[NEXT] = page < pages - 1 ? markerItem("minecraft:arrow", `§fPage ${page + 2} >>`) : markerItem("minecraft:gray_stained_glass_pane", " ");
        for (let k = 0; k < PAGE; k++) slots[FIRST + k] = cur.items[page * PAGE + k];
        return slots;
    };

    return openContainer(player, {
        title: title ?? `${rec.nickname}'s Bag`,
        slots: render(),
        locked: [INFO, PREV, NEXT],
        isValid: src.valid,
        onSync(items, handle) {
            const strays = [];
            GEAR.forEach(([k], i) => {
                const it = items[i];
                if (it && !FITS[k](it.typeId)) { strays.push(it); cur.gear[k] = undefined; } else cur.gear[k] = it;
            });
            for (let k = 0; k < PAGE; k++) if (page * PAGE + k < src.size) cur.items[page * PAGE + k] = items[FIRST + k];
            for (const it of strays) {
                const free = cur.items.findIndex((x, i) => !x && i < src.size);
                if (free >= 0) cur.items[free] = it; else giveBack(player, it);
            }
            src.write(cur.gear, cur.items);
            if (strays.length) handle.setAll(render());
        },
        onPress(slot, handle) {
            if (slot === PREV && page > 0) page--;
            else if (slot === NEXT && page < pages - 1) page++;
            else return;
            handle.setAll(render());
        },
    });
}
