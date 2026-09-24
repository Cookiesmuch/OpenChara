// The engine's live gameplay loop. It owns only MECHANISMS; what gets
// counted and how anything grows is the project's (it subscribes to the
// character events emitted here - events.js - and calls the database API).
//
//   - Character events: raw world events (entityDie, entityHurt, a 1s
//     movement sweep) become kill / damageDealt / damageTaken / knockedOut /
//     death / second events for whichever character they belong to.
//   - Knockout instead of death: a character beaten to RULES.knockoutHp is
//     despawned to data with her gear/inventory intact, never allowed to
//     die and scatter (or duplicate) her items.
//   - Periodic live snapshot: every manifested character's gear/inventory
//     is written back to her record whenever it changed.
//   - Counter flush: counters a project queued (counters.js queueStat) are
//     committed in one batched write per character, then fed to quest
//     progress and quest completion, then announced as a "flush" event.
//   - Owner defense: anything that hurts a player, or that a player
//     attacks, is tagged so characters' native targeting joins in.

import { world, system } from "@minecraft/server";
import { flushQueuedStats } from "./counters.js";
import { getCharacter, snapshotGearAndInventory, tryCompleteQuest, addQuestProgress } from "./characterRecord.js";
import { despawnCharacter, markKnockedOut, KNOCKOUT_MS } from "./manifest.js";
import { serializeGear, serializeInventory } from "./itemSerializer.js";
import { QUESTS } from "./quests.js";
import { emit } from "./events.js";
import { RULES } from "./rules.js";
import { NS, CHAR, N, TAG } from "./ids.js";

const CHARACTER_TYPE = `${NS}:${CHAR}`;
const FLUSH_INTERVAL_TICKS = 100;     // ~5s
const SNAPSHOT_INTERVAL_TICKS = 200;  // ~10s
const SECOND_TICKS = 20;
const COMBAT_WINDOW_TICKS = RULES.combatWindowSeconds * 20;

const lastCombatTick = new Map(); // characterId -> tick she last dealt/took damage
const knockingOut = new Set();    // characterIds with a knockout despawn already scheduled

export function findOnlinePlayer(playerId) {
    return world.getAllPlayers().find(p => p.id === playerId) ?? null;
}

// { characterId, ownerId } for one of this project's character entities,
// or null for anything else.
export function identifyCharacter(entity) {
    try {
        if (!entity || entity.typeId !== CHARACTER_TYPE) return null;
        const characterId = entity.getDynamicProperty(`${NS}:${CHAR}Id`);
        const ownerId = entity.getDynamicProperty(`${NS}:ownerId`);
        return characterId && ownerId ? { characterId, ownerId } : null;
    } catch (e) { return null; }
}

export function isInCombat(characterId) {
    return system.currentTick - (lastCombatTick.get(characterId) ?? -Infinity) <= COMBAT_WINDOW_TICKS;
}

function withOwner(id) { return { ...id, owner: findOnlinePlayer(id.ownerId) }; }

function onEntityDie(event) {
    const victim = event.deadEntity;
    const source = event.damageSource;

    // A kill credited to a character (arrows report their shooter as the
    // damaging entity, so ranged kills count too).
    const killer = identifyCharacter(source?.damagingEntity);
    if (killer) {
        let victimType = "unknown";
        try { victimType = victim.typeId; } catch (e) { /* fine */ }
        emit("kill", { ...withOwner(killer), entity: source.damagingEntity, victim, victimType });
    }

    // A character's avatar actually died (a one-shot past the knockout
    // floor, /kill, the void...). Her record still holds the last snapshot
    // and her inventory is `private` so it doesn't drop - she's simply
    // knocked out, same as below.
    const dead = identifyCharacter(victim);
    if (dead) {
        let cause = source?.cause ?? "unknown";
        try { if (source?.damagingEntity) cause = source.damagingEntity.typeId; } catch (e) { /* fine */ }
        markKnockedOut(dead.characterId);
        const payload = { ...withOwner(dead), cause };
        emit("death", payload);
        if (payload.owner) {
            // Reconciliation would clear manifestedEntityId within ~5s
            // anyway; doing it now makes menus show the truth at once.
            system.run(() => { try { despawnCharacter(payload.owner, dead.characterId); } catch (e) { /* fine */ } });
            const name = getCharacter(payload.owner, dead.characterId)?.nickname ?? `Your ${N.one}`;
            payload.owner.sendMessage(`§c${name} was defeated! She's safe and can return in ${KNOCKOUT_MS / 1000}s.`);
        }
    }
}

const OWNER_ENEMY_TAG = `${NS}_owner_enemy`;
const OWNER_ENEMY_TICKS = 600;
function markOwnerEnemy(entity) {
    try {
        if (!entity?.isValid || entity.typeId === "minecraft:player" || entity.typeId === CHARACTER_TYPE) return;
        if (entity.hasTag(OWNER_ENEMY_TAG)) return;
        entity.addTag(OWNER_ENEMY_TAG);
        system.runTimeout(() => { try { if (entity.isValid) entity.removeTag(OWNER_ENEMY_TAG); } catch (e) { /* gone */ } }, OWNER_ENEMY_TICKS);
    } catch (e) { /* fine */ }
}

