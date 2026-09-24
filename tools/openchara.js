#!/usr/bin/env node
// OpenChara command-line tool.
//
//   node tools/openchara.js build  <projectDir>   build into <projectDir>/build/
//   node tools/openchara.js check  <projectDir>   build + validate only (nothing written)
//   node tools/openchara.js export <projectDir>   build + write <projectDir>/dist/<Name> <version>.mcaddon
//   node tools/openchara.js deploy <projectDir>   build + sync into Minecraft's development pack folders
//   node tools/openchara.js dev    <projectDir>   deploy, then watch the project's PATCHES and this
//                                                engine for changes and redeploy automatically
//   node tools/openchara.js log    <projectDir>   show this project's errors/warnings from Minecraft's
//                                                newest content log (--all: every pack; --follow: keep tailing)
//
// <projectDir> is the folder containing PATCHES/ (defaults to the current
// directory). Every build is validated first (JSON, JS syntax, imports);
// a failing build is never deployed.

"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { build, writeTree } = require("./lib/build.js");
const { checkTree } = require("./lib/check.js");
const { zip } = require("./lib/zip.js");

function comMojang() {
    if (process.env.OPENCHARA_COM_MOJANG) return process.env.OPENCHARA_COM_MOJANG;
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const candidates = [
        path.join(appdata, "Minecraft Bedrock", "Users", "Shared", "games", "com.mojang"),
        path.join(process.env.LOCALAPPDATA || "", "Packages", "Microsoft.MinecraftUWP_8wekyb3d8bbwe", "LocalState", "games", "com.mojang"),
    ];
    const found = candidates.find(c => fs.existsSync(c));
    if (!found) throw new Error("Can't find Minecraft's com.mojang folder - set OPENCHARA_COM_MOJANG to its path.");
    return found;
}

function stamp() { return new Date().toTimeString().slice(0, 8); }

function buildChecked(projectDir) {
    const t0 = Date.now();
    const result = build(projectDir);
    const errors = [...checkTree(result.bp, "BP", result.project.minuiDir), ...checkTree(result.rp, "RP", result.project.minuiDir)];
    result.ms = Date.now() - t0;
    if (errors.length) {
        const e = new Error(`Build has ${errors.length} problem(s):\n  - ${errors.join("\n  - ")}`);
        e.buildErrors = errors;
        throw e;
    }
    return result;
}

function cmdBuild(projectDir) {
    const r = buildChecked(projectDir);
    const out = path.join(projectDir, "build");
    const a = writeTree(r.bp, path.join(out, r.project.packs.behavior.folder));
    const b = writeTree(r.rp, path.join(out, r.project.packs.resource.folder));
    console.log(`[${stamp()}] Built ${r.project.name} in ${r.ms}ms -> ${out} (${a.written + b.written} written, ${a.removed + b.removed} removed)`);
    return r;
}

function cmdDeploy(projectDir, quiet = false) {
    const r = buildChecked(projectDir);
    const root = comMojang();
    const a = writeTree(r.bp, path.join(root, "development_behavior_packs", r.project.packs.behavior.folder));
    const b = writeTree(r.rp, path.join(root, "development_resource_packs", r.project.packs.resource.folder));
    const changed = a.written + b.written + a.removed + b.removed;
    if (!quiet || changed) console.log(`[${stamp()}] Deployed ${r.project.name} (${r.ms}ms build): ${a.written + b.written} file(s) updated, ${a.removed + b.removed} removed.`);
    return { r, changed };
}

