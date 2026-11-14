// The bridge's contribution surface: the rows and palette items a plugin
// registered through gentle-shell-bridge, ready for this shell to render.
//
// Read lazily and fail closed, entry by entry: a missing bridge, a foreign
// schema, a throwing getter or one malformed entry costs that entry — never the
// menu. Nothing here is cached at startup, because a plugin registers during
// `session_start` and the next menu or palette open must see it.

export const PLUGIN_SURFACE_KEY = Symbol.for("gentle-shell-bridge/plugin-surface/v1");

/** One action a plugin wants on the Keymaps page; the plugin binds the key itself. */
export interface PluginKeymapAction {
	/** Plugin-owned and stable: never a built-in id, never `command:<name>`. */
	id: string;
	label: string;
	/** The environment variable that overrides this key, same semantics as a built-in action. */
	env?: string;
	defaultKey?: string;
	/** The slash command this action invokes, when it has one. */
	command?: string;
}

/** One item a plugin wants in the command palette. */
export interface PluginCommandContribution {
	id: string;
	/** An existing palette section title, or a new one the plugin owns. */
	section?: string;
	label: string;
	/** The slash command the palette runs; listed only while it is registered. */
	command: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The published surface, or undefined when it is absent or not one we can read. */
function surface(): Record<string, unknown> | undefined {
	let published: unknown;
	try {
		published = (globalThis as Record<symbol, unknown>)[PLUGIN_SURFACE_KEY];
	} catch {
		return undefined;
	}
	const candidate = record(published);
	return candidate && candidate.schema === 1 ? candidate : undefined;
}

/** Whatever `channel` returns, as a list; a missing or throwing getter is an empty list. */
function entries(channel: unknown): unknown[] {
	if (typeof channel !== "function") return [];
	try {
		const value: unknown = channel();
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

/** Optional text: absent stays absent, but a present-and-wrong value rejects the entry. */
function optional(value: unknown): { ok: true; value: string | undefined } | { ok: false } {
	if (value === undefined) return { ok: true, value: undefined };
	const resolved = text(value);
	return resolved === undefined ? { ok: false } : { ok: true, value: resolved };
}

export function bridgeKeymapActions(): readonly PluginKeymapAction[] {
	const published = surface();
	if (!published) return [];
	const actions: PluginKeymapAction[] = [];
	const seen = new Set<string>();
	for (const entry of entries(published.keymaps)) {
		const value = record(entry);
		const id = text(value?.id);
		const label = text(value?.label);
		if (!value || !id || !label || seen.has(id)) continue;
		const env = optional(value.env);
		const defaultKey = optional(value.defaultKey);
		const command = optional(value.command);
		if (!env.ok || !defaultKey.ok || !command.ok) continue;
		seen.add(id);
		actions.push({
			id,
			label,
			...(env.value === undefined ? {} : { env: env.value }),
			...(defaultKey.value === undefined ? {} : { defaultKey: defaultKey.value }),
			...(command.value === undefined ? {} : { command: command.value }),
		});
	}
	return actions;
}

export function bridgeCommandContributions(): readonly PluginCommandContribution[] {
	const published = surface();
	if (!published) return [];
	const contributions: PluginCommandContribution[] = [];
	const seen = new Set<string>();
	for (const entry of entries(published.commands)) {
		const value = record(entry);
		const id = text(value?.id);
		const label = text(value?.label);
		const command = text(value?.command);
		if (!value || !id || !label || !command || seen.has(id)) continue;
		const section = optional(value.section);
		if (!section.ok) continue;
		seen.add(id);
		contributions.push({ id, label, command, ...(section.value === undefined ? {} : { section: section.value }) });
	}
	return contributions;
}
