// Loads a built OpenChara behavior pack's scripts in plain Node for tests,
// by giving them an in-memory stand-in for @minecraft/server and
// @minecraft/server-ui. Only the storage surface is real (dynamic
// properties on the world and on fake players); everything else is an inert
// catch-all, so modules that subscribe to events or start intervals at load
// time import cleanly and simply never fire.
//
//   const { root } = installStub(tmpDir);   // writes node_modules + package.json
//   // copy scripts into tmpDir, then:
//   const mod = await import(pathToFileURL(path.join(tmpDir, "scripts/openchara/api.js")));
//   const { makePlayer, world } = await import(pathToFileURL(path.join(root, "node_modules/@minecraft/server/index.js")));

"use strict";
const fs = require("fs");
const path = require("path");

const SERVER_STUB = String.raw`
const inert = () => new Proxy(function () {}, {
    get: (t, p) => (p === Symbol.toPrimitive ? () => "" : p === "then" ? undefined : inert()),
    apply: () => inert(),
    construct: () => inert(),
});

class PropertyHolder {
    constructor() { this._dp = new Map(); }
    getDynamicProperty(k) { return this._dp.get(k); }
    setDynamicProperty(k, v) { if (v === undefined) this._dp.delete(k); else this._dp.set(k, v); }
    getDynamicPropertyIds() { return [...this._dp.keys()]; }
}

class World extends PropertyHolder {
    constructor() { super(); this.players = []; this.afterEvents = inert(); this.beforeEvents = inert(); }
    getAllPlayers() { return this.players; }
    getPlayers() { return this.players; }
    getEntity() { return undefined; }
    getDimension() { return inert(); }
    sendMessage() {}
}

export const world = new World();

export const system = {
    currentTick: 0,
    run() { return 0; },
    runInterval() { return 0; },
    runTimeout() { return 0; },
    runJob() { return 0; },
    clearRun() {},
    afterEvents: inert(),
    beforeEvents: inert(),
};

export class ItemStack {
    constructor(typeId, amount = 1) { this.typeId = typeId; this.amount = amount; this.nameTag = undefined; this._lore = []; }
    getComponent() { return undefined; }
    getComponents() { return []; }
    getLore() { return this._lore; }
    setLore(l) { this._lore = l ?? []; }
}

export function makePlayer(id, name = id) {
    const p = new PropertyHolder();
    Object.assign(p, { id, name, typeId: "minecraft:player", messages: [], sendMessage(m) { this.messages.push(m); }, isValid: true });
    world.players.push(p);
    return p;
}
`;

// Forms record what was put on them. show() asks globalThis.__formResponder
// (form, player) for a response, else reports the form as cancelled.
const UI_STUB = String.raw`
class Form {
    constructor(kind) { this.kind = kind; this.titleText = ""; this.bodyText = ""; this.buttons = []; this.fields = []; }
    title(t) { this.titleText = t; return this; }
    body(t) { this.bodyText = t; return this; }
    button(text, icon) { this.buttons.push({ text, icon }); return this; }
    button1(t) { this.buttons[0] = { text: t }; return this; }
    button2(t) { this.buttons[1] = { text: t }; return this; }
    textField(label, placeholder, opts) { this.fields.push({ type: "text", label, placeholder, opts }); return this; }
    dropdown(label, options, opts) { this.fields.push({ type: "dropdown", label, options, opts }); return this; }
    toggle(label, opts) { this.fields.push({ type: "toggle", label, opts }); return this; }
    slider(label, min, max, opts) { this.fields.push({ type: "slider", label, min, max, opts }); return this; }
    async show(player) {
        const r = globalThis.__formResponder?.(this, player);
        return r ?? { canceled: true, cancelationReason: "UserClosed" };
    }
}
export class ActionFormData extends Form { constructor() { super("action"); } }
export class ModalFormData extends Form { constructor() { super("modal"); } }
export class MessageFormData extends Form { constructor() { super("message"); } }
`;

function installStub(dir) {
    const put = (rel, text) => {
        const f = path.join(dir, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text);
    };
    put("package.json", JSON.stringify({ type: "module" }));
    put("node_modules/@minecraft/server/package.json", JSON.stringify({ name: "@minecraft/server", type: "module", main: "index.js" }));
    put("node_modules/@minecraft/server/index.js", SERVER_STUB);
    put("node_modules/@minecraft/server-ui/package.json", JSON.stringify({ name: "@minecraft/server-ui", type: "module", main: "index.js" }));
    put("node_modules/@minecraft/server-ui/index.js", UI_STUB);
    return { root: dir };
}

module.exports = { installStub };
