// The army tick (plan Section 8.2, Coordination, one level above the squad
// tick): with two or more squads in the field, nearby hostiles are
// clustered, squads are assigned to clusters so the army spreads across
// multiple fronts instead of every squad bunching onto the nearest threat,
// and squads sharing one cluster split its circle into arcs (Squad A takes
// 0-180°, Squad B 180-360°) so they envelop it jointly - Double
// Envelopment (#7) / Anvil and Hammer (#19) shaped, instead of colliding.
//
// Much slower than the squad tick (every ARMY_INTERVAL_TICKS) and only
// re-issues movement when the plan actually changes (a new assignment or a
// cluster that drifted), per the anti-jank rule in Section 8.3.
//
// Two entry points: the automatic tick (only while Auto-Tactics is on) and
// envelopTarget() for a manual "all squads, surround that" command.

import { world, system } from "@minecraft/server";
import { readSquads } from "./squads.js";
import { gatherManifestedMembers, centroidOf, dist2D } from "./squadContext.js";
import { findNearbyHostiles } from "./perception.js";
import { navigateToCoordinate } from "./navigation.js";
import { setTaskLock } from "./fsm.js";
import { isAutoTriggerEnabled } from "./playbookTriggers.js";
import { TAG } from "./ids.js";

const ARMY_INTERVAL_TICKS = 60;
const CLUSTER_LINK_DISTANCE = 8;
const REPLAN_DRIFT = 5;
const LOCK_TICKS = 100;

// playerId -> last plan signature + cluster centroids, for change detection.
const lastPlans = new Map();

// Single-linkage clustering: two hostiles within CLUSTER_LINK_DISTANCE are
// in the same cluster. Tiny n (a handful of mobs), so O(n^2) is fine.
export function clusterHostiles(hostiles) {
    const clusters = [];
    const seen = new Set();
    for (const h of hostiles) {
        if (seen.has(h.id)) continue;
        const group = [h];
        seen.add(h.id);
        for (let i = 0; i < group.length; i++) {
            for (const other of hostiles) {
                if (seen.has(other.id)) continue;
                if (dist2D(group[i].location, other.location) <= CLUSTER_LINK_DISTANCE) { seen.add(other.id); group.push(other); }
            }
        }
        const centroid = centroidOf(group.map(g => g.location));
        const spread = Math.max(0, ...group.map(g => dist2D(g.location, centroid)));
        clusters.push({ members: group, centroid, spread, size: group.length });
    }
    return clusters.sort((a, b) => b.size - a.size);
}

// Greedy: every cluster first gets its nearest free squad (spread across
// fronts); leftover squads reinforce the biggest cluster(s).
export function assignSquadsToClusters(squads, clusters) {
    const assignment = new Map(); // squadId -> cluster index
    const free = [...squads];
    for (let ci = 0; ci < clusters.length && free.length > 0; ci++) {
        free.sort((a, b) => dist2D(a.centroid, clusters[ci].centroid) - dist2D(b.centroid, clusters[ci].centroid));
        assignment.set(free.shift().squad.id, ci);
    }
    let ci = 0;
    while (free.length > 0 && clusters.length > 0) { assignment.set(free.shift().squad.id, ci % clusters.length); ci++; }
    return assignment;
}

// Places `squadMembers` evenly inside arc [a0, a1) around `center`.
function arcPositions(center, radius, a0, a1, count) {
    return Array.from({ length: count }, (_, i) => {
        const a = a0 + ((i + 0.5) / count) * (a1 - a0);
        return { x: center.x + Math.cos(a) * radius, y: center.y, z: center.z + Math.sin(a) * radius };
    });
}

function moveArcs(squadsOnCluster, center, radius, dimension) {
    const n = squadsOnCluster.length;
    squadsOnCluster.forEach((sq, k) => {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        const positions = arcPositions(center, radius, a0, a1, sq.members.length);
        const lockUntil = system.currentTick + LOCK_TICKS;
        sq.members.forEach((m, i) => {
            setTaskLock(m.characterId, "army", lockUntil);
            navigateToCoordinate(m.entity, positions[i].x, positions[i].y, positions[i].z, dimension);
        });
    });
}

function fieldedSquads(player) {
    return readSquads(player)
        .map(squad => ({ squad, members: gatherManifestedMembers(player, squad) }))
        .filter(s => s.members.length > 0)
        .map(s => ({ ...s, centroid: centroidOf(s.members.map(m => m.entity.location)) }));
}

// Manual command: every fielded squad envelops one entity, each on its own arc.
export function envelopTarget(player, target) {
    const squads = fieldedSquads(player);
    if (squads.length === 0 || !target?.isValid) return 0;
    moveArcs(squads, target.location, 5, target.dimension);
    return squads.length;
}

function tickPlayer(player) {
    const squads = fieldedSquads(player);
    if (squads.length < 2) { lastPlans.delete(player.id); return; }
    const hostiles = findNearbyHostiles(player.dimension, player.location, 32);
    if (hostiles.length === 0) { lastPlans.delete(player.id); return; }

    const clusters = clusterHostiles(hostiles);
    const assignment = assignSquadsToClusters(squads, clusters);
    const signature = [...assignment.entries()].sort().map(([s, c]) => `${s}:${c}:${clusters[c].size}`).join("|");
    const prev = lastPlans.get(player.id);
    const drifted = prev && clusters.some((c, i) => prev.centroids[i] && dist2D(c.centroid, prev.centroids[i]) > REPLAN_DRIFT);
    if (prev && prev.signature === signature && !drifted) return;
    lastPlans.set(player.id, { signature, centroids: clusters.map(c => c.centroid) });

    const summary = [];
    clusters.forEach((cluster, ci) => {
        const onCluster = squads.filter(s => assignment.get(s.squad.id) === ci);
        if (onCluster.length === 0) return;
        moveArcs(onCluster, cluster.centroid, 4 + cluster.spread, player.dimension);
        summary.push(`${onCluster.map(s => s.squad.name).join("+")} → ${cluster.size} hostile(s)${onCluster.length > 1 ? " (envelop)" : ""}`);
    });
    try { player.onScreenDisplay.setActionBar(`§6Army: ${summary.join(" · ")}`); } catch (e) { /* fine */ }
}

export function startArmyLoop() {
    system.runInterval(() => {
        if (!isAutoTriggerEnabled()) return;
        for (const player of world.getAllPlayers()) {
            try { tickPlayer(player); } catch (e) { console.warn(`[${TAG}] Army tick failed for ${player.name}: ${e}`); }
        }
    }, ARMY_INTERVAL_TICKS);
}
