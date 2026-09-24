// The axis-based individual state machine (plan Section 8.1). Never a flat
// enum of "states" - a member's effective behavior is always the
// combination of several small, independent axes. All of it is ephemeral,
// in-memory state (Section 8.11) - never a durable dynamic property. A
// world/script restart resetting this to a blank slate mid-fight is
// correct, cheap behavior for short-term combat memory, not data loss.

export const AWARENESS = ["unaware", "suspicious", "alerted", "engaged"];
export const ENGAGEMENT = ["disengaged", "approaching", "positioning", "attacking", "on-cooldown", "suppressed", "retreating", "regrouping"];
export const POSITIONING_STATUS = ["in-position", "moving", "blocked", "out-of-formation"];

// characterId -> { awareness, engagement, positioningStatus, assignment }
const memberAxes = new Map();

function defaultAxes() {
    return { awareness: "unaware", engagement: "disengaged", positioningStatus: "in-position", assignment: { type: "unassigned" } };
}

export function getMemberAxes(characterId) {
    if (!memberAxes.has(characterId)) memberAxes.set(characterId, defaultAxes());
    return memberAxes.get(characterId);
}

export function setAwareness(characterId, level) {
    if (!AWARENESS.includes(level)) throw new Error(`Unknown awareness level "${level}"`);
    getMemberAxes(characterId).awareness = level;
}

export function setEngagement(characterId, state) {
    if (!ENGAGEMENT.includes(state)) throw new Error(`Unknown engagement state "${state}"`);
    getMemberAxes(characterId).engagement = state;
}

export function setPositioningStatus(characterId, status) {
    if (!POSITIONING_STATUS.includes(status)) throw new Error(`Unknown positioning status "${status}"`);
    getMemberAxes(characterId).positioningStatus = status;
}

export function setAssignment(characterId, assignment) {
    getMemberAxes(characterId).assignment = assignment;
}

// Health bucket is derived live from HP%, never stored (Section 8.1).
export function healthBucket(entity) {
    try {
        const health = entity.getComponent("minecraft:health");
        if (!health) return "healthy";
        const pct = health.currentValue / health.effectiveMax;
        if (pct > 0.66) return "healthy";
        if (pct > 0.33) return "wounded";
        return "critical";
    } catch (e) {
        return "healthy";
    }
}

export function clearMemberAxes(characterId) {
    memberAxes.delete(characterId);
}

// Task lock: a multi-step maneuver (hunt staging, army envelopment) claims
// a member so the standing-order loop (orders.js) doesn't drag her back to
// her player mid-maneuver. `untilTick` bounds it so a maneuver that never
// finishes can't strand her forever.
const taskLocks = new Map(); // characterId -> { label, untilTick }

export function setTaskLock(characterId, label, untilTick) { taskLocks.set(characterId, { label, untilTick }); }
export function clearTaskLock(characterId) { taskLocks.delete(characterId); }
export function getTaskLock(characterId, currentTick) {
    const lock = taskLocks.get(characterId);
    if (!lock) return null;
    if (currentTick > lock.untilTick) { taskLocks.delete(characterId); return null; }
    return lock;
}
