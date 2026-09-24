// The character record itself (plan Section 1.1) - creation, the cached
// `stats` recompute, and every mutation path (level-up, bond linking,
// soft-delete, quest completion, schema migration). Every mutation here
// goes through dataCore's writeCharacter() - nothing in this file ever writes
// a dynamic property directly.

import { CW_SCHEMA_VERSION, readCharacter, writeCharacter } from "./dataCore.js";
import { addToIndex, updateIndexEntry, removeFromIndex, reconcileIndex, isNicknameTaken } from "./characterIndex.js";
import { generateCharacterId, registerCharacterOwner } from "./characterId.js";
import { getClass, resolveDefaultClass } from "./classData.js";
import { readBond, writeBond } from "./bonds.js";
import { QUESTS, checkQuestProgress, questAvailableTo } from "./quests.js";
import { isAccumulating, eventAmount, conditionKey } from "./conditions.js";
import { readIndex } from "./characterIndex.js";
import { NS, CHAR, N, TAG } from "./ids.js";

// ---- Stat computation (Section 1.0/1.1: cache, computed from the real
// sources of truth - level + static growth curve + gear + skills) --------
export function computeStats(record) {
    const cls = getClass(record.class);
    const stats = { ...cls.baseStats };
    const levels = Math.max(0, record.level - 1);
    for (const key of Object.keys(stats)) {
        stats[key] += (cls.perLevelGrowth[key] ?? 0) * levels;
    }
    // Skill-node bonuses (flat, from the class's static skill tree).
    for (const skillId of record.unlockedSkills ?? []) {
        const node = cls.skillTree?.nodes?.[skillId];
        if (!node) continue;
        if (node.effect?.atkPct) stats.atk *= 1 + node.effect.atkPct;
        if (node.effect?.critRate) stats.critRate += node.effect.critRate;
    }
    // Gear: vanilla armor points -> DEF, weapon tier -> ATK, each
    // enchantment level a small bonus. Custom item stat rolls can extend
    // GEAR_STATS later without touching any stored record (Section 1.0).
    for (const item of Object.values(record.gear ?? {})) {
        if (!item?.typeId) continue;
        const g = gearStatsFor(item.typeId);
        stats.def += g.def;
        stats.atk += g.atk;
        const enchLevels = (item.enchantments ?? []).reduce((a, e) => a + (e.level ?? 0), 0);
        if (g.def > 0) stats.def += enchLevels * 2;
        if (g.atk > 0) stats.atk += enchLevels * 3;
    }
    return stats;
}

const ARMOR_POINTS = { helmet: [1, 2, 2, 3, 3, 2], chestplate: [3, 5, 6, 8, 8, 5], leggings: [2, 4, 5, 6, 7, 3], boots: [1, 1, 2, 3, 3, 1] };
const TIERS = ["leather", "golden", "iron", "diamond", "netherite", "chainmail"];
const WEAPON_ATK = { wooden: 4, golden: 4, stone: 5, iron: 6, diamond: 7, netherite: 8 };

export function gearStatsFor(typeId) {
    const name = typeId.replace("minecraft:", "");
    const [tier, piece] = name.split("_");
    if (ARMOR_POINTS[piece]) {
        const t = TIERS.indexOf(tier);
        return { def: t >= 0 ? ARMOR_POINTS[piece][t] * 5 : 0, atk: 0 };
    }
    if (name === "turtle_helmet") return { def: 10, atk: 0 };
    if (name === "shield") return { def: 15, atk: 0 };
    if (piece === "sword" || piece === "axe") return { def: 0, atk: (WEAPON_ATK[tier] ?? 4) * (piece === "axe" ? 6 : 5) };
    if (name === "bow" || name === "crossbow") return { def: 0, atk: 30 };
    if (name === "trident") return { def: 0, atk: 45 };
    if (name === "mace") return { def: 0, atk: 30 };
    return { def: 0, atk: 0 };
}

