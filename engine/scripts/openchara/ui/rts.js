// RTS command mode: a free top-down camera over the battlefield, an
// in-world cursor, and hotbar command items - built from the proven AC
// spikes (rtsSpike/rtsDummy, AC history 7641b72) and UI-0 spike (f).
//
// Entering:
//   1. A BODY DOUBLE (<ns>:rts_body) is spawned where the player stands and
//      takes a full copy of their gear + inventory. Only once that copy is
//      confirmed are the player's own items cleared (the rtsDummy rule: the
//      trusted copy is never destroyed before the new one is confirmed). A
//      serialized backup also goes into a player dynamic property.
//   2. The player gets locked command items, turns invisible and protected,
//      and loses movement input (WASD now pans the camera).
//   3. "follow" characters follow the body double, not the player.
// While in RTS:
//   - camera: minecraft:free, eased, looking down at a fixed angle;
//     WASD pans, jump/sneak raise/lower it;
//   - cursor: a ray from the camera along its angle, offset by how far the
//     player's head has turned since entering (the head still turns
//     freely), marked in the world with particles; the player's own body
//     is teleported along under the camera so chunks keep loading;
//   - command items (right-click): select squad (or the squad of the waifu
//     under the cursor), move here, attack/hunt, formation, surround,
//     summon squad here, exit.
// Exiting: the player goes back to the body double, gets their items back
// from it (or the backup if it's gone), and only then is it removed.
// A player who relogs, dies or hits /reload in RTS is restored the same way.

import { world, system, ItemStack, InputPermissionCategory, ItemLockMode } from "@minecraft/server";
import { serializeItem, deserializeItem } from "../itemSerializer.js";
import { readSquads, getSquad, getManifestedMembers } from "../squads.js";
import { getCharacter, setOrder } from "../characterRecord.js";
import { manifestCharacter, teleportToMe } from "../manifest.js";
import { executeFormation, FORMATION_TYPES } from "../formations.js";
import { startHunt } from "../hunt.js";
import { envelopTarget } from "../army.js";
import { setTaskLock } from "../fsm.js";
import { setFollowOverride } from "../orders.js";
import { identifyCharacter } from "../statTracking.js";
import { closeContainer } from "./container.js";
import { NS, TAG } from "../ids.js";

const BODY = `${NS}:rts_body`;
const DP_STATE = `${NS}:rts`;          // { bodyId, dim, loc, rot }
const DP_BACKUP = `${NS}:rtsBackup`;   // serialized items (second safety net)
const ARMOR = ["Head", "Chest", "Legs", "Feet"];
const ITEMS = [
    ["rts_select", "select"], ["rts_move", "move"], ["rts_attack", "attack"], ["rts_formation", "formation"],
    ["rts_surround", "surround"], ["rts_summon", "summon"], null, null, ["rts_exit", "exit"],
];
const COMMANDS = new Map(ITEMS.filter(Boolean).map(([id, cmd]) => [`${NS}:${id}`, cmd]));
const PITCH = 55;
const LOCK_TICKS = 20 * 60 * 10;
const EFFECTS = ["invisibility", "resistance", "fire_resistance", "water_breathing"];

const active = new Map(); // playerId -> state
const busy = new Set();

const say = (p, m) => { try { p.sendMessage(m); } catch (e) { /* offline */ } };
const bar = (p, m) => { try { p.onScreenDisplay.setActionBar(m); } catch (e) { /* fine */ } };
function live(id) { try { const e = id && world.getEntity(id); return e?.isValid ? e : null; } catch (e) { return null; } }
function readState(player) { try { return JSON.parse(player.getDynamicProperty(DP_STATE) ?? "null"); } catch (e) { return null; } }

export function isInRts(player) { return active.has(player.id); }

