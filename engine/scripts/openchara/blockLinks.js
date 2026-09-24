// Block links (plan Section 1.5.7): a world-scoped reference from a block
// position to a character, for future features that anchor her to a place (a
// home bed, a shrine, a guard post). Keyed by position so it works whether
// or not Bedrock block entities can carry dynamic properties of their own.
//
//   cw:blockLink:<dimension>:<x>:<y>:<z> -> { characterId, kind }
//
// Pure storage; the integrity scan drops links whose character no longer
// exists, and purge removes a character's links.

import { world } from "@minecraft/server";
import { readJsonProperty, writeJsonProperty } from "./dataCore.js";
import { NS } from "./ids.js";

const PREFIX = `${NS}:blockLink:`;

function linkKey(dimensionId, pos) {
    return `${PREFIX}${dimensionId.replace("minecraft:", "")}:${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}`;
}

export function setBlockLink(dimensionId, pos, characterId, kind = "generic") {
    return writeJsonProperty(world, linkKey(dimensionId, pos), { characterId, kind },
        v => typeof v?.characterId === "string" && typeof v?.kind === "string");
}

export function getBlockLink(dimensionId, pos) {
    return readJsonProperty(world, linkKey(dimensionId, pos), null);
}

export function clearBlockLink(dimensionId, pos) {
    world.setDynamicProperty(linkKey(dimensionId, pos), undefined);
}

// Every link, parsed: [{ key, dimension, x, y, z, characterId, kind }].
export function listBlockLinks(filterCharacterId = null) {
    const out = [];
    for (const key of world.getDynamicPropertyIds()) {
        if (!key.startsWith(PREFIX)) continue;
        const v = readJsonProperty(world, key, null);
        if (!v || (filterCharacterId && v.characterId !== filterCharacterId)) continue;
        const [dimension, x, y, z] = key.slice(PREFIX.length).split(":");
        out.push({ key, dimension, x: +x, y: +y, z: +z, ...v });
    }
    return out;
}

export function clearLinksFor(characterId) {
    for (const link of listBlockLinks(characterId)) world.setDynamicProperty(link.key, undefined);
}