function defaultRecord({ nickname, species, class: classId, soulId }) {
    const now = Date.now();
    return {
        v: CW_SCHEMA_VERSION,
        nickname,
        species,
        soulId,
        class: classId,
        rank: 0,
        eidolonLevel: 0,
        level: 1,
        xp: 0,
        stats: null, // filled in below once the shape is otherwise final
        skillPoints: 0,
        unlockedSkills: [],
        abilities: [...getClass(classId).defaultAbilities],
        resources: {},
        relationships: {
            playerBond: { level: 0, xp: 0 },
            combatBond: { level: 0, xp: 0 },
            friendship: { level: 0, xp: 0 },
            love: { level: 0, xp: 0 },
        },
        bondPartners: [],
        story: { flags: {}, cutscenesUnlocked: [], cutscenesSeen: [] },
        quests: {},
        gear: { head: null, chest: null, legs: null, feet: null, mainhand: null, offhand: null },
        inventory: [],
        squadId: null,
        order: "follow",
        homeLocation: null,
        lastManifestLocation: null,
        manifestedEntityId: null,
        createdAt: now,
        deletedAt: null,
        migratedFrom: null,
    };
}

// ---- Creation (summon or migration entry point) ------------------------
// Does NOT prompt for a nickname - callers (the summon recipe handler, or
// the migration item, or nicknameUI.js's modal flow) resolve the nickname
// first, since uniqueness-checking needs the player anyway.
// Active-roster cap (the plan's 50-characters-per-player figure). Released
// characters in the Trash don't count (Section 1.6.1).
export const MAX_ROSTER = 50;

export function createCharacter(owner, { nickname, species, migratedFrom = null }) {
    if (readIndex(owner).length >= MAX_ROSTER) {
        throw new Error(`Roster is full (${MAX_ROSTER}). Release someone first.`);
    }
    if (isNicknameTaken(owner, nickname)) {
        throw new Error(`Nickname "${nickname}" is already taken for this player.`);
    }
    const id = generateCharacterId();
    const classId = resolveDefaultClass(species);
    let record = defaultRecord({ nickname, species, class: classId, soulId: id });
    record.stats = computeStats(record);
    record.migratedFrom = migratedFrom;

    const committed = writeCharacter(owner, id, () => record);
    if (!committed) throw new Error(`Failed to create ${N.one} record (validation/commit failed).`);

    registerCharacterOwner(id, owner.id);
    addToIndex(owner, { id, nickname, species });
    return { id, record: committed };
}

export function getCharacter(owner, characterId) {
    return readCharacter(owner, characterId);
}

export function recordExists(owner, characterId) {
    return getCharacter(owner, characterId) !== null;
}

export function reconcileCharacterIndex(owner) {
    return reconcileIndex(owner, id => recordExists(owner, id));
}

// ---- Mutations (all funnel through writeCharacter's copy-validate-commit) --

export function renameCharacter(owner, characterId, newNickname) {
    if (isNicknameTaken(owner, newNickname, characterId)) return false;
    const result = writeCharacter(owner, characterId, old => ({ ...old, nickname: newNickname }));
    if (!result) return false;
    updateIndexEntry(owner, characterId, { nickname: newNickname });
    return true;
}

export const MAX_LEVEL = 80;

export function xpToNextLevel(level) {
    // Simple placeholder curve - real leveling curve is a balance pass,
    // not a schema concern.
    return 100 * level;
}

export function grantXp(owner, characterId, amount) {
    return writeCharacter(owner, characterId, old => {
        let { level, xp, skillPoints } = old;
        if (level >= MAX_LEVEL) return old;
        xp += amount;
        while (level < MAX_LEVEL && xp >= xpToNextLevel(level)) {
            xp -= xpToNextLevel(level);
            level += 1;
            skillPoints += 1;
        }
        if (level >= MAX_LEVEL) xp = 0;
        const next = { ...old, level, xp, skillPoints };
        next.stats = computeStats(next);
        return next;
    });
}

