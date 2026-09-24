// Built-in UI data providers and actions - the generic parts of any
// character UI, so a project's screens can show a roster and summon a
// character without writing JS. Projects add their own through api.js
// (registerUiProvider / registerUiAction / registerUiHandler), and may
// replace any of these by registering the same name again.
//
// Providers:
//   roster                     { characters: [view...], count, max, summoned }
//   character   (params.id)    { c: view } - one character
// A character view is her whole record (core + project fields) plus:
//   id, info (her characters/*.json entry), summoned, order, squad (name or null)
//
// Actions (usable in on:press):
//   summon(id)  recall(id)  teleport(id)  order(id, "follow"|"stay"|"wander"|"home")
//   summonAll()  recallAll()

import { world } from "@minecraft/server";
import { registerUiProvider, registerUiAction } from "./runtime.js";
import { readIndex } from "../characterIndex.js";
import { getCharacter, getOrder, setOrder, MAX_ROSTER } from "../characterRecord.js";
import { manifestCharacter, despawnCharacter, teleportToMe, getLastManifestFailure } from "../manifest.js";
import { getSquad } from "../squads.js";
import { getSpeciesInfo } from "../speciesData.js";
import { applyOrderToEntity } from "../orders.js";

function liveEntity(id) {
    try { const e = world.getEntity(id); return e?.isValid ? e : null; } catch (e) { return null; }
}

export function characterView(player, id) {
    const rec = getCharacter(player, id);
    if (!rec) return null;
    const squad = rec.squadId ? getSquad(player, rec.squadId) : null;
    return {
        ...rec,
        id,
        info: getSpeciesInfo(rec.species),
        summoned: Boolean(rec.manifestedEntityId && liveEntity(rec.manifestedEntityId)),
        order: getOrder(rec),
        squad: squad?.name ?? null,
    };
}

registerUiProvider("roster", player => {
    const characters = readIndex(player).map(e => characterView(player, e.id)).filter(Boolean);
    return { characters, count: characters.length, max: MAX_ROSTER, summoned: characters.filter(c => c.summoned).length };
});

registerUiProvider("character", (player, params) => ({ c: characterView(player, params.id) }));

function need(id) { if (!id) throw new Error("No character selected."); return id; }

registerUiAction("summon", (player, id) => {
    if (!manifestCharacter(player, need(id), player.location, player.dimension)) throw new Error(`Can't summon: ${getLastManifestFailure(id)}.`);
});
registerUiAction("recall", (player, id) => { despawnCharacter(player, need(id)); });
registerUiAction("teleport", (player, id) => {
    if (!teleportToMe(player, need(id), player.location, player.dimension)) throw new Error(`Can't teleport: ${getLastManifestFailure(id)}.`);
});
registerUiAction("order", (player, id, order) => {
    const rec = setOrder(player, need(id), order);
    const entity = rec?.manifestedEntityId ? liveEntity(rec.manifestedEntityId) : null;
    if (entity) applyOrderToEntity(entity, order);
});
registerUiAction("summonAll", player => {
    for (const e of readIndex(player)) {
        const rec = getCharacter(player, e.id);
        if (rec && !(rec.manifestedEntityId && liveEntity(rec.manifestedEntityId))) manifestCharacter(player, e.id, player.location, player.dimension);
    }
});
registerUiAction("recallAll", player => {
    for (const e of readIndex(player)) {
        if (getCharacter(player, e.id)?.manifestedEntityId) despawnCharacter(player, e.id);
    }
});
