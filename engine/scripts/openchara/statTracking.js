// Live gameplay hooks feeding the database (plan Section 1.4.3 counters,
// 1.1 xp/relationships, 1.4.2 character-to-character combat bonds, 1.8
// quest auto-completion), plus two data-safety loops:
//
//   - Knockout instead of death: a character beaten below KNOCKOUT_HP is
//     despawned to data with her gear/inventory intact, never allowed to
//     die and scatter (or duplicate) her items.
//   - Periodic live snapshot: every manifested character's gear/inventory is
//     written back to her record whenever it actually changed, so losing
//     an entity unexpectedly (chunk corruption, /kill, crash) never loses
//     more than one interval of item changes.
//
// All hot-path events (entityHurt, movement) only queue in memory; the
// actual property writes happen in one batched flush per character per
// FLUSH_INTERVAL_TICKS (counters.js's queueStat/flushQueuedStats).

import { world, system } from "@minecraft/server";
import { queueStat, flushQueuedStats } from "./counters.js";
import { getCharacter, grantXp, grantRelationshipXp, linkBond, snapshotGearAndInventory, tryCompleteQuest, addQuestProgress } from "./characterRecord.js";
import { despawnCharacter, markKnockedOut, KNOCKOUT_MS } from "./manifest.js";
import { serializeGear, serializeInventory } from "./itemSerializer.js";
import { QUESTS } from "./quests.js";
import { NS, CHAR, N, TAG } from "./ids.js";

const CHARACTER_TYPE = `${NS}:${CHAR}`;
const FLUSH_INTERVAL_TICKS = 100;     // ~5s
const SNAPSHOT_INTERVAL_TICKS = 200;  // ~10s
const DISTANCE_INTERVAL_TICKS = 20;   // ~1s
const KNOCKOUT_HP = 8;                // of the entity's 40
const BOND_RADIUS = 16;               // squadmates this close share a kill's combat bond

const lastCombatTick = new Map(); // characterId -> tick she last dealt/took damage
const COMBAT_WINDOW_TICKS = 100;   // "in combat" = hit or was hit within ~5s
const FRIENDSHIP_RADIUS = 8;       // squadmates this close for a minute grow friendship
const knockingOut = new Set(); // characterIds with a knockout despawn already scheduled
const pendingXp = new Map(); // `${ownerId}|${characterId}` -> amount
const pendingPlayerBond = new Map(); // same key -> { track: amount }

function findOnlinePlayer(playerId) {
    return world.getAllPlayers().find(p => p.id === playerId) ?? null;
}

// { characterId, ownerId } for a ${NS}:character entity, or null for anything else.
function identify(entity) {
    try {
        if (!entity || entity.typeId !== CHARACTER_TYPE) return null;
        const characterId = entity.getDynamicProperty(`${NS}:${CHAR}Id`);
        const ownerId = entity.getDynamicProperty(`${NS}:ownerId`);
        return characterId && ownerId ? { characterId, ownerId } : null;
    } catch (e) { return null; }
}

// A kill/hit credited to a character may come through her projectile rather
// than her body - check both.
function creditedCharacter(damageSource) {
    return identify(damageSource?.damagingEntity) ?? null;
}

function addPending(map, key, amount) { map.set(key, (map.get(key) ?? 0) + amount); }
function addPendingTracks(key, tracks) {
    const cur = pendingPlayerBond.get(key) ?? {};
    for (const [t, a] of Object.entries(tracks)) cur[t] = (cur[t] ?? 0) + a;
    pendingPlayerBond.set(key, cur);
}

function xpForVictim(victim) {
    try {
        const hp = victim.getComponent("minecraft:health");
        return Math.max(1, Math.round((hp?.effectiveMax ?? 10) / 2));
    } catch (e) { return 5; }
}

function nearbySquadmates(killer, killerEntity) {
    const owner = findOnlinePlayer(killer.ownerId);
    if (!owner) return [];
    const record = getCharacter(owner, killer.characterId);
    if (!record?.squadId) return [];
    let others = [];
    try {
        others = killerEntity.dimension.getEntities({ type: CHARACTER_TYPE, location: killerEntity.location, maxDistance: BOND_RADIUS });
    } catch (e) { return []; }
    const result = [];
    for (const e of others) {
        const id = identify(e);
        if (!id || id.characterId === killer.characterId) continue;
        const otherOwner = findOnlinePlayer(id.ownerId);
        if (!otherOwner) continue;
        if (getCharacter(otherOwner, id.characterId)?.squadId === record.squadId && id.ownerId === killer.ownerId) {
            result.push({ ...id, owner: otherOwner });
        }
    }
    return result;
}