// ---- item snapshots ---------------------------------------------------------------------
// Flat 42-slot layout (rtsDummy): 0-35 inventory, 36-39 armor, 40 offhand.
function snapshotPlayer(player) {
    const eq = player.getComponent("minecraft:equippable");
    const inv = player.getComponent("minecraft:inventory").container;
    const out = new Array(42).fill(undefined);
    for (let i = 0; i < 36 && i < inv.size; i++) out[i] = inv.getItem(i);
    ARMOR.forEach((s, k) => { try { out[36 + k] = eq.getEquipment(s); } catch (e) { /* fine */ } });
    try { out[40] = eq.getEquipment("Offhand"); } catch (e) { /* fine */ }
    return out;
}
// A player's main hand is just their selected hotbar slot - restore it
// through the inventory only, never setEquipment(Mainhand) (rtsDummy note).
function writePlayer(player, items) {
    const eq = player.getComponent("minecraft:equippable");
    const inv = player.getComponent("minecraft:inventory").container;
    inv.clearAll();
    for (let i = 0; i < 36 && i < inv.size; i++) if (items[i]) inv.setItem(i, items[i]);
    ARMOR.forEach((s, k) => eq.setEquipment(s, items[36 + k]));
    eq.setEquipment("Offhand", items[40]);
}
function clearPlayer(player) {
    const eq = player.getComponent("minecraft:equippable");
    player.getComponent("minecraft:inventory").container.clearAll();
    for (const s of [...ARMOR, "Offhand"]) { try { eq.setEquipment(s, undefined); } catch (e) { /* fine */ } }
}
const itemSig = it => (it ? `${it.typeId}x${it.amount}` : "-");

// ---- command items ------------------------------------------------------------------------
function giveCommandItems(player) {
    const inv = player.getComponent("minecraft:inventory").container;
    ITEMS.forEach((entry, slot) => {
        if (!entry) return;
        const item = new ItemStack(`${NS}:${entry[0]}`, 1);
        try { item.lockMode = ItemLockMode.slot; } catch (e) { /* fine */ }
        try { item.keepOnDeath = true; } catch (e) { /* fine */ }
        inv.setItem(slot, item);
    });
}
function stripCommandItems(player) {
    try {
        const inv = player.getComponent("minecraft:inventory").container;
        for (let i = 0; i < inv.size; i++) if (COMMANDS.has(inv.getItem(i)?.typeId)) inv.setItem(i, undefined);
    } catch (e) { /* fine */ }
}

// ---- enter ---------------------------------------------------------------------------------
export function enterRts(player) {
    if (active.has(player.id) || busy.has(player.id)) return false;
    if (readState(player)) { restore(player); return false; }
    busy.add(player.id);
    try {
        closeContainer(player);
        const items = snapshotPlayer(player);            // read only - nothing touched yet
        const rot = player.getRotation();
        const loc = { ...player.location };
        const body = player.dimension.spawnEntity(BODY, loc);
        try { body.teleport(loc, { rotation: rot }); } catch (e) { /* fine */ }
        const bodyInv = body.getComponent("minecraft:inventory").container;
        items.forEach((it, i) => { if (it) bodyInv.setItem(i, it); });
        // Confirm the copy before touching the player's own items.
        for (let i = 0; i < 42; i++) {
            if (itemSig(bodyInv.getItem(i)) !== itemSig(items[i])) {
                bodyInv.clearAll(); body.remove();
                throw new Error("couldn't copy your items safely - nothing was changed");
            }
        }
        try { body.nameTag = player.name; body.setDynamicProperty(`${NS}:rtsOwner`, player.id); } catch (e) { /* fine */ }
        player.setDynamicProperty(DP_STATE, JSON.stringify({ bodyId: body.id, dim: player.dimension.id, loc, rot }));
        try { player.setDynamicProperty(DP_BACKUP, JSON.stringify(items.map(it => (it ? serializeItem(it) : null)))); }
        catch (e) { console.warn(`[${TAG}] RTS backup skipped: ${e}`); }

        clearPlayer(player);
        giveCommandItems(player);
        for (const fx of EFFECTS) { try { player.addEffect(fx, 20000000, { amplifier: fx === "resistance" ? 4 : 0, showParticles: false }); } catch (e) { /* fine */ } }
        try { player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, false); } catch (e) { /* fine */ }
        setFollowOverride(player.id, { location: loc, dimension: player.dimension });

        const state = {
            bodyId: body.id,
            cam: { x: loc.x, y: loc.y + 20, z: loc.z - 14 },
            r0: rot,
            squadId: readSquads(player).find(s => s.memberIds.length)?.id ?? null,
            formation: FORMATION_TYPES.includes("circle") ? "circle" : FORMATION_TYPES[0],
            cursor: null,
            target: null,
        };
        state.run = system.runInterval(() => tick(player, state), 2);
        active.set(player.id, state);
        say(player, "§b[Command mode] WASD pans, jump/sneak zoom, look to aim. Right-click the hotbar items to give orders.");
        return true;
    } catch (e) {
        say(player, `§c[Command mode] ${e?.message ?? e}`);
        return false;
    } finally { busy.delete(player.id); }
}

