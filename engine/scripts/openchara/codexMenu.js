// The Character Codex - the player-facing front end for the whole database.
// Modal ActionForm/ModalForm/MessageForm screens (server-ui) standing in
// until the full custom json-ui GUI (Phase 11) exists. Everything here is
// UI only: every change goes through the same record/squad/maintenance
// functions the rest of the addon uses, never a raw property write.
//
// Opened by using the cw:character_codex item, or by interacting with one of
// your own manifested characters (empty hand or holding the Codex).

import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { readIndex, isNicknameTaken } from "./characterIndex.js";
import {
    createCharacter, getCharacter, renameCharacter, releaseCharacter, restoreCharacter, isPastGracePeriod, TRASH_GRACE_PERIOD_MS,
    unlockSkill, startQuest, tryCompleteQuest, setOrder, getOrder, ORDERS, setHomeLocation, xpToNextLevel, MAX_LEVEL,
    raiseEidolon, MAX_EIDOLON, MAX_ROSTER,
} from "./characterRecord.js";
import { createSoulToken } from "./souls.js";
import { transferCharacter } from "./dbTransfer.js";
import { manifestCharacter, despawnCharacter, teleportToMe, getLastManifestFailure } from "./manifest.js";
import { readSquads, getSquad, createSquad, joinSquad, leaveSquad, deleteSquad, renameSquad, setCaptain, getManifestedMembers, MAX_MEMBERS_PER_SQUAD, MAX_SQUADS_PER_PLAYER } from "./squads.js";
import { readCounters } from "./counters.js";
import { getBondBetween } from "./characterRecord.js";
import { getClass, getAbility } from "./classData.js";
import { SPECIES, getSpeciesInfo } from "./speciesData.js";
import { QUESTS, questAvailableTo } from "./quests.js";
import { evaluateCondition, describeProgress } from "./conditions.js";
import { readCounter } from "./counters.js";
import { scanIntegrity, listTrash, purgeCharacter } from "./dbMaintenance.js";
import { exportCharacter, importCharacter } from "./dbTransfer.js";
import { applyOrderToEntity } from "./orders.js";
import { executeFormation, FORMATION_TYPES } from "./formations.js";
import { detectChokePoints } from "./chokePoints.js";
import { breachStack } from "./playbooks.js";
import { setAutoTriggerEnabled, isAutoTriggerEnabled } from "./playbookTriggers.js";
import { pickHuntTarget, startHunt } from "./hunt.js";
import { envelopTarget } from "./army.js";
import { NS, CHAR, N, TAG } from "./ids.js";

export const CODEX_ITEM = `${NS}:${CHAR}_codex`;
export const SCROLL_ITEM = `${NS}:summon_scroll`;

const ORDER_LABELS = { follow: "Follow me", stay: "Stay here", wander: "Wander freely", home: "Go home" };

// ---- small helpers ----------------------------------------------------------
function findEntity(entityId) {
    try { const e = world.getEntity(entityId); return e?.isValid ? e : null; } catch (e) { return null; }
}
function isManifested(record) { return Boolean(record?.manifestedEntityId && findEntity(record.manifestedEntityId)); }
function fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(n < 1 ? 2 : 1); }
function pct(n) { return `${Math.round(n * 100)}%`; }
function isCreative(player) {
    try { return String(player.getGameMode()).toLowerCase() === "creative"; } catch (e) { return false; }
}
function say(player, msg) { try { player.sendMessage(msg); } catch (e) { /* offline */ } }

async function show(player, form) {
    // A form can't open over chat/another screen ("UserBusy") - retry
    // briefly instead of silently failing, the standard server-ui pattern.
    for (let i = 0; i < 20; i++) {
        const res = await form.show(player);
        if (!(res.canceled && res.cancelationReason === "UserBusy")) return res;
        await new Promise(r => system.runTimeout(r, 5));
    }
    return { canceled: true };
}

async function confirm(player, title, body, yes = "Confirm", no = "Cancel") {
    const res = await show(player, new MessageFormData().title(title).body(body).button1(yes).button2(no));
    return !res.canceled && res.selection === 0;
}

// Buttons + handlers built together so the index can never drift.
async function menu(player, title, body, entries) {
    const form = new ActionFormData().title(title).body(body);
    for (const e of entries) form.button(e.label);
    const res = await show(player, form);
    if (res.canceled || res.selection === undefined) return;
    await entries[res.selection]?.run?.();
}

// Rich-content renderer (Section 1.7): the one switch over block type.
function renderContent(blocks, checked = {}) {
    const lines = [];
    for (const b of blocks ?? []) {
        switch (b.type) {
            case "text": lines.push(b.value); break;
            case "heading": lines.push(`§l${b.value}§r`); break;
            case "bulletList": for (const i of b.items) lines.push(` • ${i}`); break;
            case "numberedList": b.items.forEach((i, n) => lines.push(` ${n + 1}. ${i}`)); break;
            case "checklist": for (const i of b.items) lines.push(` ${checked[i.id] ? "§a[x]" : "§7[ ]"} ${i.text}§r`); break;
            default: break;
        }
    }
    return lines.join("\n");
}

