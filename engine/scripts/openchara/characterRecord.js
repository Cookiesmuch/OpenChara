// The character record - creation and every generic mutation path. Every
// write goes through dataCore's writeCharacter() (copy-validate-commit, A/B
// slots, mirror); nothing here writes a dynamic property directly.
//
// What a record CONTAINS beyond the engine's core fields is the project's
// business: declared in PATCHES/database/schema.json (schema.js), shaped by
// project hooks (hooks.js: derived fields like cached stats, initializers,
// track curves, quest rewards) and changed by project scripts through
// updateCharacter() / grantTracksXp(). The engine never names a
// project-specific field.

import { readCharacter, writeCharacter } from "./dataCore.js";
import { addToIndex, updateIndexEntry, removeFromIndex, reconcileIndex, isNicknameTaken, readIndex } from "./characterIndex.js";
import { generateCharacterId, registerCharacterOwner } from "./characterId.js";
import { resolveDefaultClass } from "./classData.js";
import { readBond, writeBond } from "./bonds.js";
import { QUESTS, checkQuestProgress, questAvailableTo } from "./quests.js";
import { isAccumulating, eventAmount, conditionKey } from "./conditions.js";
import { blankRecord, ENGINE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION, projectPv } from "./schema.js";
import { applyDerived, runInitializers, levelTrack, applyQuestRewards, getProjectMigration } from "./hooks.js";
import { RULES } from "./rules.js";
import { NS, N, TAG } from "./ids.js";

export const MAX_ROSTER = RULES.maxRoster;
export const TRASH_GRACE_PERIOD_MS = RULES.trashGraceDays * 24 * 60 * 60 * 1000;

