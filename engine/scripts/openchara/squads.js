// Squad / army hierarchy (plan Section 1.4). `${NS}:squads` is a small,
// menu-edited JSON blob on the owning player - not a hot path, so it goes
// through the same copy-validate-commit discipline as everything else but
// doesn't need its own A/B slots (it's cheap to fully rebuild if ever
// found corrupt, unlike a character's own record).

import { readJsonProperty, writeJsonProperty, writeCharacter } from "./dataCore.js";
import { getCharacter } from "./characterRecord.js";
import { NS, N } from "./ids.js";

const SQUADS_KEY = `${NS}:squads`;
export const MAX_MEMBERS_PER_SQUAD = 10;
export const MAX_SQUADS_PER_PLAYER = 5;

function isValidSquadList(list) {
    if (!Array.isArray(list)) return false;
    return list.every(s =>
        s && typeof s.id === "string" && typeof s.name === "string" &&
        (s.captainId === null || typeof s.captainId === "string") &&
        Array.isArray(s.memberIds) &&
        (s.commanderId === null || typeof s.commanderId === "string")
    );
}

export function readSquads(owner) {
    return readJsonProperty(owner, SQUADS_KEY, []);
}

function writeSquads(owner, list) {
    if (list.length === 0) {
        owner.setDynamicProperty(SQUADS_KEY, undefined);
        return true;
    }
    return writeJsonProperty(owner, SQUADS_KEY, list, isValidSquadList);
}

export function getSquad(owner, squadId) {
    return readSquads(owner).find(s => s.id === squadId) ?? null;
}

// Resolves a real squad id or its display name (case-insensitive) to the
// real id - same reasoning as characterIndex.js's resolveCharacterIdentifier(),
// since typing "sq1" instead of the name you actually gave a squad is an
// easy mixup (confirmed the hard way once already this session).
export function resolveSquadIdentifier(owner, identifier) {
    if (!identifier) return null;
    const list = readSquads(owner);
    if (list.some(s => s.id === identifier)) return identifier;
    const lower = identifier.toLowerCase();
    return list.find(s => s.name.toLowerCase() === lower)?.id ?? null;
}

function nextSquadId(owner) {
    let counter = owner.getDynamicProperty(`${NS}:squadCounter`);
    counter = (typeof counter === "number" ? counter : 0) + 1;
    owner.setDynamicProperty(`${NS}:squadCounter`, counter);
    return `sq${counter}`;
}

export function createSquad(owner, name) {
    const list = readSquads(owner);
    if (list.length >= MAX_SQUADS_PER_PLAYER) throw new Error(`Squad cap reached (${MAX_SQUADS_PER_PLAYER}).`);
    const squad = { id: nextSquadId(owner), name, captainId: null, memberIds: [], commanderId: null };
    writeSquads(owner, [...list, squad]);
    return squad;
}

export function renameSquad(owner, squadId, name) {
    const list = readSquads(owner);
    const next = list.map(s => (s.id === squadId ? { ...s, name } : s));
    return writeSquads(owner, next);
}

// Deletes the squad and clears squadId on every member who was in it
// (authoritative-first per Section 1.5.2: the squads list is updated
// first, each member's own cached squadId second).
export function deleteSquad(owner, squadId) {
    const list = readSquads(owner);
    const squad = list.find(s => s.id === squadId);
    if (!squad) return false;
    writeSquads(owner, list.filter(s => s.id !== squadId));
    for (const characterId of squad.memberIds) {
        writeCharacter(owner, characterId, old => ({ ...old, squadId: null }));
    }
    return true;
}

// `${NS}:squads` is the single source of truth for membership/captaincy
// (Section 1.1's own note) - a character's own `squadId` field is a cache,
// always written second, per the write-ordering rule (Section 1.5.2).
export function joinSquad(owner, squadId, characterId) {
    if (typeof characterId !== "string" || characterId.length === 0) throw new Error(`Missing ${N.one} id.`);
    if (!getCharacter(owner, characterId)) throw new Error(`No such ${N.one} "${characterId}" for this player.`);
    const list = readSquads(owner);
    const squad = list.find(s => s.id === squadId);
    if (!squad) throw new Error("No such squad.");
    if (squad.memberIds.includes(characterId)) return squad;
    if (squad.memberIds.length >= MAX_MEMBERS_PER_SQUAD) throw new Error(`Squad is full (${MAX_MEMBERS_PER_SQUAD}).`);

    // A character can only be in one squad - leave any prior one first.
    const priorSquad = list.find(s => s.memberIds.includes(characterId));
    let next = list;
    if (priorSquad) {
        next = next.map(s => (s.id === priorSquad.id ? { ...s, memberIds: s.memberIds.filter(id => id !== characterId), captainId: s.captainId === characterId ? null : s.captainId } : s));
    }
    next = next.map(s => (s.id === squadId ? { ...s, memberIds: [...s.memberIds, characterId] } : s));
    writeSquads(owner, next);

    writeCharacter(owner, characterId, old => ({ ...old, squadId }));
    return next.find(s => s.id === squadId);
}

export function leaveSquad(owner, characterId) {
    const list = readSquads(owner);
    const squad = list.find(s => s.memberIds.includes(characterId));
    if (!squad) return false;
    const next = list.map(s => (s.id === squad.id
        ? { ...s, memberIds: s.memberIds.filter(id => id !== characterId), captainId: s.captainId === characterId ? null : s.captainId }
        : s));
    writeSquads(owner, next);
    writeCharacter(owner, characterId, old => ({ ...old, squadId: null }));
    return true;
}

export function setCaptain(owner, squadId, characterId) {
    const list = readSquads(owner);
    const squad = list.find(s => s.id === squadId);
    if (!squad) throw new Error("No such squad.");
    if (!squad.memberIds.includes(characterId)) throw new Error("Not a member of this squad.");
    return writeSquads(owner, list.map(s => (s.id === squadId ? { ...s, captainId: characterId } : s)));
}

// Reserved for the future rank/eidolon-gated commander mechanic (Section
// 1) - no gating enforced yet since `rank` isn't a real progression axis
// this early; just the plumbing.
export function setCommander(owner, squadId, characterId) {
    const list = readSquads(owner);
    const squad = list.find(s => s.id === squadId);
    if (!squad) throw new Error("No such squad.");
    return writeSquads(owner, list.map(s => (s.id === squadId ? { ...s, commanderId: characterId } : s)));
}

// Manifested member entities currently in a squad, for formation/movement
// code to act on. Skips anyone not currently manifested - a formation
// only ever moves who's actually present.
export function getManifestedMembers(owner, squadId) {
    const squad = getSquad(owner, squadId);
    if (!squad) return [];
    const result = [];
    for (const characterId of squad.memberIds) {
        const record = getCharacter(owner, characterId);
        if (record?.manifestedEntityId) result.push({ characterId, record });
    }
    return result;
}
