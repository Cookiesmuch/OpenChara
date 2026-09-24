// Formation slot resolution (plan Section 8.3). Each formation type below
// produces real slot *descriptors* (a tolerance band, not a literal
// coordinate) - the same shape used for both plain formations and future
// playbook steps (Section 8.4 reuses this verbatim, just with different
// descriptor weights per role). Resolving a descriptor against real
// terrain (elevation/cover/LOS scoring, anti-jank hysteresis) is
// slotResolution.js's job; this module only owns the formation geometry
// and per-class descriptor weighting.

import { resolveSlotWithHysteresis } from "./slotResolution.js";
import { getClass } from "./classData.js";
import { navigateToCoordinate } from "./navigation.js";

// Each formation type maps (count, headingRadians) -> an array of
// idealOffset descriptors {angle, minRadius, maxRadius}, one per slot.
const FORMATIONS = {
    circle: (count) => {
        const radius = Math.max(2, count * 0.6);
        const offsets = [];
        for (let i = 0; i < count; i++) {
            const angle = (2 * Math.PI * i) / count;
            offsets.push({ angle, minRadius: radius - 0.5, maxRadius: radius + 1.5 });
        }
        return offsets;
    },
    line: (count, heading) => {
        const spacing = 2;
        const perp = heading + Math.PI / 2;
        const start = -((count - 1) / 2) * spacing;
        const offsets = [];
        for (let i = 0; i < count; i++) {
            const d = start + i * spacing;
            offsets.push({ angle: d >= 0 ? perp : perp + Math.PI, minRadius: Math.abs(d), maxRadius: Math.abs(d) + 1.5 });
        }
        return offsets;
    },
    column: (count, heading) => {
        const spacing = 2;
        const behind = heading + Math.PI;
        const offsets = [];
        for (let i = 0; i < count; i++) {
            const d = (i + 1) * spacing;
            offsets.push({ angle: behind, minRadius: d - 0.5, maxRadius: d + 1 });
        }
        return offsets;
    },
    // Formation #3 (Section 8.5): tankiest-first point, others fanning out
    // behind in a V - used to punch through and split a line of enemies.
    wedge: (count, heading) => {
        if (count === 1) return [{ angle: heading, minRadius: 0, maxRadius: 1 }];
        const spacing = 2;
        const spreadAngle = Math.PI / 4; // 45 degrees off the point's heading, per rank
        const offsets = [{ angle: heading, minRadius: 0, maxRadius: 1 }]; // the point - must lead
        for (let i = 1; i < count; i++) {
            const rank = Math.ceil(i / 2);
            const side = i % 2 === 1 ? 1 : -1;
            const angle = heading + Math.PI + side * spreadAngle; // fanning out behind the point
            const radius = rank * spacing;
            offsets.push({ angle, minRadius: radius - 0.5, maxRadius: radius + 1 });
        }
        return offsets;
    },
    // Formation #12 (Section 8.5): column with alternating left-right
    // offset, so no single line/AoE threatens the whole file at once.
    staggeredColumn: (count, heading) => {
        const spacing = 2;
        const lateralOffset = 1;
        const behind = heading + Math.PI;
        const perp = heading + Math.PI / 2;
        const offsets = [];
        for (let i = 0; i < count; i++) {
            const back = (i + 1) * spacing;
            const side = i % 2 === 0 ? 1 : -1;
            // Combine the "behind" and lateral vectors into one angle/radius
            // pair by treating them as a small 2D offset from the anchor.
            const bx = Math.cos(behind) * back + Math.cos(perp) * lateralOffset * side;
            const bz = Math.sin(behind) * back + Math.sin(perp) * lateralOffset * side;
            const radius = Math.hypot(bx, bz);
            const angle = Math.atan2(bz, bx);
            offsets.push({ angle, minRadius: radius - 0.5, maxRadius: radius + 1 });
        }
        return offsets;
    },
    // Formation #2 (Section 8.5): tight, dense line that holds ground
    // rather than advancing - same geometry as `line` with a much tighter
    // tolerance band, since "phalanx" is specifically about density.
    phalanx: (count, heading) => {
        const spacing = 1.2;
        const perp = heading + Math.PI / 2;
        const start = -((count - 1) / 2) * spacing;
        const offsets = [];
        for (let i = 0; i < count; i++) {
            const d = start + i * spacing;
            offsets.push({ angle: d >= 0 ? perp : perp + Math.PI, minRadius: Math.abs(d), maxRadius: Math.abs(d) + 0.5 });
        }
        return offsets;
    },
};

export const FORMATION_TYPES = Object.keys(FORMATIONS);

function headingOf(dir) {
    return Math.atan2(dir?.z ?? 0, dir?.x ?? 1);
}