// ---- Creation (summon or migration entry point) ------------------------
// Does NOT prompt for a nickname - callers resolve it first, since
// uniqueness-checking needs the player anyway.
export function createCharacter(owner, { nickname, species, migratedFrom = null }) {
    if (readIndex(owner).length >= MAX_ROSTER) {
        throw new Error(`Roster is full (${MAX_ROSTER}). Release someone first.`);
    }
    if (isNicknameTaken(owner, nickname)) {
        throw new Error(`Nickname "${nickname}" is already taken for this player.`);
    }
    const id = generateCharacterId();
    let record = blankRecord({
        nickname,
        species,
        soulId: id,
        class: resolveDefaultClass(species),
        createdAt: Date.now(),
        migratedFrom,
    });
    record = applyDerived(runInitializers(record));

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

// ---- The generic write path for project scripts --------------------------
// `mutate(oldRecord) -> newRecord` (build a new object; throw to abort).
// Derived fields are recomputed after every update, so a project never has
// to remember to refresh its own caches.
export function updateCharacter(owner, characterId, mutate) {
    return writeCharacter(owner, characterId, old => {
        const next = mutate(old);
        return next ? applyDerived({ ...next }) : next;
    });
}

// Adds xp to one or more leveled tracks ({ level, xp } objects) anywhere in
// the record, addressed by dotted path: { "relationships.love": 5 }. The
// project's registered track curve decides the level-ups.
export function grantTracksXp(owner, characterId, deltas) {
    return updateCharacter(owner, characterId, old => {
        const next = JSON.parse(JSON.stringify(old));
        for (const [path, delta] of Object.entries(deltas)) {
            const keys = path.split(".");
            let obj = next;
            for (const k of keys.slice(0, -1)) obj = obj[k] ??= {};
            const leaf = keys[keys.length - 1];
            obj[leaf] = levelTrack(obj[leaf], delta);
        }
        return next;
    });
}

export function renameCharacter(owner, characterId, newNickname) {
    if (isNicknameTaken(owner, newNickname, characterId)) return false;
    const result = writeCharacter(owner, characterId, old => ({ ...old, nickname: newNickname }));
    if (!result) return false;
    updateIndexEntry(owner, characterId, { nickname: newNickname });
    return true;
}

// ---- Core-field mutations -------------------------------------------------

export function setGear(owner, characterId, gear) {
    return updateCharacter(owner, characterId, old => ({ ...old, gear }));
}

export function setInventory(owner, characterId, inventory) {
    return updateCharacter(owner, characterId, old => ({ ...old, inventory }));
}

// Gear + inventory together in one write (the periodic live-entity
// snapshot, statTracking.js). Skips the write entirely when nothing
// changed, so an idle character costs zero writes.
export function snapshotGearAndInventory(owner, characterId, gear, inventory) {
    const current = readCharacter(owner, characterId);
    if (!current) return null;
    if (JSON.stringify(current.gear) === JSON.stringify(gear) &&
        JSON.stringify(current.inventory) === JSON.stringify(inventory)) return current;
    return updateCharacter(owner, characterId, old => ({ ...old, gear, inventory }));
}

// Everything a despawn changes, committed as ONE atomic record write - an
// interruption can never leave gear saved but manifestedEntityId still
// pointing at a dead entity.
export function applyDespawnSnapshot(owner, characterId, { gear, inventory, location }) {
    return updateCharacter(owner, characterId, old => {
        const next = { ...old, manifestedEntityId: null };
        if (gear) next.gear = gear;
        if (inventory) next.inventory = inventory;
        if (location) next.lastManifestLocation = location;
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

// ---- Character-to-character bonds -----------------------------------------
// World-scoped pair records with the project's declared tracks (schema.js
// BOND_TRACKS). Character ids are globally unique, so they're used directly
// as the pair key and as entries in each other's bondPartners.
export function grantBondXp(ownerA, characterIdA, ownerB, characterIdB, track, delta) {
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

// Pre-split name, kept so older content keeps working.
export const linkBond = grantBondXp;

export function getBondBetween(characterIdA, characterIdB) {
    return readBond(characterIdA, characterIdB);
}

// ---- Soft-delete ------------------------------------------------------------
export function releaseCharacter(owner, characterId) {
    const result = writeCharacter(owner, characterId, old => ({ ...old, deletedAt: Date.now() }));
    if (result) removeFromIndex(owner, characterId);
    return result;
}

export function restoreCharacter(owner, characterId) {
    const record = readCharacter(owner, characterId);
    if (!record || record.deletedAt === null || record.deletedAt === undefined) return null;
    if (readIndex(owner).length >= MAX_ROSTER) return null;
    const result = writeCharacter(owner, characterId, old => ({ ...old, deletedAt: null }));
    if (result) addToIndex(owner, { id: characterId, nickname: result.nickname, species: result.species });
    return result;
}

export function isPastGracePeriod(record, now = Date.now()) {
    return record.deletedAt !== null && record.deletedAt !== undefined && now - record.deletedAt > TRASH_GRACE_PERIOD_MS;
}

// ---- Quests -------------------------------------------------------------------
// Definitions come from PATCHES/quests; rewards are applied by whatever
// handlers the project registered for each reward key (hooks.js).
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

    return updateCharacter(owner, characterId, old => {
        const next = { ...old, quests: { ...old.quests, [questId]: { ...old.quests[questId], status: "completed" } } };
        return applyQuestRewards(next, def.rewards, def);
    });
}

// Advances every active quest's event/tick conditions by one flush of
// counter deltas. One write, and only when something actually moved - most
// flushes touch no quest at all.
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

// ---- Standing orders (engine core field) --------------------------------------
export const ORDERS = ["follow", "stay", "wander", "home"];

export function getOrder(record) {
    return ORDERS.includes(record?.order) ? record.order : "follow";
}

export function setOrder(owner, characterId, order) {
    if (!ORDERS.includes(order)) throw new Error(`Unknown order "${order}".`);
    return writeCharacter(owner, characterId, old => ({ ...old, order }));
}

// ---- Schema migrations ----------------------------------------------------------
// Two independent version tracks: the engine's (`v`, core fields - these
// migrations live here) and the project's (`pv`, its own fields - its
// migrations are registered by project scripts). Never in place:
// transform -> validate -> back up the old record -> commit.
const ENGINE_MIGRATIONS = {
    // v1 -> v2: standing orders. Every pre-existing character was
    // effectively following (dimensionFollow treated them all that way).
    1: (old) => ({ ...old, order: "follow" }),
};

export function needsMigration(record) {
    return Boolean(record) && (record.v < ENGINE_SCHEMA_VERSION || projectPv(record) < PROJECT_SCHEMA_VERSION);
}

export function migrateCharacterIfNeeded(owner, characterId) {
    const record = readCharacter(owner, characterId);
    if (!needsMigration(record)) return record;

    let migrated = record;
    try {
        while (migrated.v < ENGINE_SCHEMA_VERSION) {
            const t = ENGINE_MIGRATIONS[migrated.v];
            if (!t) throw new Error(`no engine migration from v${migrated.v}`);
            migrated = { ...t(migrated), v: migrated.v + 1 };
        }
        while (projectPv(migrated) < PROJECT_SCHEMA_VERSION) {
            const from = projectPv(migrated);
            const t = getProjectMigration(from);
            if (!t) throw new Error(`no project migration registered from pv${from}`);
            migrated = { ...t(migrated), pv: from + 1 };
        }
    } catch (e) {
        console.warn(`[${TAG}] Migration of ${N.one} ${characterId} stopped (${e?.message ?? e}); left untouched.`);
        return record;
    }

    // Bounded rolling backup - "one migration back" is enough.
    owner.setDynamicProperty(`${NS}:migrationBackup:${characterId}:${record.v}`, JSON.stringify(record));

    const result = updateCharacter(owner, characterId, () => migrated);
    if (!result) {
        console.error(`[${TAG}] Migration commit failed for ${N.one} ${characterId}; left at v${record.v}/pv${projectPv(record)}.`);
        return record;
    }
    return result;
}
