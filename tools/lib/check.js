// Build validation. One bad import silently kills an entire Bedrock script
// pack (no error in chat, just nothing runs), so every build is checked
// before it's allowed anywhere near the dev folders:
//   - every .json parses
//   - every .js passes `node --check` (syntax)
//   - every relative `import { a } from "./x.js"` resolves to a real file
//     that actually exports `a`

"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function exportsOf(src) {
    const out = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g)) out.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
        for (const part of m[1].split(",")) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name) out.add(name);
        }
    }
    return out;
}

function checkTree(map, label) {
    const errors = [];
    const files = [...map.keys()];

    for (const rel of files.filter(f => f.endsWith(".json"))) {
        try { JSON.parse(map.get(rel).toString("utf8").replace(/^﻿/, "")); }
        catch (e) { errors.push(`${label}/${rel}: invalid JSON (${e.message})`); }
    }

    const scripts = files.filter(f => f.endsWith(".js"));
    if (scripts.length) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openchara-check-"));
        try {
            for (const rel of scripts) {
                const f = path.join(tmp, rel);
                fs.mkdirSync(path.dirname(f), { recursive: true });
                fs.writeFileSync(f, map.get(rel));
                const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
                if (r.status !== 0) errors.push(`${label}/${rel}: syntax error\n${(r.stderr || "").trim().split("\n").slice(0, 4).join("\n")}`);
            }
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

        for (const rel of scripts) {
            const src = map.get(rel).toString("utf8");
            const dir = path.posix.dirname(rel);
            const re = /(?:import|export)\s*(?:\{([^}]*)\}\s*from\s*)?["'](\.{1,2}\/[^"']+)["']/g;
            for (const m of src.matchAll(re)) {
                const target = path.posix.normalize(path.posix.join(dir, m[2]));
                if (!map.has(target)) { errors.push(`${label}/${rel}: imports missing file ${m[2]}`); continue; }
                if (!m[1]) continue;
                const ex = exportsOf(map.get(target).toString("utf8"));
                for (const part of m[1].split(",")) {
                    const name = part.trim().split(/\s+as\s+/)[0].trim();
                    if (name && !ex.has(name)) errors.push(`${label}/${rel}: "${name}" is not exported by ${m[2]}`);
                }
            }
        }
    }
    return errors;
}

module.exports = { checkTree };
