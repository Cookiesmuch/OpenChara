// Data-integrity core: the copy-validate-commit write pattern (plan
// Section 1.5.1) and A/B deployment slots (Section 1.5.1a). Every read/write
// of a character record goes through readCharacter()/writeCharacter() here - nothing
// else in the codebase should touch the raw ":A"/":B"/":active" keys.

import { world } from "@minecraft/server";
import { NS, CHAR, N, TAG } from "./ids.js";
import { recordProblem } from "./schema.js";

// The engine's own record schema version (core fields). v2 added `order`.
// A project's fields have their own version (`pv`, schema.js).
export { ENGINE_SCHEMA_VERSION } from "./schema.js";

// ---- Generic checksum (Section 1.5.6) --------------------------------
// Cheap, non-cryptographic. Computed over the JSON of the record with
// `_checksum` itself excluded (it can't include its own value).
export function computeChecksum(obj) {
    const { _checksum, ...rest } = obj;
    const str = JSON.stringify(rest, Object.keys(rest).sort());
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
}

export function withChecksum(obj) {
    const clone = { ...obj };
    clone._checksum = computeChecksum(clone);
    return clone;
}

export function verifyChecksum(obj) {
    if (!obj || typeof obj !== "object" || typeof obj._checksum !== "string") return false;
    return obj._checksum === computeChecksum(obj);
}

// ---- Generic copy-validate-commit dynamic-property helpers ------------
// Not character-specific - any `${NS}:`-prefixed structure in the schema (index,
// bonds, counters) can use these two directly for its own read/write.

export function readJsonProperty(owner, key, fallback = undefined) {
    const raw = owner.getDynamicProperty(key);
    if (raw === undefined) return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.warn(`[${TAG}] Corrupt JSON at property "${key}" on ${owner?.typeId ?? "world"}: ${e}`);
        return fallback;
    }
}

// validate: (value) => true/false. Throws away the write (leaves the key
// completely untouched) if validation fails - never a partial write.
export function writeJsonProperty(owner, key, value, validate) {
    if (validate && !validate(value)) {
        console.warn(`[${TAG}] Rejected write to "${key}": failed validation.`);
        return false;
    }
    const raw = value === undefined ? undefined : JSON.stringify(value);
    // Bedrock's own per-string-property ceiling; fail loudly rather than
    // silently truncating data.
    if (raw !== undefined && raw.length > 32000) {
        console.warn(`[${TAG}] Rejected write to "${key}": ${raw.length} bytes exceeds safe ceiling.`);
        return false;
    }
    owner.setDynamicProperty(key, raw);
    return true;
}

// ---- Character record shape validation ------------------------------------
// Structural check only, driven by the record schema (schema.js: engine core
// fields + the project's declared fields), plus the checksum. Good enough
// to catch a botched write or hand-edit before it's ever committed.
export function isValidCharacterRecord(rec) {
    return recordProblem(rec) === null && verifyChecksum(rec);
}

// ---- A/B slot machinery for the character record (Section 1.5.1a) --------

function slotKey(characterId, slot) { return `${NS}:${CHAR}:${characterId}:${slot}`; }
function activeKey(characterId) { return `${NS}:${CHAR}:${characterId}:active`; }
// characterId is now a real UUID (characterId.js) - already globally unique, so
// the mirror key needs no separate owner-prefixed "global id" alongside it.
function mirrorKey(characterId) { return `${NS}:mirror:${CHAR}:${characterId}`; }

// Reads the current active record for one character off her owning player.
// Self-healing: if the primary fails checksum verification, transparently
// recovers from the world-scoped RAID mirror (Section 1.5.5) and repairs
// the primary in place before returning.
export function readCharacter(owner, characterId) {
    const active = owner.getDynamicProperty(activeKey(characterId));
    const slot = active === "A" || active === "B" ? active : null;
    // No active pointer at all means this character id has simply never been
    // written yet (e.g. the very first read inside createCharacter's own
    // writeCharacter call) - not corruption, so stay silent and just miss.
    const everExisted = slot !== null;

    if (slot) {
        const rec = readJsonProperty(owner, slotKey(characterId, slot));
        if (isValidCharacterRecord(rec)) return rec;
        console.warn(`[${TAG}] ${N.One} ${characterId} primary slot ${slot} failed validation - attempting mirror recovery.`);
    }

    // Primary missing/corrupt: try the mirror.
    const mirrored = readJsonProperty(world, mirrorKey(characterId));
    if (isValidCharacterRecord(mirrored)) {
        if (everExisted) console.warn(`[${TAG}] ${N.One} ${characterId} recovered from mirror; repairing primary.`);
        const recoverSlot = slot === "A" ? "B" : "A"; // write into whichever slot isn't presumed-bad
        writeJsonProperty(owner, slotKey(characterId, recoverSlot), mirrored, isValidCharacterRecord);
        owner.setDynamicProperty(activeKey(characterId), recoverSlot); // plain scalar, never JSON-wrapped
        return mirrored;
    }

    if (everExisted) {
        console.error(`[${TAG}] ${N.One} ${characterId} unrecoverable: primary and mirror both missing/corrupt.`);
    }
    return null;
}

// Full copy-validate-commit + A/B swap + mirror write, in one call.
// `mutate(oldRecord) -> newRecord` must return a brand-new object (or
// throw to abort); oldRecord is never mutated in place. Returns the
// committed record, or null if the write was aborted.
export function writeCharacter(owner, characterId, mutate) {
    const oldRecord = readCharacter(owner, characterId);
    let newRecord;
    try {
        newRecord = mutate(oldRecord);
    } catch (e) {
        console.warn(`[${TAG}] writeCharacter(${characterId}) mutate() threw, aborting write: ${e}`);
        return null;
    }
    if (!newRecord) return null;

    newRecord = withChecksum(newRecord);
    if (!isValidCharacterRecord(newRecord)) {
        console.warn(`[${TAG}] writeCharacter(${characterId}) produced an invalid record, aborting write.`);
        return null;
    }

    const activeSlot = owner.getDynamicProperty(activeKey(characterId));
    // First-ever write (no pointer yet) targets "A"; otherwise always the
    // currently-inactive slot, never the live one.
    const targetSlot = activeSlot === "A" ? "B" : "A";

    // (1) Write fully-finished record into the currently-inactive slot only.
    if (!writeJsonProperty(owner, slotKey(characterId, targetSlot), newRecord, isValidCharacterRecord)) {
        return null;
    }
    // (2) Read it back and confirm - a real commit check, not an assumption.
    const readBack = readJsonProperty(owner, slotKey(characterId, targetSlot));
    if (!isValidCharacterRecord(readBack) || readBack._checksum !== newRecord._checksum) {
        console.error(`[${TAG}] writeCharacter(${characterId}) commit verification failed - live record left untouched.`);
        return null;
    }
    // (3) Flip the pointer - the only moment a reader's view changes. A
    // plain scalar write, never routed through writeJsonProperty (which
    // would JSON.stringify a bare "A"/"B" into a quoted 3-char string that
    // would never again compare equal to a raw "A"/"B" read anywhere else).
    owner.setDynamicProperty(activeKey(characterId), targetSlot);

    // (4) Mirror, authoritative-first (Section 1.5.2/1.5.5).
    writeJsonProperty(world, mirrorKey(characterId), newRecord, isValidCharacterRecord);

    return newRecord;
}