// Shared level-up rule for every relationship track (player-facing and
// character-to-character alike): 100*(level+1) xp per level. Placeholder
// balance, same caveat as xpToNextLevel().
export function levelTrack(track, delta) {
    let { level, xp } = track ?? { level: 0, xp: 0 };
    xp += delta;
    while (xp >= 100 * (level + 1)) { xp -= 100 * (level + 1); level += 1; }
    return { level, xp };
}

// `deltas` = { playerBond: 5, combatBond: 1, ... } - an open dict, so a new
// track name just works (Section 1.1: relationships is deliberately open).
export function grantRelationshipXp(owner, characterId, deltas) {
    return writeCharacter(owner, characterId, old => {
        const relationships = { ...old.relationships };
        for (const [track, delta] of Object.entries(deltas)) {
            relationships[track] = levelTrack(relationships[track], delta);
        }
        return { ...old, relationships };
    });
}

export function unlockSkill(owner, characterId, skillId) {
    return writeCharacter(owner, characterId, old => {
        const cls = getClass(old.class);
        const node = cls.skillTree?.nodes?.[skillId];
        if (!node) throw new Error(`Unknown skill node "${skillId}" for class ${old.class}`);
        if (old.unlockedSkills.includes(skillId)) throw new Error("Already unlocked");
        if (old.skillPoints < node.cost) throw new Error("Not enough skill points");
        const missing = node.prerequisites.filter(p => !old.unlockedSkills.includes(p));
        if (missing.length > 0) throw new Error(`Missing prerequisites: ${missing.join(", ")}`);
        const next = { ...old, unlockedSkills: [...old.unlockedSkills, skillId], skillPoints: old.skillPoints - node.cost };
        next.stats = computeStats(next);
        return next;
    });
}

export function setGear(owner, characterId, gear) {
    return writeCharacter(owner, characterId, old => {
        const next = { ...old, gear };
        next.stats = computeStats(next);
        return next;
    });
}

export function setInventory(owner, characterId, inventory) {
    return writeCharacter(owner, characterId, old => ({ ...old, inventory }));
}

// Gear + inventory together in one write (the periodic live-entity
// snapshot, statTracking.js). Skips the write entirely when nothing
// changed, so an idle character costs zero writes.
export function snapshotGearAndInventory(owner, characterId, gear, inventory) {
    const current = readCharacter(owner, characterId);
    if (!current) return null;
    if (JSON.stringify(current.gear) === JSON.stringify(gear) &&
        JSON.stringify(current.inventory) === JSON.stringify(inventory)) return current;
    return writeCharacter(owner, characterId, old => {
        const next = { ...old, gear, inventory };
        next.stats = computeStats(next);
        return next;
    });
}

// Everything a despawn changes, committed as ONE atomic record write
// (previously four separate writes - an interruption between them could
// leave gear saved but manifestedEntityId still pointing at a dead entity).
export function applyDespawnSnapshot(owner, characterId, { gear, inventory, location }) {
    return writeCharacter(owner, characterId, old => {
        const next = { ...old, manifestedEntityId: null };
        if (gear) next.gear = gear;
        if (inventory) next.inventory = inventory;
        if (location) next.lastManifestLocation = location;
        next.stats = computeStats(next);
        return next;
    });
}

export function setHomeLocation(owner, characterId, location) {
    return writeCharacter(owner, characterId, old => ({ ...old, homeLocation: location }));
}

export function setManifestedEntityId(owner, characterId, entityId) {
    return writeCharacter(owner, characterId, old => ({ ...old, manifestedEntityId: entityId }));
}

export function setLastManifestLocation(owner, characterId, location) {
    return writeCharacter(owner, characterId, old => ({ ...old, lastManifestLocation: location }));
}

export function setResource(owner, characterId, meterKey, value) {
    return writeCharacter(owner, characterId, old => ({ ...old, resources: { ...old.resources, [meterKey]: value } }));
}