// ---- entry points -----------------------------------------------------------
export function openCodex(player) {
    mainMenu(player).catch(e => { console.warn(`[${TAG}] Codex error: ${e}`); say(player, `§c[${TAG}] Codex error: ${e?.message ?? e}`); });
}

export function openCharacterPage(player, characterId) {
    characterPage(player, characterId).catch(e => { console.warn(`[${TAG}] Codex error: ${e}`); say(player, `§c[${TAG}] Codex error: ${e?.message ?? e}`); });
}

async function mainMenu(player) {
    const roster = readIndex(player);
    const summoned = roster.filter(e => isManifested(getCharacter(player, e.id))).length;
    const squads = readSquads(player);
    const trash = listTrash(player);
    await menu(player, `${N.One} Codex`, `§7${roster.length}/${MAX_ROSTER} ${N.one}(s) · ${summoned} summoned · ${squads.length} squad(s)
§8Tip: right-click your ${N.one} with a flower, cake or cookie to give her a gift.`, [
        { label: `My ${N.Many} (${roster.length})`, run: () => rosterMenu(player) },
        { label: `Summon a New ${N.One}`, run: () => summonNew(player) },
        { label: `Squads (${squads.length}/${MAX_SQUADS_PER_PLAYER})`, run: () => squadsMenu(player) },
        { label: "Summon Everyone to Me", run: () => { summonAll(player, roster.map(e => e.id)); } },
        { label: "Recall Everyone", run: () => { recallAll(player, roster.map(e => e.id)); } },
        { label: "All Squads: Surround Target", run: () => {
            const target = pickHuntTarget(player);
            if (!target) { say(player, "§cLook at a mob first."); return; }
            const n = envelopTarget(player, target);
            say(player, n ? `§d${n} squad(s) enveloping the ${target.typeId.replace("minecraft:", "")}.` : "§cNo squads have summoned members.");
        } },
        { label: `Trash (${trash.length})`, run: () => trashMenu(player) },
        { label: "Database Tools", run: () => dbToolsMenu(player) },
        { label: `Auto-Tactics: ${isAutoTriggerEnabled() ? "§aON" : "§cOFF"}`, run: () => { setAutoTriggerEnabled(!isAutoTriggerEnabled()); return mainMenu(player); } },
    ]);
}

function summonAll(player, ids) {
    let n = 0;
    for (const id of ids) {
        const rec = getCharacter(player, id);
        if (!rec || isManifested(rec)) continue;
        if (manifestCharacter(player, id, player.location, player.dimension)) n++;
    }
    say(player, `§d[${TAG}] Summoned ${n} ${N.one}(s).`);
}

function recallAll(player, ids) {
    let n = 0;
    for (const id of ids) {
        const rec = getCharacter(player, id);
        if (rec?.manifestedEntityId && despawnCharacter(player, id)) n++;
    }
    say(player, `§d[${TAG}] Recalled ${n} ${N.one}(s) to the Codex.`);
}

// ---- roster -----------------------------------------------------------------
async function rosterMenu(player) {
    const roster = readIndex(player);
    if (roster.length === 0) {
        await menu(player, `My ${N.Many}`, `You don't have any ${N.many} yet.`, [
            { label: `Summon a New ${N.One}`, run: () => summonNew(player) },
            { label: "Back", run: () => mainMenu(player) },
        ]);
        return;
    }
    const entries = roster.map(e => {
        const rec = getCharacter(player, e.id);
        const status = !rec ? "§cdata error" : isManifested(rec) ? "§asummoned" : "§7in Codex";
        return { label: `${e.nickname}  §8Lv${rec?.level ?? "?"}\n${status}§r §8${getSpeciesInfo(e.species).displayName}`, run: () => characterPage(player, e.id) };
    });
    entries.push({ label: "Back", run: () => mainMenu(player) });
    await menu(player, `My ${N.Many}`, `Select a ${N.one}.`, entries);
}

async function summonNew(player) {
    const speciesIds = Object.keys(SPECIES);
    const creative = isCreative(player);
    if (!creative && !hasItem(player, SCROLL_ITEM)) {
        await menu(player, `Summon a New ${N.One}`, "You need a §dSummoning Scroll§r.\n\nCraft one from §fpaper + diamond + amethyst shard§r.", [
            { label: "Back", run: () => mainMenu(player) },
        ]);
        return;
    }
    let species = speciesIds[0];
    if (speciesIds.length > 1) {
        const res = await show(player, new ModalFormData().title("Summon").dropdown("Who answers the summon?", speciesIds.map(s => SPECIES[s].displayName)));
        if (res.canceled) return;
        species = speciesIds[res.formValues[0]];
    }
    const nickname = await askNickname(player, `Name Your ${N.One}`, getSpeciesInfo(species).displayName);
    if (!nickname) return;
    if (!creative && !consumeItem(player, SCROLL_ITEM)) { say(player, `§c[${TAG}] Your Summoning Scroll is gone.`); return; }
    let created;
    try { created = createCharacter(player, { nickname, species }); }
    catch (e) { say(player, `§c[${TAG}] Summon failed: ${e?.message ?? e}`); return; }
    const entity = manifestCharacter(player, created.id, player.location, player.dimension);
    say(player, entity ? `§d✦ ${nickname} answers your summon!` : `§e${nickname} joined your Codex (couldn't appear here: ${getLastManifestFailure(created.id)}).`);
}