// ---- the running camera --------------------------------------------------------------------
function tick(player, s) {
    if (!player.isValid) { stop(player.id); return; }
    let mv = { x: 0, y: 0 };
    try { mv = player.inputInfo.getMovementVector(); } catch (e) { /* older API */ }
    const speed = 0.35 + (s.cam.y - (s.groundY ?? s.cam.y - 20)) * 0.03;
    s.cam.x += mv.x * speed;
    s.cam.z += mv.y * speed;
    try {
        if (String(player.inputInfo.getButtonState("Jump")) === "Pressed") s.cam.y += 0.6;
        if (String(player.inputInfo.getButtonState("Sneak")) === "Pressed") s.cam.y -= 0.6;
    } catch (e) { /* older API */ }
    if (s.groundY !== undefined) s.cam.y = Math.max(s.groundY + 6, Math.min(s.groundY + 60, s.cam.y));

    // Cursor: camera ray, aimed by the head's turn since entering.
    try {
        const r = player.getRotation();
        const pitch = Math.max(5, Math.min(89, PITCH + (r.x - s.r0.x))) * Math.PI / 180;
        const yaw = (r.y - s.r0.y) * Math.PI / 180;
        const dir = { x: -Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
        s.dir = dir;
        const origin = { ...s.cam };
        const hit = player.dimension.getBlockFromRay(origin, dir, { maxDistance: 160 });
        s.cursor = hit ? { x: hit.block.location.x + 0.5, y: hit.block.location.y + 1, z: hit.block.location.z + 0.5, block: hit.block.typeId } : null;
        let target = null;
        try {
            target = player.dimension.getEntitiesFromRay(origin, dir, { maxDistance: 160 })
                .map(h => h.entity)
                .find(e => e.isValid && e.typeId !== "minecraft:player" && e.typeId !== BODY && e.typeId !== `${NS}:container` && e.typeId !== "minecraft:item") ?? null;
        } catch (e) { /* fine */ }
        s.target = target;
        if (system.currentTick % 4 === 0) {
            if (target) {
                const own = identifyCharacter(target)?.ownerId === player.id;
                const t = target.location;
                player.spawnParticle(own ? "minecraft:heart_particle" : "minecraft:villager_angry", { x: t.x, y: t.y + 2.3, z: t.z });
            } else if (s.cursor) {
                const b = hit.block.location;
                for (const [dx, dz] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5]]) {
                    player.spawnParticle("minecraft:endrod", { x: b.x + dx, y: b.y + 1.05, z: b.z + dz });
                }
            }
        }
    } catch (e) { /* ray hiccup - skip this tick */ }

    // Keep the (invisible) player under the camera so the chunks there load.
    if (system.currentTick % 10 === 0) {
        try {
            const top = player.dimension.getTopmostBlock({ x: s.cam.x, z: s.cam.z });
            if (top) {
                s.groundY = top.location.y;
                const d = Math.hypot(player.location.x - s.cam.x, player.location.z - (s.cam.z + 14));
                if (d > 6) player.teleport({ x: s.cam.x, y: top.location.y + 1, z: s.cam.z + 14 }, { keepVelocity: false });
            }
        } catch (e) { /* unloaded */ }
    }
    try {
        player.camera.setCamera("minecraft:free", { location: s.cam, rotation: { x: PITCH, y: 0 }, easeOptions: { easeTime: 0.15 } });
    } catch (e) { console.warn(`[${TAG}] RTS camera: ${e}`); }
}

// ---- commands --------------------------------------------------------------------------------
function squadMembers(player, s) {
    if (!s.squadId) return [];
    return getManifestedMembers(player, s.squadId)
        .map(m => ({ ...m, entity: live(m.record.manifestedEntityId) }))
        .filter(m => m.entity);
}
function needSquad(player, s) {
    const squad = s.squadId && getSquad(player, s.squadId);
    if (!squad) throw new Error("No squad selected - use Select Squad.");
    return squad;
}
function lockAndHold(player, members) {
    for (const m of members) {
        setTaskLock(m.characterId, "rts", system.currentTick + LOCK_TICKS);
        // A commanded waifu holds where she's sent instead of walking back to you.
        if (m.record.order === "follow") { try { setOrder(player, m.characterId, "stay"); } catch (e) { /* fine */ } }
    }
}