function onEntityHurt(event) {
    const damage = event.damage ?? 0;
    if (damage <= 0) return;

    try {
        const hurtType = event.hurtEntity?.typeId;
        const src = event.damageSource?.damagingEntity;
        if (hurtType === "minecraft:player" && src) markOwnerEnemy(src);
        else if (src?.typeId === "minecraft:player") markOwnerEnemy(event.hurtEntity);
    } catch (e) { /* fine */ }

    const attacker = identifyCharacter(event.damageSource?.damagingEntity);
    if (attacker) {
        lastCombatTick.set(attacker.characterId, system.currentTick);
        emit("damageDealt", { ...withOwner(attacker), entity: event.damageSource.damagingEntity, target: event.hurtEntity, damage });
    }

    const hurt = identifyCharacter(event.hurtEntity);
    if (!hurt) return;
    lastCombatTick.set(hurt.characterId, system.currentTick);
    const hurtPayload = { ...withOwner(hurt), entity: event.hurtEntity, source: event.damageSource?.damagingEntity ?? null, cause: event.damageSource?.cause ?? "unknown", damage };
    emit("damageTaken", hurtPayload);

    let current = 20;
    try { current = event.hurtEntity.getComponent("minecraft:health").currentValue; } catch (e) { return; }
    const owner = hurtPayload.owner;
    if (current > 0 && current <= RULES.knockoutHp && owner && !knockingOut.has(hurt.characterId)) {
        knockingOut.add(hurt.characterId); // further hits before the deferred despawn lands mustn't re-trigger
        markKnockedOut(hurt.characterId);
        emit("knockedOut", { owner, ownerId: hurt.ownerId, characterId: hurt.characterId });
        system.run(() => {
            try { despawnCharacter(owner, hurt.characterId); } catch (e) { console.warn(`[${TAG}] Knockout despawn failed: ${e}`); }
            knockingOut.delete(hurt.characterId);
        });
        const name = getCharacter(owner, hurt.characterId)?.nickname ?? `Your ${N.one}`;
        owner.sendMessage(`§e${name} was knocked out and retreated to safety. She can return in ${KNOCKOUT_MS / 1000}s.`);
    }
}

// ---- Counter flush -> quest progress -> quest completion -> "flush" event ----
function flushAll() {
    for (const { owner, characterId, deltas } of flushQueuedStats(findOnlinePlayer)) {
        try { addQuestProgress(owner, characterId, deltas); } catch (e) { console.warn(`[${TAG}] Quest progress failed for ${characterId}: ${e}`); }
        const record = getCharacter(owner, characterId);
        if (record) {
            for (const [questId, state] of Object.entries(record.quests)) {
                if (state.status !== "active") continue;
                const done = tryCompleteQuest(owner, characterId, questId);
                if (done) owner.sendMessage(`§6Quest complete: ${QUESTS[questId]?.title ?? questId} (${done.nickname})!`);
            }
        }
        emit("flush", { owner, characterId, deltas });
    }
}

// ---- Periodic entity loops -------------------------------------------------
function allCharacterEntities() {
    const out = [];
    for (const dimId of ["overworld", "nether", "the_end"]) {
        try { out.push(...world.getDimension(dimId).getEntities({ type: CHARACTER_TYPE })); } catch (e) { /* fine */ }
    }
    return out;
}

function snapshotAll() {
    for (const entity of allCharacterEntities()) {
        const id = identifyCharacter(entity);
        if (!id) continue;
        const owner = findOnlinePlayer(id.ownerId);
        if (!owner) continue;
        const record = getCharacter(owner, id.characterId);
        if (!record || record.manifestedEntityId !== entity.id) continue; // stale copy - self-policing's job, never snapshot it
        try {
            const gear = serializeGear(entity.getComponent("minecraft:equippable"));
            const inventory = serializeInventory(entity.getComponent("minecraft:inventory").container);
            snapshotGearAndInventory(owner, id.characterId, gear, inventory);
        } catch (e) { console.warn(`[${TAG}] Live snapshot failed for ${id.characterId}: ${e}`); }
    }
}

const lastPositions = new Map(); // entity id -> {x, y, z, dim}

function everySecond() {
    const seen = new Set();
    for (const entity of allCharacterEntities()) {
        const id = identifyCharacter(entity);
        if (!id) continue;
        seen.add(entity.id);
        const loc = entity.location;
        const prev = lastPositions.get(entity.id);
        lastPositions.set(entity.id, { x: loc.x, y: loc.y, z: loc.z, dim: entity.dimension.id });

        let distance = 0;
        if (prev && prev.dim === entity.dimension.id) {
            const d = Math.hypot(loc.x - prev.x, loc.z - prev.z);
            if (d >= 0.05 && d <= 20) distance = d; // idle, or a teleport - not "traveled"
        }
        let mode = "walked";
        try { if (entity.isInWater) mode = "swam"; } catch (e) { /* fine */ }
        emit("second", { ...withOwner(id), entity, distance, mode, inCombat: isInCombat(id.characterId) });
    }
    for (const key of lastPositions.keys()) if (!seen.has(key)) lastPositions.delete(key);
}

export function startStatTracking() {
    world.afterEvents.entityDie.subscribe(e => { try { onEntityDie(e); } catch (err) { console.warn(`[${TAG}] entityDie hook: ${err}`); } });
    world.afterEvents.entityHurt.subscribe(e => { try { onEntityHurt(e); } catch (err) { console.warn(`[${TAG}] entityHurt hook: ${err}`); } });
    system.runInterval(flushAll, FLUSH_INTERVAL_TICKS);
    system.runInterval(snapshotAll, SNAPSHOT_INTERVAL_TICKS);
    system.runInterval(everySecond, SECOND_TICKS);
    // A player who logs off keeps their queued stats in memory until they're
    // back: dynamic properties can't be written from a (read-only)
    // beforeEvents.playerLeave callback, and after they've left there's no
    // Player object to write through.
}
