// Tunable numbers for the engine's own mechanisms, from the project's
// project.json "rules". Everything has a working default, so a project only
// lists what it wants different. Game-design numbers (level caps, XP
// curves...) are NOT here - those belong to the project's own scripts.

import { CONFIG } from "./content.generated.js";

const DEFAULTS = {
    maxRoster: 50,          // active characters per player (the Trash doesn't count)
    trashGraceDays: 30,     // how long a released character stays restorable
    maxSquads: 5,
    maxSquadMembers: 10,
    knockoutHp: 8,          // at/below this entity HP she's knocked out instead of dying
    knockoutSeconds: 30,    // how long a knocked-out character can't be re-summoned
    combatWindowSeconds: 5, // "in combat" = dealt or took damage this recently
};

export const RULES = { ...DEFAULTS, ...(CONFIG.rules ?? {}) };