function runCommand(player, cmd) {
    const s = active.get(player.id);
    if (!s) return;
    switch (cmd) {
        case "exit": exitRts(player); return;
        case "select": {
            // The squad of the waifu under the cursor, else the next squad.
            const id = s.target ? identifyCharacter(s.target) : null;
            const hers = id?.ownerId === player.id ? getCharacter(player, id.characterId)?.squadId : null;
            const squads = readSquads(player).filter(q => q.memberIds.length);
            if (!squads.length) throw new Error("You have no squads with members.");
            if (hers) s.squadId = hers;
            else {
                const i = squads.findIndex(q => q.id === s.squadId);
                s.squadId = squads[(i + 1) % squads.length].id;
            }
            const q = getSquad(player, s.squadId);
            bar(player, `§bSelected: ${q.name} (${squadMembers(player, s).length}/${q.memberIds.length} in the field)`);
            return;
        }
        case "formation": {
            const i = FORMATION_TYPES.indexOf(s.formation);
            s.formation = FORMATION_TYPES[(i + 1) % FORMATION_TYPES.length];
            bar(player, `§bFormation: ${s.formation} - Move Here uses it`);
            return;
        }
        case "move": {
            const squad = needSquad(player, s);
            if (!s.cursor) throw new Error("Aim at the ground first.");
            const members = squadMembers(player, s);
            if (!members.length) throw new Error(`${squad.name} has nobody in the field - Summon Squad Here.`);
            lockAndHold(player, members);
            const c = members.reduce((a, m) => ({ x: a.x + m.entity.location.x / members.length, z: a.z + m.entity.location.z / members.length }), { x: 0, z: 0 });
            const len = Math.hypot(s.cursor.x - c.x, s.cursor.z - c.z) || 1;
            const heading = { x: (s.cursor.x - c.x) / len, y: 0, z: (s.cursor.z - c.z) / len };
            const started = executeFormation(s.formation, player.dimension, s.cursor, heading, s.cursor, members);
            bar(player, `§a${squad.name}: ${s.formation} at ${Math.floor(s.cursor.x)}, ${Math.floor(s.cursor.z)} (${started}/${members.length})`);
            return;
        }
        case "attack": {
            const squad = needSquad(player, s);
            if (!s.target) throw new Error("Aim at a mob first.");
            if (identifyCharacter(s.target)) throw new Error("That's a waifu, not a target.");
            const members = squadMembers(player, s);
            if (!members.length) throw new Error(`${squad.name} has nobody in the field.`);
            lockAndHold(player, members);
            const desc = startHunt(members, s.target, msg => say(player, msg));
            bar(player, desc ? `§6${squad.name} hunting: ${desc}` : "§cCouldn't start the attack.");
            return;
        }
        case "surround": {
            if (!s.target || identifyCharacter(s.target)) throw new Error("Aim at a mob first.");
            const n = envelopTarget(player, s.target);
            bar(player, n ? `§6${n} squad(s) surrounding the ${s.target.typeId.replace("minecraft:", "")}` : "§cNo squads in the field.");
            return;
        }
        case "summon": {
            const squad = needSquad(player, s);
            if (!s.cursor) throw new Error("Aim at the ground first.");
            let n = 0;
            for (const id of squad.memberIds) {
                const rec = getCharacter(player, id);
                if (!rec) continue;
                const ok = live(rec.manifestedEntityId)
                    ? teleportToMe(player, id, s.cursor, player.dimension)
                    : manifestCharacter(player, id, s.cursor, player.dimension);
                if (ok) n++;
            }
            bar(player, `§a${squad.name}: ${n} deployed`);
            return;
        }
        default:
    }
}

// ---- exit / restore ------------------------------------------------------------------------------
function stop(playerId) {
    const s = active.get(playerId);
    if (s) system.clearRun(s.run);
    active.delete(playerId);
    setFollowOverride(playerId, null);
}

export function exitRts(player) {
    stop(player.id);
    restore(player);
}

