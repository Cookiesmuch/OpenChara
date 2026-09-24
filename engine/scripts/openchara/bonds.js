// Character-to-character bonds (plan Section 1.4.2). World-scoped, one
// tiny property per pair, canonical a<b ordering - sidesteps the O(n^2)
// single-array sharding problem entirely instead of deferring it. Character
// ids are real UUIDs (characterId.js), already globally unique, so the pair
// key needs no owner-prefix concatenation.

import { world } from "@minecraft/server";
import { readJsonProperty, writeJsonProperty } from "./dataCore.js";
import { NS } from "./ids.js";
import { BOND_TRACKS } from "./schema.js";

function pairKey(idA, idB) {
    const [a, b] = [idA, idB].sort();
    return `${NS}:bond:${a}:${b}`;
}

// Which tracks a pair bond has is the project's decision (schema.json
// "bondTracks"), e.g. ["combat", "friendship", "love"].
function defaultBond() {
    const bond = {};
    for (const track of BOND_TRACKS) bond[track] = { level: 0, xp: 0 };
    return bond;
}

function isValidBond(bond) {
    if (!bond || typeof bond !== "object") return false;
    return Object.values(bond).every(t => t && typeof t.level === "number" && typeof t.xp === "number");
}

// Missing tracks (e.g. one added to the schema later) read as level 0.
export function readBond(idA, idB) {
    return { ...defaultBond(), ...readJsonProperty(world, pairKey(idA, idB), {}) };
}

// `mutate(oldBond) -> newBond`, same copy-validate-commit discipline as
// dataCore's writeCharacter(). Caller is responsible for also appending each
// side's id into the other's `bondPartners` (characterRecord.js's grantBondXp()
// does this atomically alongside this call).
export function writeBond(idA, idB, mutate) {
    const old = readBond(idA, idB);
    const next = mutate(old);
    if (!next) return null;
    if (!writeJsonProperty(world, pairKey(idA, idB), next, isValidBond)) return null;
    return next;
}
