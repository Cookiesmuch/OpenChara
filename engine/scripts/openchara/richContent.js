// Shared rich-content block format (plan Section 1.7). One open array of
// typed blocks used uniformly for every ability/skill/quest description.
// Lives entirely in static data tables (classData.js, quests.js) - never
// per-character. A GUI needs exactly one switch over `type` to render any of
// it; adding a new block type never touches existing content.

export const BLOCK_TYPES = ["text", "heading", "bulletList", "numberedList", "checklist"];

export function isValidBlock(block) {
    if (!block || typeof block !== "object" || !BLOCK_TYPES.includes(block.type)) return false;
    switch (block.type) {
        case "text":
        case "heading":
            return typeof block.value === "string";
        case "bulletList":
        case "numberedList":
            return Array.isArray(block.items) && block.items.every(i => typeof i === "string");
        case "checklist":
            return Array.isArray(block.items) && block.items.every(i => i && typeof i.id === "string" && typeof i.text === "string");
        default:
            return false;
    }
}

export function isValidContent(blocks) {
    return Array.isArray(blocks) && blocks.every(isValidBlock);
}

// Merges a static checklist-type block's items with live per-character quest
// progress, so a GUI can render checked/unchecked without the description
// ever storing dynamic state itself. `progress` is the character's own
// `quests[id].progress` dict (item id -> reached boolean/count).
export function resolveChecklistState(block, progress = {}) {
    if (block.type !== "checklist") return block;
    return {
        ...block,
        items: block.items.map(item => ({ ...item, checked: Boolean(progress[item.id]) })),
    };
}
