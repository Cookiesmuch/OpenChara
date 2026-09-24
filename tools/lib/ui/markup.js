// OpenChara UI language - parsers for screen markup (*.ui.html), stylesheets
// (*.ui.css) and the small expression language used inside {braces},
// if="", each="" and on:press="". Plain Node, no dependencies. Every error
// carries file:line so a PATCHES author can find it.

"use strict";

class UiSyntaxError extends Error {
    constructor(file, line, msg) { super(`${file}:${line}: ${msg}`); }
}

// ---- markup ---------------------------------------------------------------------
// An HTML subset: elements, attributes (quoted or bare), text, comments,
// self-closing tags. Returns { tag, attrs, children: [node | { text }], line }.
function parseMarkup(src, file) {
    let i = 0, line = 1;
    const root = { tag: "#root", attrs: {}, children: [], line: 1 };
    const stack = [root];
    const adv = n => { for (let k = 0; k < n; k++) if (src[i + k] === "\n") line++; i += n; };
    const err = m => { throw new UiSyntaxError(file, line, m); };

    while (i < src.length) {
        if (src.startsWith("<!--", i)) {
            const end = src.indexOf("-->", i + 4);
            if (end < 0) err("unclosed comment");
            adv(end + 3 - i);
            continue;
        }
        if (src.startsWith("</", i)) {
            const end = src.indexOf(">", i);
            if (end < 0) err("unclosed tag");
            const name = src.slice(i + 2, end).trim();
            const open = stack.pop();
            if (!open || open.tag !== name) err(`</${name}> closes <${open?.tag}> (opened line ${open?.line})`);
            adv(end + 1 - i);
            continue;
        }
        if (src[i] === "<") {
            const startLine = line;
            adv(1);
            const nameMatch = /^[a-zA-Z][\w-]*/.exec(src.slice(i));
            if (!nameMatch) err("expected a tag name after <");
            const tag = nameMatch[0];
            adv(tag.length);
            const attrs = {};
            for (;;) {
                while (/\s/.test(src[i] ?? "")) adv(1);
                if (i >= src.length) err(`unclosed <${tag}>`);
                if (src.startsWith("/>", i)) { adv(2); stack[stack.length - 1].children.push({ tag, attrs, children: [], line: startLine }); break; }
                if (src[i] === ">") {
                    adv(1);
                    const node = { tag, attrs, children: [], line: startLine };
                    stack[stack.length - 1].children.push(node);
                    stack.push(node);
                    break;
                }
                const an = /^[a-zA-Z_:@][\w:.-]*/.exec(src.slice(i));
                if (!an) err(`bad attribute in <${tag}>`);
                adv(an[0].length);
                while (/\s/.test(src[i] ?? "")) adv(1);
                let value = true;
                if (src[i] === "=") {
                    adv(1);
                    while (/\s/.test(src[i] ?? "")) adv(1);
                    const q = src[i];
                    if (q === '"' || q === "'") {
                        const end = src.indexOf(q, i + 1);
                        if (end < 0) err(`unclosed attribute value for ${an[0]}`);
                        value = src.slice(i + 1, end);
                        adv(end + 1 - i);
                    } else {
                        const bare = /^[^\s>]+/.exec(src.slice(i));
                        value = bare[0];
                        adv(bare[0].length);
                    }
                }
                attrs[an[0]] = value;
            }
            continue;
        }
        const next = src.indexOf("<", i);
        const text = src.slice(i, next < 0 ? src.length : next);
        if (text.trim()) stack[stack.length - 1].children.push({ text: text.replace(/\s+/g, " ").trim(), line });
        adv(text.length);
    }
    if (stack.length > 1) throw new UiSyntaxError(file, stack[stack.length - 1].line, `<${stack[stack.length - 1].tag}> is never closed`);
    return root;
}

// ---- stylesheets -----------------------------------------------------------------------
// Rules: `selector, selector { prop: value; ... }`. Selectors: `tag`, `.class`,
// `#id`, or `tag.class`. Returns [{ selectors: [{tag, classes, id}], decls, order }].
function parseCss(src, file) {
    const rules = [];
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) {
        const line = clean.slice(0, m.index).split("\n").length;
        const selectors = m[1].split(",").map(s => s.trim()).filter(Boolean).map(sel => {
            const sm = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)(#[\w-]+)?$/.exec(sel);
            if (!sm) throw new UiSyntaxError(file, line, `unsupported selector "${sel}" (use tag, .class, #id or tag.class)`);
            return { tag: sm[1] ?? null, classes: sm[2] ? sm[2].slice(1).split(".") : [], id: sm[3] ? sm[3].slice(1) : null };
        });
        rules.push({ selectors, decls: parseDecls(m[2]), line, file });
    }
    return rules;
}

function parseDecls(text) {
    const decls = {};
    for (const part of text.split(";")) {
        const k = part.indexOf(":");
        if (k < 0) continue;
        const prop = part.slice(0, k).trim().toLowerCase();
        const value = part.slice(k + 1).trim();
        if (prop) decls[prop] = value;
    }
    return decls;
}

