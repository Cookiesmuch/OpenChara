// Content-registered rules. The engine owns the mechanisms (records, quests,
// bonds, tracks, migrations); a project's scripts decide the game design
// that plugs into them. Every hook has a safe engine default, so the engine
// works with no project hooks at all - it just doesn't compute anything
// project-specific.
//
// Registered from content scripts via api.js at module load (content
// scripts are imported before the engine starts).

import { TAG } from "./ids.js";

// ---- derived fields: cached values recomputed from a record's own data
// (e.g. a "stats" block from level + class + gear). Applied on every engine
// write that could change an input, and checked by the integrity scan. ----
const derivedFields = new Map(); // field -> fn(record) => value

export function registerDerivedField(field, compute) { derivedFields.set(field, compute); }

export function applyDerived(record) {
    for (const [field, compute] of derivedFields) {
        try { record[field] = compute(record); }
        catch (e) { console.warn(`[${TAG}] Derived field "${field}" failed: ${e}`); }
    }
    return record;
}

// Fields whose cached value no longer matches what they'd compute to now.
export function staleDerivedFields(record) {
    const stale = [];
    for (const [field, compute] of derivedFields) {
        try { if (JSON.stringify(compute(record)) !== JSON.stringify(record[field])) stale.push(field); }
        catch (e) { /* a throwing computer is broken, not stale - it's logged on write */ }
    }
    return stale;
}

// ---- record initializers: adjust a brand-new record before its first
// write (e.g. give her her class's starting abilities). ----
const initializers = [];
export function registerRecordInitializer(fn) { initializers.push(fn); }
export function runInitializers(record) {
    let rec = record;
    for (const fn of initializers) {
        try { rec = fn(rec) ?? rec; } catch (e) { console.warn(`[${TAG}] Record initializer failed: ${e}`); }
    }
    return rec;
}

// ---- leveled tracks: any { level, xp } pair on a record or a bond. The
// project decides the curve: xp needed to go from `level` to level + 1. ----
let trackCurve = level => 100 * (level + 1);
export function registerTrackCurve(fn) { trackCurve = fn; }

export function levelTrack(track, delta) {
    let { level, xp } = track ?? { level: 0, xp: 0 };
    xp += delta;
    for (let guard = 0; guard < 1000 && xp >= trackCurve(level); guard++) { xp -= trackCurve(level); level += 1; }
    return { level, xp };
}

// ---- quest rewards: each key of a quest's "rewards" object is applied by
// the handler registered for it: fn(record, value, questDef) => newRecord. ----
const questRewards = new Map();
export function registerQuestReward(key, apply) { questRewards.set(key, apply); }

export function applyQuestRewards(record, rewards, questDef) {
    let rec = record;
    for (const [key, value] of Object.entries(rewards ?? {})) {
        const apply = questRewards.get(key);
        if (!apply) { console.warn(`[${TAG}] Quest "${questDef?.id}": no handler registered for reward "${key}" - skipped.`); continue; }
        rec = apply(rec, value, questDef) ?? rec;
    }
    return rec;
}

// ---- project schema migrations: fromPv -> fn(record) => record at fromPv + 1 ----
const projectMigrations = new Map();
export function registerProjectMigration(fromPv, fn) { projectMigrations.set(fromPv, fn); }
export function getProjectMigration(fromPv) { return projectMigrations.get(fromPv) ?? null; }
