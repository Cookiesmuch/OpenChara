// Engine bootstrap. The build generates the pack's scripts/main.js, which
// calls startOpenChara() first, then imports dev tools (if the project
// enables them) and every content script from the project's PATCHES.

import { world, system } from "@minecraft/server";
import { startReconciliationLoop, startSelfPolicingLoop } from "./manifest.js";
import { startDimensionFollowHandlers } from "./dimensionFollow.js";
import { startPerceptionLoop } from "./perceptionTick.js";
import { startCoordinationLoop } from "./coordinationTick.js";
import { startPlaybookTriggerLoop } from "./playbookTriggers.js";
import { startStatTracking } from "./statTracking.js";
import { startOrderLoop } from "./orders.js";
import { runJoinMaintenance } from "./dbMaintenance.js";
import { startHuntLoop } from "./hunt.js";
import { startArmyLoop } from "./army.js";
import { registerSouls } from "./souls.js";
import { TAG } from "./ids.js";
import "./ui/builtins.js"; // built-in UI providers + actions (registered at load)

let started = false;

export function startOpenChara() {
    if (started) return;
    started = true;

    startReconciliationLoop();
    startSelfPolicingLoop();
    startDimensionFollowHandlers();
    startPerceptionLoop();
    startCoordinationLoop();
    startPlaybookTriggerLoop();
    startStatTracking();
    startOrderLoop();
    startHuntLoop();
    startArmyLoop();
    registerSouls();

    // Self-healing on join: a full integrity scan + repair (which also runs
    // pending schema migrations) for each player once when they join, and
    // once for everyone already online after a /reload.
    const maintain = player => {
        try { runJoinMaintenance(player); } catch (e) { console.warn(`[${TAG}] Join maintenance failed for ${player.name}: ${e}`); }
    };
    world.afterEvents.playerSpawn.subscribe(event => {
        if (event.initialSpawn) system.runTimeout(() => maintain(event.player), 60);
    });
    system.runTimeout(() => {
        for (const player of world.getAllPlayers()) maintain(player);
        try { world.sendMessage(`§d[${TAG}] Script pack loaded and running.`); } catch (e) { }
    }, 20);
}
