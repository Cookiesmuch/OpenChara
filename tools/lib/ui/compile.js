// OpenChara UI compiler: PATCHES/ui/*.ui.html + *.ui.css -> JSON UI (resource
// pack) + a runtime table (behavior pack) that tells the engine which form
// entry carries which value.
//
// How a compiled screen reaches the client (all measured in-game, UI-0):
//   - The form title is `oc1|<screenKey>|`. The engine's server_form.json hook
//     sizes our container only when that header is present and hides the
//     vanilla dialog.
//   - Each screen sits behind a factory GATE whose #collection_length is 1
//     only when the title names it, so screens that aren't shown are never
//     built (bedrock-core S8/S11). Bindings inside a gated screen use
//     binding_condition "always" (S11: factory-built cells bind too early).
//   - Every dynamic value is one form ENTRY (an ActionFormData button): text
//     in its text, textures in its icon, numbers as text read with (x - 0),
//     visibility as "1"/"0". A control reads its entry through a panel with a
//     baked collection_index under a stack declaring collection_name.
//   - A pressable control carries its own collection_details binding (S1),
//     and is vanilla common.button (mouse, touch, controller, click sound).

"use strict";
const { parseMarkup, parseCss, parseDecls, parseExpr, parseTemplate, parseAction, isStaticTemplate, UiSyntaxError } = require("./markup.js");

const HEADER = "oc1|";
const NS = "oc_screens";
const COLLECTION = "form_buttons";

const TAGS = new Set(["screen", "panel", "row", "column", "grid", "scroll", "text", "image", "portrait", "bar", "button", "spacer"]);
const CONTAINERS = new Set(["screen", "panel", "row", "column", "grid", "scroll", "button"]);

const DEFAULTS = {
    screen: { width: "100%", height: "100%" },
    panel: { width: "100%", height: "100%" },
    row: { width: "100%", height: "fit" },
    column: { width: "100%", height: "fit" },
    grid: { width: "100%", height: "fit", gap: "2" },
    scroll: { width: "100%", height: "100%" },
    text: { width: "100%", color: "#ffffff" },
    image: { width: "32", height: "32" },
    portrait: { width: "32", height: "32" },
    bar: { width: "100", height: "8", background: "textures/ui/Black", "bar-color": "#e0405a" },
    button: {
        width: "100%", height: "24",
        background: "textures/ui/button_borderless_light",
        "hover-background": "textures/ui/button_borderless_lighthover",
        "pressed-background": "textures/ui/button_borderless_lightpressed",
    },
    spacer: { width: "4", height: "4" },
};

const FONT_HEIGHT = { small: 8, normal: 10, large: 14, extra_large: 20 };

// ---- helpers ---------------------------------------------------------------------------
function hexColor(v, err) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(v).trim());
    if (!m) err(`color "${v}" must be #rrggbb`);
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(x => Math.round(x * 1000) / 1000);
}

function sizeValue(v, err) {
    const s = String(v).trim();
    if (/^-?\d+(\.\d+)?(px)?$/.test(s)) return parseFloat(s);
    if (/^\d+(\.\d+)?%$/.test(s)) return s;
    if (s === "fill") return "fill";
    if (s === "fit") return "100%c";
    if (/^[\d.%cmsxyp +\-]+$/.test(s)) return s; // raw JSON UI expression, e.g. "100% - 8px"
    err(`size "${s}" - use a number, N%, fill, fit, or an expression like "100% - 8px"`);
}

const ANCHORS = ["top_left", "top_middle", "top_right", "left_middle", "center", "right_middle", "bottom_left", "bottom_middle", "bottom_right"];


function addPx(size, px) {
    if (!px) return size;
    if (typeof size === "number") return size + px;
    return `${size} + ${px}px`;
}
function subPx(size, px) {
    if (!px) return size;
    if (typeof size === "number") return Math.max(0, size - px);
    if (size === "100%c") return size;
    return `${size} - ${px}px`;
}

function specificity(sel) { return (sel.id ? 100 : 0) + sel.classes.length * 10 + (sel.tag ? 1 : 0); }
function matches(sel, node) {
    if (sel.tag && sel.tag !== node.tag) return false;
    if (sel.id && sel.id !== node.attrs.id) return false;
    const classes = String(node.attrs.class ?? "").split(/\s+/).filter(Boolean);
    return sel.classes.every(c => classes.includes(c));
}