async function askNickname(player, title, suggestion, excludingId = null) {
    let current = suggestion;
    for (;;) {
        const res = await show(player, new ModalFormData().title(title).textField("Nickname", "Enter a nickname", { defaultValue: current }));
        if (res.canceled) return null;
        const name = String(res.formValues[0] ?? "").trim();
        if (!name) { say(player, "§cA nickname is required."); continue; }
        if (name.length > 32) { say(player, "§cKeep it to 32 characters or fewer."); current = name.slice(0, 32); continue; }
        if (isNicknameTaken(player, name, excludingId)) { say(player, `§cYou already have a ${N.one} named "${name}".`); current = name; continue; }
        return name;
    }
}

function hasItem(player, typeId) {
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;
    for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === typeId) return true;
    return false;
}

function countItem(player, typeId) {
    const inv = player.getComponent("minecraft:inventory")?.container;
    let n = 0;
    if (inv) for (let i = 0; i < inv.size; i++) { const it = inv.getItem(i); if (it?.typeId === typeId) n += it.amount; }
    return n;
}

function consumeItem(player, typeId) {
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;
    for (let i = 0; i < inv.size; i++) {
        const item = inv.getItem(i);
        if (item?.typeId !== typeId) continue;
        if (item.amount > 1) { item.amount -= 1; inv.setItem(i, item); } else inv.setItem(i, undefined);
        return true;
    }
    return false;
}

// ---- one character --------------------------------------------------------------
function describe(player, id, rec) {
    const cls = getClass(rec.class);
    const s = rec.stats;
    const squad = rec.squadId ? getSquad(player, rec.squadId) : null;
    const xpLine = rec.level >= MAX_LEVEL ? "MAX" : `${rec.xp}/${xpToNextLevel(rec.level)} xp`;
    const rel = Object.entries(rec.relationships).map(([k, v]) => `${k} Lv${v.level}`).join(" · ");
    return [
        `§l${rec.nickname}§r  §7${getSpeciesInfo(rec.species).displayName} · ${cls.displayName}`,
        `Level §e${rec.level}§r (${xpLine}) · Skill points §e${rec.skillPoints}§r`,
        `Rank ${rec.rank} · Eidolon ${rec.eidolonLevel}`,
        `Status: ${isManifested(rec) ? "§asummoned" : "§7resting in the Codex"}§r · Order: §b${ORDER_LABELS[getOrder(rec)]}§r`,
        `Squad: ${squad ? `§b${squad.name}${squad.captainId === id ? " (captain)" : ""}` : "§7none"}§r`,
        "",
        `§lStats§r`,
        `HP ${fmt(s.maxHp)} · ATK ${fmt(s.atk)} · DEF ${fmt(s.def)} · SPD ${fmt(s.spd)}`,
        `CRIT ${pct(s.critRate)} / ${pct(s.critDmg)} · ERR ${pct(s.energyRegen)}`,
        "",
        `§lRelationship§r  ${rel}`,
        `Abilities: ${rec.abilities.join(", ") || "none"}`,
        rec.homeLocation ? `Home: ${Math.floor(rec.homeLocation.x)}, ${Math.floor(rec.homeLocation.y)}, ${Math.floor(rec.homeLocation.z)} (${rec.homeLocation.dimension.replace("minecraft:", "")})` : "Home: §7not set§r",
        `§8Obtained ${new Date(rec.createdAt).toISOString().slice(0, 10)}${rec.migratedFrom ? ` · migrated from ${rec.migratedFrom.typeId}` : ""}`,
        `§8id ${id}`,
    ].join("\n");
}

