// Built-in UI data providers and actions - the generic parts of any
// character UI, so a project's screens can manage a roster, squads, the
// trash and the database without writing JS. Projects add their own through
// api.js (registerUiProvider / registerUiAction / registerUiHandler), and may
// replace any of these by registering the same name again.
//
// Providers (<screen data="...">):
//   roster                   { characters: [view...], count, max, summoned }
//   character  (params.id)   { c: view } - one character
//   squads                   { squads: [squadView...], count, max, memberMax }
//   squad      (params.id)   { s: squadView, candidates: [view...], formations: [type...] }
//   trash                    { items: [{ id, nickname, level, info, daysLeft, canPurge }], count }
//   integrity                { checked, issues: [{ nickname, problem }], issueCount, healthy }
//   players                  { players: [{ id, name }], count } - everyone else online
//   settings                 { huds: { <id>: bool }, hudList: [{ id, on }], autoTactics }
//   species                  { species: [info...], count }
// A character view is her whole record (core + project fields) plus:
//   id, info (her characters/*.json entry), summoned, order, squad (name or null), captain (bool)
// A squad view: { id, name, count, max, captainId, captain (name), summoned, members: [view...] }
//
// Actions (usable in on:press; each returns a flash message for the next screen):
//   summon(id) recall(id) teleport(id) order(id, o) summonAll() recallAll()
//   rename(id) setHome(id) soulToken(id) release(id) give(id) exportBackup(id)
//   createSquad([id]) renameSquad(sq) disbandSquad(sq) joinSquad(sq, id) leaveSquad(id)
//   setCaptain(sq, id) squadSummon(sq) squadRecall(sq) squadOrder(sq, o)
//   formation(sq, type) breach(sq) hunt(sq) surround()
//   restore(id) purge(id) repair() importBackup()
//   toggleHud(hudId) toggleAutoTactics() startQuest(id, questId) turnInQuest(id, questId)

import { world } from "@minecraft/server";
import { registerUiProvider, registerUiAction, askText, confirm, choose } from "./runtime.js";
import { SCREENS } from "./screens.generated.js";
import { readIndex, isNicknameTaken } from "../characterIndex.js";
import {
    getCharacter, getOrder, setOrder, MAX_ROSTER, renameCharacter, setHomeLocation, releaseCharacter, restoreCharacter,
    isPastGracePeriod, TRASH_GRACE_PERIOD_MS, startQuest, tryCompleteQuest,
} from "../characterRecord.js";
import { manifestCharacter, despawnCharacter, teleportToMe, getLastManifestFailure } from "../manifest.js";
import {
    readSquads, getSquad, createSquad, renameSquad, deleteSquad, joinSquad, leaveSquad, setCaptain, getManifestedMembers,
    MAX_MEMBERS_PER_SQUAD, MAX_SQUADS_PER_PLAYER,
} from "../squads.js";
import { SPECIES, getSpeciesInfo } from "../speciesData.js";
import { applyOrderToEntity } from "../orders.js";
import { createSoulToken } from "../souls.js";
import { listTrash, scanIntegrity, purgeCharacter } from "../dbMaintenance.js";
import { exportCharacter, importCharacter, transferCharacter } from "../dbTransfer.js";
import { executeFormation, FORMATION_TYPES } from "../formations.js";
import { detectChokePoints } from "../chokePoints.js";
import { breachStack } from "../playbooks.js";
import { pickHuntTarget, startHunt } from "../hunt.js";
import { envelopTarget } from "../army.js";
import { setAutoTriggerEnabled, isAutoTriggerEnabled } from "../playbookTriggers.js";
import { QUESTS } from "../quests.js";
import { setHudEnabled, isHudEnabled, listHuds } from "./hud.js";
import { N } from "../ids.js";

function liveEntity(id) {
    try { const e = id && world.getEntity(id); return e?.isValid ? e : null; } catch (e) { return null; }
}

