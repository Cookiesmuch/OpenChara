// Per-player character index (plan Section 1.2). Small, separate property so
// listing/searching a roster never requires loading every character's full
// blob. Also the enforcement point for nickname uniqueness (Section 1.1a).

import { readJsonProperty, writeJsonProperty } from "./dataCore.js";
import { NS, CHAR, TAG } from "./ids.js";

const INDEX_KEY = `${NS}:${CHAR}Index`;

function isValidIndex(list) {
    if (!Array.isArray(list)) return false;
    return list.every(e => e && typeof e.id === "string" && typeof e.nickname === "string" && typeof e.species === "string");
}

// Active entries only (deletedAt records are dropped from this list per
// Section 1.6.1 - trash still exists as a real record, just not indexed).
export function readIndex(player) {
    return readJsonProperty(player, INDEX_KEY, []);
}

function writeIndex(player, list) {
    if (list.length === 0) {
        player.setDynamicProperty(INDEX_KEY, undefined); // never store an empty array
        return true;
    }
    return writeJsonProperty(player, INDEX_KEY, list, isValidIndex);
}

export function isNicknameTaken(player, nickname, excludingId = null) {
    const list = readIndex(player);
    const lower = nickname.toLowerCase();
    return list.some(e => e.id !== excludingId && e.nickname.toLowerCase() === lower);
}

// Resolves a real character id, a nickname (case-insensitive), or - if
// `identifier` is empty - the player's first indexed character. UUIDs are
// unwieldy to type/copy in chat, so every test command should accept a
// nickname here instead of forcing the full id every time.
export function resolveCharacterIdentifier(player, identifier) {
    const list = readIndex(player);
    if (!identifier) return list[0]?.id ?? null;
    const exactId = list.find(e => e.id === identifier);
    if (exactId) return exactId.id;
    const lower = identifier.toLowerCase();
    const byNickname = list.find(e => e.nickname.toLowerCase() === lower);
    return byNickname?.id ?? null;
}

export function addToIndex(player, entry) {
    const list = readIndex(player);
    if (list.some(e => e.id === entry.id)) return; // already present, no-op
    writeIndex(player, [...list, entry]);
}

export function updateIndexEntry(player, id, patch) {
    const list = readIndex(player);
    const next = list.map(e => (e.id === id ? { ...e, ...patch } : e));
    writeIndex(player, next);
}

export function removeFromIndex(player, id) {
    const list = readIndex(player);
    writeIndex(player, list.filter(e => e.id !== id));
}

// Self-healing rebuild (Section 1.5.3): drop any index entry whose backing
// record no longer resolves. `recordExists(id) -> boolean` is supplied by
// the caller so this module doesn't need to import the character-record module
// (avoids a circular import - characterRecord.js already imports this one).
export function reconcileIndex(player, recordExists) {
    const list = readIndex(player);
    const clean = list.filter(e => {
        const ok = recordExists(e.id);
        if (!ok) console.warn(`[${TAG}] Dropping stale index entry ${e.id} for player ${player.name} - no backing record.`);
        return ok;
    });
    if (clean.length !== list.length) writeIndex(player, clean);
    return clean;
}
