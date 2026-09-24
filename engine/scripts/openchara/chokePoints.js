// Choke-point detection (plan Section 8.4). The plan itself flags this
// explicitly as "a genuine design proposal needing real playtesting/
// tuning, not a proven algorithm yet" - this is a first, reasonable
// implementation of that proposal, not a guaranteed-correct one. Treat any
// result as a candidate to verify in-game, not a fact.

import { floodFillPassable } from "./floodFill.js";

// Counts how many of the 4 horizontal neighbors (same Y) are also in the
// flood-filled set - a doorway/corridor reads low (1-2), an open room
// reads high (3-4).
function localOpenness(cellSet, cell) {
    const offsets = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
    let open = 0;
    for (const o of offsets) {
        if (cellSet.has(`${cell.x + o.x},${cell.y},${cell.z + o.z}`)) open++;
    }
    return open;
}

const NARROW_THRESHOLD = 2; // <=2 open horizontal neighbors reads as "narrow"
const WIDE_THRESHOLD = 3; // >=3 reads as "genuinely wider space"
const WIDE_SEARCH_RADIUS = 2; // blocks - "clearly wider space immediately before/after"

/**
 * Flood-fills from `start` and returns the subset of cells that look like
 * choke points: narrow themselves, with genuinely wider space nearby -
 * distinguishing an actual doorway/gap from a corridor that's simply
 * narrow the whole way through (which isn't a choke point, just a hallway).
 */
export function detectChokePoints(dimension, start, maxBlocks = 200) {
    const cells = floodFillPassable(dimension, start, maxBlocks);
    const cellSet = new Set(cells.map(c => `${c.x},${c.y},${c.z}`));
    const chokePoints = [];

    for (const cell of cells) {
        if (localOpenness(cellSet, cell) > NARROW_THRESHOLD) continue;

        const hasWiderNearby = cells.some(c =>
            Math.abs(c.x - cell.x) <= WIDE_SEARCH_RADIUS &&
            Math.abs(c.z - cell.z) <= WIDE_SEARCH_RADIUS &&
            c.y === cell.y &&
            localOpenness(cellSet, c) >= WIDE_THRESHOLD
        );
        if (hasWiderNearby) chokePoints.push(cell);
    }
    return chokePoints;
}