async function characterPage(player, id) {
    const rec = getCharacter(player, id);
    if (!rec) { say(player, `§c[${TAG}] That ${N.one}'s record couldn't be read - try Database Tools > Integrity Check.`); return; }
    if (rec.deletedAt !== null) return trashItem(player, id);
    const here = isManifested(rec);
    const back = () => characterPage(player, id);
    const entries = [];
    if (here) {
        entries.push({ label: "Teleport to Me", run: () => { say(player, teleportToMe(player, id, player.location, player.dimension) ? `§d${rec.nickname} is by your side.` : `§c${getLastManifestFailure(id)}`); } });
        entries.push({ label: "Recall to Codex", run: () => { despawnCharacter(player, id); say(player, `§d${rec.nickname} returns to the Codex.`); } });
    } else {
        entries.push({ label: "Summon Here", run: () => { say(player, manifestCharacter(player, id, player.location, player.dimension) ? `§d${rec.nickname} appears!` : `§cCan't summon: ${getLastManifestFailure(id)}.`); } });
    }
    entries.push(
        { label: `Orders: ${ORDER_LABELS[getOrder(rec)]}`, run: () => ordersMenu(player, id) },
        { label: "Rename", run: async () => {
            const name = await askNickname(player, "Rename", rec.nickname, id);
            if (name && renameCharacter(player, id, name)) {
                const ent = findEntity(getCharacter(player, id)?.manifestedEntityId);
                if (ent) ent.nameTag = name;
                say(player, `§d${rec.nickname} is now ${name}.`);
            }
            return back();
        } },
        { label: "Squad", run: () => characterSquadMenu(player, id) },
        { label: `Skills (${rec.skillPoints} pt)`, run: () => skillsMenu(player, id) },
        { label: "Quests", run: () => questsMenu(player, id) },
        { label: "Stats & Bonds", run: () => statsPage(player, id) },
        { label: "Set Home Here", run: () => {
            setHomeLocation(player, id, { x: player.location.x, y: player.location.y, z: player.location.z, dimension: player.dimension.id });
            say(player, `§d${rec.nickname}'s home is set here.`); return back();
        } },
        { label: "Make Soul Token", run: () => {
            try { createSoulToken(player, id); say(player, `§d${rec.nickname}'s Soul Token is in your inventory - use it anytime to call her.`); }
            catch (e) { say(player, `§c${e?.message ?? e}`); }
        } },
        { label: "Export Backup", run: () => exportPage(player, id) },
        { label: "Give to Another Player", run: () => giveFlow(player, id) },
        { label: "§cRelease", run: () => releaseFlow(player, id) },
        { label: "Back", run: () => rosterMenu(player) },
    );
    await menu(player, rec.nickname, describe(player, id, rec), entries);
}

async function ordersMenu(player, id) {
    const rec = getCharacter(player, id);
    const current = getOrder(rec);
    const entries = ORDERS.map(o => ({
        label: `${o === current ? "§a> " : ""}${ORDER_LABELS[o]}`,
        run: async () => {
            if (o === "home" && !rec.homeLocation) { say(player, "§eSet her home first (Set Home Here)."); return characterPage(player, id); }
            setOrder(player, id, o);
            const ent = findEntity(rec.manifestedEntityId);
            if (ent) applyOrderToEntity(ent, o);
            say(player, `§d${rec.nickname}: "${ORDER_LABELS[o]}" - got it!`);
            return characterPage(player, id);
        },
    }));
    entries.push({ label: "Back", run: () => characterPage(player, id) });
    await menu(player, `Orders - ${rec.nickname}`, "Follow: walks with you, comes through portals.\nStay: holds position.\nWander: roams where she is.\nGo home: returns to her home point.", entries);
}

async function characterSquadMenu(player, id) {
    const rec = getCharacter(player, id);
    const squads = readSquads(player);
    const entries = [];
    for (const s of squads) {
        if (s.id === rec.squadId) continue;
        entries.push({ label: `Join ${s.name} (${s.memberIds.length}/${MAX_MEMBERS_PER_SQUAD})`, run: () => {
            try { joinSquad(player, s.id, id); say(player, `§d${rec.nickname} joined ${s.name}.`); }
            catch (e) { say(player, `§c${e?.message ?? e}`); }
            return characterPage(player, id);
        } });
    }
    if (squads.length < MAX_SQUADS_PER_PLAYER) {
        entries.push({ label: "Create a New Squad for Her", run: async () => {
            const name = await askSquadName(player);
            if (!name) return characterPage(player, id);
            try { const sq = createSquad(player, name); joinSquad(player, sq.id, id); setCaptain(player, sq.id, id); say(player, `§d${rec.nickname} now leads ${name}.`); }
            catch (e) { say(player, `§c${e?.message ?? e}`); }
            return characterPage(player, id);
        } });
    }
    if (rec.squadId) entries.push({ label: "Leave Squad", run: () => { leaveSquad(player, id); say(player, `§d${rec.nickname} left her squad.`); return characterPage(player, id); } });
    entries.push({ label: "Back", run: () => characterPage(player, id) });
    await menu(player, `Squad - ${rec.nickname}`, rec.squadId ? `Currently in §b${getSquad(player, rec.squadId)?.name}` : "Not in a squad.", entries);
}

