// Export / import (plan Section 1.6.3) - a player-controlled backup that
// survives even total loss of the world save. One character's full record plus
// her counters serialize to a single self-checksummed text string; import
// verifies that checksum and the record's own shape before writing
// anything, so a truncated or hand-edited string is rejected outright
// rather than half-applied.
//
// Import semantics are "restore", not "clone": the character keeps her
// original UUID, so importing is refused if that id already exists
// anywhere in this world. That keeps "only one of her ever exists"
// (Section 3.2) true even across backups - moving her to another world is
// fine, duplicating her inside one world is not.

import { writeCharacter, isValidCharacterRecord, withChecksum, computeChecksum } from "./dataCore.js";
import { addToIndex, isNicknameTaken, readIndex, removeFromIndex } from "./characterIndex.js";
import { registerCharacterOwner, resolveCharacterOwnerId } from "./characterId.js";
import { getCharacter, computeStats, MAX_ROSTER } from "./characterRecord.js";
import { leaveSquad } from "./squads.js";
import { readCounters, replaceCounters } from "./counters.js";
import { NS, CHAR, N } from "./ids.js";

const PREFIX = "CWX1";

function stripTrailingNulls(list) {
    let end = list.length;
    while (end > 0 && list[end - 1] === null) end--;
    return list.slice(0, end);
}

export function exportCharacter(player, characterId) {
    const record = getCharacter(player, characterId);
    if (!record) throw new Error(`No such ${N.one}.`);
    // Instance-only/world-specific fields are dropped - they'd be wrong in
    // any other world anyway, and import resets them.
    const { _checksum, stats, manifestedEntityId, squadId, ...portable } = record;
    portable.inventory = stripTrailingNulls(record.inventory);
    const payload = JSON.stringify({ id: characterId, record: portable, counters: readCounters(player, characterId) });
    const sum = computeChecksum({ payload });
    return `${PREFIX}|${sum}|${payload}`;
}

// Parses + verifies without writing anything. Returns { id, record,
// counters } or throws with a human-readable reason.
export function parseExport(text) {
    const trimmed = (text ?? "").trim();
    const first = trimmed.indexOf("|");
    const second = trimmed.indexOf("|", first + 1);
    if (first < 0 || second < 0 || trimmed.slice(0, first) !== PREFIX) throw new Error("That isn't a CW backup string.");
    const sum = trimmed.slice(first + 1, second);
    const payload = trimmed.slice(second + 1);
    if (computeChecksum({ payload }) !== sum) throw new Error("Backup checksum mismatch - the text was cut off or edited.");
    let data;
    try { data = JSON.parse(payload); } catch (e) { throw new Error("Backup text is damaged (bad JSON)."); }
    if (typeof data?.id !== "string" || !data.record) throw new Error("Backup is missing her id or record.");
    return data;
}

// Returns { ok, reason?, needsNickname? , characterId? }. If her nickname
// collides with one already in this roster, pass `nicknameOverride`.
export function importCharacter(player, text, nicknameOverride = null) {
    const { id, record, counters } = parseExport(text);

    if (readIndex(player).length >= MAX_ROSTER) return { ok: false, reason: `Your roster is full (${MAX_ROSTER}).` };
    const existingOwner = resolveCharacterOwnerId(id);
    if (existingOwner === player.id && getCharacter(player, id)) return { ok: false, reason: `${record.nickname} is already in your roster (or trash).` };
    if (existingOwner && existingOwner !== player.id) return { ok: false, reason: `${record.nickname} already belongs to another player in this world.` };

    const nickname = nicknameOverride ?? record.nickname;
    if (isNicknameTaken(player, nickname)) return { ok: false, needsNickname: true, reason: `You already have a ${N.one} named "${nickname}".` };

    const inventory = [...(record.inventory ?? [])];
    while (inventory.length < 36) inventory.push(null);
    const restored = {
        ...record,
        nickname,
        inventory,
        manifestedEntityId: null,
        squadId: null,
        deletedAt: null,
        _checksum: "",
    };
    restored.stats = computeStats(restored);
    if (!isValidCharacterRecord(withChecksum(restored))) return { ok: false, reason: "Backup record failed validation - not imported." };

    // Authoritative record first, derived structures after (Section 1.5.2).
    const committed = writeCharacter(player, id, () => restored);
    if (!committed) return { ok: false, reason: "Write failed - nothing was changed." };
    registerCharacterOwner(id, player.id);
    addToIndex(player, { id, nickname, species: committed.species });
    if (counters && Object.keys(counters).length > 0) replaceCounters(player, id, counters);
    return { ok: true, characterId: id, nickname };
}

// ---- Ownership transfer (both players online) -----------------------------
// Moves her record, counters and roster entry from one player to another,
// keeping her UUID (so bonds, mirror and soul tokens stay valid). Order is
// authoritative-first (Section 1.5.2): the recipient's copy is written and
// verified, then the owner registry flips, and only then is the giver's
// copy removed - an interruption leaves at worst a duplicate the integrity
// scan resolves via the registry, never a lost character.
export function transferCharacter(fromPlayer, toPlayer, characterId) {
    const record = getCharacter(fromPlayer, characterId);
    if (!record || record.deletedAt !== null) return { ok: false, reason: "She isn't in your active roster." };
    if (record.manifestedEntityId) return { ok: false, reason: "Recall her to the Codex first." };
    if (fromPlayer.id === toPlayer.id) return { ok: false, reason: "That's you." };
    if (isNicknameTaken(toPlayer, record.nickname)) return { ok: false, reason: `${toPlayer.name} already has a ${N.one} named "${record.nickname}".` };
    if (readIndex(toPlayer).length >= MAX_ROSTER) return { ok: false, reason: `${toPlayer.name}'s roster is full.` };

    const counters = readCounters(fromPlayer, characterId);
    const moved = { ...record, squadId: null, manifestedEntityId: null, homeLocation: null };
    const committed = writeCharacter(toPlayer, characterId, () => moved);
    if (!committed) return { ok: false, reason: "Write to the new owner failed - nothing changed." };
    replaceCounters(toPlayer, characterId, counters);
    registerCharacterOwner(characterId, toPlayer.id);
    addToIndex(toPlayer, { id: characterId, nickname: committed.nickname, species: committed.species });

    if (record.squadId) leaveSquad(fromPlayer, characterId);
    for (const key of fromPlayer.getDynamicPropertyIds()) {
        if (key.startsWith(`${NS}:${CHAR}:${characterId}:`) || key.startsWith(`${NS}:migrationBackup:${characterId}:`)) fromPlayer.setDynamicProperty(key, undefined);
    }
    removeFromIndex(fromPlayer, characterId);
    return { ok: true, nickname: committed.nickname };
}
