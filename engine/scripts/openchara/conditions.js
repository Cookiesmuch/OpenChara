// The shared condition registry (plan Section 12a). One evaluator, reused
// by ultimate chargeConditions (Section 12) and quest conditions (Section
// 1.8) alike - a single, growable vocabulary for "has X happened" instead
// of every feature reinventing its own trigger format.
//
// Three kinds:
//   poll  - reads data the record/counters already store; zero extra tracking.
//   event - accumulates from live gameplay deltas (statTracking.js's
//           batched flush hands each character's deltas to eventAmount()); the
//           running total lives in the consumer's own progress store (a
//           quest's `progress` dict; later an ultimate's meter).
//   tick  - same accumulation path, fed by a per-second counter rather
//           than a discrete event.
// Unknown types always fail closed (false / 0), never throw.

import { readCounter } from "./counters.js";
import { TAG } from "./ids.js";

// Engine types are generic; projects register their own (e.g. "onKill"
// reading their own "kills" counter) with registerConditionType(). A def:
//   { kind: "poll", check(ctx, cond) => bool }
//   { kind: "event"|"tick", amount(deltas, cond) => number }   deltas = { category: { subject: n } }
//   optional describe(ctx, cond, current) => string   (UI progress text)
export const CONDITION_TYPES = {
    counterThreshold: {
        kind: "poll",
        check: (ctx, cond) => readCounter(ctx.owner, ctx.characterId, cond.category, cond.subject) >= cond.target,
    },
    // Any numeric value in the record, by dotted path: { path: "level", target: 10 }.
    recordValue: {
        kind: "poll",
        check: (ctx, cond) => readPath(ctx.character, cond.path) >= cond.target,
        describe: (ctx, cond) => `${cond.path}: ${Math.min(readPath(ctx.character, cond.path), cond.target)}/${cond.target}`,
    },
    // Escape hatch: a condition authored in JS can hold a real function.
    custom: {
        kind: "poll",
        check: (ctx, cond) => Boolean(cond.fn?.(ctx)),
    },
};

export function registerConditionType(type, def) {
    if (!def || !["poll", "event", "tick"].includes(def.kind)) throw new Error(`Condition type "${type}" needs kind poll|event|tick.`);
    CONDITION_TYPES[type] = def;
}

function readPath(obj, path) {
    let v = obj;
    for (const k of String(path).split(".")) v = v?.[k];
    return typeof v === "number" ? v : 0;
}

// Stable storage key for an event/tick condition's accumulated progress:
// its explicit `id` if authored, else its position in the list.
export function conditionKey(cond, index) { return cond?.id ?? `c${index}`; }

export function isAccumulating(cond) {
    const kind = CONDITION_TYPES[cond?.type]?.kind;
    return kind === "event" || kind === "tick";
}

export function eventAmount(cond, deltas) {
    const def = CONDITION_TYPES[cond?.type];
    if (!def?.amount) return 0;
    try { return Number(def.amount(deltas, cond)) || 0; } catch (e) { return 0; }
}

// `ctx = { character, owner, characterId, progress? }`; `index` locates an
// accumulating condition's running total in ctx.progress.
export function evaluateCondition(ctx, cond, index = 0) {
    const def = CONDITION_TYPES[cond?.type];
    if (!def) return false;
    try {
        if (def.kind === "poll") return Boolean(def.check(ctx, cond));
        return (ctx.progress?.[conditionKey(cond, index)] ?? 0) >= (cond.target ?? Infinity);
    } catch (e) {
        console.warn(`[${TAG}] Condition "${cond.type}" threw during evaluation: ${e}`);
        return false;
    }
}

export function evaluateAllConditions(ctx, conditions) {
    return Array.isArray(conditions) && conditions.every((c, i) => evaluateCondition(ctx, c, i));
}

// Human-readable progress for a UI ("zombie 4/10", "damage 120/500"). A
// registered type's own describe() wins; otherwise a generic "current/target".
export function describeProgress(ctx, cond, index, readCounterFn) {
    const def = CONDITION_TYPES[cond?.type];
    if (!def) return null;
    const current = def.kind === "poll" ? null : Math.floor(ctx.progress?.[conditionKey(cond, index)] ?? 0);
    try { if (def.describe) return def.describe(ctx, cond, current); } catch (e) { return null; }
    if (cond.type === "counterThreshold") {
        return `${String(cond.subject).replace("minecraft:", "")}: ${Math.min(readCounterFn(cond.category, cond.subject), cond.target)}/${cond.target}`;
    }
    if (current !== null) return `${cond.type}: ${Math.min(current, cond.target)}/${cond.target}`;
    return null;
}
