// Public API for project content scripts (PATCHES/scripts/**, built into
// scripts/content/). Import from "../openchara/api.js" (one more "../" per
// subfolder). Anything not re-exported here is engine-internal and may
// change without notice.
//
// The split: OpenChara owns the MECHANISMS (storage, integrity, quests,
// bonds, squads, AI). A project owns the GAME DESIGN - what its records
// hold (PATCHES/database/schema.json), how things grow and what gets
// counted (its scripts, using the hooks and events below).

// ---- identity / config ------------------------------------------------------
export { NS, CHAR, N, TAG } from "./ids.js";
export { CONFIG, CHARACTERS, CLASSES, ABILITIES, QUESTS, SCHEMA } from "./content.generated.js";
export { RULES } from "./rules.js";

// ---- database: character records ----------------------------------------
export {
    createCharacter, getCharacter, recordExists, updateCharacter, grantTracksXp, renameCharacter,
    setGear, setInventory, setHomeLocation, releaseCharacter, restoreCharacter, isPastGracePeriod,
    MAX_ROSTER, TRASH_GRACE_PERIOD_MS, grantBondXp, linkBond, getBondBetween,
    startQuest, tryCompleteQuest, ORDERS, getOrder, setOrder,
} from "./characterRecord.js";
export { readIndex, resolveCharacterIdentifier, isNicknameTaken } from "./characterIndex.js";
export { resolveCharacterOwnerId } from "./characterId.js";
export { incrementStat, incrementStats, queueStat, readCounter, readCounters } from "./counters.js";
export { scanIntegrity, listTrash, purgeCharacter, discoverCharacterIds } from "./dbMaintenance.js";
export { exportCharacter, importCharacter, parseExport, transferCharacter } from "./dbTransfer.js";
export { setBlockLink, getBlockLink, clearBlockLink, listBlockLinks } from "./blockLinks.js";
export { BOND_TRACKS, ENGINE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "./schema.js";

// ---- database: project rules plugged into engine mechanisms -------------
export {
    registerDerivedField, registerRecordInitializer, registerTrackCurve, levelTrack,
    registerQuestReward, registerProjectMigration,
} from "./hooks.js";
export { registerConditionType, evaluateCondition, describeProgress, conditionKey } from "./conditions.js";

// ---- character events -----------------------------------------------------------
export { on } from "./events.js";
export { findOnlinePlayer, identifyCharacter, isInCombat } from "./statTracking.js";

// ---- content lookups -------------------------------------------------------------
export { getClass, getAbility, resolveDefaultClass } from "./classData.js";
export { SPECIES, getSpeciesInfo, DEFAULT_SPECIES } from "./speciesData.js";
export { questAvailableTo, checkQuestProgress } from "./quests.js";

// ---- avatars in the world --------------------------------------------------------
export { manifestCharacter, despawnCharacter, teleportToMe, getLastManifestFailure, getKnockoutRemainingMs } from "./manifest.js";
export { applyOrderToEntity } from "./orders.js";
export { createSoulToken, soulIdOf } from "./souls.js";

// ---- squads, tactics, army -------------------------------------------------------
export {
    readSquads, getSquad, createSquad, joinSquad, leaveSquad, deleteSquad, renameSquad, setCaptain, setCommander,
    getManifestedMembers, resolveSquadIdentifier, MAX_MEMBERS_PER_SQUAD, MAX_SQUADS_PER_PLAYER,
} from "./squads.js";
export { executeFormation, FORMATION_TYPES } from "./formations.js";
export { detectChokePoints } from "./chokePoints.js";
export { breachStack, roomClearCross, slicePie } from "./playbooks.js";
export { setAutoTriggerEnabled, isAutoTriggerEnabled } from "./playbookTriggers.js";
export { pickHuntTarget, startHunt } from "./hunt.js";
export { envelopTarget } from "./army.js";

// ---- custom UI (PATCHES/ui/*.ui.html) ---------------------------------------------
export {
    openScreen, hasScreen, registerUiProvider, registerUiHandler, registerUiAction, evaluate as evaluateUiExpression,
    choose, confirm, askText, askChoice, dialogue,
} from "./ui/runtime.js";
export { characterView, askNickname } from "./ui/builtins.js";
export { registerHudProvider, setHudEnabled, isHudEnabled, listHuds, showToast } from "./ui/hud.js";
export { registerLanguage, listLanguages, getPlayerLanguage, setPlayerLanguage, translate } from "./ui/i18n.js";
export { getMemberAxes } from "./fsm.js";
export { getSquadPosture } from "./coordination.js";

// ---- items / UI helpers ------------------------------------------------------------
export { serializeItem, deserializeItem, serializeGear, deserializeGear, serializeInventory, deserializeInventory } from "./itemSerializer.js";
export { promptNickname } from "./nicknameUI.js";
export { renderRichContent } from "./richContent.js";
