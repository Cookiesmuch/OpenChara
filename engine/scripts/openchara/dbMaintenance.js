// Database maintenance (plan Section 1.6): record discovery, the
// `PRAGMA integrity_check`-equivalent scan/repair (1.6.2), trash listing
// and final purge (1.6.1), and bondPartners self-healing (1.5.3).
//
// Discovery never trusts the index alone - it walks the player's actual
// dynamic property ids AND the world-scoped RAID mirror (filtered through
// the owner registry), so a record the index lost track of, or one whose
// primary copy is gone entirely, is still found and recoverable.

import { world } from "@minecraft/server";
import { readJsonProperty, writeJsonProperty, readCharacter, writeCharacter, verifyChecksum, isValidCharacterRecord, ENGINE_SCHEMA_VERSION } from "./dataCore.js";
import { readIndex, addToIndex, removeFromIndex, updateIndexEntry } from "./characterIndex.js";
import { registerCharacterOwner, resolveCharacterOwnerId } from "./characterId.js";
import { isPastGracePeriod, migrateCharacterIfNeeded, needsMigration } from "./characterRecord.js";
import { staleDerivedFields, applyDerived } from "./hooks.js";
import { projectPv, PROJECT_SCHEMA_VERSION } from "./schema.js";
import { RULES } from "./rules.js";
import { readSquads } from "./squads.js";
import { replaceCounters } from "./counters.js";
import { listBlockLinks, clearLinksFor } from "./blockLinks.js";
import { NS, CHAR, N, TAG } from "./ids.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECORD_KEY_RE = new RegExp(`^${NS}:${CHAR}:(${UUID}):(A|B|active)$`);
const SIZE_WARN_BYTES = 24000;
const MIRROR_KEY_RE = new RegExp(`^${NS}:mirror:${CHAR}:(${UUID})$`);

function findEntity(entityId) {
    try { const e = world.getEntity(entityId); return e?.isValid ? e : null; } catch (e) { return null; }
}

// Every character id this player has any trace of: record slots on the player,
// index entries, and world mirrors registered to them.
export function discoverCharacterIds(player) {
    const ids = new Set();
    for (const key of player.getDynamicPropertyIds()) {
        const m = RECORD_KEY_RE.exec(key);
        if (m) ids.add(m[1]);
    }
    for (const e of readIndex(player)) ids.add(e.id);
    for (const key of world.getDynamicPropertyIds()) {
        const m = MIRROR_KEY_RE.exec(key);
        if (m && resolveCharacterOwnerId(m[1]) === player.id) ids.add(m[1]);
    }
    return [...ids];
}

// Released (soft-deleted) characters, newest first.
export function listTrash(player) {
    const out = [];
    for (const id of discoverCharacterIds(player)) {
        const rec = readCharacter(player, id);
        if (rec && rec.deletedAt !== null) out.push({ id, record: rec });
    }
    return out.sort((a, b) => b.record.deletedAt - a.record.deletedAt);
}