// ---- expressions -------------------------------------------------------------------------
// AST (plain JSON, interpreted by the engine at runtime - no eval in game):
//   ["num", n] ["str", s] ["bool", b] ["null"] ["path", [seg...]]   seg = string | AST
//   ["not", x] ["neg", x] ["bin", op, a, b] ["filter", name, x, [args...]]
function parseExpr(src, file, line) {
    const toks = [];
    const re = /\s*(\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|==|!=|>=|<=|&&|\|\||[A-Za-z_$][\w$]*|[.()[\]+\-*/!<>|,:%])/y;
    let m, pos = 0;
    while (pos < src.length) {
        re.lastIndex = pos;
        m = re.exec(src);
        if (!m) { if (/^\s*$/.test(src.slice(pos))) break; throw new UiSyntaxError(file, line, `can't read expression "${src}" near "${src.slice(pos)}"`); }
        toks.push(m[1]);
        pos = re.lastIndex;
    }
    let k = 0;
    const peek = () => toks[k];
    const take = t => { if (t !== undefined && toks[k] !== t) throw new UiSyntaxError(file, line, `expected "${t}" in "${src}"`); return toks[k++]; };

    function primary() {
        const t = take();
        if (t === undefined) throw new UiSyntaxError(file, line, `unexpected end of "${src}"`);
        if (/^\d/.test(t)) return ["num", Number(t)];
        if (t[0] === "'" || t[0] === '"') return ["str", t.slice(1, -1).replace(/\\(.)/g, "$1")];
        if (t === "(") { const e = expr(); take(")"); return e; }
        if (t === "true" || t === "false") return ["bool", t === "true"];
        if (t === "null") return ["null"];
        if (/^[A-Za-z_$]/.test(t)) {
            const segs = [t];
            for (;;) {
                if (peek() === ".") { take("."); segs.push(take()); }
                else if (peek() === "[") { take("["); segs.push(expr()); take("]"); }
                else break;
            }
            return ["path", segs];
        }
        throw new UiSyntaxError(file, line, `unexpected "${t}" in "${src}"`);
    }
    function unary() {
        if (peek() === "!") { take(); return ["not", unary()]; }
        if (peek() === "-") { take(); return ["neg", unary()]; }
        return primary();
    }
    function mul() { let a = unary(); while (["*", "/", "%"].includes(peek())) { const op = take(); a = ["bin", op, a, unary()]; } return a; }
    function add() { let a = mul(); while (["+", "-"].includes(peek())) { const op = take(); a = ["bin", op, a, mul()]; } return a; }
    function cmp() { let a = add(); if (["==", "!=", ">=", "<=", ">", "<"].includes(peek())) { const op = take(); a = ["bin", op, a, add()]; } return a; }
    function and() { let a = cmp(); while (peek() === "&&") { take(); a = ["bin", "&&", a, cmp()]; } return a; }
    function or() { let a = and(); while (peek() === "||") { take(); a = ["bin", "||", a, and()]; } return a; }
    function expr() {
        let a = or();
        while (peek() === "|" ) {
            take("|");
            const name = take();
            const args = [];
            while (peek() === ":") { take(":"); args.push(unary()); }
            a = ["filter", name, a, args];
        }
        return a;
    }
    const ast = expr();
    if (k < toks.length) throw new UiSyntaxError(file, line, `unexpected "${toks[k]}" in "${src}"`);
    return ast;
}

// A text template: "Lv {c.level} - {t:roster.title}" ->
//   [["s","Lv "], ["e", AST], ["s"," - "], ["t", "roster.title", [argAST...]]]
// {t:key} is a translation key; {t:key:expr:expr} passes arguments (%1, %2...).
function parseTemplate(text, file, line) {
    const parts = [];
    let i = 0;
    while (i < text.length) {
        const open = text.indexOf("{", i);
        if (open < 0) { parts.push(["s", text.slice(i)]); break; }
        if (open > i) parts.push(["s", text.slice(i, open)]);
        const close = text.indexOf("}", open);
        if (close < 0) throw new UiSyntaxError(file, line, `unclosed { in "${text}"`);
        const inner = text.slice(open + 1, close).trim();
        if (inner.startsWith("t:")) {
            const [key, ...args] = inner.slice(2).split(":");
            parts.push(["t", key.trim(), args.map(a => parseExpr(a, file, line))]);
        } else {
            parts.push(["e", parseExpr(inner, file, line)]);
        }
        i = close + 1;
    }
    return parts;
}

const isStaticTemplate = parts => parts.every(p => p[0] === "s");

// Action: `open(profile, c.id)` / `back` / `call(myHandler, c.id)` ->
//   { fn, args: [AST...] }. A bare word as the first argument of open/call/set
//   is a name, not a data path.
function parseAction(src, file, line) {
    const m = /^\s*([A-Za-z_][\w.]*)\s*(?:\((.*)\))?\s*$/s.exec(src);
    if (!m) throw new UiSyntaxError(file, line, `bad action "${src}" - expected name or name(args)`);
    const args = [];
    if (m[2] && m[2].trim()) {
        let depth = 0, cur = "", q = null;
        for (const ch of m[2]) {
            if (q) { cur += ch; if (ch === q) q = null; continue; }
            if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
            if (ch === "(" || ch === "[") depth++;
            if (ch === ")" || ch === "]") depth--;
            if (ch === "," && depth === 0) { args.push(cur); cur = ""; continue; }
            cur += ch;
        }
        args.push(cur);
    }
    const NAME_FIRST = new Set(["open", "call", "set", "action", "toggle"]);
    return {
        fn: m[1],
        args: args.map((a, idx) => (idx === 0 && NAME_FIRST.has(m[1]) && /^\s*[A-Za-z_][\w.:-]*\s*$/.test(a))
            ? ["str", a.trim()]
            : parseExpr(a, file, line)),
    };
}

module.exports = { parseMarkup, parseCss, parseDecls, parseExpr, parseTemplate, parseAction, isStaticTemplate, UiSyntaxError };