// ---- Character-to-character bonds (Section 1.4.2) -----------------------
// characterIdA/characterIdB are already globally unique (characterId.js) - no
// owner-prefix concatenation needed to use them as the pair key or as
// entries in each other's bondPartners.
export function linkBond(ownerA, characterIdA, ownerB, characterIdB, track, delta) {
    writeBond(characterIdA, characterIdB, old => ({ ...old, [track]: levelTrack(old[track], delta) }));

    for (const [owner, characterId, otherId] of [[ownerA, characterIdA, characterIdB], [ownerB, characterIdB, characterIdA]]) {
        if (!owner) continue; // offline owner - the integrity scan backfills bondPartners later
        if (readCharacter(owner, characterId)?.bondPartners.includes(otherId)) continue; // skip a no-op A/B write
        writeCharacter(owner, characterId, old => {
            if (old.bondPartners.includes(otherId)) return old;
            return { ...old, bondPartners: [...old.bondPartners, otherId] };
        });
    }
}

export function getBondBetween(characterIdA, characterIdB) {
    return readBond(characterIdA, characterIdB);
}

// ---- Soft-delete (Section 1.6.1) ----------------------------------------
export function releaseCharacter(owner, characterId) {
    const result = writeCharacter(owner, characterId, old => ({ ...old, deletedAt: Date.now() }));
    if (result) removeFromIndex(owner, characterId);
    return result;
}

export function restoreCharacter(owner, characterId) {
    const record = readCharacter(owner, characterId);
    if (!record || record.deletedAt === null) return null;
    if (readIndex(owner).length >= MAX_ROSTER) return null;
    const result = writeCharacter(owner, characterId, old => ({ ...old, deletedAt: null }));
    if (result) addToIndex(owner, { id: characterId, nickname: result.nickname, species: result.species });
    return result;
}

export const TRASH_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 real-world days, a config value not a hardcoded assumption

export function isPastGracePeriod(record, now = Date.now()) {
    return record.deletedAt !== null && now - record.deletedAt > TRASH_GRACE_PERIOD_MS;
}

// ---- Quests (Section 1.8) ------------------------------------------------
export function startQuest(owner, characterId, questId) {
    if (!QUESTS[questId]) return null;
    const current = readCharacter(owner, characterId);
    if (!current || current.quests[questId] || !questAvailableTo(QUESTS[questId], current)) return null;
    return writeCharacter(owner, characterId, old => {
        if (old.quests[questId]) return old; // already tracked, no-op
        return { ...old, quests: { ...old.quests, [questId]: { status: "active", progress: {} } } };
    });
}

// Checks live conditions and, if satisfied, applies rewards atomically in
// the same write. Returns the committed record, or null if not yet met /
// write failed.
export function tryCompleteQuest(owner, characterId, questId) {
    const def = QUESTS[questId];
    if (!def) return null;
    const current = readCharacter(owner, characterId);
    if (!current || current.quests[questId]?.status !== "active") return null;
    if (!checkQuestProgress(current, owner, characterId, questId)) return null;

    return writeCharacter(owner, characterId, old => {
        let next = { ...old, quests: { ...old.quests, [questId]: { ...old.quests[questId], status: "completed" } } };
        const r = def.rewards ?? {};
        if (r.cutsceneUnlock) {
            next.story = { ...next.story, cutscenesUnlocked: [...next.story.cutscenesUnlocked, r.cutsceneUnlock] };
        }
        if (typeof r.skillPoints === "number") next.skillPoints += r.skillPoints;
        if (typeof r.rank === "number") next.rank += r.rank;
        if (typeof r.eidolonLevel === "number") next.eidolonLevel = Math.min(MAX_EIDOLON, next.eidolonLevel + r.eidolonLevel);
        next.stats = computeStats(next);
        return next;
    });
}

