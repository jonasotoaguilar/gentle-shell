import type { CommandPaletteGroup, CommandPaletteItem } from "./command-palette.ts";
import { bridgeCommandContributions, type PluginCommandContribution } from "./plugin-surface.ts";

// The curated command set for the command palette: an OpenCode-style
// grouped menu, not a raw listing of every registered extension command.
// Only command + label live here; the live description and any shortcut
// hint are attached at build time by buildCommandPaletteGroups, from the
// actual registration and the shell's configured shortcuts.

export interface CommandPaletteCatalogItem {
	command: string;
	label: string;
}

export interface CommandPaletteCatalogGroup {
	title: string;
	items: readonly CommandPaletteCatalogItem[];
}

export const COMMAND_PALETTE_CATALOG: readonly CommandPaletteCatalogGroup[] = [
	{
		title: "Configuration",
		items: [
			{ command: "gentle:profiles", label: "Models and profiles" },
			{ command: "gentle:persona", label: "Switch persona" },
			{ command: "gentle:review-mode", label: "Review mode (receipt-driven development)" },
			{ command: "gentle:background-subagents", label: "Background subagents" },
			{ command: "gentle:double-esc-cancel", label: "Require double Esc to cancel" },
			{ command: "gentle:customize", label: "Customization · appearance + audio notifications" },
			{ command: "gentle:animations", label: "Animation mode" },
			{ command: "gentle:vim", label: "Vim opt-in · Pi slash commands" },
			{ command: "gentle:telemetry", label: "Telemetry" },
			{ command: "gentle:dev-binary", label: "Gentle AI dev binary" },
		],
	},
	{
		title: "Session",
		items: [
			{ command: "gentle:guide", label: "Guided tour of Gentle Shell" },
			{ command: "gentle:yolo", label: "🚀 YOLO 🔥 session permission" },
			{ command: "gentle:changes", label: "Browse changes" },
			{ command: "gentle:agents", label: "Subagents" },
			{ command: "gentle:jobs", label: "Background jobs" },
			{ command: "gentle:usage", label: "Subscription usage" },
			{ command: "gentle:review-session-permission", label: "Review session permission" },
			{ command: "gentle:voice", label: "Voice dictation · local Parakeet" },
			{ command: "gentle:design", label: "Design · HTML artboards" },
		],
	},
	{
		title: "Diagnostics",
		items: [
			{ command: "gentle:status", label: "Gentle AI status" },
			{ command: "gentle:doctor", label: "Doctor" },
		],
	},
	{
		title: "Skills",
		items: [{ command: "skill-registry:refresh", label: "Refresh skill registry" }],
	},
];

/** Where a contribution that names no section lands: one shared page for plugins, after the catalog. */
export const CONTRIBUTED_SECTION = "Plugins";

/**
 * Build the palette's groups for one session: keep only catalog entries
 * whose command is actually registered (so a missing extension never shows
 * a dead row), attach that registration's live description and an optional
 * shortcut hint, and drop any group left with no items. Catalog order is
 * preserved throughout.
 *
 * A bridge contribution joins the section it names — after that section's own
 * entries — or opens a section of its own after the catalog. It is filtered by
 * the same rule: a contribution whose command is not registered is not shown.
 */
export function buildCommandPaletteGroups(
	registered: readonly { name: string; description?: string }[],
	shortcuts: Readonly<Record<string, string | undefined>>,
	contributions: readonly PluginCommandContribution[] = bridgeCommandContributions(),
): CommandPaletteGroup[] {
	const byName = new Map(registered.map((command) => [command.name, command]));
	const sectionOf = (contribution: PluginCommandContribution): string => contribution.section ?? CONTRIBUTED_SECTION;
	const append = (items: CommandPaletteItem[], item: { command: string; label: string }): void => {
		const found = byName.get(item.command);
		if (!found) return;
		items.push({ command: item.command, label: item.label, description: found.description, shortcut: shortcuts[item.command] });
	};
	const groups: CommandPaletteGroup[] = [];
	for (const group of COMMAND_PALETTE_CATALOG) {
		const items: CommandPaletteItem[] = [];
		for (const entry of group.items) append(items, entry);
		for (const contribution of contributions) if (sectionOf(contribution) === group.title) append(items, contribution);
		if (items.length > 0) groups.push({ title: group.title, items });
	}
	// A section this shell does not own comes after the catalog, in the order the
	// plugins named it, and only when something survived in it.
	const adopted = new Set(COMMAND_PALETTE_CATALOG.map((group) => group.title));
	const owned = new Map<string, CommandPaletteItem[]>();
	for (const contribution of contributions) {
		const title = sectionOf(contribution);
		if (adopted.has(title)) continue;
		const items = owned.get(title) ?? [];
		owned.set(title, items);
		append(items, contribution);
	}
	for (const [title, items] of owned) if (items.length > 0) groups.push({ title, items });
	return groups;
}