export function characterView(player, id) {
    const rec = getCharacter(player, id);
    if (!rec) return null;
    const squad = rec.squadId ? getSquad(player, rec.squadId) : null;
    return {
        ...rec,
        id,
        info: getSpeciesInfo(rec.species),
        summoned: Boolean(liveEntity(rec.manifestedEntityId)),
        order: getOrder(rec),
        squad: squad?.name ?? null,
        captain: Boolean(squad && squad.captainId === id),
    };
}

function squadView(player, squad) {
    const members = squad.memberIds.map(id => characterView(player, id)).filter(Boolean);
    return {
        id: squad.id,
        name: squad.name,
        count: members.length,
        max: MAX_MEMBERS_PER_SQUAD,
        captainId: squad.captainId,
        captain: members.find(m => m.id === squad.captainId)?.nickname ?? null,
        summoned: members.filter(m => m.summoned).length,
        members,
    };
}

// ---- providers --------------------------------------------------------------------------
registerUiProvider("roster", player => {
    const characters = readIndex(player).map(e => characterView(player, e.id)).filter(Boolean);
    return { characters, count: characters.length, max: MAX_ROSTER, summoned: characters.filter(c => c.summoned).length };
});

registerUiProvider("character", (player, params) => ({ c: characterView(player, params.id) }));

registerUiProvider("squads", player => {
    const squads = readSquads(player).map(s => squadView(player, s));
    return { squads, count: squads.length, max: MAX_SQUADS_PER_PLAYER, memberMax: MAX_MEMBERS_PER_SQUAD };
});

registerUiProvider("squad", (player, params) => {
    const squad = getSquad(player, params.id);
    if (!squad) return { s: null, candidates: [], formations: FORMATION_TYPES };
    const candidates = readIndex(player).filter(e => !squad.memberIds.includes(e.id)).map(e => characterView(player, e.id)).filter(Boolean);
    return { s: squadView(player, squad), candidates, formations: FORMATION_TYPES };
});

registerUiProvider("trash", player => {
    const items = listTrash(player).map(({ id, record }) => ({
        id,
        nickname: record.nickname,
        level: record.level,
        info: getSpeciesInfo(record.species),
        daysLeft: Math.max(0, Math.ceil((record.deletedAt + TRASH_GRACE_PERIOD_MS - Date.now()) / 86400000)),
        canPurge: isPastGracePeriod(record),
    }));
    return { items, count: items.length };
});

registerUiProvider("integrity", player => {
    const { checked, issues } = scanIntegrity(player, { repair: false });
    return { checked, issues, issueCount: issues.length, healthy: issues.length === 0 };
});

registerUiProvider("players", player => {
    const players = world.getAllPlayers().filter(p => p.id !== player.id).map(p => ({ id: p.id, name: p.name }));
    return { players, count: players.length };
});

registerUiProvider("settings", player => {
    const huds = {};
    for (const id of listHuds()) huds[id] = isHudEnabled(player, id);
    return { huds, hudList: listHuds().map(id => ({ id, on: huds[id] })), autoTactics: isAutoTriggerEnabled() };
});

registerUiProvider("species", () => {
    const species = Object.values(SPECIES).sort((a, b) => a.index - b.index).map(s => getSpeciesInfo(s.id));
    return { species, count: species.length };
});

// ---- helpers --------------------------------------------------------------------------
function need(id) { if (!id) throw new Error(`No ${N.one} selected.`); return id; }
function needRecord(player, id) {
    const rec = getCharacter(player, need(id));
    if (!rec) throw new Error(`That ${N.one}'s record couldn't be read - run the integrity check.`);
    return rec;
}
function needSquad(player, squadId) {
    const s = getSquad(player, squadId);
    if (!s) throw new Error("That squad no longer exists.");
    return s;
}
function giveOrder(player, id, order) {
    const rec = setOrder(player, id, order);
    const entity = liveEntity(rec?.manifestedEntityId);
    if (entity) applyOrderToEntity(entity, order);
    return rec;
}
function presentMembers(player, squadId) {
    return getManifestedMembers(player, squadId)
        .map(m => ({ ...m, entity: liveEntity(m.record.manifestedEntityId) }))
        .filter(m => m.entity);
}
function summonMany(player, ids) {
    let n = 0;
    for (const id of ids) {
        const rec = getCharacter(player, id);
        if (rec && !liveEntity(rec.manifestedEntityId) && manifestCharacter(player, id, player.location, player.dimension)) n++;
    }
    return n;
}
function recallMany(player, ids) {
    let n = 0;
    for (const id of ids) if (getCharacter(player, id)?.manifestedEntityId && despawnCharacter(player, id)) n++;
    return n;
}

