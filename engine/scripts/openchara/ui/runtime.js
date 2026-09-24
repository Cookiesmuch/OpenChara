// OpenChara UI runtime: shows screens compiled from PATCHES/ui (see
// tools/lib/ui/compile.js). A screen is an ActionFormData whose title names
// the compiled layout (`oc1|<key>|`) and whose buttons are the layout's
// ENTRIES, one per dynamic value, in the order the compiler assigned:
//
//   text  -> button text (string, or RawMessage when it has {t:key} parts)
//   tex   -> button icon (a texture path)
//   bar   -> button text: fill width in pixels
//   vis   -> button text: "1" shown / "0" hidden
//   press -> the button a compiled control reports when pressed
//
// Forms can't change while open, so a press closes the form, runs its
// action, and the runtime immediately shows the next snapshot: the same
// screen (state changed), another screen (navigation), or nothing.
//
// Data a screen reads comes from a named PROVIDER (<screen data="name">),
// registered by the engine or a project: fn(player, params, state) => object.
// Actions and handlers are called fn(player, ...args) with `this` set to
// { params, state } of the screen they were pressed on (use a non-arrow
// function to read it); trailing arguments a screen leaves out are undefined.

import { system } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { SCREENS, UI_HEADER } from "./screens.generated.js";
import { TAG } from "../ids.js";

const providers = new Map();
const handlers = new Map();
const actions = new Map();

export function registerUiProvider(name, fn) { providers.set(name, fn); }
export function registerUiHandler(name, fn) { handlers.set(name, fn); }
export function registerUiAction(name, fn) { actions.set(name, fn); }
export function hasScreen(key) { return Boolean(SCREENS[key]); }

// ---- expression interpreter (AST from the compiler's parseExpr) -------------
const FILTERS = {
    len: v => (Array.isArray(v) || typeof v === "string" ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0),
    int: v => Math.trunc(Number(v) || 0),
    round: v => Math.round(Number(v) || 0),
    pct: v => `${Math.round((Number(v) || 0) * 100)}%`,
    upper: v => String(v ?? "").toUpperCase(),
    lower: v => String(v ?? "").toLowerCase(),
    default: (v, d) => (v === undefined || v === null || v === "" ? d : v),
    fixed: (v, n) => (Number(v) || 0).toFixed(Number(n) || 0),
    clamp: (v, lo, hi) => Math.min(Number(hi), Math.max(Number(lo), Number(v) || 0)),
    // One page of a list: each="c in characters | page:state.page:10"
    page: (v, p, size) => {
        const n = Number(size) || 10, k = Number(p) || 0;
        return Array.isArray(v) ? v.slice(k * n, (k + 1) * n) : [];
    },
    pages: (v, size) => Math.max(1, Math.ceil((Array.isArray(v) ? v.length : 0) / (Number(size) || 10))),
    // Shortens to n characters with "..." - labels have a fixed height, so an
    // over-long value would otherwise wrap into the line below.
    trunc: (v, n) => { const s = String(v ?? ""); const k = Number(n) || 12; return s.length > k ? `${s.slice(0, Math.max(1, k - 2))}..` : s; },
};

export function evaluate(ast, env) {
    switch (ast[0]) {
        case "num": case "str": case "bool": return ast[1];
        case "null": return null;
        case "path": {
            let v = env;
            for (const seg of ast[1]) {
                const key = typeof seg === "string" ? seg : evaluate(seg, env);
                if (v === undefined || v === null) return undefined;
                v = v[key];
            }
            return v;
        }
        case "not": return !evaluate(ast[1], env);
        case "neg": return -evaluate(ast[1], env);
        case "bin": {
            const op = ast[1];
            if (op === "&&") return evaluate(ast[2], env) && evaluate(ast[3], env);
            if (op === "||") return evaluate(ast[2], env) || evaluate(ast[3], env);
            const a = evaluate(ast[2], env), b = evaluate(ast[3], env);
            switch (op) {
                case "+": return (typeof a === "string" || typeof b === "string") ? `${a ?? ""}${b ?? ""}` : (a ?? 0) + (b ?? 0);
                case "-": return a - b;
                case "*": return a * b;
                case "/": return b ? a / b : 0;
                case "%": return b ? a % b : 0;
                case "==": return a == b; // eslint-disable-line eqeqeq
                case "!=": return a != b; // eslint-disable-line eqeqeq
                case ">": return a > b;
                case "<": return a < b;
                case ">=": return a >= b;
                case "<=": return a <= b;
                default: return undefined;
            }
        }
        case "filter": {
            const fn = FILTERS[ast[1]];
            const v = evaluate(ast[2], env);
            return fn ? fn(v, ...ast[3].map(a => evaluate(a, env))) : v;
        }
        default: return undefined;
    }
}

