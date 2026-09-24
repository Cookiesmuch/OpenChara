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

const UI_STUB = String.raw`
class Form { constructor() { return new Proxy(this, { get: (t, p) => (p === "show" ? async () => ({ canceled: true }) : () => t) }); } }
export class ActionFormData extends Form {}
export class ModalFormData extends Form {}
export class MessageFormData extends Form {}
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
