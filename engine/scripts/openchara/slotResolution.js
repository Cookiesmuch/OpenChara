// Terrain-aware slot descriptor resolution (plan Section 8.3). Replaces
// Phase 2's flat, non-terrain-weighted formation geometry with real
// elevation/cover/LOS scoring against actual terrain - this is what makes
// "ranged prefers high ground" a real, live behavior instead of a flat
// ring around the anchor. A slot descriptor is never a literal coordinate;
// it's resolved fresh against real terrain every time it's asked for.

import { hasLineOfSight } from "./perception.js";

const CANDIDATE_ANGLE_SAMPLES = 5;
const CANDIDATE_RADIUS_SAMPLES = 3;
const RAYCAST_START_HEIGHT = 40; // "a safely-high point" above the anchor to raycast down from
const RAYCAST_MAX_DEPTH = 128;

function findGroundHeight(dimension, x, z, fromY) {
    try {
        const hit = dimension.getBlockFromRay({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }, { maxDistance: RAYCAST_MAX_DEPTH });
        if (hit) return hit.block.location.y + 1;
    } catch (e) { /* fall through */ }
    return null;
}

// Cheap proxy for "near cover": a solid, non-air block immediately
// adjacent at foot height - not a full raycast survey, just enough to
// bias scoring toward standing next to something solid.
function hasCoverNearby(dimension, pos) {
    const offsets = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
    for (const o of offsets) {
        try {
            const block = dimension.getBlock({ x: Math.floor(pos.x) + o.x, y: Math.floor(pos.y), z: Math.floor(pos.z) + o.z });
            // `isAir` only - see floodFill.js's isStandable() for why
            // `isSolid` is avoided here now.
            if (block && !block.isAir) return true;
        } catch (e) { /* fine, just means no cover credit for this side */ }
    }
    return false;
}

function sampleCandidates(dimension, anchorPos, descriptor) {
    const { idealOffset } = descriptor;
    const candidates = [];
    const fromY = anchorPos.y + RAYCAST_START_HEIGHT;
    const angleSpread = Math.PI / 4; // +/- 45 degrees around the ideal angle - a tolerance band, not one fixed point

    for (let a = 0; a < CANDIDATE_ANGLE_SAMPLES; a++) {
        const angle = idealOffset.angle + (CANDIDATE_ANGLE_SAMPLES === 1 ? 0 : (a / (CANDIDATE_ANGLE_SAMPLES - 1) - 0.5) * angleSpread * 2);
        for (let r = 0; r < CANDIDATE_RADIUS_SAMPLES; r++) {
            const t = CANDIDATE_RADIUS_SAMPLES === 1 ? 0.5 : r / (CANDIDATE_RADIUS_SAMPLES - 1);
            const radius = idealOffset.minRadius + (idealOffset.maxRadius - idealOffset.minRadius) * t;
            const x = anchorPos.x + Math.cos(angle) * radius;
            const z = anchorPos.z + Math.sin(angle) * radius;
            const groundY = findGroundHeight(dimension, x, z, fromY);
            if (groundY === null) continue;
            candidates.push({ x, y: groundY, z, radius });
        }
    }
    return candidates;
}

function scoreCandidate(dimension, candidate, anchorPos, threatPos, descriptor, teammates) {
    let score = 0;

    if (descriptor.elevationWeight > 0) {
        if (descriptor.elevationPreference === "high") {
            const reference = threatPos ?? anchorPos;
            score += (candidate.y - reference.y) * descriptor.elevationWeight;
        } else if (descriptor.elevationPreference === "match-anchor") {
            score -= Math.abs(candidate.y - anchorPos.y) * descriptor.elevationWeight;
        }
    }

    // LOS requirement is a hard gate, not just a scoring nudge - a
    // candidate that fails required LOS is heavily penalized so it never
    // wins purely on other axes (elevation, cover) instead.
    if (descriptor.requiresLOS === "threat" && threatPos) {
        const canSee = hasLineOfSight(dimension, { x: candidate.x, y: candidate.y + 1.5, z: candidate.z }, { x: threatPos.x, y: threatPos.y + 1, z: threatPos.z });
        score += canSee ? 5 : -50;
    } else if (descriptor.requiresLOS === "anchor") {
        const canSee = hasLineOfSight(dimension, { x: candidate.x, y: candidate.y + 1.5, z: candidate.z }, { x: anchorPos.x, y: anchorPos.y + 1, z: anchorPos.z });
        score += canSee ? 5 : -50;
    }

    if (descriptor.coverPreference > 0 && hasCoverNearby(dimension, candidate)) {
        score += descriptor.coverPreference;
    }

    // Soft distance-drift-from-ideal-geometry penalty - keeps a circle
    // recognizably circular while still allowing individual terrain
    // nudges (Section 8.3's own anti-jank note).
    const idealRadius = (descriptor.idealOffset.minRadius + descriptor.idealOffset.maxRadius) / 2;
    score -= Math.abs(candidate.radius - idealRadius) * 0.5;

    if (descriptor.minSeparation > 0) {
        for (const mate of teammates) {
            const dx = candidate.x - mate.x, dz = candidate.z - mate.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < descriptor.minSeparation) score -= (descriptor.minSeparation - dist) * 2;
        }
    }

    return score;
}

/**
 * Resolves one slot descriptor to the single best-scoring real-terrain
 * candidate. `teammates` is an array of {x,z} positions of other
 * already-resolved slots this cycle, for the separation penalty. Returns
 * `null` if no candidate found valid ground (e.g. over a void).
 */
export function resolveSlot(dimension, anchorPos, threatPos, descriptor, teammates = []) {
    const candidates = sampleCandidates(dimension, anchorPos, descriptor);
    if (candidates.length === 0) return null;

    let best = null, bestScore = -Infinity;
    for (const c of candidates) {
        const s = scoreCandidate(dimension, c, anchorPos, threatPos, descriptor, teammates);
        if (s > bestScore) { bestScore = s; best = c; }
    }
    return { position: { x: best.x, y: best.y, z: best.z }, radius: best.radius, score: bestScore };
}

// ---- Anti-jank hysteresis --------------------------------------------------
// Rescoring every cycle causes visible flip-flopping between near-equal
// candidates. Only switch a member off her CURRENT slot if a fresh
// candidate beats that same position's own current-terrain score by a
// real margin - never just because a new candidate happened to score
// slightly higher this cycle.
const HYSTERESIS_MARGIN = 3;

const currentSlotAssignment = new Map(); // characterId -> {position, radius, score}

export function resolveSlotWithHysteresis(characterId, dimension, anchorPos, threatPos, descriptor, teammates = []) {
    const resolved = resolveSlot(dimension, anchorPos, threatPos, descriptor, teammates);
    const current = currentSlotAssignment.get(characterId);

    if (!resolved) return current?.position ?? null;
    if (!current) {
        currentSlotAssignment.set(characterId, resolved);
        return resolved.position;
    }

    const currentScore = scoreCandidate(
        dimension,
        { x: current.position.x, y: current.position.y, z: current.position.z, radius: current.radius },
        anchorPos, threatPos, descriptor, teammates
    );

    if (resolved.score > currentScore + HYSTERESIS_MARGIN) {
        currentSlotAssignment.set(characterId, resolved);
        return resolved.position;
    }
    return current.position;
}

export function clearSlotAssignment(characterId) {
    currentSlotAssignment.delete(characterId);
}