// Loops until the player gives a unique, non-empty name or cancels (null).
export async function askNickname(player, { title = "Nickname", value = "", excludingId = null } = {}) {
    let current = value;
    for (;;) {
        const raw = await askText(player, { title, label: "Nickname", placeholder: "Enter a nickname", value: current });
        if (raw === null) return null;
        const name = raw.trim();
        current = name;
        if (!name) continue;
        if (name.length > 32) { current = name.slice(0, 32); continue; }
        if (isNicknameTaken(player, name, excludingId)) continue;
        return name;
    }
}

async function askSquadName(player, value = "") {
    const raw = await askText(player, { title: "Squad Name", label: "Name", placeholder: "e.g. Alpha", value });
    const name = raw?.trim().slice(0, 24);
    return name || null;
}

// ---- one character ----------------------------------------------------------------------
registerUiAction("summon", (player, id) => {
    const rec = needRecord(player, id);
    if (!manifestCharacter(player, id, player.location, player.dimension)) throw new Error(`Can't summon: ${getLastManifestFailure(id)}.`);
    return `${rec.nickname} appears!`;
});
registerUiAction("recall", (player, id) => {
    const rec = needRecord(player, id);
    despawnCharacter(player, id);
    return `${rec.nickname} returns to the Codex.`;
});
registerUiAction("teleport", (player, id) => {
    const rec = needRecord(player, id);
    if (!teleportToMe(player, id, player.location, player.dimension)) throw new Error(`Can't teleport: ${getLastManifestFailure(id)}.`);
    return `${rec.nickname} is by your side.`;
});
registerUiAction("order", (player, id, order) => {
    const rec = needRecord(player, id);
    if (order === "home" && !rec.homeLocation) throw new Error("Set her home first.");
    giveOrder(player, id, order);
    return `${rec.nickname}: ${order} - got it!`;
});
registerUiAction("summonAll", player => `Summoned ${summonMany(player, readIndex(player).map(e => e.id))}.`);
registerUiAction("recallAll", player => `Recalled ${recallMany(player, readIndex(player).map(e => e.id))}.`);

registerUiAction("rename", async (player, id) => {
    const rec = needRecord(player, id);
    const name = await askNickname(player, { title: "Rename", value: rec.nickname, excludingId: id });
    if (!name || name === rec.nickname) return null;
    if (!renameCharacter(player, id, name)) throw new Error("Rename failed.");
    const ent = liveEntity(getCharacter(player, id)?.manifestedEntityId);
    if (ent) ent.nameTag = name;
    return `${rec.nickname} is now ${name}.`;
});
registerUiAction("setHome", (player, id) => {
    const rec = needRecord(player, id);
    const l = player.location;
    setHomeLocation(player, id, { x: l.x, y: l.y, z: l.z, dimension: player.dimension.id });
    return `${rec.nickname}'s home is set here.`;
});
registerUiAction("soulToken", (player, id) => {
    const rec = needRecord(player, id);
    createSoulToken(player, id);
    return `${rec.nickname}'s Soul Token is in your inventory.`;
});
registerUiAction("release", async (player, id) => {
    const rec = needRecord(player, id);
    const days = TRASH_GRACE_PERIOD_MS / 86400000;
    const ok = await confirm(player, {
        title: `Release ${rec.nickname}?`,
        body: `She moves to the Trash. Nothing is deleted - restore her any time in the next ${days} days.`,
        yes: "Release", no: "Keep her", danger: true,
    });
    if (!ok) return null;
    if (rec.manifestedEntityId) despawnCharacter(player, id);
    if (rec.squadId) leaveSquad(player, id);
    if (!releaseCharacter(player, id)) throw new Error("Release failed.");
    return { back: true, flash: `${rec.nickname} was released to the Trash.` };
});
registerUiAction("give", async (player, id) => {
    const rec = needRecord(player, id);
    const others = world.getAllPlayers().filter(p => p.id !== player.id);
    if (!others.length) throw new Error("Nobody else is online.");
    const targetId = SCREENS.give ? await choose(player, "give", id) : others[0].id;
    const target = others.find(p => p.id === targetId);
    if (!target) return null;
    if (!await confirm(player, { title: `Give ${rec.nickname} to ${target.name}?`, body: "She keeps her level, stats and bonds. This is permanent unless they give her back.", yes: "Give", no: "Cancel", danger: true })) return null;
    if (rec.manifestedEntityId) despawnCharacter(player, id);
    const r = transferCharacter(player, target, id);
    if (!r.ok) throw new Error(r.reason);
    try { target.sendMessage(`§d${player.name} gave you ${r.nickname}!`); } catch (e) { /* left */ }
    return { back: true, flash: `${r.nickname} now belongs to ${target.name}.` };
});
registerUiAction("exportBackup", async (player, id) => {
    const text = exportCharacter(player, need(id));
    await askText(player, { title: "Export Backup", label: `Select all (Ctrl+A) and copy (Ctrl+C) this somewhere safe. ${text.length} characters.`, value: text });
    return null;
});

