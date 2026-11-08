// The Agents overlay's page-scroll keys, including the extra pair offered on
// Linux so a terminal that swallows Ctrl+J/K still has a working page key.
//
// Whether the extra pair can reach the pane is a property of the terminal, not
// of this module. Pi resolves `ctrl+shift+j` only from a terminal that reports
// the Shift modifier separately:
//
// - the Kitty keyboard protocol form, `ESC [ 106 ; 6 u`, where the codepoint is
//   the unshifted `j` or the shifted `J` (Pi normalizes both), and
// - the xterm `modifyOtherKeys` form, `ESC [ 27 ; 6 ; 106 ~`.
//
// A terminal that speaks neither collapses Ctrl+Shift+J onto the very byte
// Ctrl+J sends (0x0A), so the distinction is gone before Pi reads it. There the
// extra binding stays silent and `ctrl+j`/`ctrl+k` keep doing the work; no
// amount of parsing here can recover a modifier the terminal never sends. That
// is why this is an addition on Linux and never a replacement anywhere.

import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

export type AgentsScrollDirection = "down" | "up";

/** The extra page-scroll keys: offered on Linux, inert everywhere else. */
const AGENTS_SCROLL_ALIAS: Readonly<Record<AgentsScrollDirection, KeyId>> = {
	down: "ctrl+shift+j",
	up: "ctrl+shift+k",
};

/** Where the extra pair is offered. Nothing else about the pane is platform-specific. */
function agentsScrollAliasOffered(platform: NodeJS.Platform): boolean {
	return platform === "linux";
}

/** The page-scroll hint every footer draws. */
const AGENTS_SCROLL_HINT_KEY = "ctrl+j/k";

/**
 * The hint cell for page scrolling: one wording on every platform, so the row
 * the footer draws never changes width or wording because of the Linux alias.
 * The extra pair is a compatibility convenience for terminals where `ctrl+j/k`
 * never reaches the pane, so it is documented rather than advertised here: the
 * footer must not spend cells on it, and must never name it by abbreviation.
 */
export function agentsScrollHintVariants(platform: NodeJS.Platform): readonly string[] {
	return [AGENTS_SCROLL_HINT_KEY];
}

/** True when this input data is the platform's extra page-scroll key. */
export function matchesAgentsScrollAlias(data: string, direction: AgentsScrollDirection, platform: NodeJS.Platform): boolean {
	if (!agentsScrollAliasOffered(platform)) return false;
	return matchesKey(data, AGENTS_SCROLL_ALIAS[direction]);
}