export function withLoops(env, loops) {
    if (!loops?.length) return env;
    const scoped = Object.create(env);
    for (const [name, listAst, index, indexName] of loops) {
        const list = evaluate(listAst, scoped);
        scoped[name] = Array.isArray(list) ? list[index] : undefined;
        if (indexName) scoped[indexName] = index;
    }
    return scoped;
}

const str = v => (v === undefined || v === null ? "" : typeof v === "number" && !Number.isInteger(v) ? String(Math.round(v * 10) / 10) : String(v));

// A text template -> plain string, or a RawMessage when it has translations
// (the client localizes those into the player's game language).
// A value that is itself a RawMessage ({ translate } / { rawtext }) - e.g. a
// provider's localized string - is embedded as one.
const isRaw = v => v !== null && typeof v === "object" && ("rawtext" in v || "translate" in v);
function renderTemplate(parts, env) {
    const values = parts.map(p => (p[0] === "e" ? evaluate(p[1], env) : null));
    if (parts.every((p, i) => p[0] !== "t" && !isRaw(values[i]))) return parts.map((p, i) => (p[0] === "s" ? p[1] : str(values[i]))).join("");
    return {
        rawtext: parts.map((p, i) => (p[0] === "s" ? { text: p[1] }
            : p[0] === "e" ? (isRaw(values[i]) ? values[i] : { text: str(values[i]) })
                : { translate: p[1], with: p[2].map(a => str(evaluate(a, env))) })),
    };
}

export const renderTemplateForHud = (parts, env) => renderTemplate(parts, env);

// ---- per-player sessions -------------------------------------------------------------
// playerId -> { stack: [{ key, params, state }], token }
const sessions = new Map();

function top(session) { return session.stack[session.stack.length - 1]; }

function buildEnv(player, frame) {
    const screen = SCREENS[frame.key];
    let data = {};
    if (screen.provider) {
        const provide = providers.get(screen.provider);
        if (!provide) console.warn(`[${TAG}] UI: no provider "${screen.provider}" registered for screen "${frame.key}"`);
        else {
            try { data = provide(player, frame.params, frame.state) ?? {}; }
            catch (e) { console.warn(`[${TAG}] UI provider "${screen.provider}" failed: ${e}`); }
        }
    }
    return { ...data, params: frame.params, state: frame.state, player: { name: player.name }, flash: frame.flash ?? null };
}

function buildForm(player, frame) {
    const screen = SCREENS[frame.key];
    const env = buildEnv(player, frame);
    const form = new ActionFormData().title(`${UI_HEADER}${frame.key}|`).body("");
    screen.fields.forEach(f => {
        const e = withLoops(env, f.loops);
        try {
            switch (f.k) {
                case "text": form.button(renderTemplate(f.t, e)); break;
                case "tex": {
                    const path = renderTemplate(f.t, e);
                    if (typeof path === "string" && path) form.button("", path); else form.button("");
                    break;
                }
                case "bar": {
                    const v = Math.max(0, Math.min(100, Number(evaluate(f.e, e)) || 0));
                    form.button(String(Math.round((v / 100) * f.px)));
                    break;
                }
                case "vis": form.button(evaluate(f.e, e) ? "1" : "0"); break;
                case "press": form.button(""); break;
                default: form.button("");
            }
        } catch (err) {
            console.warn(`[${TAG}] UI "${frame.key}" entry failed: ${err}`);
            form.button("");
        }
    });
    return { form, env };
}

// A form can't open over chat or another screen ("UserBusy"): retry briefly.
async function showForm(player, form) {
    let res = { canceled: true };
    for (let tries = 0; tries < 40; tries++) {
        res = await form.show(player);
        if (!(res.canceled && res.cancelationReason === "UserBusy")) break;
        await new Promise(r => system.runTimeout(r, 5));
    }
    return res;
}