function roughOffsetPosition(anchor, offset) {
    const radius = (offset.minRadius + offset.maxRadius) / 2;
    return { x: anchor.x + Math.cos(offset.angle) * radius, z: anchor.z + Math.sin(offset.angle) * radius };
}

// Per-class descriptor weighting: a ranged class wants elevation and a
// guaranteed sightline to the threat; melee wants tight cohesion instead.
// This is exactly Section 8.3's "a playbook just supplies different
// descriptor weights per role" idea, applied to plain formations first.
function buildDescriptor(idealOffset, record, formationType) {
    const positioning = getClass(record.class).positioning;
    const isRanged = positioning.role === "ranged";
    // Phalanx is specifically about density - a much tighter minimum
    // separation than every other formation, which otherwise default to a
    // comfortable spacing.
    const minSeparation = formationType === "phalanx" ? 0.6 : 1.5;
    return {
        idealOffset,
        elevationPreference: isRanged ? "high" : "neutral",
        elevationWeight: isRanged ? 1.5 : 0,
        requiresLOS: isRanged && !["column", "phalanx"].includes(formationType) ? "anchor" : null,
        coverPreference: isRanged ? 0 : 2,
        minSeparation,
    };
}

// Greedy nearest-fit assignment of members to slots (Section 8.3's own
// anti-jank spirit: minimize total member travel rather than assigning in
// an arbitrary fixed order), using each slot's rough ideal position for
// the distance estimate - the real terrain position is resolved
// afterward, per assigned member, since resolution needs to know WHO is
// going there (her class) before it can weight the descriptor correctly.
function assignSlotsToMembers(members, offsets, anchor) {
    const roughSlots = offsets.map((offset, i) => ({ offset, idx: i, ...roughOffsetPosition(anchor, offset) }));
    const remainingMembers = [...members];
    const remainingSlots = [...roughSlots];
    const assignments = [];

    while (remainingMembers.length > 0 && remainingSlots.length > 0) {
        let best = null;
        for (const member of remainingMembers) {
            for (const slot of remainingSlots) {
                const dx = member.entity.location.x - slot.x, dz = member.entity.location.z - slot.z;
                const dist = dx * dx + dz * dz;
                if (!best || dist < best.dist) best = { member, slot, dist };
            }
        }
        assignments.push({ member: best.member, offset: best.slot.offset });
        remainingMembers.splice(remainingMembers.indexOf(best.member), 1);
        remainingSlots.splice(remainingSlots.indexOf(best.slot), 1);
    }
    return assignments;
}

/**
 * Resolves a whole formation against real terrain. `members` is
 * `[{characterId, record, entity}]`; `threatPos` (optional) is the position
 * ranged descriptors should try to keep elevation/LOS advantage over.
 * Returns `[{characterId, position}]`, one entry per member whose slot
 * resolved to real ground (a member over unresolvable terrain, e.g. a
 * void, is simply omitted rather than given a bad position).
 */
export function resolveFormationOnTerrain(formationType, dimension, anchorLocation, headingDirection, threatPos, members) {
    const fn = FORMATIONS[formationType];
    if (!fn) throw new Error(`Unknown formation "${formationType}". Known: ${FORMATION_TYPES.join(", ")}`);
    if (members.length === 0) return [];

    const heading = headingOf(headingDirection);
    const offsets = fn(members.length, heading);
    const slotAssignments = assignSlotsToMembers(members, offsets, anchorLocation);

    const results = [];
    const resolvedSoFar = []; // {x,z} of teammates already placed this cycle, for separation scoring
    for (const { member, offset } of slotAssignments) {
        const descriptor = buildDescriptor(offset, member.record, formationType);
        const position = resolveSlotWithHysteresis(member.characterId, dimension, anchorLocation, threatPos, descriptor, resolvedSoFar);
        if (!position) continue;
        resolvedSoFar.push(position);
        results.push({ characterId: member.characterId, position });
    }
    return results;
}

/**
 * Resolves a formation AND actually moves members there via real
 * navigation - the one shared execution path for both manual invocation
 * (the test harness) and auto-triggering (Section 8.4/8.2). Returns how
 * many members started navigating.
 */
export function executeFormation(formationType, dimension, anchorLocation, headingDirection, threatPos, members) {
    const assignments = resolveFormationOnTerrain(formationType, dimension, anchorLocation, headingDirection, threatPos, members);
    let started = 0;
    for (const a of assignments) {
        const m = members.find(e => e.characterId === a.characterId);
        if (m && navigateToCoordinate(m.entity, a.position.x, a.position.y, a.position.z, m.entity.dimension)) started++;
    }
    return started;
}