// on:press="a(x); back" - several actions run in order (stops at the first
// that fails). Splits on ; outside quotes and brackets.
function splitActions(src) {
    const out = [];
    let depth = 0, cur = "", q = null;
    for (const ch of src) {
        if (q) { cur += ch; if (ch === q) q = null; continue; }
        if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
        if (ch === "(" || ch === "[") depth++;
        if (ch === ")" || ch === "]") depth--;
        if (ch === ";" && depth === 0) { if (cur.trim()) out.push(cur); cur = ""; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
}

// ---- compiler ------------------------------------------------------------------------
class ScreenCompiler {
    constructor(key, file, rules) {
        this.key = key;
        this.file = file;
        this.rules = rules;
        this.fields = [];   // runtime table, index = form entry
        this.defs = {};     // extra top-level JSON UI definitions (scroll contents, animations)
        this.n = 0;
        this.ns = NS;
    }

    err(node, msg) { throw new UiSyntaxError(this.file, node?.line ?? 0, msg); }
    name(prefix = "e") { return `${prefix}${this.n++}`; }

    style(node) {
        const out = { ...(DEFAULTS[node.tag] ?? {}) };
        const hits = [];
        this.rules.forEach((rule, order) => {
            for (const sel of rule.selectors) if (matches(sel, node)) hits.push({ spec: specificity(sel), order, decls: rule.decls });
        });
        hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
        for (const h of hits) Object.assign(out, h.decls);
        if (typeof node.attrs.style === "string") Object.assign(out, parseDecls(node.attrs.style));
        return out;
    }

    field(f) { this.fields.push(f); return this.fields.length - 1; }

    // Common placement props from style -> control.
    placement(st, node) {
        const e = m => this.err(node, m);
        const p = { size: [sizeValue(st.width ?? "100%", e), sizeValue(st.height ?? "100%", e)] };
        if (st.anchor) {
            const a = st.anchor.replace(/-/g, "_");
            if (!ANCHORS.includes(a)) e(`anchor "${st.anchor}" - use one of ${ANCHORS.join(", ").replace(/_/g, "-")}`);
            p.anchor_from = a; p.anchor_to = a;
        }
        if (st.offset) {
            const [x, y] = st.offset.split(/\s+/);
            p.offset = [sizeValue(x, e), sizeValue(y ?? "0", e)];
        }
        if (st.layer) p.layer = parseInt(st.layer, 10);
        if (st.opacity) p.alpha = parseFloat(st.opacity);
        if (st.clip === "true") p.clips_children = true;
        this.animate(st, p, e);
        return p;
    }

    // ---- animations (JSON UI anim_type alpha/offset, chained with "next") ----------
    // They play when the control is created, i.e. every time the screen is
    // shown - meant for reveals and attention pulses, not everyday screens.
    //   fade-in: <duration> [delay]          0 -> opacity
    //   slide-from: <dx> <dy> <duration> [delay]   from offset+(dx,dy) to offset
    //   pulse: <period>                       loops alpha between 1 and 0.35
    //   easing: linear | out-cubic | out-back | in-out-quad | ...
    anim(def) {
        const name = `anim_${this.key}_${this.n++}`;
        this.defs[name] = def;
        return `@${this.ns}.${name}`;
    }
    animate(st, p, e) {
        const secs = v => {
            const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(String(v ?? "").trim());
            if (!m) e(`time "${v}" - write e.g. 0.4s or 250ms`);
            return m[2] === "ms" ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);
        };
        const easing = (st.easing ?? "out-cubic").replace(/-/g, "_");
        const target = p.alpha ?? 1;
        let pulse = null;
        if (st.pulse) {
            const half = secs(st.pulse) / 2;
            const a = `anim_${this.key}_${this.n++}`, b = `anim_${this.key}_${this.n++}`;
            this.defs[a] = { anim_type: "alpha", easing: "in_out_quad", duration: half, from: 1, to: 0.35, next: `@${this.ns}.${b}` };
            this.defs[b] = { anim_type: "alpha", easing: "in_out_quad", duration: half, from: 0.35, to: 1, next: `@${this.ns}.${a}` };
            pulse = `@${this.ns}.${a}`;
        }
        if (st["fade-in"]) {
            const [d, delay] = st["fade-in"].split(/\s+/);
            const main = { anim_type: "alpha", easing, duration: secs(d), from: 0, to: target };
            if (pulse) main.next = pulse;
            let ref = this.anim(main);
            if (delay) ref = this.anim({ anim_type: "alpha", easing: "linear", duration: secs(delay), from: 0, to: 0, next: ref });
            p.alpha = ref;
            p.propagate_alpha = true;
        } else if (pulse) { p.alpha = pulse; p.propagate_alpha = true; }
        if (st["slide-from"]) {
            const [dx, dy, d, delay] = st["slide-from"].split(/\s+/);
            const to = p.offset ?? [0, 0];
            if (typeof to[0] !== "number" || typeof to[1] !== "number") e("slide-from needs a pixel offset (or none)");
            const from = [to[0] + parseFloat(dx), to[1] + parseFloat(dy ?? "0")];
            let ref = this.anim({ anim_type: "offset", easing, duration: secs(d ?? "0.4s"), from, to });
            if (delay) ref = this.anim({ anim_type: "offset", easing: "linear", duration: secs(delay), from, to: from, next: ref });
            p.offset = ref;
        }
    }

    // Wraps `control` so it reads form entry `index`. The wrapper takes the
    // control's placement; the control fills the indexed cell.
    indexed(index, control, extraCell = {}) {
        const { size, anchor_from, anchor_to, offset, layer, ...rest } = control;
        const wrap = { type: "stack_panel", orientation: "vertical", size, collection_name: COLLECTION };
        if (anchor_from) Object.assign(wrap, { anchor_from, anchor_to });
        if (offset) wrap.offset = offset;
        if (layer !== undefined) wrap.layer = layer;
        return {
            ...wrap,
            controls: [{ cell: { type: "panel", size: ["100%", "100%"], collection_index: index, ...extraCell, controls: [{ v: { ...rest, size: ["100%", "100%"] } }] } }],
        };
    }

    collectionRead(name = "#form_button_text", override) {
        const b = { binding_name: name, binding_type: "collection", binding_collection_name: COLLECTION, binding_condition: "always" };
        if (override) b.binding_name_override = override;
        return b;
    }

    // Visibility gate for if="..." / each presence.
    //
    // `axis` is the immediate parent's real stacking direction: "horizontal"
    // for a <row>/<grid> cell, "vertical" for a <column>/<scroll>/button
    // content stack, or null when the parent doesn't flow its children at
    // all (a bare <panel>/<screen>, where each child is independently
    // anchored - nothing needs to collapse there, so any size is fine).
    //
    // Inside an actual stack, JSON UI can only "measure past" a hidden
    // sibling along an axis that's a literal pixel number - never a
    // percentage/fill one (a stack_panel sized "100%c" folds to whatever it
    // currently measures, and only a fixed-size hidden child measures as
    // zero). A gated sibling whose size on the STACK's own axis is a
    // percentage therefore can never truly collapse: it keeps reserving
    // that width/height even while hidden, which pushes every sibling after
    // it out of the row/column - in the worst case off the panel entirely
    // (this is exactly what happened to Squad > Disband's Cancel button:
    // the Yes/No row is horizontal, but the buttons' fold-eligible axis was
    // their fixed HEIGHT, not their percentage WIDTH, so the hidden
    // alternate-style button's 50% width was never reclaimed). So when
    // `axis` is known, that axis must be numeric - otherwise this is a
    // compile error, not a layout bug for someone to find by playing.
    gated(index, control, node, axis) {
        const { size, anchor_from, anchor_to, offset, layer, ...rest } = control;
        const [w, h] = size;
        let hug, orientation, wrapSize, gateSize;
        if (axis) {
            const foldWidth = axis === "horizontal";
            const fold = foldWidth ? w : h;
            if (typeof fold !== "number") {
                this.err(node, `an if=""/each item here sits in a ${axis === "horizontal" ? "row or grid" : "column or scroll"}, so its ${foldWidth ? "width" : "height"} must be a plain pixel number (it's "${fold}") - a percentage/fill size can't be hidden without leaving its space behind`);
            }
            hug = true;
            orientation = axis;
            wrapSize = foldWidth ? ["100%c", h] : [w, "100%c"];
            gateSize = foldWidth ? [fold, typeof h === "number" ? h : "100%"] : [typeof w === "number" ? w : "100%", fold];
        } else {
            // Not flowing past anything - fold along whichever axis has a
            // fixed pixel size anyway (harmless, keeps old behavior exactly).
            hug = typeof w === "number" || typeof h === "number";
            orientation = typeof h === "number" ? "vertical" : "horizontal";
            wrapSize = [typeof w === "number" ? "100%c" : w, typeof h === "number" ? "100%c" : h];
            gateSize = [typeof w === "number" ? w : "100%", typeof h === "number" ? h : "100%"];
        }
        const wrap = { type: "stack_panel", orientation, size: hug ? wrapSize : size, collection_name: COLLECTION };
        if (anchor_from) Object.assign(wrap, { anchor_from, anchor_to });
        if (offset) wrap.offset = offset;
        if (layer !== undefined) wrap.layer = layer;
        return {
            ...wrap,
            controls: [{
                gate: {
                    type: "panel",
                    size: hug ? gateSize : ["100%", "100%"],
                    collection_index: index,
                    visible: "#visible",
                    property_bag: { "#visible": false },
                    bindings: [
                        this.collectionRead("#form_button_text", "#vis_value"),
                        { binding_type: "view", source_property_name: "(#vis_value = '1')", target_property_name: "#visible", binding_condition: "always" },
                    ],
                    controls: [{ v: { ...rest, size: ["100%", "100%"] } }],
                },
            }],
        };
    }

    // ---- dynamic values: FORM mode (one form entry each) ------------------------------
    dynText(label, index) {
        return this.indexed(index, { ...label, text: "#form_button_text", bindings: [this.collectionRead()] });
    }
    dynTex(img, index) {
        return this.indexed(index, {
            ...img,
            allow_debug_missing_texture: false,
            bindings: [
                this.collectionRead("#form_button_texture", "#texture"),
                this.collectionRead("#form_button_texture_file_system", "#texture_file_system"),
            ],
        });
    }
    dynBar(fill, index, h, pad) {
        const f = {
            ...fill,
            bindings: [
                this.collectionRead(),
                { binding_type: "view", source_property_name: "(#form_button_text - 0)", target_property_name: "#size_binding_x", binding_condition: "always" },
                { binding_type: "view", source_property_name: `((#form_button_text = #form_button_text) * ${h})`, target_property_name: "#size_binding_y", binding_condition: "always" },
            ],
        };
        return {
            track: {
                type: "stack_panel", orientation: "vertical", size: ["100%", "100%"], collection_name: COLLECTION,
                controls: [{
                    cell: {
                        type: "panel", size: ["100%", "100%"], collection_index: index,
                        controls: [{ unit: { type: "panel", size: [1, 1], anchor_from: "left_middle", anchor_to: "left_middle", offset: [pad, 0], controls: [{ fill: f }] } }],
                    },
                }],
            },
        };
    }
    gate(index, control, node, axis) { return this.gated(index, control, node, axis); }
    pressAllowed() { return true; }

    // ---- elements ------------------------------------------------------------------------
    // Returns an array of [name, control] (each="" expands to several).
    // `axis` is the immediate parent stack's direction (see gated() above) -
    // callers that actually flow their children (row/column/grid/scroll,
    // button content) pass it; a bare panel/screen leaves it null.
    emit(node, loops, axis = null) {
        if (node.text !== undefined) this.err(node, `stray text "${node.text}" - put text inside <text>`);
        if (node.tag === "use") return this.use(node, loops, axis);
        if (!TAGS.has(node.tag)) this.err(node, `unknown element <${node.tag}> (known: ${[...TAGS].join(", ")}, use)`);

        if (node.attrs.each && !node._expanded) {
            const m = /^\s*([A-Za-z_]\w*)(?:\s*,\s*([A-Za-z_]\w*))?\s+in\s+(.+)$/.exec(String(node.attrs.each));
            if (!m) this.err(node, `each="${node.attrs.each}" - write each="item in list" (or "item, i in list")`);
            const max = parseInt(node.attrs.max ?? "", 10);
            if (!(max > 0)) this.err(node, `each= needs max="N" - a compiled screen reserves room for at most N items`);
            const listAst = parseExpr(m[3], this.file, node.line);
            const out = [];
            for (let k = 0; k < max; k++) {
                const clone = { ...node, _expanded: true };
                const loop = [m[1], listAst, k];
                if (m[2]) loop.push(m[2]);
                out.push(...this.emit(clone, [...loops, loop], axis));
            }
            return out;
        }

        const st = this.style(node);
        let control = this.element(node, st, loops);

        // Presence of an each-instance and/or an if="" condition -> one visibility entry.
        const conds = [];
        const loop = node._expanded ? loops[loops.length - 1] : null;
        if (loop) conds.push(["bin", "<", ["num", loop[2]], ["filter", "len", loop[1], []]]);
        if (node.attrs.if) conds.push(parseExpr(String(node.attrs.if), this.file, node.line));
        if (conds.length) {
            const e = conds.reduce((a, b) => ["bin", "&&", a, b]);
            control = this.gate(this.field({ k: "vis", e, loops }), control, node, axis);
        }
        return [[this.name(node.tag.slice(0, 3)), control]];
    }

    // <use t="name" var="value"/> pastes <template id="name">'s children,
    // with every $var in their attributes and text replaced (unset -> "").
    use(node, loops, axis = null) {
        const tpl = this.templates?.[node.attrs.t];
        if (!tpl) this.err(node, `<use t="${node.attrs.t}"> - no <template id="${node.attrs.t}"> (templates: ${Object.keys(this.templates ?? {}).join(", ") || "none"})`);
        const sub = v => String(v).replace(/\$([A-Za-z_]\w*)/g, (_, k) => (node.attrs[k] === undefined ? "" : String(node.attrs[k])));
        const clone = n => (n.text !== undefined
            ? { ...n, text: sub(n.text) }
            : { ...n, attrs: Object.fromEntries(Object.entries(n.attrs).map(([k, v]) => [k, typeof v === "string" ? sub(v) : v])), children: n.children.map(clone) });
        const out = [];
        for (const c of tpl.children) {
            if (c.text !== undefined) continue;
            out.push(...this.emit(clone(c), loops, axis));
        }
        return out;
    }

    // `axis`: pass "horizontal"/"vertical" when `node`'s children actually
    // flow one after another (row/column/grid/scroll, button content);
    // leave null for a bare panel/screen, whose children are independently
    // anchored and never need to collapse (see gated()).
    children(node, loops, axis = null) {
        const out = [];
        for (const c of node.children) {
            if (c.text !== undefined) this.err(c, `stray text "${c.text}" in <${node.tag}> - put text inside <text>`);
            out.push(...this.emit(c, loops, axis));
        }
        return out;
    }

    withGap(entries, gap, horizontal) {
        if (!gap) return entries.map(([n, c]) => ({ [n]: c }));
        const out = [];
        entries.forEach(([n, c], i) => {
            if (i > 0) out.push({ [this.name("gap")]: { type: "panel", size: horizontal ? [gap, "100%"] : ["100%", gap] } });
            out.push({ [n]: c });
        });
        return out;
    }

    background(st, node) {
        if (st.background || st["background-color"]) {
            const img = { type: "image", texture: st.background ?? "textures/ui/White" };
            if (st["background-color"]) img.color = hexColor(st["background-color"], m => this.err(node, m));
            if (st.nineslice) img.nineslice_size = parseInt(st.nineslice, 10);
            if (st["background-opacity"]) img.alpha = parseFloat(st["background-opacity"]);
            return img;
        }
        return null;
    }

    // Container: optional background image around a layout panel/stack with padding.
    container(node, st, loops, layoutCtl, childControls) {
        const place = this.placement(st, node);
        const pad = st.padding ? parseFloat(st.padding) : 0;
        const bg = this.background(st, node);
        const inner = { ...layoutCtl, controls: childControls };
        const [w, h] = place.size;
        inner.size = [w === "100%c" ? "100%c" : (pad ? subPx("100%", pad * 2) : "100%"), h === "100%c" ? "100%c" : (pad ? subPx("100%", pad * 2) : "100%")];
        if (!bg && !pad) return { ...place, ...inner, size: place.size };
        const outer = { ...(bg ?? { type: "panel" }), ...place };
        if (pad) outer.size = [w === "100%c" ? addPx("100%c", pad * 2) : w, h === "100%c" ? addPx("100%c", pad * 2) : h];
        outer.controls = [{ inner }];
        return outer;
    }

    element(node, st, loops) {
        const e = m => this.err(node, m);
        const gap = st.gap ? parseFloat(st.gap) : 0;
        switch (node.tag) {
            case "screen":
            case "panel":
                return this.container(node, st, loops, { type: "panel" }, this.children(node, loops).map(([n, c]) => ({ [n]: c })));
            case "row":
            case "column": {
                const horizontal = node.tag === "row";
                return this.container(node, st, loops, { type: "stack_panel", orientation: horizontal ? "horizontal" : "vertical" },
                    this.withGap(this.children(node, loops, horizontal ? "horizontal" : "vertical"), gap, horizontal));
            }
            case "grid": {
                const cols = parseInt(node.attrs.columns ?? "", 10);
                if (!(cols > 0)) e(`<grid> needs columns="N"`);
                const cells = this.children(node, loops, "horizontal"); // each cell ends up in a horizontal row
                const rows = [];
                for (let i = 0; i < cells.length; i += cols) {
                    rows.push([this.name("row"), { type: "stack_panel", orientation: "horizontal", size: ["100%", "100%c"], controls: this.withGap(cells.slice(i, i + cols), gap, true) }]);
                }
                return this.container(node, st, loops, { type: "stack_panel", orientation: "vertical" }, this.withGap(rows, gap, false));
            }
            case "scroll": {
                const defName = this.name("scroll_");
                this.defs[`${this.key}_${defName}`] = {
                    type: "stack_panel", orientation: "vertical", size: ["100% - 4px", "100%c"],
                    anchor_from: "top_left", anchor_to: "top_left",
                    controls: this.withGap(this.children(node, loops, "vertical"), gap, false),
                };
                const place = this.placement(st, node);
                return {
                    type: "panel", ...place,
                    controls: [{
                        [`${defName}@common.scrolling_panel`]: {
                            anchor_to: "top_left", anchor_from: "top_left",
                            $show_background: false,
                            size: ["100%", "100%"],
                            $scrolling_content: `${this.ns}.${this.key}_${defName}`,
                            $scroll_size: [5, "100% - 4px"],
                            $scrolling_pane_size: ["100% - 4px", "100% - 2px"],
                            $scrolling_pane_offset: [2, 0],
                            $scroll_bar_right_padding_size: [0, 0],
                        },
                    }],
                };
            }
            case "spacer":
                return { type: "panel", ...this.placement(st, node) };
            case "text": {
                const raw = node.children.map(c => (c.text !== undefined ? c.text : e("<text> may only contain text"))).join(" ");
                const parts = parseTemplate(raw, this.file, node.line);
                const scale = st["font-scale"] ? parseFloat(st["font-scale"]) : 1;
                const fontSize = st["font-size"] ?? "normal";
                if (!FONT_HEIGHT[fontSize]) e(`font-size "${fontSize}" - use small, normal, large or extra_large`);
                const lines = st.lines ? parseInt(st.lines, 10) : 1;
                const lineH = Math.ceil(FONT_HEIGHT[fontSize] * scale);
                const place = this.placement({ ...st, height: st.height ?? String(lineH * lines) }, node);
                const label = {
                    type: "label", ...place,
                    color: hexColor(st.color ?? "#ffffff", e),
                    font_size: fontSize,
                    localize: false,
                    shadow: st.shadow === "true",
                };
                if (scale !== 1) label.font_scale_factor = scale;
                if (st["text-align"]) label.text_alignment = st["text-align"];
                if (isStaticTemplate(parts)) return { ...label, text: parts.map(p => p[1]).join("") };
                return this.dynText(label, this.field({ k: "text", t: parts, loops }));
            }
            case "image":
            case "portrait": {
                const src = String(node.attrs.src ?? "");
                if (!src) e(`<${node.tag}> needs src="..."`);
                const parts = parseTemplate(src, this.file, node.line);
                const img = { type: "image", ...this.placement(st, node) };
                if (st.color) img.color = hexColor(st.color, e);
                if (st.nineslice) img.nineslice_size = parseInt(st.nineslice, 10);
                if (isStaticTemplate(parts)) return { ...img, texture: parts.map(p => p[1]).join("") };
                return this.dynTex(img, this.field({ k: "tex", t: parts, loops }));
            }
            case "bar": {
                const place = this.placement(st, node);
                const [w, h] = place.size;
                if (typeof w !== "number" || typeof h !== "number") e(`<bar> needs a pixel width and height`);
                if (!node.attrs.value) e(`<bar> needs value="{expr}" (0-100)`);
                const pad = st.padding !== undefined ? parseFloat(st.padding) : 1;
                const inner = w - pad * 2;
                const frame = { ...this.background(st, node), ...place };
                const fill = {
                    type: "image", texture: st["bar-texture"] ?? "textures/ui/White",
                    color: hexColor(st["bar-color"], e),
                    anchor_from: "left_middle", anchor_to: "left_middle",
                    size: [0, h - pad * 2],
                };
                const valueAst = parseTemplate(String(node.attrs.value), this.file, node.line).find(p => p[0] === "e")?.[1];
                if (!valueAst) e(`<bar value="..."> must be an expression in {braces}`);
                const index = this.field({ k: "bar", e: valueAst, px: inner, loops });
                frame.controls = [this.dynBar(fill, index, h - pad * 2, pad)];
                return frame;
            }
            case "button": {
                if (!this.pressAllowed()) e("<button> isn't possible on a HUD (the HUD never takes clicks)");
                const action = node.attrs["on:press"];
                if (!action) e(`<button> needs on:press="..."`);
                const place = this.placement(st, node);
                const stateImg = key => {
                    const img = { type: "image", size: ["100%", "100%"], texture: st[key] ?? st.background };
                    if (st.nineslice) img.nineslice_size = parseInt(st.nineslice, 10);
                    const colorKey = key === "background" ? "background-color" : key.replace("background", "background-color");
                    if (st[colorKey]) img.color = hexColor(st[colorKey], e);
                    return img;
                };
                const press = this.field({ k: "press", a: splitActions(String(action)).map(a => parseAction(a, this.file, node.line)), loops });
                const btn = {
                    type: "button", size: ["100%", "100%"],
                    sound_name: "random.click", sound_volume: 1.0,
                    focus_enabled: true, focus_magnet_enabled: true,
                    default_control: "default", hover_control: "hover", pressed_control: "pressed", locked_control: "",
                    button_mappings: [
                        { from_button_id: "button.menu_select", to_button_id: "button.form_button_click", mapping_type: "pressed" },
                        { from_button_id: "button.menu_ok", to_button_id: "button.form_button_click", mapping_type: "focused" },
                    ],
                    bindings: [{ binding_type: "collection_details", binding_collection_name: COLLECTION }],
                    controls: [
                        { default: stateImg("background") },
                        { hover: stateImg("hover-background") },
                        { pressed: stateImg("pressed-background") },
                    ],
                };
                // Content draws as a sibling ABOVE the button (labels/images
                // don't take input, so presses still reach the button).
                const pad = st.padding ? parseFloat(st.padding) : 0;
                const horizontal = (st.direction ?? "column") === "row";
                const content = {
                    type: "stack_panel", orientation: horizontal ? "horizontal" : "vertical", layer: 2,
                    size: [subPx("100%", pad * 2), subPx("100%", pad * 2)],
                    controls: this.withGap(this.children(node, loops, horizontal ? "horizontal" : "vertical"), st.gap ? parseFloat(st.gap) : 0, horizontal),
                };
                return {
                    type: "panel", ...place,
                    controls: [
                        { press: { type: "stack_panel", size: ["100%", "100%"], collection_name: COLLECTION, controls: [{ cell: { type: "panel", size: ["100%", "100%"], collection_index: press, controls: [{ b: btn }] } }] } },
                        { content },
                    ],
                };
            }
            default:
                return e(`unhandled <${node.tag}>`);
        }
    }
}

// ---- HUD mode ---------------------------------------------------------------------------
// A HUD value can't ride a form: it rides the TITLE channel. Each value has
// its own key (`ocH|<hud>.<n>|`); the runtime sends `key + value` titles, one
// per tick per player (two titles in one tick: only the last is seen, UI-0),
// and a "preserved title" data control inside the element keeps the last
// value it saw for its key (wiki: preserve-title-texts, proven in UI-0).
const HUD_HEADER = "ocH|";

class HudCompiler extends ScreenCompiler {
    constructor(...a) { super(...a); this.ns = "oc_hud"; }
    hudKey(index) { return `${HUD_HEADER}${this.key}.${index}|`; }

    data(index) {
        const key = this.hudKey(index);
        return {
            d: {
                type: "panel", size: [0, 0],
                property_bag: { "#preserved_text": "" },
                bindings: [
                    { binding_name: "#hud_title_text_string" },
                    { binding_name: "#hud_title_text_string", binding_name_override: "#preserved_text", binding_condition: "visibility_changed" },
                    {
                        binding_type: "view",
                        source_property_name: `(not (#hud_title_text_string = #preserved_text) and not ((#hud_title_text_string - '${key}') = #hud_title_text_string))`,
                        target_property_name: "#visible",
                    },
                ],
            },
        };
    }
    read(index, target, expr) {
        return { binding_type: "view", source_control_name: "d", source_property_name: expr ?? `(#preserved_text - '${this.hudKey(index)}')`, target_property_name: target };
    }

    dynText(label, index) {
        return { ...label, text: "#text", controls: [this.data(index)], bindings: [this.read(index, "#text")] };
    }
    dynTex(img, index) {
        return { ...img, allow_debug_missing_texture: false, controls: [this.data(index)], bindings: [this.read(index, "#texture")] };
    }
    dynBar(fill, index, h, pad) {
        const key = this.hudKey(index);
        const f = {
            ...fill,
            controls: [this.data(index)],
            bindings: [
                this.read(index, "#size_binding_x", `((#preserved_text - '${key}') - 0)`),
                this.read(index, "#size_binding_y", `((#preserved_text = #preserved_text) * ${h})`),
            ],
        };
        return { unit: { type: "panel", size: [1, 1], anchor_from: "left_middle", anchor_to: "left_middle", offset: [pad, 0], controls: [{ fill: f }] } };
    }
    // The data control sits BESIDE the gated content: a hidden subtree
    // wouldn't keep catching its own updates. Same axis-fold requirement as
    // ScreenCompiler.gated() (see its comment) applies to a HUD
    // row/column of each=""/if="" elements.
    gate(index, control, node, axis) {
        const { size, anchor_from, anchor_to, offset, layer, ...rest } = control;
        const [w, h] = size;
        let wrap, innerSize;
        if (axis) {
            const foldWidth = axis === "horizontal";
            const fold = foldWidth ? w : h;
            if (typeof fold !== "number") {
                this.err(node, `an if=""/each item here sits in a HUD ${axis === "horizontal" ? "row" : "column"}, so its ${foldWidth ? "width" : "height"} must be a plain pixel number (it's "${fold}") - a percentage/fill size can't be hidden without leaving its space behind`);
            }
            wrap = { type: "stack_panel", orientation: axis, size: foldWidth ? ["100%c", h] : [w, "100%c"] };
            innerSize = foldWidth ? [fold, typeof h === "number" ? h : "100%"] : [typeof w === "number" ? w : "100%", fold];
        } else {
            wrap = { type: "panel", size };
            innerSize = ["100%", "100%"];
        }
        if (anchor_from) Object.assign(wrap, { anchor_from, anchor_to });
        if (offset) wrap.offset = offset;
        if (layer !== undefined) wrap.layer = layer;
        const key = this.hudKey(index);
        return {
            ...wrap,
            controls: [
                this.data(index),
                {
                    g: {
                        ...rest, size: innerSize,
                        visible: "#visible",
                        property_bag: { "#visible": false },
                        bindings: [{
                            binding_type: "view", source_control_name: "d", resolve_sibling_scope: true,
                            source_property_name: `((#preserved_text - '${key}') = '1')`, target_property_name: "#visible",
                        }],
                    },
                },
            ],
        };
    }
    pressAllowed() { return false; }
}

// ---- entry point ---------------------------------------------------------------------
// files: [{ rel, text }] for *.ui.html and *.ui.css under PATCHES/ui.
function compileUi(files) {
    const rules = [];
    for (const f of files.filter(f => f.rel.endsWith(".ui.css"))) rules.push(...parseCss(f.text, `ui/${f.rel}`));

    const screens = {};
    const huds = {};
    const hudUi = { namespace: "oc_hud", root: { type: "panel", size: ["100%", "100%"], controls: [] } };
    const jsonUi = { namespace: NS, root: { type: "panel", size: ["100%", "100%"], controls: [] } };
    const docs = files.filter(f => f.rel.endsWith(".ui.html")).map(f => ({ file: `ui/${f.rel}`, doc: parseMarkup(f.text, `ui/${f.rel}`) }));
    const templates = {};
    for (const { file, doc } of docs) {
        for (const top of doc.children) {
            if (top.tag !== "template") continue;
            const id = String(top.attrs.id ?? "");
            if (!id) throw new UiSyntaxError(file, top.line, "<template> needs an id");
            if (templates[id]) throw new UiSyntaxError(file, top.line, `template "${id}" is defined twice`);
            templates[id] = top;
        }
    }
    for (const { file, doc } of docs) {
        for (const top of doc.children) {
            if (top.text !== undefined) throw new UiSyntaxError(file, top.line, "text outside <screen>");
            if (top.tag === "template") continue;
            if (top.tag === "hud") { compileHud(top, file, rules, huds, hudUi, templates); continue; }
            if (top.tag !== "screen") throw new UiSyntaxError(file, top.line, `top-level elements must be <screen>, <hud> or <template>, got <${top.tag}>`);
            const key = String(top.attrs.id ?? "");
            if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new UiSyntaxError(file, top.line, `<screen id="${key}"> - ids are lowercase letters, digits, _`);
            if (screens[key]) throw new UiSyntaxError(file, top.line, `screen "${key}" is defined twice`);

            const c = new ScreenCompiler(key, file, rules);
            c.templates = templates;
            const [[, control]] = c.emit(top, []);
            jsonUi[`screen_${key}`] = control;
            Object.assign(jsonUi, c.defs);
            jsonUi.root.controls.push({
                [`gate_${key}`]: {
                    type: "collection_panel",
                    size: ["100%", "100%"],
                    factory: { name: `oc_gate_${key}`, control_name: `@${NS}.screen_${key}` },
                    bindings: [
                        { binding_name: "#title_text" },
                        {
                            binding_type: "view",
                            source_property_name: `((not ((#title_text - '${HEADER}${key}|') = #title_text)) * 1)`,
                            target_property_name: "#collection_length",
                        },
                    ],
                },
            });
            screens[key] = {
                params: String(top.attrs.params ?? "").split(",").map(s => s.trim()).filter(Boolean),
                provider: top.attrs.data ? String(top.attrs.data) : null,
                fields: c.fields,
            };
        }
    }
    return {
        rp: { "ui/openchara/screens.json": jsonUi, "ui/openchara/hud.json": hudUi },
        runtime: `// GENERATED by OpenChara UI compiler from PATCHES/ui - do not edit.\n` +
            `export const UI_HEADER = ${JSON.stringify(HEADER)};\n` +
            `export const SCREENS = ${JSON.stringify(screens)};\n` +
            `export const HUD_HEADER = ${JSON.stringify(HUD_HEADER)};\n` +
            `export const HUDS = ${JSON.stringify(huds)};\n`,
        stats: Object.fromEntries(Object.entries(screens).map(([k, s]) => [k, s.fields.length])),
    };
}

// <hud id="..." data="provider"> - its root sits in the HUD behind an
// implicit visibility key (<id>.0) the runtime drives from the player's
// HUD settings, so any HUD can be switched off per player.
function compileHud(top, file, rules, huds, hudUi, templates) {
    const key = String(top.attrs.id ?? "");
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new UiSyntaxError(file, top.line, `<hud id="${key}"> - ids are lowercase letters, digits, _`);
    if (huds[key]) throw new UiSyntaxError(file, top.line, `hud "${key}" is defined twice`);
    const c = new HudCompiler(key, file, rules);
    c.templates = templates;
    const rootIndex = c.field({ k: "vis", e: ["bool", true], root: true, loops: [] });
    const [[, control]] = c.emit({ ...top, tag: "panel" }, []);
    hudUi[`hud_${key}`] = c.gate(rootIndex, control);
    Object.assign(hudUi, c.defs);
    hudUi.root.controls.push({ [`h_${key}`]: { type: "panel", size: ["100%", "100%"], controls: [{ [`content@oc_hud.hud_${key}`]: {} }] } });
    huds[key] = { provider: top.attrs.data ? String(top.attrs.data) : null, fields: c.fields };
}

module.exports = { compileUi, HEADER, HUD_HEADER };
