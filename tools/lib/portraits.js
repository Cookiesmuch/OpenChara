// Automatic character portraits. For every character whose model and skin
// are in the project's resource pack, the build renders the model's FRONT
// view (every cube's north face, drawn back to front, inflated outer layers
// last) straight from the geometry file, then crops:
//
//   <id>_face.png  the head, for HUD slots and small cards
//   <id>_bust.png  head and shoulders, for profile screens
//
// written to textures/ui/oc_portraits/. A character can override either with
// real art by setting "portrait" / "bust" in characters/<id>.json. Works for
// any rig - nothing here knows bone names; the head is found as the highest
// cube. Bone rotations are ignored (a portrait is a straight-on front view).

"use strict";
const fs = require("fs");
const path = require("path");
const { decodePng, encodePng, createImage, blendPixel, getPixel, scaleImage } = require("./png.js");

function findGeometry(rpDir, identifier, walk) {
    for (const rel of walk(rpDir)) {
        if (!rel.endsWith(".json")) continue;
        let doc;
        try { doc = JSON.parse(fs.readFileSync(path.join(rpDir, rel), "utf8")); } catch (e) { continue; }
        for (const g of doc["minecraft:geometry"] ?? []) {
            if (g.description?.identifier === identifier) return g;
        }
    }
    return null;
}

// Every cube with a usable front (north) face: { x0, x1, y0, y1, z, inflate, uv, uvSize }.
function frontFaces(geo) {
    const faces = [];
    for (const bone of geo.bones ?? []) {
        for (const c of bone.cubes ?? []) {
            const north = c.uv?.north;
            if (!north || !c.origin || !c.size) continue;
            const [ow, oh] = north.uv_size ?? [0, 0];
            if (!ow || !oh) continue;
            const inf = c.inflate ?? 0;
            faces.push({
                x0: c.origin[0] - inf, x1: c.origin[0] + c.size[0] + inf,
                y0: c.origin[1] - inf, y1: c.origin[1] + c.size[1] + inf,
                z: c.origin[2] - inf, inflate: inf,
                uv: north.uv, uvSize: north.uv_size,
            });
        }
    }
    return faces;
}

// Renders faces into a canvas covering [minX,maxX]x[minY,maxY] model units at
// `ppu` pixels per unit. Screen x = model x (the character faces the viewer,
// so her right side - negative x - is on the viewer's left).
function renderFront(faces, tex, texScale, box, ppu) {
    const W = Math.ceil((box.maxX - box.minX) * ppu), H = Math.ceil((box.maxY - box.minY) * ppu);
    const img = createImage(W, H);
    const order = [...faces].sort((a, b) => (a.inflate - b.inflate) || (b.z - a.z));
    for (const f of order) {
        const px0 = Math.floor((f.x0 - box.minX) * ppu), px1 = Math.ceil((f.x1 - box.minX) * ppu);
        const py0 = Math.floor((box.maxY - f.y1) * ppu), py1 = Math.ceil((box.maxY - f.y0) * ppu);
        for (let py = Math.max(0, py0); py < Math.min(H, py1); py++) {
            for (let px = Math.max(0, px0); px < Math.min(W, px1); px++) {
                const tx = ((px + 0.5) / ppu + box.minX - f.x0) / (f.x1 - f.x0);
                const ty = ((py + 0.5) / ppu - (box.maxY - f.y1)) / (f.y1 - f.y0);
                if (tx < 0 || tx >= 1 || ty < 0 || ty >= 1) continue;
                const u = Math.floor((f.uv[0] + tx * f.uvSize[0]) * texScale);
                const v = Math.floor((f.uv[1] + ty * f.uvSize[1]) * texScale);
                blendPixel(img, px, py, getPixel(tex, u, v));
            }
        }
    }
    return img;
}

// A skin's normal texture has transparent HOLES where its emissive parts
// (eyes, glowing trims) go; the emissive texture is the complete one. So the
// portrait source is the emissive texture with the normal one laid over it.
function skinForPortrait(rpDir, c, texFile) {
    const normal = decodePng(fs.readFileSync(texFile));
    const emissiveFile = c.emissiveTexture ? path.join(rpDir, `${c.emissiveTexture}.png`) : null;
    if (!emissiveFile || !fs.existsSync(emissiveFile)) return normal;
    const base = decodePng(fs.readFileSync(emissiveFile));
    if (base.width !== normal.width || base.height !== normal.height) return normal;
    for (let y = 0; y < normal.height; y++) for (let x = 0; x < normal.width; x++) blendPixel(base, x, y, getPixel(normal, x, y));
    return base;
}

function crop(img, x, y, w, h) {
    const out = createImage(w, h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const p = getPixel(img, x + xx, y + yy);
        const i = (yy * w + xx) * 4;
        out.data[i] = p[0]; out.data[i + 1] = p[1]; out.data[i + 2] = p[2]; out.data[i + 3] = p[3];
    }
    return out;
}

// Renders `box` (model units) and scales it up to roughly `targetPx` tall.
function shot(faces, tex, texScale, box, targetPx) {
    const ppu = 2 * texScale; // half-unit precision for 0.5 inflation
    const img = renderFront(faces, tex, texScale, box, ppu);
    const factor = Math.max(1, Math.round(targetPx / img.height));
    return scaleImage(img, factor);
}

/**
 * Generates portraits for every character it can. Returns
 * { files: Map<rpRelPath, Buffer>, paths: { id: { portrait, bust } }, notes: [] }.
 */
function generatePortraits(project, characters, walk) {
    const rpDir = path.join(project.patchesDir, "rp");
    const files = new Map(), paths = {}, notes = [];
    const geoCache = new Map();
    for (const c of Object.values(characters)) {
        const geoId = c.geometry ?? project.character.geometry;
        if (!geoCache.has(geoId)) geoCache.set(geoId, findGeometry(rpDir, geoId, walk));
        const geo = geoCache.get(geoId);
        const texFile = path.join(rpDir, `${c.texture}.png`);
        if (!geo || !fs.existsSync(texFile)) { notes.push(`${c.id}: no ${geo ? "texture" : `geometry "${geoId}"`} in PATCHES/rp - no auto portrait`); continue; }
        let tex;
        try { tex = skinForPortrait(rpDir, c, texFile); } catch (e) { notes.push(`${c.id}: ${e.message}`); continue; }
        const texScale = tex.width / (geo.description?.texture_width ?? tex.width);
        const faces = frontFaces(geo);
        if (!faces.length) { notes.push(`${c.id}: geometry has no front faces`); continue; }

        // Head = the non-inflated cube reaching highest.
        const head = faces.filter(f => f.inflate === 0).sort((a, b) => b.y1 - a.y1)[0];
        const hx0 = head.x0, hx1 = head.x1, hy0 = head.y0, hy1 = head.y1;
        const headW = hx1 - hx0, headH = hy1 - hy0;
        const faceBox = { minX: hx0 - 1, maxX: hx1 + 1, minY: hy0 - 1, maxY: hy1 + 1 };
        const bustBox = { minX: hx0 - headW * 0.5, maxX: hx1 + headW * 0.5, minY: hy0 - headH * 1.1, maxY: hy1 + 1 };

        const base = `textures/ui/oc_portraits/${c.id}`;
        files.set(`${base}_face.png`, encodePng(shot(faces, tex, texScale, faceBox, 64)));
        files.set(`${base}_bust.png`, encodePng(shot(faces, tex, texScale, bustBox, 96)));
        paths[c.id] = { portrait: `${base}_face`, bust: `${base}_bust` };
    }
    return { files, paths, notes };
}

module.exports = { generatePortraits, frontFaces, renderFront };