async function present(player, session) {
    const token = session.token = (session.token ?? 0) + 1;
    const frame = top(session);
    if (!frame) { sessions.delete(player.id); return; }
    if (!SCREENS[frame.key]) { console.warn(`[${TAG}] UI: unknown screen "${frame.key}"`); sessions.delete(player.id); return; }

    frame.flash = session.flash ?? null; // a flash message shows once
    session.flash = null;
    const { form, env } = buildForm(player, frame);
    frame.flash = null;
    const res = await showForm(player, form);
    if (session.token !== token) return; // superseded by another present
    if (res.canceled || res.selection === undefined) { sessions.delete(player.id); return; }

    const field = SCREENS[frame.key].fields[res.selection];
    if (field?.k === "press") {
        const scoped = withLoops(env, field.loops);
        for (const action of field.a) {
            if (!await runAction(player, session, action, scoped)) break;
        }
    }
    if (sessions.get(player.id) !== session) return;
    if (top(session)) system.run(() => present(player, session));
    else {
        // Closed by the action: its message goes to chat instead.
        sessions.delete(player.id);
        if (session.flash) try { player.sendMessage(`${session.flash.error ? "§c" : "§d"}${session.flash.text}`); } catch (e) { /* offline */ }
    }
}

// Runs one action; false when it failed (a sequence stops there).
async function runAction(player, session, action, env) {
    try {
        await runActionInner(player, session, action, env);
        return true;
    } catch (e) {
        console.warn(`[${TAG}] UI action "${action.fn}" failed: ${e}`);
        if (session.stack.length) session.flash = { text: String(e?.message ?? e), error: true };
        else try { player.sendMessage(`§c${e?.message ?? e}`); } catch (err) { /* offline */ }
        return false;
    }
}

async function runActionInner(player, session, action, env) {
    const args = action.args.map(a => evaluate(a, env));
    const frame = top(session);
    switch (action.fn) {
        case "open": {
            const [key, ...rest] = args;
            const screen = SCREENS[key];
            if (!screen) { console.warn(`[${TAG}] UI: open() of unknown screen "${key}"`); return; }
            const params = {};
            screen.params.forEach((name, i) => { params[name] = rest[i]; });
            session.stack.push({ key, params, state: {} });
            return;
        }
        case "replace": {
            const [key, ...rest] = args;
            const screen = SCREENS[key];
            if (!screen) return;
            const params = {};
            screen.params.forEach((name, i) => { params[name] = rest[i]; });
            session.stack[session.stack.length - 1] = { key, params, state: {} };
            return;
        }
        case "back": session.stack.pop(); return;
        case "close": session.stack.length = 0; return;
        case "set": frame.state[args[0]] = args[1]; return;
        case "choose": return; // only meaningful in a choose() picker
        case "toggle": frame.state[args[0]] = !frame.state[args[0]]; return;
        case "call": {
            const fn = handlers.get(args[0]);
            if (!fn) { console.warn(`[${TAG}] UI: no handler "${args[0]}"`); return; }
            const result = await fn.call({ params: frame.params, state: frame.state }, player, ...args.slice(1));
            applyResult(session, result);
            return;
        }
        default: {
            const fn = actions.get(action.fn);
            if (!fn) { console.warn(`[${TAG}] UI: unknown action "${action.fn}"`); return; }
            const result = await fn.call({ params: frame.params, state: frame.state }, player, ...args);
            applyResult(session, result);
        }
    }
}

