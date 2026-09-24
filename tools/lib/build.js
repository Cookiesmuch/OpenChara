// OpenChara build: engine + a project's PATCHES -> a ready-to-load
// behavior pack + resource pack.
//
// Pipeline (every step is deterministic; same inputs -> byte-identical
// output, so the dev watcher can tell real changes from rebuild noise):
//   1. load + validate PATCHES/project.json
//   2. engine/bp, engine/rp  -> copied with {{placeholders}} filled
//   3. engine/scripts        -> BP scripts/ (devtools only if enabled)
//   4. generated:            -> content.generated.js, main.js, manifests,
//                               lang, character entity (with nav slots),
//                               client entity + render controller
//   5. PATCHES/scripts       -> BP scripts/content/
//   6. PATCHES/bp, PATCHES/rp -> overlaid last (a project file at the same
//                               path replaces the engine's)
//
// Returns { bp: Map<relPath, Buffer>, rp: Map<relPath, Buffer>, project }.
// Nothing is written here - see writeTree()/deploy.js.

"use strict";
const fs = require("fs");
const path = require("path");
const { compileUi } = require("./ui/compile.js");

// Minecraft Bedrock's own game languages (texts/<id>.lang it will load).
const GAME_LOCALES = new Set([
    "en_US", "en_GB", "de_DE", "es_ES", "es_MX", "fr_FR", "fr_CA", "it_IT", "ja_JP", "ko_KR", "pt_BR", "pt_PT",
    "ru_RU", "zh_CN", "zh_TW", "nl_NL", "bg_BG", "cs_CZ", "da_DK", "el_GR", "fi_FI", "hu_HU", "id_ID", "nb_NO",
    "pl_PL", "sk_SK", "sv_SE", "tr_TR", "uk_UA",
]);
const LOCALE_ALIASES = { en_GB: "en_US", es_MX: "es_ES", fr_CA: "fr_FR", pt_PT: "pt_BR", zh_TW: "zh_CN" };

// key=value lines; "##" starts a comment (whole line or trailing, like Minecraft's).
function parseLang(text) {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s*##.*$/, "");
        const k = line.indexOf("=");
        if (k <= 0) continue;
        out[line.slice(0, k).trim()] = line.slice(k + 1).replace(/\t+$/, "");
    }
    return out;
}
const { generatePortraits } = require("./portraits.js");

const TEXT_EXT = new Set([".json", ".lang", ".js", ".md", ".txt", ".mcfunction"]);

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { throw new Error(`${file}: ${e.message}`); }
}

function walk(dir, base = dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, base, out);
        else out.push(path.relative(base, full).split(path.sep).join("/"));
    }
    return out.sort();
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---- project ----------------------------------------------------------------
function loadProject(projectDir) {
    const patchesDir = path.join(projectDir, "PATCHES");
    const file = path.join(patchesDir, "project.json");
    if (!fs.existsSync(file)) throw new Error(`No PATCHES/project.json in ${projectDir}`);
    const p = readJson(file);
    const need = (cond, msg) => { if (!cond) throw new Error(`project.json: ${msg}`); };
    need(typeof p.name === "string", "name is required");
    need(/^[a-z][a-z0-9_]*$/.test(p.namespace ?? ""), "namespace must be lowercase letters/digits/underscores");
    need(/^[a-z][a-z0-9_]*$/.test(p.character?.key ?? ""), "character.key must be lowercase letters/digits/underscores");
    need(p.packs?.behavior?.uuid && p.packs?.resource?.uuid, "packs.behavior.uuid and packs.resource.uuid are required");
    p.version ??= [1, 0, 0];
    p.minEngineVersion ??= [1, 21, 0];
    p.authors ??= [];
    p.character.nouns ??= { one: p.character.key, many: `${p.character.key}s` };
    p.character.geometry ??= "geometry.humanoid.custom";
    p.character.material ??= "entity_alphatest";
    p.packs.behavior.folder ??= `${p.name} B`;
    p.packs.resource.folder ??= `${p.name} R`;
    p.scriptModules ??= { "@minecraft/server": "2.6.0", "@minecraft/server-ui": "2.0.0" };
    p.navigationSlots ??= 10000;
    p.devTools ??= false;
    p.projectDir = projectDir;
    p.patchesDir = patchesDir;
    p.engineDir = path.resolve(projectDir, p.engine ?? "../OpenChara");
    need(fs.existsSync(path.join(p.engineDir, "engine")), `engine not found at ${p.engineDir} (set "engine" to the OpenChara folder)`);
    return p;
}