function cmdExport(projectDir) {
    const r = buildChecked(projectDir);
    const entries = [];
    for (const [folder, map] of [[r.project.packs.behavior.folder, r.bp], [r.project.packs.resource.folder, r.rp]]) {
        for (const [rel, data] of map) entries.push({ name: `${folder}/${rel}`, data });
    }
    const dist = path.join(projectDir, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const file = path.join(dist, `${r.project.name} ${r.project.version.join(".")}.mcaddon`);
    fs.writeFileSync(file, zip(entries));
    console.log(`[${stamp()}] Exported ${file} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
}

function cmdDev(projectDir) {
    let project;
    try { project = cmdDeploy(projectDir).r.project; }
    catch (e) { console.error(`[${stamp()}] ${e.message}`); project = require("./lib/build.js").loadProject(projectDir); }

    const watched = [project.patchesDir, path.join(project.engineDir, "engine")];
    let timer = null, running = false, again = false;
    const run = () => {
        if (running) { again = true; return; }
        running = true;
        try { cmdDeploy(projectDir, true); }
        catch (e) { console.error(`[${stamp()}] Not deployed - ${e.message}`); }
        running = false;
        if (again) { again = false; schedule(); }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 400); };

    for (const dir of watched) {
        fs.watch(dir, { recursive: true }, (evt, file) => {
            if (file && /(^|[\\/])(\.git|node_modules|build|dist)([\\/]|$)/.test(file)) return;
            schedule();
        });
    }
    // Safety net: some editors/sync tools don't fire watch events reliably;
    // a periodic no-op-if-unchanged deploy catches anything missed.
    setInterval(schedule, 30000);
    console.log(`[${stamp()}] Watching:\n  ${watched.join("\n  ")}\nChanges redeploy automatically. After a script change use /reload in-game; new entities/items/textures need a world rejoin. Ctrl+C to stop.`);
}

// ---- log: Minecraft's content log, filtered to this project ------------------------------
// JSON UI and entity-definition errors never show in-game; they only land
// in %APPDATA%/Minecraft Bedrock/logs/ContentLog*.txt. This shows the newest
// log's errors and warnings that mention this project's packs or namespace
// (or [Scripting]/[UI] lines), repeated lines collapsed.
function logDir() {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const dirs = [path.join(appdata, "Minecraft Bedrock", "logs"), path.join(process.env.LOCALAPPDATA || "", "Packages", "Microsoft.MinecraftUWP_8wekyb3d8bbwe", "LocalState", "logs")];
    return dirs.find(d => fs.existsSync(d)) ?? null;
}
function cmdLog(projectDir, flags) {
    const dir = logDir();
    if (!dir) throw new Error("Can't find Minecraft's logs folder.");
    const newest = () => fs.readdirSync(dir).filter(f => /^ContentLog.*\.txt$/.test(f))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f;
    const file = newest();
    if (!file) { console.log("No content log yet - enable Settings > Creator > Content Log File, then play."); return; }
    let project = null;
    try { project = require("./lib/build.js").loadProject(projectDir); } catch (e) { /* show everything */ }
    const needles = project && !flags.includes("--all")
        ? [project.packs.behavior.folder, project.packs.resource.folder, `${project.namespace}:`, "[Scripting]", "[UI]"]
        : null;
    const clean = l => l.replace(/%APPDATA%\/Minecraft Bedrock\/Users\/Shared\/games\/com\.mojang\/development_(behavior|resource)_packs\//g, "");
    const show = text => {
        const counts = new Map();
        for (const raw of text.split(/\r?\n/)) {
            if (!/\[(error|warning)\]/i.test(raw)) continue;
            if (needles && !needles.some(n => raw.includes(n))) continue;
            const key = clean(raw.replace(/^\d\d:\d\d:\d\d/, "")).trim();
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        for (const [line, n] of counts) console.log(`${n > 1 ? `${String(n).padStart(3)}x ` : "     "}${line}`);
        return counts.size;
    };
    const full = path.join(dir, file);
    console.log(`${file}${needles ? ` (filtered to ${project.name}; --all for everything)` : ""}:`);
    const n = show(fs.readFileSync(full, "utf8"));
    if (!n) console.log("     no errors or warnings");
    if (!flags.includes("--follow")) return;
    let size = fs.statSync(full).size;
    console.log(`[${stamp()}] following ${file} - Ctrl+C to stop`);
    setInterval(() => {
        const now = fs.statSync(full).size;
        if (now <= size) return;
        const fd = fs.openSync(full, "r");
        const buf = Buffer.alloc(now - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        size = now;
        show(buf.toString("utf8"));
    }, 1000);
}

function main() {
    const args = process.argv.slice(2);
    const flags = args.filter(a => a.startsWith("--"));
    const [cmd, dirArg] = args.filter(a => !a.startsWith("--"));
    const projectDir = path.resolve(dirArg ?? ".");
    try {
        switch (cmd) {
            case "build": cmdBuild(projectDir); break;
            case "check": { const r = buildChecked(projectDir); console.log(`OK - ${r.project.name}: ${r.bp.size} BP + ${r.rp.size} RP files, all checks passed (${r.ms}ms).`); break; }
            case "export": cmdExport(projectDir); break;
            case "deploy": cmdDeploy(projectDir); break;
            case "dev": cmdDev(projectDir); break;
            case "log": cmdLog(projectDir, flags); break;
            default:
                console.log("Usage: node tools/openchara.js <build|check|export|deploy|dev|log> [projectDir]");
                process.exitCode = cmd ? 1 : 0;
        }
    } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}

main();
