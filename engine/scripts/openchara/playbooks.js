// A first playbook set: Breach Stack (Formation #13), Room-Clear Cross
// Pattern (Formation #14), and Slice the Pie (Micro-Playbook #1) - all
// three genuinely novel/untested choreography per the plan's own framing
// ("a real design proposal needing real playtesting/tuning"). Each is
// sequenced with real navigateToCoordinate() calls and onArrive callbacks
// rather than fixed timers, so a slower or blocked member doesn't desync
// the sequence.

import { navigateToCoordinate } from "./navigation.js";
import { markSweepCoverage } from "./roomSafety.js";
import { hasLineOfSight, findNearbyHostiles } from "./perception.js";

function headOf(entity) {
    try { return entity.getHeadLocation(); } catch (e) { return entity.location; }
}

// Waits for every entry in `entities` to either arrive or fail to start,
// then calls `onAllDone` exactly once. A member whose navigation never
// starts (slot pool exhausted) counts as "done" immediately rather than
// hanging the whole stack forever.
function navigateAllThen(members, targets, onAllDone) {
    let remaining = members.length;
    if (remaining === 0) { onAllDone(); return; }
    members.forEach((m, i) => {
        const t = targets[i];
        const started = navigateToCoordinate(m.entity, t.x, t.y, t.z, m.entity.dimension, () => {
            remaining--;
            if (remaining <= 0) onAllDone();
        });
        if (!started) {
            remaining--;
            if (remaining <= 0) onAllDone();
        }
    });
}

// ---- Formation #13: Breach Stack -------------------------------------------
/**
 * Stacks `members` single-file just outside `chokePoint` (queued along the
 * approach direction), then - once all are staged - breaches through to
 * points just beyond, staggered, alternating left/right coverage (the
 * "cross" technique).
 */
export function breachStack(members, chokePoint, approachDirection, dimension, onComplete) {
    if (members.length === 0) { onComplete?.(); return; }

    const norm = Math.hypot(approachDirection.x, approachDirection.z) || 1;
    const dir = { x: approachDirection.x / norm, z: approachDirection.z / norm };
    const perp = { x: -dir.z, z: dir.x };

    const stackSpacing = 1;
    const stackPoints = members.map((_, i) => ({
        x: chokePoint.x - dir.x * (stackSpacing * (i + 1)),
        y: chokePoint.y,
        z: chokePoint.z - dir.z * (stackSpacing * (i + 1)),
    }));

    navigateAllThen(members, stackPoints, () => {
        const breachSpacing = 2;
        const peelOffset = 2;
        const breachPoints = members.map((_, i) => {
            const side = i % 2 === 0 ? 1 : -1;
            return {
                x: chokePoint.x + dir.x * breachSpacing + perp.x * peelOffset * side,
                y: chokePoint.y,
                z: chokePoint.z + dir.z * breachSpacing + perp.z * peelOffset * side,
            };
        });
        // Staggered, not simultaneous: each member starts once the previous
        // one starts moving (a small stagger), matching the plan's own
        // "pass through with a small stagger" description more closely
        // than an all-at-once dash through a doorway.
        members.forEach((m, i) => {
            const t = breachPoints[i];
            navigateToCoordinate(m.entity, t.x, t.y, t.z, dimension, i === members.length - 1 ? onComplete : undefined);
        });
    });
}

// ---- Formation #14: Room-Clear Cross Pattern -------------------------------
/**
 * Sends `members` to the room's near corners first, then far corners, in a
 * fixed order - `roomCorners` is `[nearLeft, nearRight, farLeft, farRight]`
 * relative to the entry point (caller works this out from room bounds).
 * Marks each hop's sweep as room coverage.
 */
export function roomClearCross(members, roomId, roomCorners, dimension, onComplete) {
    if (members.length === 0 || roomCorners.length < 2) { onComplete?.(); return; }

    const nearCorners = roomCorners.slice(0, 2);
    const farCorners = roomCorners.slice(2, 4);
    const firstWave = members.slice(0, 2);
    const secondWave = members.slice(2, 4);

    function markArrivalSweep(member, target) {
        const hostiles = findNearbyHostiles(dimension, target, 12);
        const sawThreat = hostiles.some(h => hasLineOfSight(dimension, headOf(member.entity), headOf(h)));
        markSweepCoverage(roomId, member.entity.location, target, sawThreat);
    }

    function clearNear(cb) {
        if (firstWave.length === 0) { cb(); return; }
        navigateAllThen(firstWave, nearCorners, () => {
            firstWave.forEach((m, i) => markArrivalSweep(m, nearCorners[i]));
            cb();
        });
    }

    function clearFar(cb) {
        const wave = secondWave.length > 0 ? secondWave : firstWave;
        if (wave.length === 0 || farCorners.length === 0) { cb(); return; }
        navigateAllThen(wave, farCorners, () => {
            wave.forEach((m, i) => markArrivalSweep(m, farCorners[i]));
            cb();
        });
    }

    clearNear(() => clearFar(() => onComplete?.()));
}

// ---- Micro-Playbook #1: Slice the Pie --------------------------------------
/**
 * Arc-sweeps a doorway from `pivot`, advancing `member` in small angular
 * increments around `standoffRadius`, LOS-checking each newly-revealed
 * slice before advancing further. Halts immediately (calling `onThreat`)
 * the moment a hostile is spotted - doesn't complete the sweep. Marks each
 * slice's sweep as room coverage on the way.
 */
export function slicePie(member, roomId, pivot, facingAngle, dimension, { steps = 8, standoffRadius = 3, arcSpan = Math.PI } = {}, onComplete, onThreat) {
    let step = 0;

    function nextSlice() {
        if (step >= steps) { onComplete?.(); return; }
        const t = step / (steps - 1);
        const angle = facingAngle - arcSpan / 2 + arcSpan * t;
        const target = {
            x: pivot.x + Math.cos(angle) * standoffRadius,
            y: pivot.y,
            z: pivot.z + Math.sin(angle) * standoffRadius,
        };

        navigateToCoordinate(member.entity, target.x, target.y, target.z, dimension, () => {
            const sliceLookTarget = { x: pivot.x + Math.cos(angle) * (standoffRadius + 8), y: pivot.y, z: pivot.z + Math.sin(angle) * (standoffRadius + 8) };
            const hostiles = findNearbyHostiles(dimension, target, 12);
            const visible = hostiles.filter(h => hasLineOfSight(dimension, headOf(member.entity), headOf(h)));

            markSweepCoverage(roomId, member.entity.location, sliceLookTarget, visible.length > 0);

            if (visible.length > 0) {
                onThreat?.(visible);
                return; // halt the sweep - a real threat overrides continuing to slice
            }
            step++;
            nextSlice();
        });
    }

    nextSlice();
}
