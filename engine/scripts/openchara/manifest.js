// Entity manifestation/recall (plan Section 3), reconciliation (3.1), and
// self-policing duplicate cleanup (3.2, Section 6). A cw:character entity is
// always just a disposable visualization of her data record - losing it
// never loses her; manifesting again from the record is always possible.

import { world, system } from "@minecraft/server";
import { getCharacter, setManifestedEntityId, applyDespawnSnapshot, getOrder } from "./characterRecord.js";
import { queueStat } from "./counters.js";
import { getSpeciesInfo } from "./speciesData.js";
import { getClass } from "./classData.js";
import { serializeGear, deserializeGear, serializeInventory, deserializeInventory } from "./itemSerializer.js";
import { NS, CHAR, TAG } from "./ids.js";

const CHARACTER_FAMILY = `${NS}_${CHAR}`;

function findEntityById(entityId) {
    // world.getEntity() is dimension-agnostic and the documented way to
    // resolve a live entity by id without a scan.
    try {
        const e = world.getEntity(entityId);
        return e && e.isValid ? e : null;
    } catch (e) {
        return null;
    }
}

function displayName(record) {
    return record.nickname;
}

// ---- Knockout (instead of a real, item-dropping death) --------------------
// A character whose avatar is beaten down is "knocked out": despawned to data
// with her gear/inventory intact (statTracking.js triggers it), then can't
// be re-manifested for KNOCKOUT_MS. Ephemeral by design (Section 8.11) - a
// restart clearing a cooldown is harmless.
export const KNOCKOUT_MS = 30000;
const knockedOutUntil = new Map(); // characterId -> epoch ms

export function markKnockedOut(characterId) { knockedOutUntil.set(characterId, Date.now() + KNOCKOUT_MS); }
export function getKnockoutRemainingMs(characterId) {
    const until = knockedOutUntil.get(characterId);
    if (!until) return 0;
    const left = until - Date.now();
    if (left <= 0) { knockedOutUntil.delete(characterId); return 0; }
    return left;
}

// Why the last manifestCharacter() call for a character returned null, so UI can
// show something better than "failed". Purely informational.
const lastManifestFailure = new Map();
export function getLastManifestFailure(characterId) { return lastManifestFailure.get(characterId) ?? "unknown error"; }
function fail(characterId, reason) { lastManifestFailure.set(characterId, reason); return null; }

// Section 3.2: only manifests if no other live entity currently claims
// her - enforced structurally via manifestedEntityId, never a world scan.
export function manifestCharacter(owner, characterId, location, dimension) {
    const record = getCharacter(owner, characterId);
    if (!record) {
        console.warn(`[${TAG}] manifestCharacter: no record for ${characterId} on ${owner.name}`);
        return fail(characterId, "no record found");
    }
    if (record.deletedAt !== null) {
        console.warn(`[${TAG}] manifestCharacter: ${characterId} is soft-deleted, refusing to manifest.`);
        return fail(characterId, "she's in the trash - restore her first");
    }
    if (record.manifestedEntityId && findEntityById(record.manifestedEntityId)) {
        console.warn(`[${TAG}] manifestCharacter: ${characterId} already has a live manifestation.`);
        return fail(characterId, "she's already summoned");
    }
    const koLeft = getKnockoutRemainingMs(characterId);
    if (koLeft > 0) return fail(characterId, `she's knocked out - ${Math.ceil(koLeft / 1000)}s until she can return`);

    let entity;
    try { entity = dimension.spawnEntity(`${NS}:${CHAR}`, location); }
    catch (e) { return fail(characterId, `spawn failed (${e?.message ?? e})`); }
    const speciesInfo = getSpeciesInfo(record.species);
    entity.setProperty(`${NS}:species_index`, speciesInfo.index);
    entity.nameTag = displayName(record);
    // Standing order's entity-side switch: the spawn event adds the wander
    // group by default, so turn it back off for anything but wander/home
    // (same rule as orders.js's wandersUnder()).
    const order = getOrder(record);
    if (order !== "wander" && order !== "home") { try { entity.triggerEvent(`${NS}:wander_off`); } catch (e) { /* fine */ } }
    // Combat style from her class (entity JSON's ${NS}:melee / cw:ranged groups).
    const role = getClass(record.class).positioning?.role === "ranged" ? `${NS}:role_ranged` : `${NS}:role_melee`;
    try { entity.triggerEvent(role); } catch (e) { /* fine */ }

    // Self-policing identity stamp (Section 6) - the entity's own copy of
    // "who am I," purely so it can check itself against the data record.
    entity.setDynamicProperty(`${NS}:${CHAR}Id`, characterId);
    entity.setDynamicProperty(`${NS}:ownerId`, owner.id);

    try {
        const equippable = entity.getComponent("minecraft:equippable");
        if (equippable) deserializeGear(equippable, record.gear);
    } catch (e) { console.warn(`[${TAG}] Failed to restore gear for ${characterId}: ${e}`); }

    try {
        const inv = entity.getComponent("minecraft:inventory");
        if (inv?.container) deserializeInventory(inv.container, record.inventory);
    } catch (e) { console.warn(`[${TAG}] Failed to restore inventory for ${characterId}: ${e}`); }

    setManifestedEntityId(owner, characterId, entity.id);
    queueStat(owner.id, characterId, "timesManifested", "total");
    return entity;
}

