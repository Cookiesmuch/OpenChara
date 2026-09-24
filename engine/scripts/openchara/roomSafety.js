// Room Safety (plan Section 8.6): cumulative coverage tracking so
// "cleared" means real accumulated raycast coverage across a room's
// bounds, not just momentary LOS. Bounds are flood-filled ONCE per room on
// first definition, never per-tick - exactly the class of computation this
// project has already been burned by treating too casually elsewhere.
// Ephemeral, in-memory only (Section 8.11) - never a dynamic property.

import { floodFillPassable } from "./floodFill.js";

const CELL_XZ_SIZE = 2; // 2x2 block horizontal cells, per Section 8.6
const SAFE_COVERAGE_THRESHOLD = 0.9; // 90%+ seen-clear, not literally 100%

// roomId -> { bounds: Set<cellKey>, coverageGrid: Map<cellKey, "unseen"|"seen-clear"|"threat">, safe }
const rooms = new Map();

function cellKey(pos) {
    return `${Math.floor(pos.x / CELL_XZ_SIZE)},${Math.floor(pos.y)},${Math.floor(pos.z / CELL_XZ_SIZE)}`;
}

/**
 * Flood-fills from `start` to define a room's bounds. Call once per room,
 * on first entry - never repeatedly for the same room.
 */
export function defineRoom(roomId, dimension, start, maxBlocks = 400) {
    const cells = floodFillPassable(dimension, start, maxBlocks);
    const bounds = new Set(cells.map(cellKey));
    const coverageGrid = new Map();
    for (const key of bounds) coverageGrid.set(key, "unseen");
    const room = { bounds, coverageGrid, safe: false };
    rooms.set(roomId, room);
    return room;
}

export function getRoom(roomId) {
    return rooms.get(roomId) ?? null;
}

/**
 * Marks every grid cell a straight sweep from `fromPos` to `toPos` crosses
 * as covered - `sawThreat` marks the whole sweep as "threat" instead of
 * "seen-clear" (a real spotted hostile always wins over a prior
 * "seen-clear" mark for that cell).
 */
export function markSweepCoverage(roomId, fromPos, toPos, sawThreat = false) {
    const room = rooms.get(roomId);
    if (!room) return;
    const dist = Math.hypot(toPos.x - fromPos.x, toPos.y - fromPos.y, toPos.z - fromPos.z);
    const steps = Math.max(1, Math.ceil(dist));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = {
            x: fromPos.x + (toPos.x - fromPos.x) * t,
            y: fromPos.y + (toPos.y - fromPos.y) * t,
            z: fromPos.z + (toPos.z - fromPos.z) * t,
        };
        const key = cellKey(p);
        if (!room.bounds.has(key)) continue;
        if (sawThreat || room.coverageGrid.get(key) !== "threat") {
            room.coverageGrid.set(key, sawThreat ? "threat" : "seen-clear");
        }
    }
}

/**
 * Recomputes and returns `room.safe`: coverage% >= threshold AND zero live
 * hostiles currently in bounds (caller supplies that count from whatever
 * hostile scan it already ran this cycle - this function does no scanning
 * of its own).
 */
export function updateRoomSafety(roomId, liveHostilesInBounds) {
    const room = rooms.get(roomId);
    if (!room) return false;
    const total = room.bounds.size;
    const clear = [...room.coverageGrid.values()].filter(v => v === "seen-clear").length;
    const coveragePct = total > 0 ? clear / total : 0;
    room.safe = coveragePct >= SAFE_COVERAGE_THRESHOLD && liveHostilesInBounds === 0;
    return room.safe;
}

// A rough axis-aligned bounding box over the room's bounds, reduced to 4
// corner points (min/max X paired with min/max Z, at the room's average Y)
// - "near" vs "far" relative to a real entry point is a later polish
// detail, not needed for Room-Clear Cross Pattern to be genuinely testable.
export function getRoomCorners(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.bounds.size === 0) return [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, ySum = 0, count = 0;
    for (const key of room.bounds) {
        const [gx, gy, gz] = key.split(",").map(Number);
        const x = gx * CELL_XZ_SIZE, z = gz * CELL_XZ_SIZE;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        ySum += gy; count++;
    }
    const y = count > 0 ? ySum / count : 0;
    return [
        { x: minX, y, z: minZ }, { x: maxX, y, z: minZ },
        { x: minX, y, z: maxZ }, { x: maxX, y, z: maxZ },
    ];
}

export function coveragePercent(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.bounds.size === 0) return 0;
    const clear = [...room.coverageGrid.values()].filter(v => v === "seen-clear").length;
    return clear / room.bounds.size;
}

export function isPositionInRoom(roomId, pos) {
    const room = rooms.get(roomId);
    return room ? room.bounds.has(cellKey(pos)) : false;
}

export function clearRoom(roomId) {
    rooms.delete(roomId);
}