// ---- squads -------------------------------------------------------------------------------
registerUiAction("createSquad", async (player, id) => {
    const name = await askSquadName(player);
    if (!name) return null;
    const sq = createSquad(player, name);
    if (id) { joinSquad(player, sq.id, id); setCaptain(player, sq.id, id); }
    return `Squad ${name} created.`;
});
registerUiAction("renameSquad", async (player, squadId) => {
    const s = needSquad(player, squadId);
    const name = await askSquadName(player, s.name);
    if (!name) return null;
    renameSquad(player, squadId, name);
    return `Renamed to ${name}.`;
});
registerUiAction("disbandSquad", async (player, squadId) => {
    const s = needSquad(player, squadId);
    if (!await confirm(player, { title: `Disband ${s.name}?`, body: "Members stay in your roster, just without a squad.", yes: "Disband", no: "Cancel", danger: true })) return null;
    deleteSquad(player, squadId);
    return { back: true, flash: `${s.name} was disbanded.` };
});
registerUiAction("joinSquad", (player, squadId, id) => {
    const s = needSquad(player, squadId);
    const rec = needRecord(player, id);
    joinSquad(player, squadId, id);
    return `${rec.nickname} joined ${s.name}.`;
});
registerUiAction("leaveSquad", (player, id) => {
    const rec = needRecord(player, id);
    leaveSquad(player, id);
    return `${rec.nickname} left her squad.`;
});
registerUiAction("setCaptain", (player, squadId, id) => {
    const rec = needRecord(player, id);
    setCaptain(player, squadId, id);
    return `${rec.nickname} is now captain.`;
});
registerUiAction("squadSummon", (player, squadId) => `Summoned ${summonMany(player, needSquad(player, squadId).memberIds)}.`);
registerUiAction("squadRecall", (player, squadId) => `Recalled ${recallMany(player, needSquad(player, squadId).memberIds)}.`);
registerUiAction("squadOrder", (player, squadId, order) => {
    const s = needSquad(player, squadId);
    let n = 0;
    for (const id of s.memberIds) {
        const r = getCharacter(player, id);
        if (!r || (order === "home" && !r.homeLocation)) continue;
        giveOrder(player, id, order);
        n++;
    }
    return `${s.name}: ${order} (${n}).`;
});
registerUiAction("formation", (player, squadId, type) => {
    const s = needSquad(player, squadId);
    const members = presentMembers(player, squadId);
    if (!members.length) throw new Error("No summoned members - summon the squad first.");
    const started = executeFormation(type, player.dimension, player.location, player.getViewDirection(), player.location, members);
    return { close: true, flash: `${s.name}: ${type} (${started}/${members.length} moving).` };
});
registerUiAction("breach", (player, squadId) => {
    const s = needSquad(player, squadId);
    const members = presentMembers(player, squadId);
    if (!members.length) throw new Error("No summoned members.");
    const points = detectChokePoints(player.dimension, player.location, 200);
    if (!points.length) throw new Error("No doorway or choke point near you.");
    breachStack(members, points[0], player.getViewDirection(), player.dimension, () => { try { player.sendMessage(`§a${s.name}: breach complete.`); } catch (e) { /* left */ } });
    return { close: true };
});
registerUiAction("hunt", (player, squadId) => {
    const s = needSquad(player, squadId);
    const members = presentMembers(player, squadId);
    if (!members.length) throw new Error("No summoned members.");
    const target = pickHuntTarget(player);
    if (!target) throw new Error("Nothing huntable nearby - look at an animal or mob.");
    const desc = startHunt(members, target, msg => { try { player.sendMessage(msg); } catch (e) { /* left */ } });
    if (!desc) throw new Error("Couldn't start the hunt.");
    try { player.sendMessage(`§d${s.name} is stalking: ${desc}.`); } catch (e) { /* left */ }
    return { close: true };
});
registerUiAction("surround", player => {
    const target = pickHuntTarget(player);
    if (!target) throw new Error("Look at a mob first.");
    const n = envelopTarget(player, target);
    if (!n) throw new Error("No squads have summoned members.");
    try { player.sendMessage(`§d${n} squad(s) surrounding the ${target.typeId.replace("minecraft:", "")}.`); } catch (e) { /* left */ }
    return { close: true };
});