// ---- Integrity scan (Section 1.6.2) --------------------------------------
// Returns { checked, issues: [{ id, nickname, problem, fixed }] }. With
// repair=false it's a pure read - nothing is written at all.
export function scanIntegrity(player, { repair = false } = {}) {
    const issues = [];
    const note = (id, nickname, problem, fixed = false) => issues.push({ id, nickname, problem, fixed: repair && fixed });
    const ids = discoverCharacterIds(player);
    const squads = readSquads(player);
    const index = readIndex(player);
    const liveIds = new Set();
    const resolvedIds = new Set(); // ids with a readable record (live or released)

    for (const id of ids) {
        // --- the record itself: primary slots, pointer, mirror ---
        const active = player.getDynamicProperty(`${NS}:${CHAR}:${id}:active`);
        const slotA = readJsonProperty(player, `${NS}:${CHAR}:${id}:A`);
        const slotB = readJsonProperty(player, `${NS}:${CHAR}:${id}:B`);
        const mirror = readJsonProperty(world, `${NS}:mirror:${CHAR}:${id}`);
        const primaryOk = (active === "A" && isValidCharacterRecord(slotA)) || (active === "B" && isValidCharacterRecord(slotB));

        const registeredOwner = resolveCharacterOwnerId(id);
        if (registeredOwner && registeredOwner !== player.id) {
            // The registry is authoritative for ownership: a copy here is a
            // leftover from an interrupted transfer (dbTransfer.js), never
            // grounds to take her back. Only the local leftover is removed.
            note(id, (slotA ?? slotB ?? {}).nickname ?? "?", `leftover copy of a ${N.one} now owned by another player`, true);
            if (repair) {
                for (const key of player.getDynamicPropertyIds()) {
                    if (key.startsWith(`${NS}:${CHAR}:${id}:`) || key.startsWith(`${NS}:migrationBackup:${id}:`)) player.setDynamicProperty(key, undefined);
                }
                removeFromIndex(player, id);
            }
            continue;
        }
        if (!registeredOwner) {
            note(id, (slotA ?? slotB ?? {}).nickname ?? "?", "owner registry entry missing", true);
            if (repair) registerCharacterOwner(id, player.id);
        }


        // readCharacter self-heals from the mirror when the primary is bad -
        // only call it when repairing, so a plain scan stays read-only.
        let rec = primaryOk ? (active === "A" ? slotA : slotB) : (repair ? readCharacter(player, id) : (isValidCharacterRecord(mirror) ? mirror : null));
        const nick = rec?.nickname ?? "?";

        if (!rec) {
            note(id, nick, "record unrecoverable: primary slots and mirror are all missing or corrupt");
            continue;
        }
        resolvedIds.add(id);
        if (!primaryOk) note(id, nick, active ? `active slot ${active} corrupt - recovered from mirror` : "primary copy missing - recovered from mirror", true);

        const inactive = active === "A" ? slotB : slotA;
        if (primaryOk && inactive !== undefined && !verifyChecksum(inactive)) {
            note(id, nick, "previous-generation (rollback) slot is corrupt - rollback would fail", true);
            if (repair) writeJsonProperty(player, `${NS}:${CHAR}:${id}:${active === "A" ? "B" : "A"}`, rec, isValidCharacterRecord);
        }

        if (!isValidCharacterRecord(mirror) || mirror._checksum !== rec._checksum) {
            note(id, nick, mirror ? "RAID mirror out of sync with primary" : "RAID mirror missing", true);
            if (repair) writeJsonProperty(world, `${NS}:mirror:${CHAR}:${id}`, rec, isValidCharacterRecord);
        }

        if (needsMigration(rec)) {
            note(id, nick, `schema v${rec.v}/pv${projectPv(rec)} behind current v${ENGINE_SCHEMA_VERSION}/pv${PROJECT_SCHEMA_VERSION}`, true);
            if (repair) rec = migrateCharacterIfNeeded(player, id) ?? rec;
        }

        // --- the index (Section 1.5.3: rebuildable from records) ---
        const entry = index.find(e => e.id === id);
        if (rec.deletedAt === null) {
            liveIds.add(id);
            if (!entry) {
                note(id, nick, `active ${N.one} missing from roster index`, true);
                if (repair) addToIndex(player, { id, nickname: rec.nickname, species: rec.species });
            } else if (entry.nickname !== rec.nickname || entry.species !== rec.species) {
                note(id, nick, "roster index entry stale (nickname/species)", true);
                if (repair) updateIndexEntry(player, id, { nickname: rec.nickname, species: rec.species });
            }
        } else if (entry) {
            note(id, nick, `released ${N.one} still listed in roster`, true);
            if (repair) removeFromIndex(player, id);
        }

        // --- per-record field fixes, batched into one write ---
        const patch = {};
        if (rec.manifestedEntityId && !findEntity(rec.manifestedEntityId)) {
            note(id, nick, "points at a manifestation that no longer exists", true);
            patch.manifestedEntityId = null;
        }
        const badPartners = rec.bondPartners.filter(pid => world.getDynamicProperty(`${NS}:bond:${[id, pid].sort().join(":")}`) === undefined);
        if (badPartners.length > 0) {
            note(id, nick, `${badPartners.length} bond partner(s) with no bond record`, true);
            patch.bondPartners = rec.bondPartners.filter(pid => !badPartners.includes(pid));
        }
        const owningSquad = squads.find(s => s.memberIds.includes(id));
        const trueSquadId = rec.deletedAt === null ? owningSquad?.id ?? null : null;
        if ((rec.squadId ?? null) !== trueSquadId) {
            note(id, nick, `cached squadId "${rec.squadId}" disagrees with squad list ("${trueSquadId}")`, true);
            patch.squadId = trueSquadId;
        }
        const stale = staleDerivedFields(rec);
        if (stale.length > 0) {
            note(id, nick, `cached ${stale.join(", ")} stale`, true);
            const fresh = applyDerived({ ...rec });
            for (const field of stale) patch[field] = fresh[field];
        }
        if (repair && Object.keys(patch).length > 0) writeCharacter(player, id, old => ({ ...old, ...patch }));

        // --- size headroom (Section 1.9): warn well before the 32KB ceiling,
        // so sharding the offending field happens by plan, not by surprise.
        const recordBytes = JSON.stringify(rec).length;
        if (recordBytes > SIZE_WARN_BYTES) note(id, nick, `record is ${recordBytes} bytes (ceiling ~32000) - a field needs sharding`);
        const counterBytes = String(player.getDynamicProperty(`${NS}:${CHAR}:${id}:counters`) ?? "").length;
        if (counterBytes > SIZE_WARN_BYTES) note(id, nick, `counters are ${counterBytes} bytes - shard by category (Section 1.4.3)`);
    }

    // --- index entries with no record at all ---
    for (const e of readIndex(player)) {
        if (!resolvedIds.has(e.id)) {
            note(e.id, e.nickname, "roster entry with no backing record", true);
            if (repair) removeFromIndex(player, e.id);
        }
    }

    // --- duplicate nicknames (report only: renaming is the player's call) ---
    const seen = new Map();
    for (const e of readIndex(player)) {
        const k = e.nickname.toLowerCase();
        if (seen.has(k)) note(e.id, e.nickname, `duplicate nickname (also ${seen.get(k)})`);
        else seen.set(k, e.id);
    }

    // --- squads referencing missing/released characters ---
    let squadsChanged = false;
    const cleanSquads = squads.map(s => {
        const members = s.memberIds.filter(mid => liveIds.has(mid));
        if (members.length === s.memberIds.length) return s;
        note(s.id, s.name, `squad lists ${s.memberIds.length - members.length} member(s) that don't exist or were released`, true);
        squadsChanged = true;
        return { ...s, memberIds: members, captainId: members.includes(s.captainId) ? s.captainId : null };
    });
    if (repair && squadsChanged) writeJsonProperty(player, `${NS}:squads`, cleanSquads);

    // --- block links (Section 1.5.7) pointing at this player's characters
    // whose records are gone for good ---
    for (const link of listBlockLinks()) {
        if (resolveCharacterOwnerId(link.characterId) !== null) continue; // someone (maybe not us) still owns her
        note(link.characterId, "?", `block link at ${link.x},${link.y},${link.z} points at a deleted ${N.one}`, true);
        if (repair) world.setDynamicProperty(link.key, undefined);
    }

    return { checked: ids.length, issues };
}