function onEntityDie(event) {
    const victim = event.deadEntity;
    const source = event.damageSource;

    // A character scored a kill.
    const killer = creditedCharacter(source);
    if (killer) {
        let victimType = "unknown";
        try { victimType = victim.typeId; } catch (e) { /* fine */ }
        queueStat(killer.ownerId, killer.characterId, "kills", victimType);
        const key = `${killer.ownerId}|${killer.characterId}`;
        addPending(pendingXp, key, xpForVictim(victim));
        addPendingTracks(key, { combatBond: 2, playerBond: 1 });

        // Character-to-character combat bond with squadmates fighting
        // alongside her (Section 1.4.2). Written immediately - kills are
        // rare enough that this isn't a hot path.
        try {
            for (const mate of nearbySquadmates(killer, source.damagingEntity)) {
                linkBond(findOnlinePlayer(killer.ownerId), killer.characterId, mate.owner, mate.characterId, "combat", 5);
            }
        } catch (e) { console.warn(`[${TAG}] Combat bond update failed: ${e}`); }
    }

    // A character's avatar actually died (a one-shot past the knockout floor,
    // /kill, void...). Her record still holds the last snapshot, and her
    // inventory is `private` in the entity JSON so it doesn't drop - she's
    // simply knocked out, same as below.
    const dead = identify(victim);
    if (dead) {
        let cause = source?.cause ?? "unknown";
        try { if (source?.damagingEntity) cause = source.damagingEntity.typeId; } catch (e) { /* fine */ }
        queueStat(dead.ownerId, dead.characterId, "deaths", cause);
        markKnockedOut(dead.characterId);
        const owner = findOnlinePlayer(dead.ownerId);
        if (owner) {
            // Reconciliation would clear manifestedEntityId within ~5s
            // anyway; doing it now makes the Codex show the truth instantly.
            system.run(() => { try { despawnCharacter(owner, dead.characterId); } catch (e) { /* fine */ } });
            const name = getCharacter(owner, dead.characterId)?.nickname ?? `Your ${N.one}`;
            owner.sendMessage(`§c${name} was defeated! She's safe in your Codex and can return in ${KNOCKOUT_MS / 1000}s.`);
        }
    }
}

// "Defend me / help me": anything that hurts a player, or that a player
// attacks, gets the cw_owner_enemy tag for OWNER_ENEMY_TICKS - the entity
// JSON's nearest_attackable_target picks tagged mobs up. Never players or
// other characters (the JSON filter excludes both as well).
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

    const attacker = creditedCharacter(event.damageSource);
    if (attacker) {
        queueStat(attacker.ownerId, attacker.characterId, "damageDealt", "total", Math.round(damage));
        lastCombatTick.set(attacker.characterId, system.currentTick);
    }

    const hurt = identify(event.hurtEntity);
    if (!hurt) return;
    queueStat(hurt.ownerId, hurt.characterId, "damageTaken", "total", Math.round(damage));
    lastCombatTick.set(hurt.characterId, system.currentTick);

    let current = 20;
    try { current = event.hurtEntity.getComponent("minecraft:health").currentValue; } catch (e) { return; }
    if (current > 0 && current <= KNOCKOUT_HP && !knockingOut.has(hurt.characterId)) {
        const owner = findOnlinePlayer(hurt.ownerId);
        if (!owner) return;
        knockingOut.add(hurt.characterId); // further hits before the deferred despawn lands mustn't re-trigger
        markKnockedOut(hurt.characterId);
        queueStat(hurt.ownerId, hurt.characterId, "knockouts", "total");
        system.run(() => {
            try { despawnCharacter(owner, hurt.characterId); } catch (e) { console.warn(`[${TAG}] Knockout despawn failed: ${e}`); }
            knockingOut.delete(hurt.characterId);
        });
        const name = getCharacter(owner, hurt.characterId)?.nickname ?? `Your ${N.one}`;
        owner.sendMessage(`§e${name} was knocked out and retreated to your Codex. She can return in ${KNOCKOUT_MS / 1000}s.`);
    }
}

// ---- Flush loop: counters, xp, relationships, quest auto-completion ------
function flushAll() {
    const flushed = flushQueuedStats(findOnlinePlayer);

    for (const [key, amount] of pendingXp) {
        const [ownerId, characterId] = key.split("|");
        const owner = findOnlinePlayer(ownerId);
        if (!owner) continue;
        pendingXp.delete(key);
        const before = getCharacter(owner, characterId);
        const after = grantXp(owner, characterId, amount);
        if (before && after && after.level > before.level) {
            owner.sendMessage(`§a${after.nickname} reached level ${after.level}! (+${after.level - before.level} skill point${after.level - before.level > 1 ? "s" : ""})`);
        }
    }

    for (const [key, tracks] of pendingPlayerBond) {
        const [ownerId, characterId] = key.split("|");
        const owner = findOnlinePlayer(ownerId);
        if (!owner) continue;
        pendingPlayerBond.delete(key);
        const before = getCharacter(owner, characterId);
        const after = grantRelationshipXp(owner, characterId, tracks);
        if (before && after) {
            for (const track of Object.keys(tracks)) {
                const b = before.relationships[track]?.level ?? 0;
                const a = after.relationships[track]?.level ?? 0;
                if (a > b) owner.sendMessage(`§d${after.nickname}'s ${track} rose to level ${a}!`);
            }
        }
    }

    // Any character whose counters just moved: event/tick quest conditions
    // accumulate from the same deltas (conditions.js), then every active
    // quest is re-checked for completion.
    for (const { owner, characterId, deltas } of flushed) {
        try { addQuestProgress(owner, characterId, deltas); } catch (e) { console.warn(`[${TAG}] Quest progress failed for ${characterId}: ${e}`); }
        const record = getCharacter(owner, characterId);
        if (!record) continue;
        for (const [questId, state] of Object.entries(record.quests)) {
            if (state.status !== "active") continue;
            const done = tryCompleteQuest(owner, characterId, questId);
            if (done) owner.sendMessage(`§6Quest complete: ${QUESTS[questId]?.title ?? questId} (${done.nickname})!`);
        }
    }
}

