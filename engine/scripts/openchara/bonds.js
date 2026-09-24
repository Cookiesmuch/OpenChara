// Character-to-character bonds (plan Section 1.4.2). World-scoped, one
// tiny property per pair, canonical a<b ordering - sidesteps the O(n^2)
// single-array sharding problem entirely instead of deferring it. Character
// ids are real UUIDs (characterId.js), already globally unique, so the pair
// key needs no owner-prefix concatenation.

import { world } from "@minecraft/server";
import { readJsonProperty, writeJsonProperty } from "./dataCore.js";
import { NS } from "./ids.js";

function pairKey(idA, idB) {
    const [a, b] = [idA, idB].sort();
    return `${NS}:bond:${a}:${b}`;
}

function defaultBond() {
    return {
        combat: { level: 0, xp: 0 },
        friendship: { level: 0, xp: 0 },
        love: { level: 0, xp: 0 },
    };
}

function isValidBond(bond) {
    if (!bond || typeof bond !== "object") return false;
    return ["combat", "friendship", "love"].every(track =>
        bond[track] && typeof bond[track].level === "number" && typeof bond[track].xp === "number"
    );
}

export function readBond(idA, idB) {
    return readJsonProperty(world, pairKey(idA, idB), defaultBond());
}

// `mutate(oldBond) -> newBond`, same copy-validate-commit discipline as
// dataCore's writeCharacter(). Caller is responsible for also appending each
// side's id into the other's `bondPartners` (characterRecord.js's linkBond()
// does this atomically alongside this call).
export function writeBond(idA, idB, mutate) {
    const old = readBond(idA, idB);
    const next = mutate(old);
    if (!next) return null;
    if (!writeJsonProperty(world, pairKey(idA, idB), next, isValidBond)) return null;
    return next;
}
