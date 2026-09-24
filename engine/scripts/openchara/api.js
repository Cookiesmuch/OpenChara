// Public API for project content scripts (PATCHES/scripts/*.js, built into
// scripts/content/). Import from "../openchara/api.js" - anything not
// re-exported here is engine-internal and may change without notice.

export { NS, CHAR, N, TAG } from "./ids.js";
export { CONFIG, CHARACTERS, CLASSES, ABILITIES, QUESTS } from "./content.generated.js";
export {
    createCharacter, getCharacter, renameCharacter, grantXp, grantRelationshipXp, setGear, setInventory,
    unlockSkill, startQuest, tryCompleteQuest, setOrder, getOrder, raiseEidolon,
    setStoryFlag, unlockCutscene, markCutsceneSeen, linkBond, getBondBetween,
} from "./characterRecord.js";
export { readIndex, resolveCharacterIdentifier } from "./characterIndex.js";
export { manifestCharacter, despawnCharacter, teleportToMe } from "./manifest.js";
export { serializeItem, deserializeItem, serializeGear, deserializeGear, serializeInventory, deserializeInventory } from "./itemSerializer.js";
export { getSpeciesInfo, DEFAULT_SPECIES } from "./speciesData.js";
export { promptNickname } from "./nicknameUI.js";
export { incrementStat, readCounter, readCounters } from "./counters.js";
export { setBlockLink, getBlockLink, clearBlockLink } from "./blockLinks.js";
export { openCodex } from "./codexMenu.js";
