# OpenChara UI

OpenChara gives a project a fully custom in-game UI. You write screens in an HTML-like language with CSS-like styles. The build compiles them to Minecraft JSON UI plus a table the engine uses at runtime. Your screens get:

- full-screen **menus**, with navigation, popups, text prompts and dialogue;
- a persistent **HUD**, which each player can switch on and off per element;
- **container** (chest-style) screens;
- an **RTS command mode**;
- **per-player languages**.

It works with mouse, touch and controller: every button is Minecraft's own button control.

```
PATCHES/ui/*.ui.html    screens, HUDs, templates
PATCHES/ui/*.ui.css     styles (every .ui.css applies to every screen)
PATCHES/lang/*.lang     text for {t:key}
PATCHES/scripts/*.js    data providers, actions, HUD providers (through api.js)
```

Credit: the transport tricks this is built on were measured by [bedrock-core/ui](https://github.com/bedrock-core/ui) (MIT). They're described in its `docs/spikes`: form entries as data, collection indexes, container facts, and live layout. OpenChara re-verified each one in-game before using it.

---

## 1. How it works (short version)

**A menu** is a server form (`ActionFormData`). Its title is `oc1|<screen>|`, which the engine's `ui/server_form.json` hook recognizes; it then draws your compiled layout instead of the vanilla dialog. Every dynamic value on the screen (a text, an icon, a bar length, a visibility flag, a pressable button) is one **entry** in that form. Only the screen being shown is ever built, thanks to a factory gate per screen.

Forms can't change while they're open. A press closes the form, the engine runs the action, and it immediately shows the next snapshot: the same screen with new state, another screen, or nothing.

**A HUD** rides the title channel. Each value has a key (`ocH|<hud>.<n>|`), and the engine sends `key+value` titles. It sends exactly one per player per tick, because the client only sees the last title of a tick. Values are only sent when they change. A "preserved title" control in your HUD keeps the last value for its key.

**A container screen** is a small satchel entity with a chest inventory, placed where the player is looking. Their next right-click opens it (scripts can't force a container open).

---

## 2. Screens

```html
<screen id="profile" data="profile" params="id">
  <panel class="window">
    <column class="content">
      <text class="title">{c.nickname}</text>
      <bar class="xpbar" value="{xp.pct}"/>
      <button class="primary" on:press="summon(c.id)" if="!c.summoned">
        <text class="center">{t:my.ui.summon}</text>
      </button>
    </column>
  </panel>
</screen>
```

Screen attributes:

- **`id`** is the screen key, used in `open(profile, ...)`: lowercase letters, digits and `_`.
- **`data`** names the provider whose object the expressions read. `params` and `state` are always there too.
- **`params`** is a comma list naming the arguments `open(...)` passes: `open(profile, c.id)` sets `params.id`.

Top-level elements in a `.ui.html` file are `<screen>`, `<hud>` and `<template>`.

### Elements

| element | what it is |
|---|---|
| `panel` | a box; children are placed by their own `anchor`/`offset` (default: centered) |
| `row` / `column` | stack children horizontally / vertically with `gap` |
| `grid columns="N"` | children in rows of N |
| `scroll` | a vertically scrolling column |
| `text` | a label; its content is a text template (below) |
| `image`, `portrait` | `src="textures/..."` or `src="{expr}"` |
| `bar value="{expr}"` | a fill bar, 0-100; needs a pixel `width` and `height` |
| `button on:press="..."` | a pressable; its children are its content |
| `spacer` | empty space |
| `use t="name" ...` | pastes a `<template>` (see Templates) |

### Attributes on any element

- **`if="expr"`:** shown only when true. A hidden element with a pixel size along its stack's axis takes no space.
- **`each="item in list" max="N"`:** repeats the element for each list item, up to `N`. A compiled screen reserves room for N, so pick a real maximum and paginate beyond it. `each="item, i in list"` also gives the index.
- **`class="a b"`, `id`, `style="width: 40; color: #ffffff"`:** styling (see Styles).

### Text templates

Text content and `src` can mix literal text with:

- **`{expr}`:** a value, e.g. `Lv {c.level}` or `{c.nickname | trunc:10}`.
- **`{t:key}`:** translated text from `lang/*.lang`.
- **`{t:key:arg1:arg2}`:** translated text with `%s` / `%1$s` filled.

Labels have a fixed height, so use `| trunc:N` on anything that might be long. It will not wrap into the next line.

### Expressions

These are JavaScript-like, and evaluated by the engine, never with `eval`:

- **Paths:** `c.info.portrait`, `list[0].name`.
- **Operators:** `!`, `-`, `* / %`, `+ -`, `< > <= >=`, `== !=`, `&&`, `||`, and parentheses.
- **Literals:** `'text'`, `"text"`, numbers, `true`, `false`, `null`.
- **Filters:** `value | filter:arg:arg`, chainable.

| filter | result |
|---|---|
| `len` | length of a list/string/object |
| `int`, `round` | whole numbers |
| `fixed:n` | n decimals |
| `pct` | `0.05` → `5%` |
| `upper`, `lower` | case |
| `default:x` | `x` when empty/null |
| `clamp:lo:hi` | clamp a number |
| `trunc:n` | shorten to n characters with `..` |
| `page:p:size` | one page of a list: `each="c in list \| page:state.page:10"` |
| `pages:size` | number of pages |

### Actions (`on:press`)

`on:press` takes one action, or several separated by `;`. A sequence stops at the first action that fails.

| action | does |
|---|---|
| `open(screen, args...)` | push a screen (args fill its `params`) |
| `replace(screen, args...)` | swap the current screen (tabs) |
| `back` | pop one screen |
| `close` | close the UI |
| `set(name, value)` | `state.name = value` on this screen (e.g. paging) |
| `toggle(name)` | flip `state.name` |
| `choose(value)` | answer a picker (see `choose()` below) |
| `call(handler, args...)` | run a JS handler |
| `anyAction(args...)` | run a registered action, built-in or yours |

Examples:

- `on:press="joinSquad(s.id, params.id); back"` joins, then goes back.
- `on:press="set(page, (state.page || 0) + 1)"` turns the page.

An action can steer what happens next by returning:

- `{ open: [...] }` or `{ replace: [...] }` to navigate;
- `{ back: true }` or `{ close: true }`;
- `{ flash: "message" }`, or just a string, to show a one-time message on the next screen;
- `{ error: "message" }` for a failure message.

A thrown error becomes an error flash. Show flashes with a template like:

```html
<template id="flash">
  <panel class="flash" if="flash && !flash.error"><text>{flash.text}</text></panel>
  <panel class="flash error" if="flash && flash.error"><text>{flash.text}</text></panel>
</template>
```

When the UI is closed (`close`), the flash goes to chat instead.

### Templates

A template is a reusable block. Every `$name` in its attributes and text is replaced by the `<use>` attribute of the same name; unset names become empty.

```html
<template id="tab_bar">
  <row class="tabs">
    <button class="tab $overview" on:press="replace(profile, c.id)"><text>{t:ui.overview}</text></button>
    <button class="tab $skills" on:press="replace(profile_skills, c.id)"><text>{t:ui.skills}</text></button>
  </row>
</template>

<use t="tab_bar" skills="active"/>
```

---

## 3. Styles

The CSS subset supports these selectors: `tag`, `.class`, `#id`, `tag.class`, `.a.b`, and comma lists. More specific rules win over less specific ones, later rules win over earlier ones, and inline `style` wins over all of them.

| property | values |
|---|---|
| `width`, `height` | pixels `40`, `50%`, `fill` (take the rest of a row/column), `fit` (size to children), or an expression like `50% - 2px` |
| `anchor` | `top-left`, `top-middle`, `top-right`, `left-middle`, `center`, `right-middle`, `bottom-left`, `bottom-middle`, `bottom-right` |
| `offset` | `x y` in pixels |
| `layer` | draw order among siblings |
| `opacity` | `0`-`1` |
| `clip` | `true` clips children to the box |
| `gap` | space between children of `row`/`column`/`grid` |
| `padding` | inner space (containers, buttons, bars) |
| `background`, `background-color`, `background-opacity`, `nineslice` | a texture (optionally tinted) behind the element; `nineslice` = border width in texture pixels |
| `hover-background`, `pressed-background` (+ `-color`) | button states |
| `direction` | `row` or `column`: how a button lays out its content |
| `color` | text or image tint, `#rrggbb` |
| `font-size` | `small`, `normal`, `large`, `extra_large` |
| `font-scale` | e.g. `0.8` |
| `text-align` | `left`, `center`, `right` |
| `shadow` | `true` |
| `lines` | a text's height in lines (it wraps within its width) |
| `bar-color`, `bar-texture` | a bar's fill |

### Animations

Animations play when the element is created, which is every time the screen is shown. Use them for reveals and highlights, not on everyday menus.

| property | effect |
|---|---|
| `fade-in: 0.5s [delay]` | opacity 0 → its normal opacity |
| `slide-from: dx dy 0.4s [delay]` | moves in from `offset + (dx, dy)` |
| `pulse: 2s` | loops opacity 1 ↔ 0.35 (after `fade-in`, if both) |
| `easing` | `linear`, `out-cubic` (default), `out-back`, `in-out-quad`, ... (JSON UI easing names with `-`) |

---

## 4. Data: providers, actions, handlers

In a content script:

```js
import { registerUiProvider, registerUiAction, registerUiHandler, openScreen } from "../openchara/api.js";

// <screen data="profile" params="id"> reads this object.
registerUiProvider("profile", (player, params, state) => ({ c: characterView(player, params.id), ... }));

// on:press="ascend(c.id)" - `this` is { params, state } of the pressed screen.
registerUiAction("ascend", async (player, id) => {
    if (!await confirm(player, { title: "Ascend?", body: "...", yes: "Ascend", no: "Back" })) return null;
    ...
    return "She ascended!";                       // flash message
});

openScreen(player, "home");                       // from anywhere (item use, command...)
```

Providers run every time a screen is shown, so keep them cheap. They may return a RawMessage (`{ translate, with }`) anywhere a text is shown.

### Helpers for actions (the form is closed while an action runs)

| helper | returns |
|---|---|
| `choose(player, screen, ...params)` | shows `screen` once as a picker; resolves to the value of the `choose(value)` pressed, or `null` |
| `confirm(player, { title, body, yes, no, danger })` | `true`/`false`; uses your `confirm` screen (params `title,body,yes,no,danger`) if you have one |
| `askText(player, { title, label, placeholder, value })` | a string, or `null` (Minecraft's own text box: custom screens can't take typing) |
| `askChoice(player, { title, label, options })` | an index, or `null` |
| `askNickname(player, { title, value, excludingId })` | a unique, non-empty character name, or `null` |
| `dialogue(player, { name, portrait, text, choices })` | the chosen index; uses your `dialogue` screen (params `name,portrait,text,choices`) |

### Built-in providers and actions

The engine registers generic ones, so a project gets a complete character UI without writing JS. See the header of `engine/scripts/openchara/ui/builtins.js` for the full list and data shapes.

- **Providers:** `roster`, `character`, `squads`, `squad`, `trash`, `integrity`, `players`, `settings`, `languages`, `species`.
- **Actions:**
  - Characters: `summon`, `recall`, `teleport`, `order`, `summonAll`, `recallAll`, `rename`, `setHome`, `soulToken`, `release`, `give`, `exportBackup`, `openBag`.
  - Squads: `createSquad`, `renameSquad`, `disbandSquad`, `joinSquad`, `leaveSquad`, `setCaptain`, `squadSummon`, `squadRecall`, `squadOrder`, `formation`, `breach`, `hunt`, `surround`.
  - Trash and database: `restore`, `purge`, `repair`, `importBackup`.
  - Settings and modes: `toggleHud`, `toggleAutoTactics`, `setLanguage`, `enterRts`.
  - Quests: `startQuest`, `turnInQuest`.

Register the same name to replace any of them.

---

## 5. HUD

```html
<hud id="squad" data="squadHud">
  <column class="hud-squad">
    <panel each="m in members" max="6" class="hud-member">
      <image src="{m.portrait}" class="hud-face"/>
      <text class="hud-name">{m.name | trunc:11}</text>
      <bar class="hud-hp" value="{m.hp}"/>
    </panel>
  </column>
</hud>
```

```js
registerHudProvider("squadHud", player => ({ visible: members.length > 0, members }));
```

A HUD's provider runs every few ticks, and only changed values are sent. Return `visible: false` to hide the whole HUD. Players switch HUDs off per player with `setHudEnabled(player, id, bool)`, or the `toggleHud(id)` action. The built-in `toasts` HUD provider shows `showToast(player, text)` messages.

HUDs can't have buttons. Keep the number of values small: at one value per tick, 40 changing values take 2 seconds to all update.

---

## 6. Languages

`{t:key}` text comes from `PATCHES/lang/<locale>.lang` (`key=value`; `##` starts a comment).

- **Default:** text goes out as a translation key, and the client shows it in the player's game language. Minecraft locales (`en_US`, `es_ES`, `ja_JP`, `zh_CN`, ...) are written into the resource pack. Missing keys fall back to English.
- **Per-player override:** `setPlayerLanguage(player, id)`, or the `setLanguage(id)` action with the `languages` provider. The engine then resolves every `{t:key}` itself, including languages Minecraft doesn't ship (any `lang/<id>.lang`, e.g. `fil_PH`).
- **Name:** each lang file names itself with `openchara.language.name=Español`.
- **Transform languages:** `registerLanguage(id, { name, base: "en_US", transform })` adds a language computed from a base one. Claude Waifus' hieroglyphs map letters to a custom font page (`rp/font/glyph_F1.png`, Private Use Area U+F100–). The transform only changes the template text, never the values inside it.

---

## 7. Container screens

```js
import { openContainer, markerItem } from "../openchara/api.js";

openContainer(player, {
    title: "Shop",
    slots: [...27 ItemStacks or undefined],
    locked: [0, 8],                      // filler/button slots: restored when clicked
    onSync(items, handle) {},            // unlocked slots changed - write them to your data
    onPress(slot, handle) {},            // a locked slot was clicked
    isValid: () => true,                 // closes when false
});
```

The satchel appears where the player looks, and their next right-click opens it. Behaviour:

- **Locked slots:** moving one puts it back, and the moved copy is removed from the player's cursor and inventory, so nothing duplicates. Build them with `markerItem(typeId, name, lore)`.
- **Closing:** the screen closes when the player walks away, leaves, or idles for 5 minutes. On closing it does a last sync, empties the satchel and removes it.
- **Leftover satchels:** any satchel the engine didn't open (from a crash or reload) is emptied and removed as soon as its chunk loads.

`openBag(player, characterId)` is the built-in character bag: 6 gear slots plus her 36-slot inventory in two 18-slot pages. It works whether she's out in the world or resting in the Codex.

---

## 8. RTS command mode

`enterRts(player)` / `exitRts(player)` (also available as the built-in action `enterRts`). While active:

- **Body double:** holds a verified copy of the player's items, plus a serialized backup.
- **Controls:** the player is invisible and protected; WASD pans a free camera, and jump/sneak raise or lower it.
- **Cursor:** turning the head aims an in-world cursor.
- **Orders:** hotbar items give orders: select squad, move here (in the chosen formation), attack/hunt, formation, surround, summon squad here, exit.
- **Following:** characters on "follow" follow the body double.

Exiting, relogging, dying or `/reload` all put the player back at their body with their items. `getRtsInfo(player)` feeds a HUD (Claude Waifus: `<hud id="rts">`).

---

## 9. Linting

`node tools/openchara.js check <projectDir>` (and every `build`/`deploy`/`dev`) runs a JSON UI linter over everything under `ui/` in the resource pack - the compiler's own output and any raw JSON UI a project overlays by hand. It catches the "parses fine, does nothing in-game" mistakes: `>=` in a binding (Molang has no such operator), an empty `''` literal, `collection_index` with no ancestor `collection_name`, a `button` with no `collection_details` binding, and a `$variable` inside a `modifications`-injected subtree. A build fails rather than shipping one of these silently.

## 10. Testing

`tools/lib/mcstub.js` runs a built project's scripts in Node, with an in-memory stand-in for `@minecraft/server`. Its forms record what was put on them and can be answered by a script. Claude Waifus' `tests/ui-smoke.mjs` uses it to:

- render every screen and click through real flows;
- check language overrides;
- test the bag and the RTS item swap.

Do this before anything reaches the game.
