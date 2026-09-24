// Quests (plan Section 1.8). Static definitions here (id, title,
// description via richContent.js, conditions via the shared
// CONDITION_TYPES registry, rewards); only a character's own progress against
// a definition is a stored fact, living in her record's `quests` dict:
//   quests[questId] = { status: "active"|"completed", progress: { condKey: n } }
// `progress` only ever holds running totals for event/tick conditions -
// poll conditions read counters/relationships directly (Section 1.0).
//
// A definition's optional `species` list limits who can take it; omitted
// means anyone. A checklist block's items line up with `conditions` by
// index, so the Codex can tick them off live.

import { evaluateAllConditions } from "./conditions.js";
import { isValidContent } from "./richContent.js";
import { QUESTS as PATCHED_QUESTS } from "./content.generated.js";

// Definitions come from the project's PATCHES/quests/*.json.
export const QUESTS = { ...PATCHED_QUESTS };

export function getQuest(id) {
    return QUESTS[id];
}

export function questAvailableTo(def, record) {
    return !def.species || def.species.includes(record.species);
}

function isValidQuestDef(def) {
    if (!def || typeof def !== "object") return false;
    if (typeof def.id !== "string" || typeof def.title !== "string") return false;
    if (!isValidContent(def.description)) return false;
    if (!Array.isArray(def.conditions)) return false;
    return true;
}

// Read-only check: does this character currently satisfy an active quest's
// conditions? Does not itself grant rewards or mutate anything - that's
// tryCompleteQuest()'s job (characterRecord.js), kept separate so checking
// progress is always safe to call speculatively (e.g. for a GUI's live
// checklist rendering) without side effects.
export function checkQuestProgress(character, owner, characterId, questId) {
    const def = QUESTS[questId];
    if (!isValidQuestDef(def)) return false;
    const state = character.quests?.[questId];
    if (!state || state.status !== "active") return false;
    return evaluateAllConditions({ character, owner, characterId, progress: state.progress ?? {} }, def.conditions);
}
