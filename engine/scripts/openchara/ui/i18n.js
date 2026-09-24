// OpenChara UI languages.
//
// By default a screen's {t:key} text goes out as a RawMessage and the client
// shows it in the player's GAME language (resource pack texts/<locale>.lang).
// A player can override that per player (setPlayerLanguage): the engine then
// resolves every {t:key} itself from the table the build generated from
// PATCHES/lang/*.lang (lang.generated.js). That is also the only way to show
// a language Minecraft doesn't ship as a game locale (e.g. fil_PH).
//
// A project can add a TRANSFORM language on top of a base one:
//   registerLanguage("hieroglyph", { name: "Hieroglyphs", base: "en_US", transform: s => ... })
// (the transform is applied to the translated template text, never to the
// values inserted into it, so names and numbers stay readable).
//
// Each lang file names itself with `openchara.language.name=...`.

import { LANGS } from "./lang.generated.js";
import { NS } from "../ids.js";

const PROP = `${NS}:uiLang`;
const registered = new Map(); // id -> { name, base, transform }

export function registerLanguage(id, { name = id, base = "en_US", transform = null } = {}) {
    registered.set(id, { name, base, transform });
}

export function listLanguages() {
    const out = Object.entries(LANGS).map(([id, l]) => ({ id, name: l.name }));
    for (const [id, l] of registered) out.push({ id, name: l.name });
    return out;
}

export function languageName(id) {
    return registered.get(id)?.name ?? LANGS[id]?.name ?? id;
}

// null = follow the game language.
export function getPlayerLanguage(player) {
    try {
        const v = player.getDynamicProperty(PROP);
        return typeof v === "string" && v && (LANGS[v] || registered.has(v)) ? v : null;
    } catch (e) { return null; }
}

export function setPlayerLanguage(player, id) {
    player.setDynamicProperty(PROP, id ? String(id) : undefined);
}

// "%s" in order, or "%1$s" by position - the same as Minecraft's own lang files.
function format(text, args) {
    let i = 0;
    return text.replace(/%(?:(\d+)\$)?s/g, (_, n) => {
        const v = n ? args[Number(n) - 1] : args[i++];
        return v === undefined || v === null ? "" : String(v);
    });
}

export function translate(lang, key, args = []) {
    const extra = registered.get(lang);
    const table = LANGS[extra ? extra.base : lang]?.table ?? {};
    let text = table[key] ?? LANGS.en_US?.table?.[key] ?? key;
    if (extra?.transform) {
        // Transform the template, keeping the %s markers intact.
        text = text.split(/(%(?:\d+\$)?s)/).map((part, i) => (i % 2 ? part : extra.transform(part))).join("");
    }
    return format(text, args);
}

// Resolves a RawMessage ({ text } / { translate, with } / { rawtext: [...] })
// to a plain string in `lang`.
export function resolveRaw(lang, msg) {
    if (msg === null || msg === undefined) return "";
    if (typeof msg !== "object") return String(msg);
    if (Array.isArray(msg.rawtext)) return msg.rawtext.map(m => resolveRaw(lang, m)).join("");
    if (msg.translate) {
        const w = Array.isArray(msg.with) ? msg.with : (msg.with?.rawtext ?? []).map(m => resolveRaw(lang, m));
        return translate(lang, msg.translate, w.map(x => (typeof x === "object" ? resolveRaw(lang, x) : x)));
    }
    return msg.text !== undefined ? String(msg.text) : "";
}