// A handler/action may steer navigation by returning { open: [key, ...args] },
// { replace: [key, ...args] }, { back: true } or { close: true }, and/or show
// a one-time message on the next screen with { flash: "text" } (a string
// result is shorthand for that; { error: "text" } shows it as a failure).
function applyResult(session, result) {
    if (typeof result === "string") result = { flash: result };
    if (!result || typeof result !== "object") return;
    if (Array.isArray(result.replace)) {
        const [key, ...rest] = result.replace;
        const screen = SCREENS[key];
        if (screen) {
            const params = {};
            screen.params.forEach((name, i) => { params[name] = rest[i]; });
            session.stack[session.stack.length - 1] = { key, params, state: {} };
        }
    } else if (result.close) session.stack.length = 0;
    else if (result.back) session.stack.pop();
    else if (Array.isArray(result.open)) {
        const [key, ...rest] = result.open;
        const screen = SCREENS[key];
        if (!screen) return;
        const params = {};
        screen.params.forEach((name, i) => { params[name] = rest[i]; });
        session.stack.push({ key, params, state: {} });
    }
    if (result.flash || result.error) session.flash = { text: String(result.flash ?? result.error), error: Boolean(result.error) };
}

// ---- public entry ----------------------------------------------------------------------
// Opens `key` as a fresh navigation root (replacing whatever this player had
// open). `args` fill the screen's declared params in order.
export function openScreen(player, key, ...args) {
    const screen = SCREENS[key];
    if (!screen) { console.warn(`[${TAG}] UI: openScreen of unknown screen "${key}"`); return false; }
    const params = {};
    screen.params.forEach((name, i) => { params[name] = args[i]; });
    const session = { stack: [{ key, params, state: {} }] };
    sessions.set(player.id, session);
    system.run(() => present(player, session));
    return true;
}

// ---- pickers, prompts, dialogue ------------------------------------------------------------
// Handlers run while no form is open, so they can await these and then
// return; the runtime re-shows the current screen afterwards.

// Shows `key` once as a PICKER: pressing a control whose action is
// choose(value) resolves to that value; anything else (back, close, the X)
// resolves to null. Use it for confirmations, player pickers, dialogue.
export async function choose(player, key, ...args) {
    const screen = SCREENS[key];
    if (!screen) { console.warn(`[${TAG}] UI: choose() of unknown screen "${key}"`); return null; }
    const params = {};
    screen.params.forEach((name, i) => { params[name] = args[i]; });
    const frame = { key, params, state: {} };
    const { form, env } = buildForm(player, frame);
    const res = await showForm(player, form);
    if (res.canceled || res.selection === undefined) return null;
    const field = screen.fields[res.selection];
    const pick = field?.k === "press" ? field.a.find(a => a.fn === "choose") : null;
    if (!pick) return null;
    const scoped = withLoops(env, field.loops);
    return pick.args.length ? evaluate(pick.args[0], scoped) : true;
}

// Yes/no. Uses the project's "confirm" screen (params: title, body, yes, no,
// danger) when it has one, else Minecraft's message box.
export async function confirm(player, { title = "", body = "", yes = "OK", no = "Cancel", danger = false } = {}) {
    if (SCREENS.confirm) return (await choose(player, "confirm", title, body, yes, no, danger)) === "yes";
    const res = await showForm(player, new MessageFormData().title(title).body(body).button1(yes).button2(no));
    return !res.canceled && res.selection === 0;
}

// One line of text (rename, paste an import string...). Minecraft's own text
// box - custom screens can't take typing. null when cancelled.
export async function askText(player, { title = "", label = "", placeholder = "", value = "" } = {}) {
    const res = await showForm(player, new ModalFormData().title(title).textField(label, placeholder, { defaultValue: String(value ?? "") }));
    if (res.canceled) return null;
    return String(res.formValues?.[0] ?? "");
}

// A dropdown choice; resolves to the chosen index or null.
export async function askChoice(player, { title = "", label = "", options = [] } = {}) {
    const res = await showForm(player, new ModalFormData().title(title).dropdown(label, options.map(String)));
    if (res.canceled) return null;
    return res.formValues?.[0] ?? null;
}

// A dialogue line: { name, portrait, text, choices: [label...] } -> the
// chosen index (or null). Uses the project's "dialogue" screen (params:
// name, portrait, text, choices) when it has one.
export async function dialogue(player, { name = "", portrait = "", text = "", choices = ["..."] } = {}) {
    if (SCREENS.dialogue) {
        const v = await choose(player, "dialogue", name, portrait, text, choices);
        return typeof v === "number" ? v : null;
    }
    const form = new ActionFormData().title(name).body(text);
    choices.forEach(c => form.button(String(c)));
    const res = await showForm(player, form);
    return res.canceled ? null : res.selection ?? null;
}
