// Squad coordination (plan Section 8.2, Coordination). Nothing here is
// ever persisted (Section 8.11) - target assignments, posture, and
// cohesion/threat-saturation signals are all recomputed fresh every cycle
// from live state, held in plain in-memory Maps keyed by squad id.
//
// Ability/cooldown data doesn't exist yet (Phase 10 builds it) - the
// cooldown-weighted half of "health/aggro/cooldown-weighted reassignment"
// is therefore a documented no-op for now (canUseDefensiveCooldown() below
// is the real gate a future ability-use call site checks; there's nothing
// to gate against yet). Health/aggro-weighted reassignment IS fully real.

import { getMemberAxes, setEngagement, healthBucket } from "./fsm.js";
import { getClass } from "./classData.js";
import { dist2D } from "./squadContext.js";

export const POSTURE = ["passive", "alert", "engaged", "regrouping", "retreating", "protecting"];

// squadId -> posture string
const squadPosture = new Map();

function hostileCapacity(hostile) {
    try {
        const health = hostile.getComponent("minecraft:health");
        const maxHp = health?.effectiveMax ?? 20;
        // Scales handling capacity with toughness (1-3 members) - a
        // vanilla zombie (20 HP) needs one attacker, something 3-4x
        // tankier warrants a second or third rather than leaving the rest
        // of the squad idle around one fight.
        return Math.max(1, Math.min(3, Math.round(maxHp / 20)));
    } catch (e) {
        return 1;
    }
}

// Greedy nearest-fit target assignment, respecting each hostile's
// saturation cap - prevents both dogpiling (members past capacity get
// left free for the next target) and unopposed flanks (every live hostile
// gets at least one assignment as long as members remain free). Tougher
// targets are assigned first so a dangerous one is never left
// under-handled while easy ones soak up attention.
export function assignTargets(members, hostiles) {
    const assignments = new Map(); // characterId -> hostileId
    const remainingCapacity = new Map(hostiles.map(h => [h.id, hostileCapacity(h)]));
    const freeMembers = [...members];
    const sortedHostiles = [...hostiles].sort((a, b) => hostileCapacity(b) - hostileCapacity(a));

    for (const hostile of sortedHostiles) {
        let cap = remainingCapacity.get(hostile.id);
        while (cap > 0 && freeMembers.length > 0) {
            let best = null, bestDist = Infinity;
            for (const member of freeMembers) {
                const d = dist2D(member.entity.location, hostile.location);
                if (d < bestDist) { bestDist = d; best = member; }
            }
            assignments.set(best.characterId, hostile.id);
            freeMembers.splice(freeMembers.indexOf(best), 1);
            cap -= 1;
        }
    }
    return assignments;
}

// Protect-priority list (Section 8.2): [player, healer-class members,
// current lowest-HP member, everyone else] - recomputed every cycle since
// health ranking changes constantly. Healer role isn't modeled by any
// real class yet (classData.js only has ranged/melee positioning so far) -
// this checks for it anyway so a healer class added later needs zero
// changes here.
export function computeProtectPriority(player, members) {
    const healers = members.filter(m => getClass(m.record.class).positioning.role === "healer");
    const bucketRank = { critical: 0, wounded: 1, healthy: 2 };
    const byHealth = [...members].sort((a, b) => bucketRank[healthBucket(a.entity)] - bucketRank[healthBucket(b.entity)]);
    const lowestHealth = byHealth[0];
    const rest = members.filter(m => !healers.includes(m) && m !== lowestHealth);

    const priority = [{ type: "player", ref: player }];
    for (const m of healers) priority.push({ type: "member", ref: m });
    if (lowestHealth) priority.push({ type: "member", ref: lowestHealth });
    for (const m of rest) priority.push({ type: "member", ref: m });
    return priority;
}

// Health-weighted reassignment: a critical-health member gets pulled onto
// "retreating" - a real behavioral consequence of the axis combination,
// not a separate state machine. Aggro-weighted reassignment ("whoever
// holds the most aggro needs backup") is left to whatever assigns
// `protector`/backup roles once that logic exists (Phase 7's playbooks) -
// this function only owns the health half, which is fully real today.
export function applyHealthReassignment(members) {
    for (const member of members) {
        if (healthBucket(member.entity) === "critical") {
            setEngagement(member.characterId, "retreating");
        }
    }
}

// Synchronized-ability throttling: a soft, in-memory budget so a squad
// never pops every defensive cooldown in the same window. This is the
// real gate; there's no ability system yet (Phase 10) to call it, but the
// primitive itself needs no ability data to exist and work correctly.
const lastDefensiveUse = new Map(); // squadId -> tick
const DEFENSIVE_THROTTLE_TICKS = 40; // ~2s

export function canUseDefensiveCooldown(squadId, currentTick) {
    return currentTick - (lastDefensiveUse.get(squadId) ?? -Infinity) >= DEFENSIVE_THROTTLE_TICKS;
}
export function recordDefensiveUse(squadId, currentTick) {
    lastDefensiveUse.set(squadId, currentTick);
}

// ---- Squad posture + derived cohesion/threat-saturation -------------------
// Both signals are derived-never-stored (Section 8.1) - callers get a
// fresh number every cycle, nothing to keep in sync.
export function cohesionSpread(members, centroid) {
    if (members.length === 0) return 0;
    return members.reduce((sum, m) => sum + dist2D(m.entity.location, centroid), 0) / members.length;
}

export function threatSaturation(members, hostiles) {
    const totalDemand = hostiles.reduce((sum, h) => sum + hostileCapacity(h), 0);
    return totalDemand / Math.max(1, members.length); // >1 means outnumbered
}

const SCATTER_THRESHOLD = 12; // blocks - beyond this, "in formation" reads as "scattered"
const OVERWHELMED_SATURATION = 1.5;

export function computePosture(squadId, player, members, hostiles, centroid) {
    if (members.length === 0) return "passive";

    const anyEngaged = members.some(m => getMemberAxes(m.characterId).awareness === "engaged");
    const anyAlerted = members.some(m => ["alerted", "suspicious"].includes(getMemberAxes(m.characterId).awareness));
    const saturation = threatSaturation(members, hostiles);
    const scatter = cohesionSpread(members, centroid);

    // "protecting": a live threat is genuinely closer to the player than
    // to any squad member - the squad's job right now is standing between
    // them, not just fighting wherever it happens to be standing.
    const playerIsClosestTarget = hostiles.some(h => {
        const distToPlayer = dist2D(player.location, h.location);
        const distToNearestMember = Math.min(...members.map(m => dist2D(m.entity.location, h.location)));
        return distToPlayer < distToNearestMember;
    });

    let posture;
    if (anyEngaged && saturation > OVERWHELMED_SATURATION) posture = "retreating";
    else if (anyEngaged && playerIsClosestTarget) posture = "protecting";
    else if (anyEngaged) posture = "engaged";
    else if (anyAlerted && scatter > SCATTER_THRESHOLD) posture = "regrouping";
    else if (anyAlerted) posture = "alert";
    else posture = "passive";

    squadPosture.set(squadId, posture);
    return posture;
}

export function getSquadPosture(squadId) {
    return squadPosture.get(squadId) ?? "passive";
}

export function clearSquadCoordination(squadId) {
    squadPosture.delete(squadId);
    lastDefensiveUse.delete(squadId);
}
