// Minimal PNG decode/encode on Node's zlib - no npm dependencies. Enough for
// the build's generated art (portraits, UI kits): 8-bit non-interlaced PNGs
// of every color type in, RGBA out.
//
//   const img = decodePng(buffer)   -> { width, height, data: Uint8Array RGBA }
//   const buf = encodePng(img)
//   const img = createImage(w, h)   -> transparent RGBA canvas

"use strict";
const zlib = require("zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf) {
    if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
    let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
    let palette = null, trns = null;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString("ascii", pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === "IHDR") {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            depth = data[8]; colorType = data[9]; interlace = data[12];
        } else if (type === "PLTE") palette = data;
        else if (type === "tRNS") trns = data;
        else if (type === "IDAT") idat.push(data);
        else if (type === "IEND") break;
        pos += 12 + len;
    }
    if (interlace) throw new Error("interlaced PNGs are not supported");
    if (depth !== 8) throw new Error(`only 8-bit PNGs are supported (got ${depth}-bit)`);
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const px = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const out = px.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? out[i - channels] : 0;
            const b = prev ? prev[i] : 0;
            const c = prev && i >= channels ? prev[i - channels] : 0;
            let v = line[i];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) v += paeth(a, b, c);
            out[i] = v & 255;
        }
    }

    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
        const s = i * channels;
        switch (colorType) {
            case 6: rgba[j] = px[s]; rgba[j + 1] = px[s + 1]; rgba[j + 2] = px[s + 2]; rgba[j + 3] = px[s + 3]; break;
            case 2: rgba[j] = px[s]; rgba[j + 1] = px[s + 1]; rgba[j + 2] = px[s + 2]; rgba[j + 3] = 255; break;
            case 0: rgba[j] = rgba[j + 1] = rgba[j + 2] = px[s]; rgba[j + 3] = 255; break;
            case 4: rgba[j] = rgba[j + 1] = rgba[j + 2] = px[s]; rgba[j + 3] = px[s + 1]; break;
            case 3: {
                const k = px[s];
                rgba[j] = palette[k * 3]; rgba[j + 1] = palette[k * 3 + 1]; rgba[j + 2] = palette[k * 3 + 2];
                rgba[j + 3] = trns && k < trns.length ? trns[k] : 255;
                break;
            }
        }
    }
    return { width, height, data: rgba };
}

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

function encodePng({ width, height, data }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function createImage(width, height) {
    return { width, height, data: new Uint8Array(width * height * 4) };
}

function getPixel(img, x, y) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return [0, 0, 0, 0];
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

// Alpha-composites [r,g,b,a] over the pixel at (x, y).
function blendPixel(img, x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height || a === 0) return;
    const i = (y * img.width + x) * 4;
    const sa = a / 255, da = img.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    img.data[i] = Math.round((r * sa + img.data[i] * da * (1 - sa)) / oa);
    img.data[i + 1] = Math.round((g * sa + img.data[i + 1] * da * (1 - sa)) / oa);
    img.data[i + 2] = Math.round((b * sa + img.data[i + 2] * da * (1 - sa)) / oa);
    img.data[i + 3] = Math.round(oa * 255);
}

function setPixel(img, x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
}

// Nearest-neighbour upscale by an integer factor (pixel art stays crisp).
function scaleImage(img, factor) {
    const out = createImage(img.width * factor, img.height * factor);
    for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) setPixel(out, x, y, getPixel(img, Math.floor(x / factor), Math.floor(y / factor)));
    }
    return out;
}

module.exports = { decodePng, encodePng, createImage, getPixel, setPixel, blendPixel, scaleImage };
