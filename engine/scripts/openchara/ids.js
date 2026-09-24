// Every namespaced identifier the engine uses is built here from the
// project's config (generated at build time from PATCHES/project.json), so
// the engine itself never hardcodes a namespace. A project that sets
// namespace "cw" and character key "waifu" gets exactly `cw:waifu`,
// `cw:waifu:<id>:A`, `cw_waifu` etc. - the engine is generic, the built
// addon is not.

import { CONFIG } from "./content.generated.js";

export const NS = CONFIG.namespace;       // e.g. "cw"
export const CHAR = CONFIG.characterKey;  // e.g. "waifu"

// Display nouns for player-facing text ("waifu" / "Waifus" ...).
export const N = {
    one: CONFIG.nouns.one,
    many: CONFIG.nouns.many,
    One: CONFIG.nouns.one.charAt(0).toUpperCase() + CONFIG.nouns.one.slice(1),
    Many: CONFIG.nouns.many.charAt(0).toUpperCase() + CONFIG.nouns.many.slice(1),
};

// Chat tag for player-facing messages ("[CW] ..."): the namespace upper-cased
// unless the project sets its own.
export const TAG = CONFIG.chatTag ?? NS.toUpperCase();
