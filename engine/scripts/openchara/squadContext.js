// Small shared helpers for anything that needs "this squad's currently
// manifested members, resolved to live entities" - used by both
// perceptionTick.js and coordinationTick.js so the gather logic exists in
// exactly one place.

import { world } from "@minecraft/server";
import { getManifestedMembers } from "./squads.js";

export function findEntity(entityId) {
    try { return world.getEntity(entityId); } catch (e) { return null; }
}

export function headOf(entity) {
    try { return entity.getHeadLocation(); } catch (e) { return entity.location; }
}

export function centroidOf(locations) {
    const sum = locations.reduce((a, l) => ({ x: a.x + l.x, y: a.y + l.y, z: a.z + l.z }), { x: 0, y: 0, z: 0 });
    const n = locations.length;
    return { x: sum.x / n, y: sum.y / n, z: sum.z / n };
}

export function dist2D(a, b) {
    const dx = a.x - b.x, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

// Members of `squad` that are both manifested AND resolve to a still-live
// entity - a member whose manifestation went stale gets silently skipped
// here (reconciliation, manifest.js, is what actually fixes that record).
export function gatherManifestedMembers(owner, squad) {
    return getManifestedMembers(owner, squad.id)
        .map(m => ({ ...m, entity: findEntity(m.record.manifestedEntityId) }))
        .filter(m => m.entity);
}