// ---- Periodic entity loops -----------------------------------------------
function allCharacterEntities() {
    const out = [];
    for (const dimId of ["overworld", "nether", "the_end"]) {
        try { out.push(...world.getDimension(dimId).getEntities({ type: CHARACTER_TYPE })); } catch (e) { /* fine */ }
    }
    return out;
}

function snapshotAll() {
    for (const entity of allCharacterEntities()) {
        const id = identify(entity);
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
let minuteCounter = 0;

function trackDistance() {
    const seen = new Set();
    const squadNeighbors = {}; // ownerId -> [{ characterId, entity }], filled on the once-a-minute pass
    minuteCounter += DISTANCE_INTERVAL_TICKS;
    const awardTime = minuteCounter >= 1200;
    if (awardTime) minuteCounter = 0;

    for (const entity of allCharacterEntities()) {
        const id = identify(entity);
        if (!id) continue;
        seen.add(entity.id);
        const loc = entity.location;
        const prev = lastPositions.get(entity.id);
        lastPositions.set(entity.id, { x: loc.x, y: loc.y, z: loc.z, dim: entity.dimension.id });

        // A minute spent manifested alongside her player grows playerBond.
        if (awardTime) addPendingTracks(`${id.ownerId}|${id.characterId}`, { playerBond: 1 });
        if (system.currentTick - (lastCombatTick.get(id.characterId) ?? -Infinity) <= COMBAT_WINDOW_TICKS) {
            queueStat(id.ownerId, id.characterId, "combatTime", "seconds", DISTANCE_INTERVAL_TICKS / 20);
        }
        if (awardTime) (squadNeighbors[id.ownerId] ??= []).push({ ...id, entity });

        if (!prev || prev.dim !== entity.dimension.id) continue;
        const d = Math.hypot(loc.x - prev.x, loc.z - prev.z);
        if (d < 0.05 || d > 20) continue; // idle, or a teleport - not "traveled"
        let mode = "walked";
        try { if (entity.isInWater) mode = "swam"; } catch (e) { /* fine */ }
        queueStat(id.ownerId, id.characterId, "distanceTraveled", mode, Math.round(d * 10) / 10);
    }
    for (const key of lastPositions.keys()) if (!seen.has(key)) lastPositions.delete(key);
    if (awardTime) growSquadFriendships(squadNeighbors);
}

// Once a minute: every pair of same-squad characters standing near each other
// grows their character-to-character friendship bond (Section 1.4.2).
function growSquadFriendships(byOwner) {
    for (const [ownerId, list] of Object.entries(byOwner)) {
        const owner = findOnlinePlayer(ownerId);
        if (!owner || list.length < 2) continue;
        const withSquad = list.map(x => ({ ...x, squadId: getCharacter(owner, x.characterId)?.squadId })).filter(x => x.squadId);
        for (let i = 0; i < withSquad.length; i++) {
            for (let j = i + 1; j < withSquad.length; j++) {
                const a = withSquad[i], b = withSquad[j];
                if (a.squadId !== b.squadId || a.entity.dimension.id !== b.entity.dimension.id) continue;
                if (Math.hypot(a.entity.location.x - b.entity.location.x, a.entity.location.z - b.entity.location.z) > FRIENDSHIP_RADIUS) continue;
                try { linkBond(owner, a.characterId, owner, b.characterId, "friendship", 2); } catch (e) { /* fine */ }
            }
        }
    }
}

export function startStatTracking() {
    world.afterEvents.entityDie.subscribe(e => { try { onEntityDie(e); } catch (err) { console.warn(`[${TAG}] entityDie hook: ${err}`); } });
    world.afterEvents.entityHurt.subscribe(e => { try { onEntityHurt(e); } catch (err) { console.warn(`[${TAG}] entityHurt hook: ${err}`); } });
    system.runInterval(flushAll, FLUSH_INTERVAL_TICKS);
    system.runInterval(snapshotAll, SNAPSHOT_INTERVAL_TICKS);
    system.runInterval(trackDistance, DISTANCE_INTERVAL_TICKS);
    // Note: a player who logs off keeps their queued stats in memory until
    // they're back - dynamic properties can't be written from a
    // (read-only) beforeEvents.playerLeave callback, and after they've left
    // there's no Player object to write through.
}
