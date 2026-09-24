// Manual control for Phase 7's auto-trigger layer (off by default).
//
//   /scriptevent <ns>:autotrigger on|off - enables/disables playbook auto-triggering

import { system } from "@minecraft/server";
import { setAutoTriggerEnabled, isAutoTriggerEnabled } from "../playbookTriggers.js";
import { NS, TAG } from "../ids.js";

system.afterEvents.scriptEventReceive.subscribe(event => {
    const player = event.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") return;
    if (event.id !== `${NS}:autotrigger`) return;

    const arg = (event.message ?? "").trim().toLowerCase();
    if (arg === "on") { setAutoTriggerEnabled(true); player.sendMessage(`§a[${TAG}] Auto-triggering enabled.`); }
    else if (arg === "off") { setAutoTriggerEnabled(false); player.sendMessage(`§e[${TAG}] Auto-triggering disabled.`); }
    else player.sendMessage(`§b[${TAG}] Auto-triggering is currently ${isAutoTriggerEnabled() ? "ON" : "OFF"}. Usage: ${NS}:autotrigger on|off`);
});