async function skillsMenu(player, id) {
    const rec = getCharacter(player, id);
    const cls = getClass(rec.class);
    const nodes = Object.entries(cls.skillTree?.nodes ?? {});
    const entries = nodes.map(([nodeId, node]) => {
        const owned = rec.unlockedSkills.includes(nodeId);
        const locked = node.prerequisites.some(p => !rec.unlockedSkills.includes(p));
        const tag = owned ? "§a[owned]" : locked ? "§8[locked]" : `§e[${node.cost} pt]`;
        return { label: `${nodeId} ${tag}\n§r${renderContent(node.description).slice(0, 40)}`, run: async () => {
            if (!owned && await confirm(player, nodeId, `${renderContent(node.description)}\n\nCost: ${node.cost} skill point(s)\nRequires: ${node.prerequisites.join(", ") || "nothing"}`, "Unlock", "Back")) {
                say(player, unlockSkill(player, id, nodeId) ? `§a${rec.nickname} learned ${nodeId}!` : "§cCan't unlock that yet (points or prerequisites).");
            }
            return skillsMenu(player, id);
        } };
    });
    const cost = getSpeciesInfo(rec.species).eidolonCost;
    const costText = cost.map(c => `${c.amount}x ${c.item.replace(/^(minecraft|cw):/, "").replace(/_/g, " ")}`).join(", ");
    if (rec.eidolonLevel < MAX_EIDOLON) entries.push({ label: `Ascend: Eidolon ${rec.eidolonLevel} -> ${rec.eidolonLevel + 1}
§7${costText}`, run: async () => {
        const creative = isCreative(player);
        const missing = creative ? [] : cost.filter(c => countItem(player, c.item) < c.amount);
        if (missing.length) { say(player, `§cYou need ${costText}.`); return skillsMenu(player, id); }
        if (await confirm(player, "Ascend?", `Raise ${rec.nickname} to Eidolon ${rec.eidolonLevel + 1}?

Consumes: ${creative ? "nothing (creative)" : costText}`, "Ascend", "Back")) {
            if (!creative) for (const c of cost) for (let i = 0; i < c.amount; i++) consumeItem(player, c.item);
            const done = raiseEidolon(player, id);
            say(player, done ? `§6✦ ${rec.nickname} reached Eidolon ${done.eidolonLevel}!` : "§cAscension failed.");
        }
        return skillsMenu(player, id);
    } });
    entries.push({ label: "Back", run: () => characterPage(player, id) });
    const abilities = rec.abilities.map(a => `§l${a}§r\n${renderContent(getAbility(a)?.description)}`).join("\n\n");
    await menu(player, `Skills - ${rec.nickname}`, `${cls.displayName} · ${rec.skillPoints} skill point(s) · Eidolon ${rec.eidolonLevel}/${MAX_EIDOLON}\n\n${abilities || "No abilities yet."}${nodes.length ? "" : "\n\n§7This class has no skill tree yet."}`, entries);
}

function questCheckState(player, id, rec, def) {
    const ctx = { character: rec, owner: player, characterId: id, progress: rec.quests[def.id]?.progress ?? {} };
    const checked = {};
    const list = (def.description ?? []).find(b => b.type === "checklist")?.items ?? [];
    list.forEach((item, i) => { if (def.conditions[i]) checked[item.id] = evaluateCondition(ctx, def.conditions[i], i); });
    const started = Boolean(rec.quests[def.id]);
    const progress = def.conditions
        .map((c, i) => (started || c.type === "counterThreshold" || c.type === "relationshipLevel")
            ? describeProgress(ctx, c, i, (cat, subj) => readCounter(player, id, cat, subj)) : null)
        .filter(Boolean);
    return { checked, progress };
}

