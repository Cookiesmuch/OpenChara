// First-obtain nickname prompt (plan Section 1.1a). Species display name
// is only the pre-filled *suggestion* - the player must confirm or change
// it before she's usable, and a collision re-prompts rather than silently
// appending a number.

import { ModalFormData } from "@minecraft/server-ui";
import { isNicknameTaken } from "./characterIndex.js";
import { N } from "./ids.js";

// `speciesDisplayName` is the suggested default text. `onConfirmed(name)`
// is called once a unique, non-empty nickname is chosen; the prompt loops
// (re-shown) on a collision or empty submission until the player commits
// one or cancels the form entirely (onCancelled(), if given).
export function promptNickname(player, speciesDisplayName, onConfirmed, onCancelled) {
    const form = new ModalFormData()
        .title(`Name Your ${N.One}`)
        .textField("Nickname", "Enter a nickname", { defaultValue: speciesDisplayName });

    form.show(player).then(response => {
        if (response.canceled) {
            onCancelled?.();
            return;
        }
        const [raw] = response.formValues;
        const nickname = (raw ?? "").trim();

        if (nickname.length === 0) {
            player.sendMessage("§cA nickname is required.");
            promptNickname(player, speciesDisplayName, onConfirmed, onCancelled);
            return;
        }
        if (isNicknameTaken(player, nickname)) {
            player.sendMessage(`§cYou already have a ${N.one} named "${nickname}" - choose a different name.`);
            promptNickname(player, speciesDisplayName, onConfirmed, onCancelled);
            return;
        }
        onConfirmed(nickname);
    });
}
