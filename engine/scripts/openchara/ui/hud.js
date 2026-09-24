// OpenChara HUD runtime. HUDs are compiled from <hud> elements in
// PATCHES/ui (tools/lib/ui/compile.js, HUD mode). Each dynamic value has its
// own key; its value reaches the client as a title `ocH|<hud>.<n>|<value>`,
// which the vanilla HUD hides and a "preserved title" element keeps.
//
// Measured in UI-0: the client only sees the LAST title set in a tick, so
// the sender pushes exactly one value per player per tick, from a queue
// holding only values that changed (latest value wins, original position
// kept). Providers are re-evaluated every REFRESH_TICKS.
//
// Per-player settings: setHudEnabled(player, id, bool) persists in a player
// dynamic property; a disabled HUD gets its root visibility key set to "0".

import { world, system } from "@minecraft/server";
import { HUDS, HUD_HEADER } from "./screens.generated.js";
import { evaluate, renderTemplateForHud, withLoops } from "./runtime.js";
import { getPlayerLanguage } from "./i18n.js";
import { NS, TAG } from "../ids.js";

const REFRESH_TICKS = 4;
const providers = new Map();
export function registerHudProvider(name, fn) { providers.set(name, fn); }

const PREFS_KEY = `${NS}:hudPrefs`;
function prefs(player) {
    try { return JSON.parse(player.getDynamicProperty(PREFS_KEY) ?? "{}"); } catch (e) { return {}; }
}
export function isHudEnabled(player, id) { return prefs(player)[id] !== false; }
export function setHudEnabled(player, id, enabled) {
    const p = prefs(player);
    p[id] = Boolean(enabled);
    player.setDynamicProperty(PREFS_KEY, JSON.stringify(p));
    refreshPlayer(player);
}
export function listHuds() { return Object.keys(HUDS); }

// playerId -> { sent: Map<key, value>, queue: Map<key, value> }
const states = new Map();
function state(player) {
    let s = states.get(player.id);
    if (!s) { s = { sent: new Map(), queue: new Map() }; states.set(player.id, s); }
    return s;
}


function valueOf(field, env) {
    switch (field.k) {
        case "text": return renderTemplateForHud(field.t, env);
        case "tex": { const v = renderTemplateForHud(field.t, env); return typeof v === "string" ? v : ""; }
        case "bar": { const v = Math.max(0, Math.min(100, Number(evaluate(field.e, env)) || 0)); return String(Math.round((v / 100) * field.px)); }
        case "vis": return evaluate(field.e, env) ? "1" : "0";
        default: return "";
    }
}

function refreshPlayer(player) {
    const s = state(player);
    for (const [id, hud] of Object.entries(HUDS)) {
        const enabled = isHudEnabled(player, id);
        let data = {};
        if (enabled && hud.provider) {
            const provide = providers.get(hud.provider);
            if (!provide) continue;
            try { data = provide(player) ?? {}; } catch (e) { console.warn(`[${TAG}] HUD provider "${hud.provider}" failed: ${e}`); continue; }
        }
        const env = { ...data, player: { name: player.name }, __lang: getPlayerLanguage(player) };
        let reshown = false;
        hud.fields.forEach((f, i) => {
            const key = `${HUD_HEADER}${id}.${i}|`;
            let value;
            if (f.root) value = enabled && data.visible !== false ? "1" : "0";
            else if (!enabled) return;
            else {
                try { value = valueOf(f, withLoops(env, f.loops)); } catch (e) { value = ""; }
            }
            const serial = typeof value === "string" ? value : JSON.stringify(value);
            if (f.k === "vis" && serial === "1" && s.sent.get(key) !== "1") reshown = true;
            if (s.sent.get(key) === serial) { s.queue.delete(key); return; }
            s.queue.set(key, value);
        });
        // Values inside a group that was hidden weren't caught by the client
        // while it was hidden - forget them so the next refresh resends.
        if (reshown) {
            hud.fields.forEach((f, i) => { if (f.k !== "vis") s.sent.delete(`${HUD_HEADER}${id}.${i}|`); });
        }
    }
}

function sendOne(player) {
    const s = states.get(player.id);
    if (!s || s.queue.size === 0) return;
    const [key, value] = s.queue.entries().next().value;
    s.queue.delete(key);
    const title = typeof value === "string" ? key + value : { rawtext: [{ text: key }, ...(value.rawtext ?? [])] };
    try {
        player.onScreenDisplay.setTitle(title, { fadeInDuration: 0, stayDuration: 2, fadeOutDuration: 0 });
        s.sent.set(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch (e) { /* player gone mid-tick */ }
}

// ---- toasts: short popups for any project HUD with data="toasts" -----------
// showToast(player, text, icon?) queues one; each shows for TOAST_TICKS,
// then the next. The provider hides its HUD when nothing is queued.
const TOAST_TICKS = 60;
const toasts = new Map(); // playerId -> [{ text, icon, until }]
export function showToast(player, text, icon = "") {
    const list = toasts.get(player.id) ?? [];
    if (list.length >= 8) list.shift();
    list.push({ text, icon, until: null });
    toasts.set(player.id, list);
}
registerHudProvider("toasts", player => {
    const list = toasts.get(player.id);
    if (!list?.length) return { visible: false, text: "", icon: "" };
    const now = system.currentTick;
    if (list[0].until === null) list[0].until = now + TOAST_TICKS;
    if (now > list[0].until) { list.shift(); if (!list.length) return { visible: false, text: "", icon: "" }; list[0].until = now + TOAST_TICKS; }
    return { visible: true, text: list[0].text, icon: list[0].icon };
});

export function startHud() {
    if (Object.keys(HUDS).length === 0) return;
    system.runInterval(() => {
        for (const player of world.getAllPlayers()) {
            if (system.currentTick % REFRESH_TICKS === 0) refreshPlayer(player);
            sendOne(player);
        }
    }, 1);
    // A (re)joining client has an empty HUD - resend everything.
    world.afterEvents.playerSpawn.subscribe(ev => { if (ev.initialSpawn) states.delete(ev.player.id); });
    world.afterEvents.playerLeave.subscribe(ev => states.delete(ev.playerId));
}
