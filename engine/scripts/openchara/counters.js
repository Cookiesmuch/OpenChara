// Gameplay statistics / counters (plan Section 1.4.3). Deliberately open
// at both levels (category, then subject) - no mob/block/item type is
// ever enumerated. Its own sharded-from-day-one property per character, kept
// out of the main record since it's the one genuinely unbounded structure
// in the whole schema.

import { readJsonProperty, writeJsonProperty } from "./dataCore.js";
import { NS, CHAR, TAG } from "./ids.js";

function counterKey(characterId) { return `${NS}:${CHAR}:${characterId}:counters`; }

function isValidCounters(obj) {
    if (!obj || typeof obj !== "object") return false;
    return Object.values(obj).every(category =>
        category && typeof category === "object" &&
        Object.values(category).every(v => typeof v === "number")
    );
}

export function readCounters(owner, characterId) {
    return readJsonProperty(owner, counterKey(characterId), {});
}

export function readCounter(owner, characterId, category, subject) {
    const all = readCounters(owner, characterId);
    return all[category]?.[subject] ?? 0;
}

// The one canonical write path for this store - mirrors the
// startCooldown()/saveSquad() "one choke point" convention.
export function incrementStat(owner, characterId, category, subject, amount = 1) {
    return incrementStats(owner, characterId, { [category]: { [subject]: amount } })[category][subject];
}

// Batched form: `deltas` = { category: { subject: amount } }, applied in
// one read + one write. Every other write path funnels into this one.
export function incrementStats(owner, characterId, deltas) {
    const all = readCounters(owner, characterId);
    const next = { ...all };
    for (const [category, subjects] of Object.entries(deltas)) {
        next[category] = { ...(next[category] ?? {}) };
        for (const [subject, amount] of Object.entries(subjects)) {
            next[category][subject] = (next[category][subject] ?? 0) + amount;
        }
    }
    writeJsonProperty(owner, counterKey(characterId), next, isValidCounters);
    return next;
}

// Raw replace, for import/purge only (dbTransfer.js / dbMaintenance.js).
export function replaceCounters(owner, characterId, counters) {
    if (!counters || Object.keys(counters).length === 0) {
        owner.setDynamicProperty(counterKey(characterId), undefined);
        return true;
    }
    return writeJsonProperty(owner, counterKey(characterId), counters, isValidCounters);
}

// ---- Buffered stat queue -------------------------------------------------
// Hot gameplay events (entityHurt fires many times a second in a real
// fight) must never each do a full property read+write. They queue here
// in memory and flushQueuedStats() commits each character's accumulated deltas
// in one batched write on a slow interval. A crash loses at most one
// interval's worth of counter increments - acceptable for statistics,
// never used for anything load-bearing.
const queued = new Map(); // `${ownerId}|${characterId}` -> { category: { subject: amount } }

export function queueStat(ownerId, characterId, category, subject, amount = 1) {
    if (!ownerId || !characterId || !amount) return;
    const key = `${ownerId}|${characterId}`;
    let deltas = queued.get(key);
    if (!deltas) { deltas = {}; queued.set(key, deltas); }
    const cat = deltas[category] ?? (deltas[category] = {});
    cat[subject] = (cat[subject] ?? 0) + amount;
}

// `findOwner(ownerId) -> Player|null`. Entries whose owner is offline stay
// queued until they're back (dynamic properties are only writable through
// the live Player object).
export function flushQueuedStats(findOwner) {
    const flushed = [];
    for (const [key, deltas] of queued) {
        const [ownerId, characterId] = key.split("|");
        const owner = findOwner(ownerId);
        if (!owner) continue;
        queued.delete(key);
        try {
            incrementStats(owner, characterId, deltas);
            flushed.push({ owner, characterId, deltas });
        } catch (e) { console.warn(`[${TAG}] Stat flush failed for ${characterId}: ${e}`); }
    }
    return flushed;
}
