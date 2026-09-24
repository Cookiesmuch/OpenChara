// Gear/inventory serialization (plan Section 2). Round-trips an ItemStack
// to/from a plain object so it can live as a field inside the character
// record's own JSON blob - no persistent "vault" entity/container needed.
//
// Captured: typeId, amount, durability, enchantments, custom name, lore,
// dyed color, potion type, nested container contents (shulker boxes,
// bundles), lock mode, keep-on-death, adventure-mode can-place-on /
// can-destroy lists, and the item's own dynamic properties (so a CW soul
// token or any other script-tagged item survives). Every field is
// optional and every read/write is individually guarded: an API gap on
// one item never costs the rest of the item or the rest of the inventory.
//
// Anything with a component this file doesn't know how to carry is logged
// ONCE per component type (Section 2's "gaps visible during testing, never
// silently lost") and falls back to what it can capture.

import { ItemStack } from "@minecraft/server";
import { TAG } from "./ids.js";

// Components that are either handled below or are static item-definition
// data (nothing per-instance to save).
const KNOWN_COMPONENTS = new Set([
    "minecraft:durability", "minecraft:enchantable", "minecraft:dyeable", "minecraft:potion",
    "minecraft:inventory", "minecraft:cooldown", "minecraft:food", "minecraft:compostable",
]);
const warnedComponents = new Set();
const MAX_NESTING = 2; // a shulker inside a bundle is fine; deeper is pathological

function tryGet(fn) { try { return fn(); } catch (e) { return undefined; } }

export function serializeItem(itemStack, depth = 0) {
    if (!itemStack) return null;
    const obj = { typeId: itemStack.typeId, amount: itemStack.amount };

    const durability = tryGet(() => itemStack.getComponent("minecraft:durability"));
    if (durability && durability.damage > 0) obj.damage = durability.damage;

    const enchantable = tryGet(() => itemStack.getComponent("minecraft:enchantable"));
    const enchList = tryGet(() => enchantable?.getEnchantments()) ?? [];
    if (enchList.length > 0) obj.enchantments = enchList.map(e => ({ type: e.type.id, level: e.level }));

    const dyeable = tryGet(() => itemStack.getComponent("minecraft:dyeable"));
    const color = tryGet(() => dyeable?.color);
    if (color) obj.color = { red: color.red, green: color.green, blue: color.blue };

    const potion = tryGet(() => itemStack.getComponent("minecraft:potion"));
    if (potion) {
        obj.potion = {
            effect: tryGet(() => potion.potionEffectType.id),
            liquid: tryGet(() => potion.potionLiquidType.id),
            modifier: tryGet(() => potion.potionModifierType.id),
        };
    }

    if (depth < MAX_NESTING) {
        const nested = tryGet(() => itemStack.getComponent("minecraft:inventory")?.container);
        if (nested && nested.size > 0) {
            const contents = [];
            for (let i = 0; i < nested.size; i++) contents.push(serializeItem(tryGet(() => nested.getItem(i)), depth + 1));
            if (contents.some(Boolean)) obj.contents = contents;
        }
    }

    if (itemStack.nameTag) obj.nameTag = itemStack.nameTag;
    const lore = tryGet(() => itemStack.getLore());
    if (lore && lore.length > 0) obj.lore = lore;

    const lockMode = tryGet(() => itemStack.lockMode);
    if (lockMode && lockMode !== "none") obj.lockMode = lockMode;
    if (tryGet(() => itemStack.keepOnDeath)) obj.keepOnDeath = true;
    const canPlaceOn = tryGet(() => itemStack.getCanPlaceOn());
    if (canPlaceOn?.length) obj.canPlaceOn = canPlaceOn;
    const canDestroy = tryGet(() => itemStack.getCanDestroy());
    if (canDestroy?.length) obj.canDestroy = canDestroy;

    const dpIds = tryGet(() => itemStack.getDynamicPropertyIds()) ?? [];
    if (dpIds.length > 0) {
        obj.dynamicProperties = {};
        for (const id of dpIds) {
            const v = tryGet(() => itemStack.getDynamicProperty(id));
            // Vector3 values are plain objects; everything else is a scalar.
            if (v !== undefined) obj.dynamicProperties[id] = v;
        }
    }

    for (const comp of tryGet(() => itemStack.getComponents()) ?? []) {
        const id = comp?.typeId;
        if (!id || KNOWN_COMPONENTS.has(id) || warnedComponents.has(id)) continue;
        warnedComponents.add(id);
        console.warn(`[${TAG}] itemSerializer: "${id}" on ${itemStack.typeId} isn't carried over - only its base fields are saved.`);
    }

    return obj;
}

