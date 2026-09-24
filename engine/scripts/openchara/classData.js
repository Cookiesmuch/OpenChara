// Class and ability registries ("store choices, derive everything else").
// Nothing here is ever duplicated into a character's own record - only her
// `class`/`species`/`level`/`unlockedSkills` choices are stored; everything
// below is looked up fresh.
//
// The tables themselves come from the project's PATCHES (classes/*.json,
// abilities/*.json), baked into content.generated.js at build time. Adding
// or rebalancing a class is a patch edit, never a migration of stored
// records.

import { CLASSES as PATCHED_CLASSES, ABILITIES as PATCHED_ABILITIES, CHARACTERS } from "./content.generated.js";

// Used when a project defines no class for a character, or a record names
// a class that no longer exists - a character must always resolve to
// *something* playable.
const FALLBACK_CLASS = {
    id: "generalist",
    displayName: "Generalist",
    positioning: { role: "melee", preference: "frontline", flankBias: 0.2 },
    baseStats: { maxHp: 1000, atk: 80, def: 60, spd: 100, critRate: 0.05, critDmg: 0.5, energyRegen: 1.0, effectHitRate: 0, effectRes: 0, breakEffect: 0 },
    perLevelGrowth: { maxHp: 55, atk: 4.5, def: 3.0, spd: 0, critRate: 0, critDmg: 0, energyRegen: 0, effectHitRate: 0, effectRes: 0, breakEffect: 0 },
    defaultAbilities: [],
    ultimate: null,
    skillTree: { nodes: {} },
};

export const CLASSES = { generalist: FALLBACK_CLASS, ...PATCHED_CLASSES };
export const ABILITIES = { ...PATCHED_ABILITIES };

export function getClass(classId) {
    return CLASSES[classId] ?? CLASSES.generalist;
}

// A character's default class comes from her own characters/*.json entry.
export function resolveDefaultClass(species) {
    const cls = CHARACTERS[species]?.class;
    return cls && CLASSES[cls] ? cls : "generalist";
}

// Ability/skill/quest descriptions all use the shared rich-content block
// format (richContent.js).
export function getAbility(id) {
    return ABILITIES[id];
}
