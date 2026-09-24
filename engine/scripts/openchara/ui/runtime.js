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

import { system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
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

function withLoops(env, loops) {
    if (!loops?.length) return env;
    const scoped = Object.create(env);
    for (const [name, listAst, index] of loops) {
        const list = evaluate(listAst, scoped);
        scoped[name] = Array.isArray(list) ? list[index] : undefined;
    }
    return scoped;
}

const str = v => (v === undefined || v === null ? "" : typeof v === "number" && !Number.isInteger(v) ? String(Math.round(v * 10) / 10) : String(v));

// A text template -> plain string, or a RawMessage when it has translations
// (the client localizes those into the player's game language).
function renderTemplate(parts, env) {
    if (parts.every(p => p[0] !== "t")) return parts.map(p => (p[0] === "s" ? p[1] : str(evaluate(p[1], env)))).join("");
    return {
        rawtext: parts.map(p => (p[0] === "s" ? { text: p[1] }
            : p[0] === "e" ? { text: str(evaluate(p[1], env)) }
                : { translate: p[1], with: p[2].map(a => str(evaluate(a, env))) })),
    };
}

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
    return { ...data, params: frame.params, state: frame.state, player: { name: player.name } };
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

async function present(player, session) {
    const token = session.token = (session.token ?? 0) + 1;
    const frame = top(session);
    if (!frame) { sessions.delete(player.id); return; }
    if (!SCREENS[frame.key]) { console.warn(`[${TAG}] UI: unknown screen "${frame.key}"`); sessions.delete(player.id); return; }

    const { form, env } = buildForm(player, frame);
    let res;
    for (let tries = 0; tries < 40; tries++) {
        res = await form.show(player);
        if (!(res.canceled && res.cancelationReason === "UserBusy")) break;
        await new Promise(r => system.runTimeout(r, 5));
    }
    if (session.token !== token) return; // superseded by another present
    if (res.canceled || res.selection === undefined) { sessions.delete(player.id); return; }

    const field = SCREENS[frame.key].fields[res.selection];
    if (field?.k === "press") {
        const scoped = withLoops(env, field.loops);
        await runAction(player, session, field.a, scoped);
    }
    if (sessions.get(player.id) === session && top(session)) system.run(() => present(player, session));
}

async function runAction(player, session, action, env) {
    const args = action.args.map(a => evaluate(a, env));
    const frame = top(session);
    try {
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
            case "toggle": frame.state[args[0]] = !frame.state[args[0]]; return;
            case "call": {
                const fn = handlers.get(args[0]);
                if (!fn) { console.warn(`[${TAG}] UI: no handler "${args[0]}"`); return; }
                const result = await fn(player, ...args.slice(1), { params: frame.params, state: frame.state });
                applyResult(session, result);
                return;
            }
            default: {
                const fn = actions.get(action.fn);
                if (!fn) { console.warn(`[${TAG}] UI: unknown action "${action.fn}"`); return; }
                const result = await fn(player, ...args, { params: frame.params, state: frame.state });
                applyResult(session, result);
            }
        }
    } catch (e) {
        console.warn(`[${TAG}] UI action "${action.fn}" failed: ${e}`);
        try { player.sendMessage(`§c${e?.message ?? e}`); } catch (err) { /* offline */ }
    }
}

// A handler/action may steer navigation by returning { open: [key, ...args] },
// { back: true } or { close: true }.
function applyResult(session, result) {
    if (!result || typeof result !== "object") return;
    if (result.close) session.stack.length = 0;
    else if (result.back) session.stack.pop();
    else if (Array.isArray(result.open)) {
        const [key, ...rest] = result.open;
        const screen = SCREENS[key];
        if (!screen) return;
        const params = {};
        screen.params.forEach((name, i) => { params[name] = rest[i]; });
        session.stack.push({ key, params, state: {} });
    }
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
