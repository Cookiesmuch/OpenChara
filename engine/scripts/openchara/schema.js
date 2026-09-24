// The character record's shape = the engine's CORE fields (the ones its own
// systems read and write) + the project's own fields, declared as data in
// PATCHES/database/schema.json. The engine never hardcodes what a project
// stores about its characters - it only builds blank records and validates
// them from that declaration.
//
//   schema.json: { "version": 1,
//                  "fields": { "<name>": { "type": "string|number|boolean|object|array|any",
//                                          "default": <json>, "nullable": bool, "optional": bool } },
//                  "bondTracks": ["..."] }
//
// `v` is the ENGINE's schema version (core fields); `pv` is the PROJECT's
// (its fields). They migrate independently. A record written before `pv`
// existed has none, which reads as project version 1.

import { SCHEMA } from "./content.generated.js";

export const ENGINE_SCHEMA_VERSION = 2;
export const PROJECT_SCHEMA_VERSION = SCHEMA.version ?? 1;
export const BOND_TRACKS = SCHEMA.bondTracks ?? [];

// Required-ness matches the pre-split validator exactly: making a field
// newly required would turn every older record missing it into "corrupt".
// Fields marked optional are type-checked only when present.
const CORE_FIELDS = {
    v: { type: "number" },
    nickname: { type: "string" },
    species: { type: "string" },
    soulId: { type: "string" },
    class: { type: "string" },
    createdAt: { type: "number" },
    gear: { type: "object", default: { head: null, chest: null, legs: null, feet: null, mainhand: null, offhand: null } },
    inventory: { type: "array", default: [] },
    quests: { type: "object", default: {} },
    bondPartners: { type: "array", default: [] },
    squadId: { type: "string", nullable: true, optional: true, default: null },
    order: { type: "string", optional: true, default: "follow" },
    homeLocation: { type: "object", nullable: true, optional: true, default: null },
    lastManifestLocation: { type: "object", nullable: true, optional: true, default: null },
    manifestedEntityId: { type: "string", nullable: true, optional: true, default: null },
    deletedAt: { type: "number", nullable: true, optional: true, default: null },
    migratedFrom: { type: "object", nullable: true, optional: true, default: null },
    pv: { type: "number", optional: true },
};

const PROJECT_FIELDS = SCHEMA.fields ?? {};

export function projectPv(record) {
    return typeof record?.pv === "number" ? record.pv : 1;
}

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Every field at its declared default, with `core` (identity fields) laid
// over the top. Project initializers (hooks.js) adjust the result.
export function blankRecord(core) {
    const rec = { v: ENGINE_SCHEMA_VERSION };
    for (const [name, f] of Object.entries(PROJECT_FIELDS)) rec[name] = clone(f.default ?? null);
    for (const [name, f] of Object.entries(CORE_FIELDS)) if ("default" in f) rec[name] = clone(f.default);
    rec.pv = PROJECT_SCHEMA_VERSION;
    return { ...rec, ...core };
}

function typeOk(value, f) {
    if (value === null) return Boolean(f.nullable);
    switch (f.type) {
        case "string": return typeof value === "string";
        case "number": return typeof value === "number" && Number.isFinite(value);
        case "boolean": return typeof value === "boolean";
        case "array": return Array.isArray(value);
        case "object": return typeof value === "object" && !Array.isArray(value);
        default: return true;
    }
}

// Structural check only - every declared field present (unless optional)
// with the right coarse type. Returns the first problem, or null if valid.
export function recordProblem(rec) {
    if (!rec || typeof rec !== "object") return "not an object";
    for (const [fields, label] of [[CORE_FIELDS, "core"], [PROJECT_FIELDS, "project"]]) {
        for (const [name, f] of Object.entries(fields)) {
            if (!(name in rec) || rec[name] === undefined) {
                if (f.optional) continue;
                return `missing ${label} field "${name}"`;
            }
            if (!typeOk(rec[name], f)) return `${label} field "${name}" should be ${f.nullable ? "null or " : ""}${f.type}`;
        }
    }
    return null;
}