// Advances every active quest's event/tick conditions by one flush of
// counter deltas (statTracking.js). One write, and only when something
// actually moved - most flushes touch no quest at all.
export function addQuestProgress(owner, characterId, deltas) {
    const current = readCharacter(owner, characterId);
    if (!current) return null;
    const updates = {};
    for (const [questId, state] of Object.entries(current.quests)) {
        if (state.status !== "active") continue;
        const def = QUESTS[questId];
        (def?.conditions ?? []).forEach((cond, i) => {
            if (!isAccumulating(cond)) return;
            const amount = eventAmount(cond, deltas);
            if (amount <= 0) return;
            const key = conditionKey(cond, i);
            (updates[questId] ??= { ...(state.progress ?? {}) })[key] = ((state.progress ?? {})[key] ?? 0) + amount;
        });
    }
    if (Object.keys(updates).length === 0) return current;
    return writeCharacter(owner, characterId, old => {
        const quests = { ...old.quests };
        for (const [questId, progress] of Object.entries(updates)) quests[questId] = { ...quests[questId], progress };
        return { ...old, quests };
    });
}

// ---- Eidolons (Section 1.1: only the unlocked level is stored; the cost
// lives in speciesData.js's static table) -----------------------------------
export const MAX_EIDOLON = 6;

export function raiseEidolon(owner, characterId) {
    return writeCharacter(owner, characterId, old => {
        if (old.eidolonLevel >= MAX_EIDOLON) throw new Error("Already at max Eidolon.");
        return { ...old, eidolonLevel: old.eidolonLevel + 1 };
    });
}

// ---- Story (Section 1.1/1.8): storage for a future cutscene system -------
export function setStoryFlag(owner, characterId, flag, value = true) {
    return writeCharacter(owner, characterId, old => ({ ...old, story: { ...old.story, flags: { ...old.story.flags, [flag]: value } } }));
}

export function unlockCutscene(owner, characterId, cutsceneId) {
    return writeCharacter(owner, characterId, old => old.story.cutscenesUnlocked.includes(cutsceneId) ? old
        : { ...old, story: { ...old.story, cutscenesUnlocked: [...old.story.cutscenesUnlocked, cutsceneId] } });
}

export function markCutsceneSeen(owner, characterId, cutsceneId) {
    return writeCharacter(owner, characterId, old => old.story.cutscenesSeen.includes(cutsceneId) ? old
        : { ...old, story: { ...old.story, cutscenesSeen: [...old.story.cutscenesSeen, cutsceneId] } });
}

// ---- Schema-version migration (Section 1.5.4) ---------------------------
// Never migrates in place: transform -> validate -> backup old -> commit.
// `migrations` maps fromVersion -> (oldRecord) => partialNewFields.
const MIGRATIONS = {
    // v1 -> v2: standing orders. Every pre-existing character was effectively
    // following (dimensionFollow treated all manifested characters that way).
    1: (old) => ({ ...old, order: "follow" }),
};

export const ORDERS = ["follow", "stay", "wander", "home"];

export function getOrder(record) {
    return ORDERS.includes(record?.order) ? record.order : "follow";
}

export function setOrder(owner, characterId, order) {
    if (!ORDERS.includes(order)) throw new Error(`Unknown order "${order}".`);
    return writeCharacter(owner, characterId, old => ({ ...old, order }));
}

export function migrateCharacterIfNeeded(owner, characterId) {
    const record = readCharacter(owner, characterId);
    if (!record || record.v >= CW_SCHEMA_VERSION) return record;

    const transform = MIGRATIONS[record.v];
    if (!transform) {
        console.warn(`[${TAG}] No migration registered for ${N.one} ${characterId} at v${record.v} -> v${CW_SCHEMA_VERSION}; left untouched.`);
        return record;
    }

    let migrated;
    try {
        migrated = { ...transform(record), v: CW_SCHEMA_VERSION };
    } catch (e) {
        console.error(`[${TAG}] Migration for ${N.one} ${characterId} threw, left at v${record.v}: ${e}`);
        return record;
    }

    // Bounded rolling backup - "one migration back" is enough.
    owner.setDynamicProperty(`${NS}:migrationBackup:${characterId}:${record.v}`, JSON.stringify(record));

    const result = writeCharacter(owner, characterId, () => migrated);
    if (!result) {
        console.error(`[${TAG}] Migration commit failed for ${N.one} ${characterId}; left at v${record.v}.`);
        return record;
    }
    return result;
}
