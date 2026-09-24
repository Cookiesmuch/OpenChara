// Character ids (plan Section 1.4.1, revised per explicit request): a real
// UUID v4, globally unique by construction - no per-player counter, no
// "w1"/"w2" scheme, no owner-prefix concatenation needed anywhere else in
// the schema. A character's id IS her global id.
//
// The one thing a bare UUID can't tell you on its own is *whose* data it
// lives under (dynamic properties are only readable by asking the actual
// owning Player object for them) - a tiny world-scoped registry closes
// that gap for the rare cross-player lookup (bonds, migration).

import { world } from "@minecraft/server";
import { NS, CHAR } from "./ids.js";

// No native crypto.randomUUID guaranteed in this scripting environment -
// this is the standard Math.random()-based UUID v4 fallback used across
// Bedrock addons. Not cryptographically secure, and doesn't need to be:
// this is an identifier, not a secret.
export function generateCharacterId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function ownerKey(characterId) { return `${NS}:${CHAR}Owner:${characterId}`; }

export function registerCharacterOwner(characterId, ownerId) {
    world.setDynamicProperty(ownerKey(characterId), ownerId);
}

export function resolveCharacterOwnerId(characterId) {
    return world.getDynamicProperty(ownerKey(characterId)) ?? null;
}