// ---- trash & database ------------------------------------------------------------------------
registerUiAction("restore", (player, id) => {
    const rec = needRecord(player, id);
    if (isNicknameTaken(player, rec.nickname)) throw new Error(`You already have a ${N.one} named "${rec.nickname}" - rename one first.`);
    if (!restoreCharacter(player, id)) throw new Error("Restore failed.");
    return `${rec.nickname} is back in your roster!`;
});
registerUiAction("purge", async (player, id) => {
    const rec = needRecord(player, id);
    if (!await confirm(player, { title: "Delete forever?", body: `This permanently erases ${rec.nickname}: record, backups, stats and bonds. Export a backup first if you might want her again.`, yes: "Delete forever", no: "Cancel", danger: true })) return null;
    const r = purgeCharacter(player, id);
    if (!r.ok) throw new Error(r.reason);
    return `${rec.nickname} was permanently deleted.`;
});
registerUiAction("repair", player => {
    const r = scanIntegrity(player, { repair: true });
    return `Repaired ${r.issues.filter(i => i.fixed).length} issue(s).`;
});
registerUiAction("importBackup", async player => {
    const text = await askText(player, { title: "Import Backup", label: "Paste a backup string", placeholder: "CWX1|..." });
    if (!text) return null;
    let result = importCharacter(player, text);
    if (!result.ok && result.needsNickname) {
        const name = await askNickname(player, { title: "Name the import" });
        if (!name) return null;
        result = importCharacter(player, text, name);
    }
    if (!result.ok) throw new Error(result.reason);
    return `${result.nickname} was restored from backup!`;
});

// ---- settings --------------------------------------------------------------------------------
registerUiAction("toggleHud", (player, hudId) => { setHudEnabled(player, hudId, !isHudEnabled(player, hudId)); });
registerUiAction("toggleAutoTactics", () => { setAutoTriggerEnabled(!isAutoTriggerEnabled()); });

// ---- quests ----------------------------------------------------------------------------------
registerUiAction("startQuest", (player, id, questId) => {
    const rec = needRecord(player, id);
    startQuest(player, id, questId);
    return `${rec.nickname} started "${QUESTS[questId]?.title ?? questId}".`;
});
registerUiAction("turnInQuest", (player, id, questId) => {
    const done = tryCompleteQuest(player, need(id), questId);
    if (!done) throw new Error("Not finished yet.");
    return `Quest complete: ${QUESTS[questId]?.title ?? questId}!`;
});