function buildBaseStack(obj) {
    if (obj.potion?.effect && typeof ItemStack.createPotion === "function") {
        const potion = tryGet(() => ItemStack.createPotion({ effect: obj.potion.effect, liquid: obj.potion.liquid, modifier: obj.potion.modifier }));
        if (potion) { potion.amount = obj.amount ?? 1; return potion; }
    }
    return new ItemStack(obj.typeId, obj.amount ?? 1);
}

export function deserializeItem(obj) {
    if (!obj || !obj.typeId) return null;
    let stack;
    try { stack = buildBaseStack(obj); }
    catch (e) { console.warn(`[${TAG}] Can't recreate item ${obj.typeId}: ${e}`); return null; }

    if (typeof obj.damage === "number") {
        tryGet(() => { const d = stack.getComponent("minecraft:durability"); if (d) d.damage = obj.damage; });
    }
    if (Array.isArray(obj.enchantments)) {
        const enchantable = tryGet(() => stack.getComponent("minecraft:enchantable"));
        for (const ench of obj.enchantments) {
            try { enchantable?.addEnchantment({ type: ench.type, level: ench.level }); }
            catch (e) { console.warn(`[${TAG}] Failed to restore enchantment ${ench.type}: ${e}`); }
        }
    }
    if (obj.color) tryGet(() => { const d = stack.getComponent("minecraft:dyeable"); if (d) d.color = obj.color; });
    if (Array.isArray(obj.contents)) {
        tryGet(() => {
            const c = stack.getComponent("minecraft:inventory")?.container;
            if (c) obj.contents.forEach((item, i) => { if (item && i < c.size) tryGet(() => c.setItem(i, deserializeItem(item))); });
        });
    }
    if (obj.nameTag) tryGet(() => { stack.nameTag = obj.nameTag; });
    if (Array.isArray(obj.lore)) tryGet(() => stack.setLore(obj.lore));
    if (obj.lockMode) tryGet(() => { stack.lockMode = obj.lockMode; });
    if (obj.keepOnDeath) tryGet(() => { stack.keepOnDeath = true; });
    if (obj.canPlaceOn) tryGet(() => stack.setCanPlaceOn(obj.canPlaceOn));
    if (obj.canDestroy) tryGet(() => stack.setCanDestroy(obj.canDestroy));
    if (obj.dynamicProperties) {
        for (const [id, v] of Object.entries(obj.dynamicProperties)) tryGet(() => stack.setDynamicProperty(id, v));
    }
    return stack;
}

export function serializeGear(equippable) {
    // `equippable` = the entity's EntityEquippableComponent (native slots).
    const slots = ["Head", "Chest", "Legs", "Feet", "Mainhand", "Offhand"];
    const gear = {};
    for (const slot of slots) {
        const key = slot.toLowerCase();
        try {
            const item = equippable.getEquipment(slot);
            gear[key] = item ? serializeItem(item) : null;
        } catch (e) { gear[key] = null; }
    }
    return gear;
}

export function deserializeGear(equippable, gear) {
    const slotMap = { head: "Head", chest: "Chest", legs: "Legs", feet: "Feet", mainhand: "Mainhand", offhand: "Offhand" };
    for (const [key, slot] of Object.entries(slotMap)) {
        const stack = gear?.[key] ? deserializeItem(gear[key]) : undefined;
        try { equippable.setEquipment(slot, stack ?? undefined); } catch (e) { console.warn(`[${TAG}] Failed to restore gear slot ${slot}: ${e}`); }
    }
}

export function serializeInventory(container) {
    const items = [];
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        items.push(item ? serializeItem(item) : null);
    }
    return items;
}

export function deserializeInventory(container, items) {
    for (let i = 0; i < container.size && i < items.length; i++) {
        const stack = items[i] ? deserializeItem(items[i]) : undefined;
        try { container.setItem(i, stack ?? undefined); } catch (e) { console.warn(`[${TAG}] Failed to restore inventory slot ${i}: ${e}`); }
    }
}