async function questsMenu(player, id) {
    const rec = getCharacter(player, id);
    const entries = Object.values(QUESTS).filter(def => questAvailableTo(def, rec)).map(def => {
        const status = rec.quests[def.id]?.status ?? "available";
        const color = status === "completed" ? "§a" : status === "active" ? "§e" : "§7";
        return { label: `${def.title}\n${color}${status}`, run: async () => {
            const cur = getCharacter(player, id);
            const st = cur.quests[def.id]?.status ?? "available";
            const { checked, progress } = questCheckState(player, id, cur, def);
            const rewards = Object.entries(def.rewards ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
            const body = `${renderContent(def.description, checked)}\n\n${progress.join("\n")}\n\n§7Rewards: ${rewards}`;
            const actions = [];
            if (st === "available") actions.push({ label: "Start Quest", run: () => { startQuest(player, id, def.id); say(player, `§e${cur.nickname} started "${def.title}".`); return questsMenu(player, id); } });
            if (st === "active") actions.push({ label: "Turn In", run: () => {
                const done = tryCompleteQuest(player, id, def.id);
                say(player, done ? `§6Quest complete: ${def.title}!` : "§7Not finished yet.");
                return questsMenu(player, id);
            } });
            actions.push({ label: "Back", run: () => questsMenu(player, id) });
            await menu(player, def.title, body, actions);
        } };
    });
    entries.push({ label: "Back", run: () => characterPage(player, id) });
    await menu(player, `Quests - ${rec.nickname}`, "Quests complete on their own once she's done the work.", entries);
}

async function statsPage(player, id) {
    const rec = getCharacter(player, id);
    const counters = readCounters(player, id);
    const lines = [];
    for (const [cat, subjects] of Object.entries(counters)) {
        const top = Object.entries(subjects).sort((a, b) => b[1] - a[1]).slice(0, 6)
            .map(([k, v]) => `${k.replace("minecraft:", "")} ${fmt(v)}`).join(", ");
        lines.push(`§l${cat}§r: ${top}`);
    }
    const roster = readIndex(player);
    const bonds = rec.bondPartners.map(pid => {
        const b = getBondBetween(id, pid);
        const name = roster.find(e => e.id === pid)?.nickname ?? `${pid.slice(0, 8)}…`;
        return `${name}: combat Lv${b.combat.level} · friendship Lv${b.friendship.level} · love Lv${b.love.level}`;
    });
    await menu(player, `Stats - ${rec.nickname}`,
        `${lines.join("\n") || "§7No recorded activity yet."}\n\n§lBonds§r\n${bonds.join("\n") || `§7No bonds with other ${N.many} yet - fight alongside squadmates to build them.`}`,
        [{ label: "Back", run: () => characterPage(player, id) }]);
}

async function exportPage(player, id) {
    let text;
    try { text = exportCharacter(player, id); } catch (e) { say(player, `§c${e?.message ?? e}`); return; }
    await show(player, new ModalFormData().title("Export Backup")
        .textField(`Select all (Ctrl+A) and copy (Ctrl+C) this text somewhere safe. Import it later from Database Tools. ${text.length} characters.`, "", { defaultValue: text }));
    return characterPage(player, id);
}

async function giveFlow(player, id) {
    const rec = getCharacter(player, id);
    const others = world.getAllPlayers().filter(p => p.id !== player.id);
    if (!others.length) { say(player, "§7Nobody else is online."); return characterPage(player, id); }
    await menu(player, `Give ${rec.nickname}`, "She'll keep her level, stats, bonds and history. Her squad and home are reset for her new owner.", [
        ...others.map(p => ({ label: p.name, run: async () => {
            if (!await confirm(player, `Give ${rec.nickname} to ${p.name}?`, "This is permanent unless they give her back.", "Give", "Cancel")) return characterPage(player, id);
            if (rec.manifestedEntityId) despawnCharacter(player, id);
            const r = transferCharacter(player, p, id);
            if (r.ok) { say(player, `§d${r.nickname} now belongs to ${p.name}.`); say(p, `§d${player.name} gave you ${r.nickname}! Find her in your Codex.`); }
            else say(player, `§c${r.reason}`);
        } })),
        { label: "Back", run: () => characterPage(player, id) },
    ]);
}

async function releaseFlow(player, id) {
    const rec = getCharacter(player, id);
    const ok = await confirm(player, `Release ${rec.nickname}?`,
        `She'll leave your roster and squad and move to the Trash.\n\nNothing is deleted: her record, stats and bonds stay intact, and you can restore her from Trash at any time in the next ${TRASH_GRACE_PERIOD_MS / 86400000} days.`,
        "Release", "Keep her");
    if (!ok) return characterPage(player, id);
    if (rec.manifestedEntityId) despawnCharacter(player, id);
    if (rec.squadId) leaveSquad(player, id);
    say(player, releaseCharacter(player, id) ? `§e${rec.nickname} was released to the Trash.` : "§cRelease failed.");
}

// ---- trash ------------------------------------------------------------------
async function trashMenu(player) {
    const trash = listTrash(player);
    const entries = trash.map(({ id, record }) => {
        const daysLeft = Math.max(0, Math.ceil((record.deletedAt + TRASH_GRACE_PERIOD_MS - Date.now()) / 86400000));
        return { label: `${record.nickname}  §8Lv${record.level}\n§7${daysLeft > 0 ? `${daysLeft} day(s) of recovery left` : "recovery window over"}`, run: () => trashItem(player, id) };
    });
    entries.push({ label: "Back", run: () => mainMenu(player) });
    await menu(player, "Trash", trash.length ? `Released ${N.many}. Restore brings her back exactly as she was.` : "The trash is empty.", entries);
}

async function trashItem(player, id) {
    const rec = getCharacter(player, id);
    if (!rec) return trashMenu(player);
    const entries = [{ label: "§aRestore", run: () => {
        if (isNicknameTaken(player, rec.nickname)) { say(player, `§cYou already have another ${N.one} named "${rec.nickname}" - rename one first.`); return trashMenu(player); }
        say(player, restoreCharacter(player, id) ? `§a${rec.nickname} is back in your roster!` : "§cRestore failed.");
        return trashMenu(player);
    } }];
    if (isPastGracePeriod(rec)) {
        entries.push({ label: "§4Delete Forever", run: async () => {
            if (await confirm(player, "Delete forever?", `This permanently erases ${rec.nickname}: record, mirror backup, stats and bonds. It cannot be undone.\n\nTip: Export a backup first if you might want her again.`, "Delete forever", "Cancel")) {
                const r = purgeCharacter(player, id);
                say(player, r.ok ? `§7${rec.nickname} was permanently deleted.` : `§c${r.reason}`);
            }
            return trashMenu(player);
        } });
    }
    entries.push({ label: "Export Backup", run: () => exportPage(player, id) });
    entries.push({ label: "Back", run: () => trashMenu(player) });
    await menu(player, rec.nickname, `Released ${new Date(rec.deletedAt).toISOString().slice(0, 10)}.\nLevel ${rec.level} ${getClass(rec.class).displayName}.`, entries);
}

// ---- squads -----------------------------------------------------------------
async function askSquadName(player, current = "") {
    const res = await show(player, new ModalFormData().title("Squad Name").textField("Name", "e.g. Alpha", { defaultValue: current }));
    if (res.canceled) return null;
    const name = String(res.formValues[0] ?? "").trim();
    return name || null;
}

async function squadsMenu(player) {
    const squads = readSquads(player);
    const roster = readIndex(player);
    const nameOf = wid => roster.find(e => e.id === wid)?.nickname ?? "?";
    const entries = squads.map(s => ({
        label: `${s.name}  §8${s.memberIds.length}/${MAX_MEMBERS_PER_SQUAD}\n§7${s.captainId ? `Captain ${nameOf(s.captainId)}` : "no captain"}`,
        run: () => squadPage(player, s.id),
    }));
    if (squads.length < MAX_SQUADS_PER_PLAYER) entries.push({ label: "Create Squad", run: async () => {
        const name = await askSquadName(player);
        if (name) { try { createSquad(player, name); say(player, `§dSquad ${name} created.`); } catch (e) { say(player, `§c${e?.message ?? e}`); } }
        return squadsMenu(player);
    } });
    entries.push({ label: "Back", run: () => mainMenu(player) });
    await menu(player, "Squads", "Squads move and fight as a unit.", entries);
}

function squadEntityMembers(player, squadId) {
    return getManifestedMembers(player, squadId)
        .map(m => ({ ...m, entity: findEntity(m.record.manifestedEntityId) }))
        .filter(m => m.entity);
}

async function squadPage(player, squadId) {
    const squad = getSquad(player, squadId);
    if (!squad) return squadsMenu(player);
    const roster = readIndex(player);
    const nameOf = wid => roster.find(e => e.id === wid)?.nickname ?? "?";
    const back = () => squadPage(player, squadId);
    const body = `§l${squad.name}§r\n${squad.memberIds.map(w => `${w === squad.captainId ? "★ " : " • "}${nameOf(w)} ${isManifested(getCharacter(player, w)) ? "§a(here)" : "§7(in Codex)"}§r`).join("\n") || "§7No members yet."}`;
    await menu(player, squad.name, body, [
        { label: "Formation", run: () => formationMenu(player, squadId) },
        { label: "Breach Nearest Doorway", run: () => {
            const members = squadEntityMembers(player, squadId);
            if (!members.length) { say(player, "§cNo summoned members."); return; }
            const points = detectChokePoints(player.dimension, player.location, 200);
            if (!points.length) { say(player, "§cNo doorway/choke point found near you."); return; }
            breachStack(members, points[0], player.getViewDirection(), player.dimension, () => say(player, `§a${squad.name}: breach complete.`));
            say(player, `§d${squad.name} is breaching.`);
        } },
        { label: "Hunt (what you're looking at)", run: () => {
            const members = squadEntityMembers(player, squadId);
            if (!members.length) { say(player, "§cNo summoned members."); return; }
            const target = pickHuntTarget(player);
            if (!target) { say(player, "§cNothing huntable nearby - look at an animal or mob."); return; }
            const desc = startHunt(members, target, msg => say(player, msg));
            say(player, desc ? `§d${squad.name} is stalking: ${desc}.` : "§cCouldn't start the hunt.");
        } },
        { label: "Summon Squad to Me", run: () => { summonAll(player, squad.memberIds); } },
        { label: "Recall Squad", run: () => { recallAll(player, squad.memberIds); } },
        { label: "Squad Orders", run: async () => {
            const res = await show(player, new ModalFormData().title(`${squad.name} Orders`).dropdown("Order for every member", ORDERS.map(o => ORDER_LABELS[o])));
            if (!res.canceled) {
                const o = ORDERS[res.formValues[0]];
                for (const w of squad.memberIds) {
                    const r = getCharacter(player, w);
                    if (!r || (o === "home" && !r.homeLocation)) continue;
                    setOrder(player, w, o);
                    const ent = findEntity(r.manifestedEntityId);
                    if (ent) applyOrderToEntity(ent, o);
                }
                say(player, `§d${squad.name}: ${ORDER_LABELS[o]}.`);
            }
            return back();
        } },
        { label: "Add Member", run: async () => {
            const candidates = roster.filter(e => !squad.memberIds.includes(e.id));
            if (!candidates.length) { say(player, "§7Everyone's already in this squad."); return back(); }
            await menu(player, "Add Member", "", [...candidates.map(e => ({ label: `${e.nickname}${getCharacter(player, e.id)?.squadId ? " §8(moves squads)" : ""}`, run: () => {
                try { joinSquad(player, squadId, e.id); } catch (err) { say(player, `§c${err?.message ?? err}`); }
                return back();
            } })), { label: "Back", run: back }]);
        } },
        { label: "Remove Member", run: async () => {
            await menu(player, "Remove Member", "", [...squad.memberIds.map(w => ({ label: nameOf(w), run: () => { leaveSquad(player, w); return back(); } })), { label: "Back", run: back }]);
        } },
        { label: "Set Captain", run: async () => {
            await menu(player, "Set Captain", "", [...squad.memberIds.map(w => ({ label: nameOf(w), run: () => { setCaptain(player, squadId, w); return back(); } })), { label: "Back", run: back }]);
        } },
        { label: "Rename Squad", run: async () => { const n = await askSquadName(player, squad.name); if (n) renameSquad(player, squadId, n); return back(); } },
        { label: "§cDisband Squad", run: async () => {
            if (await confirm(player, `Disband ${squad.name}?`, "Members stay in your roster, just without a squad.", "Disband", "Cancel")) { deleteSquad(player, squadId); return squadsMenu(player); }
            return back();
        } },
        { label: "Back", run: () => squadsMenu(player) },
    ]);
}

async function formationMenu(player, squadId) {
    const squad = getSquad(player, squadId);
    await menu(player, `${squad.name} - Formation`, "Forms up around you, facing where you look.", [
        ...FORMATION_TYPES.map(type => ({ label: type, run: () => {
            const members = squadEntityMembers(player, squadId);
            if (!members.length) { say(player, "§cNo summoned members - summon the squad first."); return; }
            const started = executeFormation(type, player.dimension, player.location, player.getViewDirection(), player.location, members);
            say(player, `§d${squad.name}: ${type} (${started}/${members.length} moving).`);
        } })),
        { label: "Back", run: () => squadPage(player, squadId) },
    ]);
}

// ---- database tools ---------------------------------------------------------
async function dbToolsMenu(player) {
    await menu(player, "Database Tools", `Your ${N.many} are stored as data with an automatic A/B rollback copy and a separate mirror backup. These tools check and repair all of it.`, [
        { label: "Integrity Check", run: () => integrityPage(player, false) },
        { label: "Import Backup", run: () => importFlow(player) },
        { label: "Back", run: () => mainMenu(player) },
    ]);
}

async function integrityPage(player, repaired) {
    const { checked, issues } = scanIntegrity(player, { repair: false });
    const body = issues.length === 0
        ? `§aAll ${checked} record(s) healthy.§r\nPrimary copies, rollback slots, mirror backups, roster index, squads and bonds all agree.${repaired ? "\n\n§aRepair finished." : ""}`
        : `§e${issues.length} issue(s) across ${checked} record(s):§r\n${issues.slice(0, 25).map(i => ` • ${i.nickname}: ${i.problem}`).join("\n")}`;
    const entries = [];
    if (issues.length) entries.push({ label: "Repair Everything", run: () => {
        const r = scanIntegrity(player, { repair: true });
        say(player, `§a[${TAG}] Repaired ${r.issues.filter(i => i.fixed).length} issue(s).`);
        return integrityPage(player, true);
    } });
    entries.push({ label: "Back", run: () => dbToolsMenu(player) });
    await menu(player, "Integrity Check", body, entries);
}

async function importFlow(player) {
    const res = await show(player, new ModalFormData().title("Import Backup").textField("Paste a CW backup string (starts with CWX1|)", "CWX1|..."));
    if (res.canceled) return dbToolsMenu(player);
    const text = String(res.formValues[0] ?? "");
    let result;
    try { result = importCharacter(player, text); }
    catch (e) { say(player, `§c[${TAG}] ${e?.message ?? e}`); return dbToolsMenu(player); }
    if (!result.ok && result.needsNickname) {
        say(player, `§e${result.reason} Pick a new name for her.`);
        const name = await askNickname(player, "Rename Import", "");
        if (!name) return dbToolsMenu(player);
        try { result = importCharacter(player, text, name); } catch (e) { say(player, `§c[${TAG}] ${e?.message ?? e}`); return dbToolsMenu(player); }
    }
    say(player, result.ok ? `§a[${TAG}] ${result.nickname} was restored from backup!` : `§c[${TAG}] ${result.reason}`);
    return dbToolsMenu(player);
}

// ---- wiring -----------------------------------------------------------------
export function registerCodex() {
    world.afterEvents.itemUse.subscribe(event => {
        if (event.itemStack?.typeId === CODEX_ITEM) openCodex(event.source);
        else if (event.itemStack?.typeId === SCROLL_ITEM) summonNew(event.source).catch(e => console.warn(`[${TAG}] Summon error: ${e}`));
    });

    // Interacting with one of your own characters (empty hand or holding the
    // Codex) opens her page. beforeEvents fires even though ${NS}:character has no
    // minecraft:interact component; it's read-only, so defer the UI.
    world.beforeEvents.playerInteractWithEntity.subscribe(event => {
        const { player, target, itemStack } = event;
        if (target.typeId !== `${NS}:${CHAR}`) return;
        if (itemStack && itemStack.typeId !== CODEX_ITEM) return;
        let characterId, ownerId;
        try { characterId = target.getDynamicProperty(`${NS}:${CHAR}Id`); ownerId = target.getDynamicProperty(`${NS}:ownerId`); } catch (e) { return; }
        if (!characterId || ownerId !== player.id) return;
        event.cancel = true;
        system.run(() => openCharacterPage(player, characterId));
    });

    // Every player gets a Codex and one free Summoning Scroll the first
    // time they join a world with CW.
    world.afterEvents.playerSpawn.subscribe(event => {
        if (!event.initialSpawn) return;
        const player = event.player;
        system.runTimeout(() => {
            try {
                if (player.getDynamicProperty(`${NS}:starterKitGiven`)) return;
                const inv = player.getComponent("minecraft:inventory")?.container;
                if (!inv) return;
                inv.addItem(new ItemStack(CODEX_ITEM, 1));
                inv.addItem(new ItemStack(SCROLL_ITEM, 1));
                player.setDynamicProperty(`${NS}:starterKitGiven`, true);
                say(player, `§d[${TAG}] You received a ${N.One} Codex and a Summoning Scroll. Use the Codex to manage everything.`);
            } catch (e) { console.warn(`[${TAG}] Starter kit failed: ${e}`); }
        }, 40);
    });
}
