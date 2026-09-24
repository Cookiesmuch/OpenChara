// Bounded flood-fill over standable blocks - the shared spatial primitive
// behind choke-point detection (Section 8.4), Room Safety bounds (Section
// 8.6), and Route & Escape Analysis (Section 8.8), per the plan's own
// explicit note that these are the same underlying computation, just
// re-centered and reinterpreted. ALWAYS capped (max blocks explored) so
// this can never runaway-scan an entire structure - this project has
// already been burned once by an uncapped/repeated scan turning into a lag
// bug, so every caller here is capped by construction, not by convention.

const DEFAULT_MAX_BLOCKS = 400;
// Horizontal neighbors plus one step up/down - handles single-block steps
// the same way native pathfinding does, not full staircase traversal
// (that's Section 8.10 Tier 3's own explicitly-scoped future spike).
const NEIGHBOR_OFFSETS = [
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
    { x: 1, y: 1, z: 0 }, { x: -1, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 1, z: -1 },
    { x: 1, y: -1, z: 0 }, { x: -1, y: -1, z: 0 }, { x: 0, y: -1, z: 1 }, { x: 0, y: -1, z: -1 },
];

export function isStandable(dimension, pos) {
    try {
        const feet = dimension.getBlock(pos);
        const head = dimension.getBlock({ x: pos.x, y: pos.y + 1, z: pos.z });
        const floor = dimension.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
        if (!feet || !head || !floor) return false;
        // `isAir` only, deliberately - a live test found the very first
        // BFS ring on plain flat grass produced zero standable neighbors,
        // consistent with `isSolid` not behaving as expected in this API
        // version. `isAir` is unambiguous and doesn't have that risk.
        return feet.isAir && head.isAir && !floor.isAir;
    } catch (e) {
        return false;
    }
}

function key(p) { return `${p.x},${p.y},${p.z}`; }

/**
 * BFS flood-fill from `start` over connected standable blocks, capped at
 * `maxBlocks`. Returns an array of integer block positions (not the
 * original fractional `start`).
 */
export function floodFillPassable(dimension, start, maxBlocks = DEFAULT_MAX_BLOCKS) {
    const startPos = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
    const visited = new Set([key(startPos)]);
    const queue = [startPos];
    const cells = [startPos];

    while (queue.length > 0 && cells.length < maxBlocks) {
        const current = queue.shift();
        for (const offset of NEIGHBOR_OFFSETS) {
            const next = { x: current.x + offset.x, y: current.y + offset.y, z: current.z + offset.z };
            const k = key(next);
            if (visited.has(k)) continue;
            visited.add(k);
            if (isStandable(dimension, next)) {
                cells.push(next);
                queue.push(next);
                if (cells.length >= maxBlocks) break;
            }
        }
    }
    return cells;
}