function placeholders(p) {
    const n = p.character.nouns;
    return {
        ns: p.namespace,
        char: p.character.key,
        Char: capitalize(n.one),
        chars: n.many,
        Chars: capitalize(n.many),
    };
}

function fill(text, vars) {
    return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ---- content tables from PATCHES --------------------------------------------
function loadTable(dir, label) {
    const table = {};
    for (const rel of walk(dir)) {
        if (!rel.endsWith(".json")) continue;
        const obj = readJson(path.join(dir, rel));
        const id = obj.id ?? path.basename(rel, ".json");
        if (table[id]) throw new Error(`${label}: duplicate id "${id}" (${rel})`);
        table[id] = { ...obj, id };
    }
    return table;
}

function loadContent(p) {
    const d = sub => path.join(p.patchesDir, sub);
    const characters = loadTable(d("characters"), "characters");
    const classes = loadTable(d("classes"), "classes");
    const abilities = loadTable(d("abilities"), "abilities");
    const quests = loadTable(d("quests"), "quests");
    const schemaFile = path.join(p.patchesDir, "database", "schema.json");
    const schema = fs.existsSync(schemaFile) ? readJson(schemaFile) : {};
    schema.version ??= 1;
    schema.fields ??= {};
    schema.bondTracks ??= [];
    const TYPES = new Set(["string", "number", "boolean", "object", "array", "any"]);
    for (const [name, f] of Object.entries(schema.fields)) {
        if (!TYPES.has(f.type)) throw new Error(`database/schema.json: field "${name}" has unknown type "${f.type}"`);
        if (CORE_FIELDS.has(name)) throw new Error(`database/schema.json: "${name}" is an engine core field - a project can't redefine it`);
    }

    const seen = new Map();
    for (const c of Object.values(characters)) {
        if (!Number.isInteger(c.index) || c.index < 0) throw new Error(`characters/${c.id}: "index" must be a non-negative integer (it is stored on entities - never renumber)`);
        if (seen.has(c.index)) throw new Error(`characters: index ${c.index} used by both "${seen.get(c.index)}" and "${c.id}"`);
        seen.set(c.index, c.id);
        if (typeof c.texture !== "string") throw new Error(`characters/${c.id}: "texture" is required`);
        if (c.class && !classes[c.class] && c.class !== "generalist") throw new Error(`characters/${c.id}: unknown class "${c.class}"`);
    }
    for (const cls of Object.values(classes)) {
        for (const a of cls.defaultAbilities ?? []) if (!abilities[a]) throw new Error(`classes/${cls.id}: unknown ability "${a}"`);
    }
    return { characters, classes, abilities, quests, schema };
}

// Record fields the engine's own systems own (mirrors engine
// scripts/openchara/schema.js). A project schema may not redefine them.
const CORE_FIELDS = new Set(["v", "pv", "nickname", "species", "soulId", "class", "gear", "inventory", "squadId", "order",
    "homeLocation", "lastManifestLocation", "manifestedEntityId", "createdAt", "deletedAt", "migratedFrom", "quests", "bondPartners"]);

// ---- generated files ----------------------------------------------------------
function generatedContentModule(p, content) {
    const config = {
        name: p.name,
        namespace: p.namespace,
        characterKey: p.character.key,
        nouns: p.character.nouns,
        chatTag: p.chatTag,
        devTools: p.devTools,
        navigationSlots: p.navigationSlots,
        rules: p.rules ?? {},
    };
    const j = v => JSON.stringify(v, null, 2);
    return `// GENERATED by OpenChara build from ${p.name}'s PATCHES - do not edit.\n` +
        `export const CONFIG = ${j(config)};\n` +
        `export const CHARACTERS = ${j(content.characters)};\n` +
        `export const CLASSES = ${j(content.classes)};\n` +
        `export const ABILITIES = ${j(content.abilities)};\n` +
        `export const QUESTS = ${j(content.quests)};\n` +
        `export const SCHEMA = ${j(content.schema)};\n`;
}

function generatedMain(p, contentScripts) {
    const lines = [
        `// GENERATED by OpenChara build - engine first, then dev tools, then ${p.name} content.`,
        `import { startOpenChara } from "./openchara/start.js";`,
    ];
    if (p.devTools) {
        for (const f of ["phase1TestHarness", "phase2TestHarness", "phase3TestHarness", "phase6TestHarness", "phase7TestHarness"]) {
            lines.push(`import "./openchara/devtools/${f}.js";`);
        }
    }
    for (const rel of contentScripts) lines.push(`import "./content/${rel}";`);
    lines.push("", "startOpenChara();", "");
    return lines.join("\n");
}

function navSlotCharacterEntity(template, p, content) {
    const ent = template["minecraft:entity"];
    const ns = p.namespace;
    ent.component_groups ??= {};
    ent.events ??= {};
    for (let i = 0; i < p.navigationSlots; i++) {
        ent.component_groups[`${ns}:navigating_slot_${i}`] = {
            "minecraft:behavior.follow_mob": {
                filters: { test: "has_tag", subject: "other", value: `${ns}_anchor_slot_${i}` },
                search_range: 64, stop_distance: 1, speed_multiplier: 1.3,
            },
        };
        ent.events[`${ns}:navigating_on_slot_${i}`] = { add: { component_groups: [`${ns}:navigating_slot_${i}`] } };
        ent.events[`${ns}:navigating_off_slot_${i}`] = { remove: { component_groups: [`${ns}:navigating_slot_${i}`] } };
    }
    const maxIndex = Math.max(15, ...Object.values(content.characters).map(c => c.index));
    const prop = ent.description?.properties?.[`${ns}:species_index`];
    if (prop) prop.range = [0, maxIndex];
    return template;
}

function clientEntity(p, content) {
    const ns = p.namespace, key = p.character.key;
    const textures = {};
    for (const c of Object.values(content.characters).sort((a, b) => a.index - b.index)) textures[`species${c.index}`] = c.texture;
    return {
        format_version: "1.16.0",
        "minecraft:client_entity": {
            description: {
                identifier: `${ns}:${key}`,
                materials: { default: p.character.material },
                textures,
                geometry: { default: p.character.geometry },
                render_controllers: [`controller.render.${ns}_${key}`],
                enable_attachables: true,
                hide_armor: false,
            },
        },
    };
}

function renderController(p, content) {
    const ns = p.namespace, key = p.character.key;
    const maxIndex = Math.max(0, ...Object.values(content.characters).map(c => c.index));
    // Indices may have gaps; a gap renders the lowest-index character.
    const first = Object.values(content.characters).sort((a, b) => a.index - b.index)[0];
    const arr = [];
    for (let i = 0; i <= maxIndex; i++) {
        const has = Object.values(content.characters).some(c => c.index === i);
        arr.push(`Texture.species${has ? i : first?.index ?? 0}`);
    }
    return {
        format_version: "1.10.0",
        render_controllers: {
            [`controller.render.${ns}_${key}`]: {
                arrays: { textures: { [`Array.${ns}_species`]: arr } },
                geometry: "Geometry.default",
                materials: [{ "*": "Material.default" }],
                textures: [`Array.${ns}_species[q.property('${ns}:species_index')]`],
            },
        },
    };
}

function manifests(p) {
    const b = p.packs.behavior, r = p.packs.resource;
    const header = uuid => ({ name: "pack.name", description: "pack.description", uuid, version: p.version, min_engine_version: p.minEngineVersion });
    const metadata = { authors: p.authors };
    const bp = {
        format_version: 2,
        header: header(b.uuid),
        modules: [
            { type: "data", uuid: b.dataModuleUuid, version: p.version },
            { type: "script", language: "javascript", uuid: b.scriptModuleUuid, entry: "scripts/main.js", version: p.version },
        ],
        dependencies: [
            { uuid: r.uuid, version: p.version },
            ...Object.entries(p.scriptModules).map(([module_name, version]) => ({ module_name, version })),
        ],
        metadata,
    };
    const rp = {
        format_version: 2,
        header: header(r.uuid),
        modules: [{ type: "resources", uuid: r.moduleUuid, version: p.version }],
        metadata,
    };
    if (!b.dataModuleUuid || !b.scriptModuleUuid || !r.moduleUuid) throw new Error("project.json: packs need dataModuleUuid, scriptModuleUuid (behavior) and moduleUuid (resource)");
    return { bp, rp };
}

// ---- main -------------------------------------------------------------------
function build(projectDir) {
    const p = loadProject(projectDir);
    const vars = placeholders(p);
    const content = loadContent(p);
    const engine = path.join(p.engineDir, "engine");
    const bp = new Map(), rp = new Map();
    const put = (map, rel, data) => map.set(rel, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
    const json = v => JSON.stringify(v, null, 2) + "\n";

    // 2. engine templates
    for (const [src, map] of [[path.join(engine, "bp"), bp], [path.join(engine, "rp"), rp]]) {
        for (const rel of walk(src)) {
            const buf = fs.readFileSync(path.join(src, rel));
            const outRel = fill(rel, vars);
            put(map, outRel, TEXT_EXT.has(path.extname(rel)) ? fill(buf.toString("utf8"), vars) : buf);
        }
    }

    // 3. engine scripts
    const scripts = path.join(engine, "scripts");
    for (const rel of walk(scripts)) {
        if (!p.devTools && rel.startsWith("openchara/devtools/")) continue;
        put(bp, `scripts/${rel}`, fs.readFileSync(path.join(scripts, rel)));
    }

    // 3b. automatic portraits (before the content module, which carries
    // their paths). A character's own portrait/bust fields always win.
    const portraits = generatePortraits(p, content.characters, walk);
    for (const [rel, buf] of portraits.files) put(rp, rel, buf);
    for (const [id, pp] of Object.entries(portraits.paths)) {
        content.characters[id].portrait ??= pp.portrait;
        content.characters[id].bust ??= pp.bust;
    }

    // 4. generated
    put(bp, "scripts/openchara/content.generated.js", generatedContentModule(p, content));
    const charRel = `entities/${p.character.key}.json`;
    if (bp.has(charRel)) put(bp, charRel, JSON.stringify(navSlotCharacterEntity(JSON.parse(bp.get(charRel).toString("utf8")), p, content)));
    put(rp, `entity/${p.character.key}.json`, json(clientEntity(p, content)));
    put(rp, `render_controllers/${p.character.key}.render_controllers.json`, json(renderController(p, content)));
    const m = manifests(p);
    put(bp, "manifest.json", json(m.bp));
    put(rp, "manifest.json", json(m.rp));

    // lang: pack name/description + engine strings + project strings
    const langDirEngine = path.join(engine, "lang");
    const langDirProject = path.join(p.patchesDir, "lang");
    const locales = new Set([...walk(langDirEngine), ...walk(langDirProject)].filter(f => f.endsWith(".lang")));
    if (locales.size === 0) locales.add("en_US.lang");
    // Every language also goes into a script table, for per-player language
    // overrides (ui/i18n.js). Only real Minecraft game locales go into the
    // packs' texts/ - the client picks those by the game language; others
    // (e.g. fil_PH) are reachable through the override only.
    const langTables = {};
    const gameTexts = {};
    // Each locale sits on top of English, key by key, so anything it
    // doesn't translate (yet) shows in English rather than as a raw key.
    const readLang = (dir, loc) => {
        const f = path.join(dir, loc);
        return fs.existsSync(f) ? parseLang(fill(fs.readFileSync(f, "utf8"), vars)) : {};
    };
    const english = { ...readLang(langDirEngine, "en_US.lang"), ...readLang(langDirProject, "en_US.lang") };
    for (const loc of locales) {
        const table = {
            "pack.name": p.name, "pack.description": p.description ?? "",
            ...english, ...readLang(langDirEngine, loc), ...readLang(langDirProject, loc),
        };
        const id = loc.replace(/\.lang$/, "");
        langTables[id] = table;
        if (GAME_LOCALES.has(id)) gameTexts[id] = Object.entries(table).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    }
    // Close regional variants reuse a sibling when the project has none.
    for (const [alias, source] of Object.entries(LOCALE_ALIASES)) if (!gameTexts[alias] && gameTexts[source]) gameTexts[alias] = gameTexts[source];
    for (const [id, text] of Object.entries(gameTexts)) {
        put(bp, `texts/${id}.lang`, text);
        put(rp, `texts/${id}.lang`, text);
    }
    const langJson = json(Object.keys(gameTexts).sort((a, b) => (a === "en_US" ? -1 : b === "en_US" ? 1 : a.localeCompare(b))));
    put(bp, "texts/languages.json", langJson);
    put(rp, "texts/languages.json", langJson);
    const langRuntime = Object.fromEntries(Object.entries(langTables).map(([id, table]) => [id, { name: table["openchara.language.name"] ?? id, table }]));
    put(bp, "scripts/openchara/ui/lang.generated.js", `// GENERATED by OpenChara build from lang/*.lang - do not edit.\nexport const LANGS = ${JSON.stringify(langRuntime)};\n`);

    // 4b. UI: PATCHES/ui/*.ui.html + *.ui.css -> JSON UI + runtime table.
    // Always generated (an empty root when a project has no screens), since
    // the engine's server_form hook and runtime reference both.
    const uiDir = path.join(p.patchesDir, "ui");
    const uiFiles = walk(uiDir).filter(f => f.endsWith(".ui.html") || f.endsWith(".ui.css"))
        .map(rel => ({ rel, text: fs.readFileSync(path.join(uiDir, rel), "utf8") }));
    const ui = compileUi(uiFiles);
    // Generated JSON UI is written minified: deeply nested, it is several times larger indented.
    for (const [rel, obj] of Object.entries(ui.rp)) put(rp, rel, JSON.stringify(obj));
    put(bp, "scripts/openchara/ui/screens.generated.js", ui.runtime);

    // 5. content scripts
    const contentDir = path.join(p.patchesDir, "scripts");
    const contentScripts = walk(contentDir).filter(f => f.endsWith(".js"));
    for (const rel of walk(contentDir)) put(bp, `scripts/content/${rel}`, fs.readFileSync(path.join(contentDir, rel)));
    // Every content script is imported once by main.js (ES modules only
    // evaluate once, so a script that's also imported by another is fine).
    // A project can list "contentScripts" in project.json to choose exactly
    // which files are entry points instead.
    const entryScripts = p.contentScripts ?? contentScripts;
    put(bp, "scripts/main.js", generatedMain(p, entryScripts));

    // 6. overlays (last, so a project can replace any engine file).
    // Shared registry files are MERGED instead of replaced - an engine item
    // texture and a project item texture must both survive.
    for (const [src, map] of [[path.join(p.patchesDir, "bp"), bp], [path.join(p.patchesDir, "rp"), rp]]) {
        for (const rel of walk(src)) {
            const buf = fs.readFileSync(path.join(src, rel));
            if (MERGED_FILES.has(rel) && map.has(rel)) put(map, rel, json(mergeRegistry(JSON.parse(map.get(rel).toString("utf8")), JSON.parse(buf.toString("utf8")))));
            else put(map, rel, buf);
        }
    }

    return { project: p, bp, rp };
}

// Registry-style files several contributors add entries to.
const MERGED_FILES = new Set([
    "textures/item_texture.json", "textures/terrain_texture.json", "textures/flipbook_textures.json",
    "ui/_ui_defs.json", "ui/_global_variables.json", "sounds/sound_definitions.json", "sounds.json",
]);

// Objects merge key by key (project wins on a scalar clash); arrays are a
// union keeping first-seen order.
function mergeRegistry(base, add) {
    if (Array.isArray(base) && Array.isArray(add)) {
        const out = [...base];
        for (const v of add) if (!out.some(x => JSON.stringify(x) === JSON.stringify(v))) out.push(v);
        return out;
    }
    if (base && add && typeof base === "object" && typeof add === "object" && !Array.isArray(base) && !Array.isArray(add)) {
        const out = { ...base };
        for (const [k, v] of Object.entries(add)) out[k] = k in base ? mergeRegistry(base[k], v) : v;
        return out;
    }
    return add;
}

// Writes a built tree to disk as a mirror: only changed files are written,
// files no longer produced are removed. Returns counts.
function writeTree(map, outDir) {
    let written = 0, removed = 0;
    for (const [rel, buf] of map) {
        const dest = path.join(outDir, rel);
        if (fs.existsSync(dest)) {
            const cur = fs.readFileSync(dest);
            if (cur.equals(buf)) continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        written++;
    }
    const want = new Set([...map.keys()]);
    for (const rel of walk(outDir)) {
        if (!want.has(rel)) { fs.rmSync(path.join(outDir, rel)); removed++; }
    }
    pruneEmptyDirs(outDir);
    return { written, removed };
}

function pruneEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            const full = path.join(dir, entry.name);
            pruneEmptyDirs(full);
            if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        }
    }
}

module.exports = { build, writeTree, loadProject, walk };
