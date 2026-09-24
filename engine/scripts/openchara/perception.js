// Perception (plan Section 8.2, Perception layer): LOS raycasting, a
// decaying threat memory so losing sight means "investigate the last-known
// spot" rather than instant amnesia or seeing through walls, a squad-level
// aggro table tracking which of OUR OWN members currently holds enemy
// attention (never an attempt to control the hostile's own native
// targeting), and blind-spot arc detection around a squad. All ephemeral,
// in-memory only (Section 8.11) - nothing here is ever a dynamic property.

const HOSTILE_FAMILY = "monster";
const THREAT_MEMORY_DECAY_TICKS = 200; // ~10s
const AGGRO_DECAY_PER_TICK = 0.02;
export const ARC_COUNT = 8;

// squadId -> Map<hostileId, {lastKnownPos, lastSeenTick}>
const threatMemoryBySquad = new Map();
// squadId -> Map<hostileId, Map<memberId, attention>>
const aggroTableBySquad = new Map();

function getThreatMemory(squadId) {
    if (!threatMemoryBySquad.has(squadId)) threatMemoryBySquad.set(squadId, new Map());
    return threatMemoryBySquad.get(squadId);
}
function getAggroTable(squadId) {
    if (!aggroTableBySquad.has(squadId)) aggroTableBySquad.set(squadId, new Map());
    return aggroTableBySquad.get(squadId);
}

// ---- LOS raycasting ------------------------------------------------------
// Reuses the same real occlusion-raycast technique already proven in this
// codebase's history (March 7's old sightline gating).
export function hasLineOfSight(dimension, fromPos, toPos, maxDistance = 32) {
    const dx = toPos.x - fromPos.x, dy = toPos.y - fromPos.y, dz = toPos.z - fromPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDistance) return false;
    if (dist < 0.001) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    try {
        const hit = dimension.getBlockFromRay(fromPos, dir, { maxDistance: dist - 0.1 });
        return hit === undefined;
    } catch (e) {
        return true; // fail open - never let perception break on a raycast API hiccup
    }
}

// ---- Hostile detection -----------------------------------------------------
// One shared scan per squad tick (Section 4's own "O(squads), not
// O(members)" principle) - never one scan per member.
export function findNearbyHostiles(dimension, center, radius = 24) {
    try {
        return dimension.getEntities({ location: center, maxDistance: radius, families: [HOSTILE_FAMILY] });
    } catch (e) {
        return [];
    }
}

// ---- Threat memory (decaying) ---------------------------------------------
export function updateThreatMemory(squadId, hostile, canSee, currentTick) {
    const memory = getThreatMemory(squadId);
    if (canSee) {
        memory.set(hostile.id, { lastKnownPos: { ...hostile.location }, lastSeenTick: currentTick });
    }
}

// Returns still-fresh entries, pruning (and dropping) anything past the
// decay window as a side effect - "investigate the last-known spot" for a
// bounded window, then genuinely forget.
export function getKnownThreats(squadId, currentTick) {
    const memory = getThreatMemory(squadId);
    const known = [];
    for (const [hostileId, entry] of memory) {
        if (currentTick - entry.lastSeenTick > THREAT_MEMORY_DECAY_TICKS) {
            memory.delete(hostileId);
            continue;
        }
        known.push({ hostileId, ...entry });
    }
    return known;
}

// ---- Squad aggro table -----------------------------------------------------
export function bumpAggro(squadId, hostileId, memberId, amount = 1) {
    const table = getAggroTable(squadId);
    if (!table.has(hostileId)) table.set(hostileId, new Map());
    const perMember = table.get(hostileId);
    perMember.set(memberId, (perMember.get(memberId) ?? 0) + amount);
}

export function decayAggro(squadId) {
    const table = getAggroTable(squadId);
    for (const [hostileId, perMember] of table) {
        for (const [memberId, value] of perMember) {
            const decayed = value * (1 - AGGRO_DECAY_PER_TICK);
            if (decayed < 0.01) perMember.delete(memberId);
            else perMember.set(memberId, decayed);
        }
        if (perMember.size === 0) table.delete(hostileId);
    }
}

export function getMostAggroedMember(squadId, hostileId) {
    const perMember = getAggroTable(squadId).get(hostileId);
    if (!perMember || perMember.size === 0) return null;
    let best = null, bestVal = -Infinity;
    for (const [memberId, value] of perMember) {
        if (value > bestVal) { bestVal = value; best = memberId; }
    }
    return best;
}

// ---- Blind-spot arc detection ----------------------------------------------
// Divides the compass around a squad centroid into ARC_COUNT arcs and
// reports which ones currently have nobody watching them.
function angleToArc(angleRad) {
    const twoPi = Math.PI * 2;
    const normalized = ((angleRad % twoPi) + twoPi) % twoPi;
    return Math.floor(normalized / (twoPi / ARC_COUNT));
}

// `watchers`: [{location, viewDirection}] - callers pass only
// alerted-or-higher members, per the plan's own "posture alert+" gate.
export function computeBlindSpots(watchers) {
    const covered = new Set();
    for (const watcher of watchers) {
        const facingAngle = Math.atan2(watcher.viewDirection.z, watcher.viewDirection.x);
        covered.add(angleToArc(facingAngle));
    }
    const blindArcs = [];
    for (let i = 0; i < ARC_COUNT; i++) {
        if (!covered.has(i)) blindArcs.push(i);
    }
    return blindArcs;
}

export function clearSquadPerception(squadId) {
    threatMemoryBySquad.delete(squadId);
    aggroTableBySquad.delete(squadId);
}
