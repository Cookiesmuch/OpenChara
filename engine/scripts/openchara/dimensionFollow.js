// Dimension-change handling (plan Section 5): despawn-and-respawn instead
// of moving entities across dimensions. "Following" isn't a real order
// state yet (no order/state-machine system exists this early) - Phase 2's
// simplification is that every currently-manifested character counts as
// following, which is revisited once real orders (guard/patrol/etc) land
// and this should only apply to whichever subset is actually following.
//
// Applies two hard-won findings from Phase 0's paused dimension spike:
// (1) read player.location/player.dimension directly rather than trusting
// PlayerDimensionChangeAfterEvent's own toLocation (observed to differ by
// ~1 block on a real Nether transition); (2) defer the re-manifest spawn
// into system.run() since a synchronous spawnEntity call inside certain
// event callbacks was found to silently not take effect.

import { world, system } from "@minecraft/server";
import { readIndex } from "./characterIndex.js";
import { getCharacter, getOrder } from "./characterRecord.js";
import { despawnCharacter, manifestCharacter } from "./manifest.js";

// playerId -> characterId[] awaiting re-manifestation once the player has
// actually arrived. Deliberately in-memory/ephemeral (Section 8.11) - if
// the process restarts mid-transfer, reconciliation (Section 3.1) already
// catches any character left in limbo with a cleared manifestedEntityId.
const pendingReManifest = new Map();

function currentlyManifestedCharacterIds(player) {
    return readIndex(player)
        .map(entry => entry.id)
        .filter(id => {
            const record = getCharacter(player, id);
            // Only characters under a "follow" order come along (Section 5) -
            // one told to stay/guard home stays put in her own dimension.
            return record?.manifestedEntityId && getOrder(record) === "follow";
        });
}

export function startDimensionFollowHandlers() {
    world.afterEvents.playerDimensionChange.subscribe(event => {
        const player = event.player;
        const following = currentlyManifestedCharacterIds(player);
        if (following.length === 0) return;
        for (const characterId of following) despawnCharacter(player, characterId);
        pendingReManifest.set(player.id, following);
    });

    world.afterEvents.playerSpawn.subscribe(event => {
        const player = event.player;
        const pending = pendingReManifest.get(player.id);
        if (!pending || pending.length === 0) return;
        pendingReManifest.delete(player.id);

        system.run(() => {
            const location = player.location;
            const dimension = player.dimension;
            for (const characterId of pending) {
                manifestCharacter(player, characterId, location, dimension);
            }
        });
    });
}