// ---- Final purge (Section 1.6.1) -----------------------------------------
// Only a released character past the grace period, and only when explicitly
// invoked (the Codex puts a confirmation dialog in front of this).
export function purgeCharacter(player, characterId) {
    const rec = readCharacter(player, characterId);
    if (!rec) return { ok: false, reason: `no such ${N.one}` };
    if (rec.deletedAt === null) return { ok: false, reason: "she hasn't been released" };
    if (!isPastGracePeriod(rec)) return { ok: false, reason: `still inside the ${RULES.trashGraceDays}-day recovery window` };

    for (const key of player.getDynamicPropertyIds()) {
        if (key.startsWith(`${NS}:${CHAR}:${characterId}:`) || key.startsWith(`${NS}:migrationBackup:${characterId}:`)) {
            player.setDynamicProperty(key, undefined);
        }
    }
    replaceCounters(player, characterId, undefined);
    world.setDynamicProperty(`${NS}:mirror:${CHAR}:${characterId}`, undefined);
    world.setDynamicProperty(`${NS}:${CHAR}Owner:${characterId}`, undefined);
    for (const key of world.getDynamicPropertyIds()) {
        if (key.startsWith(`${NS}:bond:`) && key.includes(characterId)) world.setDynamicProperty(key, undefined);
    }
    clearLinksFor(characterId);
    removeFromIndex(player, characterId);
    return { ok: true };
}

// Periodic self-healing on join (Section 1.5.3's "once automatically on
// world start" rule, applied per player since player data only exists
// while they're online). Silent unless it actually fixed something.
export function runJoinMaintenance(player) {
    const { issues } = scanIntegrity(player, { repair: true });
    const fixed = issues.filter(i => i.fixed);
    if (fixed.length > 0) {
        console.warn(`[${TAG}] Join maintenance for ${player.name}: repaired ${fixed.length} issue(s): ${fixed.map(i => i.problem).join("; ")}`);
    }
    return issues;
}