// Reverse of manifestCharacter: snapshot current entity state back into the
// record (Section 2's "snapshot before mutate" discipline), then remove
// the entity. Safe to call even if the entity is already gone (e.g. after
// reconciliation already cleared manifestedEntityId) - it just no-ops on
// the entity-side work.
export function despawnCharacter(owner, characterId) {
    const record = getCharacter(owner, characterId);
    if (!record) return false;

    const entity = record.manifestedEntityId ? findEntityById(record.manifestedEntityId) : null;
    const snapshot = {};
    if (entity) {
        try {
            const equippable = entity.getComponent("minecraft:equippable");
            if (equippable) snapshot.gear = serializeGear(equippable);
        } catch (e) { console.warn(`[${TAG}] Failed to snapshot gear for ${characterId}: ${e}`); }

        try {
            const inv = entity.getComponent("minecraft:inventory");
            if (inv?.container) snapshot.inventory = serializeInventory(inv.container);
        } catch (e) { console.warn(`[${TAG}] Failed to snapshot inventory for ${characterId}: ${e}`); }

        snapshot.location = { x: entity.location.x, y: entity.location.y, z: entity.location.z, dimension: entity.dimension.id };
    }

    // One atomic write: gear + inventory + location + manifestedEntityId
    // cleared together. Only once that's committed does the entity go -
    // never destroy the trusted copy before the new one is confirmed.
    if (!applyDespawnSnapshot(owner, characterId, snapshot)) {
        console.warn(`[${TAG}] despawnCharacter(${characterId}): snapshot commit failed - leaving her entity in place.`);
        return false;
    }

    if (entity) {
        queueStat(owner.id, characterId, "timesDespawned", "total");
        // Deferred per Phase 0's own hard-won finding: entity.remove()
        // called synchronously inside certain event callbacks silently
        // doesn't take effect. Deferring to system.run() is cheap
        // insurance and correct for a direct call too.
        system.run(() => { try { entity.remove(); } catch (e) { /* already gone */ } });
    }
    return true;
}

// "Teleport to me" (Section 5) and dimension-change following are the
// exact same primitive: despawn wherever she currently is (writing her
// state back first), then manifest fresh at the given location/dimension.
// No portal-following, no cross-dimension entity movement, ever.
export function teleportToMe(owner, characterId, location, dimension) {
    despawnCharacter(owner, characterId);
    return manifestCharacter(owner, characterId, location, dimension);
}

// ---- Reconciliation (Section 3.1) ---------------------------------------
// Low-frequency, family-filtered - never per-tick, mirrors migration.js's
// existing scanForNewlyMigrated pattern from the original (superseded)
// plan.
const RECONCILE_INTERVAL_TICKS = 100; // ~5s

function reconcileOnePlayer(player) {
    let index;
    try {
        index = JSON.parse(player.getDynamicProperty(`${NS}:${CHAR}Index`) ?? "[]");
    } catch (e) { return; }

    for (const entry of index) {
        const record = getCharacter(player, entry.id);
        if (!record || !record.manifestedEntityId) continue;
        if (!findEntityById(record.manifestedEntityId)) {
            console.warn(`[${TAG}] Reconciliation: ${entry.id} (${entry.nickname})'s manifestation is gone - clearing.`);
            setManifestedEntityId(player, entry.id, null);
        }
    }
}

export function startReconciliationLoop() {
    system.runInterval(() => {
        for (const player of world.getAllPlayers()) {
            reconcileOnePlayer(player);
        }
    }, RECONCILE_INTERVAL_TICKS);
}

// ---- Self-policing duplicate cleanup (Section 6) ------------------------
// Each ${NS}:character entity checks itself against its own owner's record on a
// slow tick; a stale entity (superseded by a newer manifestation) quietly
// self-despawns. No world-wide uniqueness scan needed anywhere.
const SELF_CHECK_INTERVAL_TICKS = 100;

export function startSelfPolicingLoop() {
    system.runInterval(() => {
        for (const dimension of [world.getDimension("overworld"), world.getDimension("nether"), world.getDimension("the_end")]) {
            let entities;
            try { entities = dimension.getEntities({ families: [CHARACTER_FAMILY] }); }
            catch (e) { continue; }

            for (const entity of entities) {
                const characterId = entity.getDynamicProperty(`${NS}:${CHAR}Id`);
                const ownerId = entity.getDynamicProperty(`${NS}:ownerId`);
                if (!characterId || !ownerId) continue;

                const owner = world.getAllPlayers().find(p => p.id === ownerId);
                if (!owner) continue; // owner offline - can't verify against their data, leave her be

                const record = getCharacter(owner, characterId);
                if (!record || record.manifestedEntityId !== entity.id) {
                    console.warn(`[${TAG}] Self-policing: stale manifestation of ${characterId} (entity ${entity.id}) - despawning.`);
                    try { entity.remove(); } catch (e) { /* already gone */ }
                }
            }
        }
    }, SELF_CHECK_INTERVAL_TICKS);
}
