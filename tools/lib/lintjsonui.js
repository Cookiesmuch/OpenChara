// JSON UI linter: catches the "silent killer" mistakes documented in
// docs/UI.md - ones that load fine and simply do nothing in-game, with no
// error anywhere. Runs over every *.json under a resource pack's `ui/`
// folder, both the compiler's own generated output (a regression check on
// the compiler itself) and any hand-written overlay files a project adds.
//
// Checked, from the UI-0 spikes and bedrock-core's own container-facts:
//   - no `>=` in a Molang expression (Bedrock's binding language has no
//     greater-or-equal operator; it silently parses as something else)
//   - no `''` empty string literal in a Molang expression
//   - `collection_index` only means something under an ancestor that
//     declares `collection_name`
//   - a `"type": "button"` needs its own `collection_details` binding to
//     report which collection cell was pressed
//   - `$variable` in a binding inside a `modifications`-injected subtree
//     (these don't resolve there - UI-0 finding)

"use strict";

// Fields whose string value is itself a Molang expression, not plain text/a path.
const MOLANG_FIELDS = new Set(["source_property_name", "visible", "enabled", "collection_length"]);

function walk(node, ctx, path, errors, file) {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, ctx, `${path}[${i}]`, errors, file)); return; }
    if (!node || typeof node !== "object") return;

    const hasCollection = "collection_name" in node;
    const baseCtx = { hasCollection: ctx.hasCollection || hasCollection, inModification: ctx.inModification };

    if ("collection_index" in node && !ctx.hasCollection && !hasCollection) {
        errors.push(`${file}: ${path} has collection_index with no ancestor collection_name`);
    }
    if (node.type === "button") {
        const bindings = Array.isArray(node.bindings) ? node.bindings : [];
        if (!bindings.some(b => b && b.binding_type === "collection_details")) {
            errors.push(`${file}: ${path} is a button with no collection_details binding - it can't report a press`);
        }
    }

    for (const [key, value] of Object.entries(node)) {
        if (typeof value === "string" && MOLANG_FIELDS.has(key)) {
            if (/>=/.test(value)) errors.push(`${file}: ${path}.${key} uses ">=" - Molang bindings have no >= operator: "${value}"`);
            if (/''/.test(value)) errors.push(`${file}: ${path}.${key} has an empty string literal '' : "${value}"`);
            if (baseCtx.inModification && /\$[A-Za-z_]\w*/.test(value)) {
                errors.push(`${file}: ${path}.${key} uses a $variable inside a modifications subtree - these don't resolve there: "${value}"`);
            }
        }
        // Only the modifications key's own subtree counts as "inside a
        // modifications-injected subtree" - the rest of the file (its own
        // description block, etc.) isn't.
        const childCtx = key === "modifications" ? { ...baseCtx, inModification: true } : baseCtx;
        walk(value, childCtx, `${path}.${key}`, errors, file);
    }
}

function lintJsonUi(map, label) {
    const errors = [];
    for (const rel of [...map.keys()]) {
        if (!rel.endsWith(".json") || !/(^|\/)ui\//.test(rel)) continue;
        let doc;
        try { doc = JSON.parse(map.get(rel).toString("utf8")); } catch (e) { continue; } // JSON validity is checkTree's job
        walk(doc, { hasCollection: false, inModification: false }, "$", errors, `${label}/${rel}`);
    }
    return errors;
}

module.exports = { lintJsonUi };
