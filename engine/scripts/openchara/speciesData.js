// Species ("character type") registry, from the project's
// PATCHES/characters/*.json. Each entry's `index` is the value written to
// the entity's species_index property and the position of its texture in
// the generated render controller's species array - the build assigns
// nothing on its own, so indices stay stable as characters are added.
//
// Also the static per-species progression data: `eidolonCost` (what
// raising her Eidolon level consumes - only the unlocked level itself is
// stored on her record) and `favoriteGifts` (gifts.js). Omitted fields fall
// back to DEFAULT_SPECIES_DATA.

import { NS } from "./ids.js";
import { CHARACTERS } from "./content.generated.js";

const DEFAULT_SPECIES_DATA = {
    eidolonCost: [
        { item: `${NS}:summon_scroll`, amount: 1 },
        { item: "minecraft:amethyst_shard", amount: 16 },
    ],
    favoriteGifts: [],
};

export const SPECIES = CHARACTERS;

// The first defined character (lowest index) - the default for anything
// that needs "some species" (dev tools, an unknown id on an old record).
export const DEFAULT_SPECIES = Object.values(CHARACTERS).sort((a, b) => a.index - b.index)[0]?.id ?? null;

export function getSpeciesInfo(species) {
    return { ...DEFAULT_SPECIES_DATA, ...(SPECIES[species] ?? SPECIES[DEFAULT_SPECIES] ?? {}) };
}
