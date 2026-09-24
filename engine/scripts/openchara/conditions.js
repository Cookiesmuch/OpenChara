// The shared condition registry (plan Section 12a). One evaluator, reused
// by ultimate chargeConditions (Section 12) and quest conditions (Section
// 1.8) alike - a single, growable vocabulary for "has X happened" instead
// of every feature reinventing its own trigger format.
//
// Three kinds:
//   poll  - reads data the schema already stores (counters, relationships);
//           zero extra tracking.
//   event - accumulates from live gameplay deltas (statTracking.js's
//           batched flush hands each character's deltas to eventAmount()); the
//           running total lives in the consumer's own progress store (a
//           quest's `progress` dict; later an ultimate's meter).
//   tick  - same accumulation path, fed by a derived per-second counter
//           (combatTime) rather than a discrete event.
// Unknown types always fail closed (false / 0), never throw.

import { readCounter } from "./counters.js";
import { TAG } from "./ids.js";

// `amount(deltas, cond)` - how much one flush of counter deltas
// ({ category: { subject: n } }) advances this condition.
const sumCategory = (deltas, category, subject) => subject
    ? (deltas[category]?.[subject] ?? 0)
    : Object.values(deltas[category] ?? {}).reduce((a, b) => a + b, 0);

export const CONDITION_TYPES = {
    onDamageDealt: { kind: "event", amount: (d, c) => sumCategory(d, "damageDealt", "total") * (c.rate ?? 1) },
    onDamageTaken: { kind: "event", amount: (d, c) => sumCategory(d, "damageTaken", "total") * (c.rate ?? 1) },
    onKill: { kind: "event", amount: (d, c) => sumCategory(d, "kills", c.subject) * (c.flatAmount ?? 1) },
    // No healing abilities exist yet (Phase 10) - nothing queues
    // healingDone, so this simply never advances until one does.
    onHealingDone: { kind: "event", amount: (d, c) => sumCategory(d, "healingDone", "total") * (c.rate ?? 1) },
    onTimeInCombat: { kind: "tick", amount: (d, c) => sumCategory(d, "combatTime", "seconds") * (c.rate ?? 1) },

    counterThreshold: {
        kind: "poll",
        check: (ctx, cond) => readCounter(ctx.owner, ctx.characterId, cond.category, cond.subject) >= cond.target,
    },
    relationshipLevel: {
        kind: "poll",
        check: (ctx, cond) => (ctx.character.relationships?.[cond.track]?.level ?? 0) >= cond.target,
    },
    // Escape hatch: since this whole table is static code (never
    // serialized per-character, per Section 1.0), a condition can hold a real
    // function reference directly for anything too bespoke to generalize.
    custom: {
        kind: "poll",
        check: (ctx, cond) => Boolean(cond.fn?.(ctx)),
    },
};

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

// Human-readable progress for a UI ("zombie 4/10", "damage 120/500").
export function describeProgress(ctx, cond, index, readCounterFn) {
    const def = CONDITION_TYPES[cond?.type];
    if (!def) return null;
    if (cond.type === "counterThreshold") {
        return `${cond.subject.replace("minecraft:", "")}: ${Math.min(readCounterFn(cond.category, cond.subject), cond.target)}/${cond.target}`;
    }
    if (cond.type === "relationshipLevel") return `${cond.track} level ${Math.min(ctx.character.relationships?.[cond.track]?.level ?? 0, cond.target)}/${cond.target}`;
    if (def.kind !== "poll") {
        const label = { onKill: cond.subject ? `${cond.subject.replace("minecraft:", "")} kills` : "kills", onDamageDealt: "damage dealt", onDamageTaken: "damage taken", onHealingDone: "healing", onTimeInCombat: "seconds in combat" }[cond.type];
        return `${label}: ${Math.min(Math.floor(ctx.progress?.[conditionKey(cond, index)] ?? 0), cond.target)}/${cond.target}`;
    }
    return null;
}
