#!/usr/bin/env node
// OpenChara command-line tool.
//
//   node tools/openchara.js build  <projectDir>   build into <projectDir>/build/
//   node tools/openchara.js check  <projectDir>   build + validate only (nothing written)
//   node tools/openchara.js export <projectDir>   build + write <projectDir>/dist/<Name> <version>.mcaddon
//   node tools/openchara.js deploy <projectDir>   build + sync into Minecraft's development pack folders
//   node tools/openchara.js dev    <projectDir>   deploy, then watch the project's PATCHES and this
//                                                engine for changes and redeploy automatically
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
    const errors = [...checkTree(result.bp, "BP"), ...checkTree(result.rp, "RP")];
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

function main() {
    const [cmd, dirArg] = process.argv.slice(2);
    const projectDir = path.resolve(dirArg ?? ".");
    try {
        switch (cmd) {
            case "build": cmdBuild(projectDir); break;
            case "check": { const r = buildChecked(projectDir); console.log(`OK - ${r.project.name}: ${r.bp.size} BP + ${r.rp.size} RP files, all checks passed (${r.ms}ms).`); break; }
            case "export": cmdExport(projectDir); break;
            case "deploy": cmdDeploy(projectDir); break;
            case "dev": cmdDev(projectDir); break;
            default:
                console.log("Usage: node tools/openchara.js <build|check|export|deploy|dev> [projectDir]");
                process.exitCode = cmd ? 1 : 0;
        }
    } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}

main();
