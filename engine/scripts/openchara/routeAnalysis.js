// Route & Escape Analysis (plan Section 8.8). From a target's position,
// which directions could it actually run? Same standability rule as the
// shared flood-fill (floodFill.js's isStandable), walked outward along a
// fan of compass rays one block at a time, stepping up/down one block like
// native pathfinding does. A ray that dead-ends quickly (wall, cliff,
// water) isn't a real route and is discarded - exactly the "a direction
// that dead-ends within a short distance isn't a real route" rule.
//
// Computed once per hunt (and once more if the target bolts), never
// per-tick. Hard-capped: RAY_COUNT * maxLen * 3 block checks at most.

import { isStandable } from "./floodFill.js";

const RAY_COUNT = 12;

function walkRay(dimension, start, angle, maxLen) {
    const dx = Math.cos(angle), dz = Math.sin(angle);
    let y = Math.floor(start.y);
    let last = { x: start.x, y, z: start.z };
    let steps = 0;
    for (let i = 1; i <= maxLen; i++) {
        const x = Math.floor(start.x + dx * i), z = Math.floor(start.z + dz * i);
        let found = null;
        for (const dy of [0, 1, -1]) {
            if (isStandable(dimension, { x, y: y + dy, z })) { found = y + dy; break; }
        }
        if (found === null) break;
        y = found;
        last = { x: x + 0.5, y, z: z + 0.5 };
        steps = i;
    }
    return { length: steps, end: last };
}

/**
 * Returns viable escape routes from `targetPos`, longest (most dangerous
 * to leave open) first: [{ angle, length, end }].
 * `openness` = fraction of rays that are viable (1 = open field).
 */
export function detectEscapeRoutes(dimension, targetPos, { maxLen = 12, minLen = 5 } = {}) {
    const routes = [];
    for (let i = 0; i < RAY_COUNT; i++) {
        const angle = (i / RAY_COUNT) * Math.PI * 2;
        const ray = walkRay(dimension, targetPos, angle, maxLen);
        if (ray.length >= minLen) routes.push({ angle, length: ray.length, end: ray.end });
    }
    routes.sort((a, b) => b.length - a.length);
    return { routes, openness: routes.length / RAY_COUNT };
}

/**
 * Blocker positions for `memberCount` members. Covers the longest routes
 * first; if there are fewer members than routes, members spread across
 * the angular gaps instead (a "collapsing net") rather than leaving the
 * biggest hole open. Each position sits `radius` blocks out along its
 * angle, snapped to real standable ground via the same ray walk.
 */
export function planBlockerPositions(dimension, targetPos, routes, memberCount, radius = 5) {
    let angles;
    if (routes.length === 0) {
        angles = Array.from({ length: memberCount }, (_, i) => (i / memberCount) * Math.PI * 2);
    } else if (routes.length <= memberCount) {
        angles = routes.map(r => r.angle);
        // Leftover members fill the widest remaining gaps.
        while (angles.length < memberCount) {
            const sorted = [...angles].sort((a, b) => a - b);
            let best = { gap: -1, mid: 0 };
            for (let i = 0; i < sorted.length; i++) {
                const a = sorted[i], b = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + Math.PI * 2;
                if (b - a > best.gap) best = { gap: b - a, mid: (a + b) / 2 };
            }
            angles.push(best.mid % (Math.PI * 2));
        }
    } else {
        // More routes than members: spread evenly, rotated so the single
        // longest route is covered head-on.
        const base = routes[0].angle;
        angles = Array.from({ length: memberCount }, (_, i) => base + (i / memberCount) * Math.PI * 2);
    }
    return angles.map(angle => {
        const ray = walkRay(dimension, targetPos, angle, radius);
        const pos = ray.length > 0 ? ray.end : { x: targetPos.x + Math.cos(angle) * 2, y: targetPos.y, z: targetPos.z + Math.sin(angle) * 2 };
        return { angle, ...pos };
    });
}