// Puts the player back at their body double and hands their items back.
// Waits (up to ~5s) for the body's chunk to load; falls back to the backup.
function restore(player) {
    if (busy.has(player.id)) return;
    const st = readState(player);
    try { player.camera.clear(); } catch (e) { /* fine */ }
    try { player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, true); } catch (e) { /* fine */ }
    for (const fx of EFFECTS) { try { player.removeEffect(fx); } catch (e) { /* fine */ } }
    if (!st) { stripCommandItems(player); return; }
    busy.add(player.id);
    try { player.teleport(st.loc, { dimension: world.getDimension(st.dim), rotation: st.rot }); } catch (e) { /* fine */ }
    let tries = 0;
    const wait = system.runInterval(() => {
        tries++;
        const body = live(st.bodyId);
        if (!body && tries < 25) return;
        system.clearRun(wait);
        try {
            let items;
            if (body) {
                const inv = body.getComponent("minecraft:inventory").container;
                items = [];
                for (let i = 0; i < 42; i++) items.push(inv.getItem(i));
            } else {
                const backup = JSON.parse(player.getDynamicProperty(DP_BACKUP) ?? "null");
                if (!backup) {
                    say(player, "§c[Command mode] Your body double and backup are both gone - your items couldn't be restored. Please report this.");
                    player.setDynamicProperty(DP_STATE, undefined);
                    stripCommandItems(player);
                    return;
                }
                items = backup.map(x => (x ? deserializeItem(x) : undefined));
                say(player, "§e[Command mode] Your body double wasn't found - restored your items from the backup.");
            }
            writePlayer(player, items);
            // Only once the player has everything back does the body go.
            if (body) { body.getComponent("minecraft:inventory").container.clearAll(); body.remove(); }
            player.setDynamicProperty(DP_STATE, undefined);
            player.setDynamicProperty(DP_BACKUP, undefined);
            say(player, "§b[Command mode] Back in your body.");
        } catch (e) {
            say(player, `§c[Command mode] Couldn't restore your items yet - your body double still holds them. (${e?.message ?? e})`);
        } finally { busy.delete(player.id); }
    }, 4);
}

// ---- wiring ----------------------------------------------------------------------------------------
export function startRts() {
    world.afterEvents.itemUse.subscribe(ev => {
        const cmd = COMMANDS.get(ev.itemStack?.typeId);
        if (!cmd) return;
        const player = ev.source;
        if (!active.has(player.id)) { stripCommandItems(player); return; }
        try { runCommand(player, cmd); } catch (e) { bar(player, `§c${e?.message ?? e}`); }
    });
    // A command item never places or breaks anything.
    world.beforeEvents.playerInteractWithBlock.subscribe(ev => { if (COMMANDS.has(ev.itemStack?.typeId)) ev.cancel = true; });
    world.beforeEvents.playerBreakBlock.subscribe(ev => { if (COMMANDS.has(ev.itemStack?.typeId)) ev.cancel = true; });

    // Relog / respawn / reload while in RTS: restore.
    world.afterEvents.playerSpawn.subscribe(ev => {
        if (active.has(ev.player.id)) { stop(ev.player.id); }
        if (readState(ev.player)) system.runTimeout(() => restore(ev.player), 20);
    });
    world.afterEvents.playerLeave.subscribe(ev => stop(ev.playerId));
    system.runTimeout(() => {
        for (const p of world.getAllPlayers()) if (readState(p) && !active.has(p.id)) restore(p);
    }, 40);

    // A body double nobody is using (its owner is online and not in RTS)
    // is emptied and removed when its chunk loads.
    try {
        world.afterEvents.entityLoad.subscribe(ev => {
            const e = ev.entity;
            if (e?.typeId !== BODY) return;
            let owner = null;
            try { owner = world.getAllPlayers().find(p => p.id === e.getDynamicProperty(`${NS}:rtsOwner`)); } catch (err) { return; }
            if (!owner) return; // offline - they'll be restored from it on rejoin
            if (readState(owner)?.bodyId === e.id) return;
            system.run(() => { try { e.getComponent("minecraft:inventory").container.clearAll(); e.remove(); } catch (err) { /* fine */ } });
        });
    } catch (e) { /* older API */ }
}

// For HUDs: what the player's command mode looks like right now.
export function getRtsInfo(player) {
    const s = active.get(player.id);
    if (!s) return { active: false };
    const squad = s.squadId ? getSquad(player, s.squadId) : null;
    let targetName = "";
    if (s.target) {
        try { targetName = s.target.nameTag || s.target.typeId.replace("minecraft:", "").replace(/_/g, " "); } catch (e) { /* fine */ }
    }
    return {
        active: true,
        squad: squad?.name ?? "-",
        fielded: squad ? squadMembers(player, s).length : 0,
        members: squad?.memberIds.length ?? 0,
        formation: s.formation,
        cursor: s.cursor ? `${Math.floor(s.cursor.x)}, ${Math.floor(s.cursor.y)}, ${Math.floor(s.cursor.z)}` : "-",
        target: targetName,
        height: s.groundY !== undefined ? Math.round(s.cam.y - s.groundY) : 20,
    };
}
