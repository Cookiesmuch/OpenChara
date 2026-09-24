// Generates the engine's placeholder container ("satchel") texture:
// engine/rp/textures/entity/oc_container.png (32x32, UV-box layout of
// engine/rp/models/entity/oc_container.geo.json). Projects can replace it
// with an overlay file of the same path.
//
//   node tools/make-satchel.js
"use strict";
const fs = require("fs");
const path = require("path");
const { createImage, encodePng, setPixel } = require("../../MinUI/lib/png.js");

const img = createImage(32, 32);
const leather = (x, y) => {
    const n = ((x * 7 + y * 13) % 5) - 2;
    return [118 + n * 3, 74 + n * 2, 42 + n, 255];
};
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setPixel(img, x, y, leather(x, y));
// darker flap region and strap
for (let y = 12; y < 21; y++) for (let x = 0; x < 22; x++) { const c = leather(x, y); setPixel(img, x, y, [c[0] - 28, c[1] - 20, c[2] - 12, 255]); }
for (let y = 21; y < 24; y++) for (let x = 0; x < 14; x++) setPixel(img, x, y, [70, 44, 26, 255]);
// stitching along the body edges
for (let x = 0; x < 26; x += 2) { setPixel(img, x, 5, [200, 170, 120, 255]); setPixel(img, x, 17, [200, 170, 120, 255]); }
// gold buckle
for (let y = 0; y < 3; y++) for (let x = 26; x < 32; x++) setPixel(img, x, y, (x + y) % 3 === 0 ? [246, 222, 160, 255] : [214, 182, 108, 255]);
const out = path.join(__dirname, "..", "engine", "rp", "textures", "entity", "oc_container.png");
fs.writeFileSync(out, encodePng(img));
console.log(`wrote ${out}`);
