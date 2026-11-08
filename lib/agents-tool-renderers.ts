import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Color, Component } from "@earendil-works/pi-tui";
import { toolItemDetails, type ToolItem } from "./agents-protocol.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

// The Agents preview draws a tool call with the chat's own renderer instead of a
// second card kept in step by hand. A preview card that is re-implemented drifts
// from the transcript the first time either side changes — that is how `write`
// and `edit` came to read one way in the chat and another in the pane — so the
// renderers are offered here by the module that already owns them for the
// transcript (extensions/quiet-tools.ts) and resolved by name when a retained
// call is drawn.
//
// Only an owner offers its own renderers: an offer is that module's declaration
// that its card draws from the call's own arguments, its retained text, and the
// bounded display details the protocol keeps for that tool (`ToolItemDetails` —
// today the edit card's own diff). A retained call carries no other details
// payload and no images, so a card that reads anything else from `result.details`
// cannot be drawn here faithfully — it would state something the preview cannot
// know. Such a card is left out rather than approximated (extensions/quiet-tools.ts
// names the ones this package knows). The call's own measured duration is
// retained too, so a card that draws an elapsed time draws the child's number
// rather than none.
//
// A tool nobody offered keeps the preview's own card (lib/agents-thread-view.ts),
// and so does an offered renderer that cannot draw the retained call: the
// preview never guesses at a card the chat would not draw.

/**
 * What a chat renderer receives as its theme. A card names theme roles (`fg`),
 * paints a background when the theme carries one (`bg`), styles text with the
 * attributes below, and paints a color of its own through the host theme's
 * pipeline (`style`) — a card identity that no theme role defines is a color the
 * card owns, and only the host theme knows which escape the terminal can show.
 * A theme that omits an attribute is answered with the text itself rather than an
 * error, so the preview works with any host theme.
 */
export interface AgentToolRendererTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
	strikethrough?(text: string): string;
}

/** The result-view options pi hands a tool result renderer. */
export interface AgentToolResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

/**
 * The render context pi hands a tool renderer. The preview fills it with what a
 * retained call can honestly provide: its own arguments, the preview's expansion
 * state, and a fresh row state the call and its result share.
 */
export interface AgentToolRenderContext {
	args: Record<string, unknown>;
	toolCallId: string;
	invalidate(): void;
	lastComponent: Component | undefined;
	state: unknown;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
	durationMs: number | undefined;
	/**
	 * The host's configured horizontal padding. The preview draws at the width it
	 * is given and applies no padding of its own, so a renderer that would apply it
	 * sees none to add.
	 */
	outputPad: number;
}

/**
 * One tool's chat renderers, as pi's renderer registry resolves them.
 *
 * Only `renderShell: "self"` is reusable here: every other renderer draws its
 * content while pi paints the row's shell and padding around it, so rendering
 * that component alone would show a row the transcript never draws.
 */
export interface AgentToolRenderer {
	renderShell?: string;
	renderCall?(args: Record<string, unknown>, theme: AgentToolRendererTheme, context: AgentToolRenderContext): Component;
	renderResult?(result: AgentToolResult<unknown>, options: AgentToolResultOptions, theme: AgentToolRendererTheme, context: AgentToolRenderContext): Component;
}

export interface AgentToolRenderOptions {
	/** Whether this card is expanded, from the preview's own presentation state. */
	expanded: boolean;
}

/** Who is offering a set of renderers, and which tool names it covers. */
export interface AgentToolRendererRegistration {
	/**
	 * The module offering these renderers, for example its extension name. One
	 * owner's next registration replaces every offer that owner made before, so a
	 * reload re-describes its cards instead of accumulating them, and an owner that
	 * stops drawing a card withdraws it instead of leaving a stale one behind.
	 */
	owner?: string;
}

interface AgentToolRendererEntry {
	renderer: AgentToolRenderer;
	/** The module that offered this renderer, so it alone can replace or withdraw it. */
	owner: string;
}

interface AgentToolRendererRegistry {
	/** The renderer each tool name resolves to: the newest offer for that name. */
	byName: Map<string, AgentToolRendererEntry>;
	/** The tool names each owner currently offers. */
	byOwner: Map<string, Set<string>>;
}

// pi loads every extension with its own module cache, so the extension that owns
// a renderer and the one that draws the overlay can hold two copies of this
// module. The process-wide slot keeps one registry per process, exactly like the
// card style and card content slots; an unset slot is an empty registry. The
// slot name carries the shape version: a registry written by an older copy of
// this module is ignored rather than misread.
const REGISTRY_SLOT = Symbol.for("gentle-pi.agents-tool-renderers.v2");
const host = globalThis as typeof globalThis & { [REGISTRY_SLOT]?: unknown };
const UNNAMED_OWNER = "agents-preview";

function registry(): AgentToolRendererRegistry {
	const existing = host[REGISTRY_SLOT] as AgentToolRendererRegistry | undefined;
	if (existing !== undefined && existing.byName instanceof Map && existing.byOwner instanceof Map) return existing;
	const created: AgentToolRendererRegistry = { byName: new Map(), byOwner: new Map() };
	host[REGISTRY_SLOT] = created;
	return created;
}

/**
 * Drops one owner's previous offers. A name another owner has offered since stays
 * with that owner: withdrawing never takes a card away from the module that
 * offered it.
 */
function withdrawOwner(registry: AgentToolRendererRegistry, owner: string): void {
	for (const name of registry.byOwner.get(owner) ?? []) {
		if (registry.byName.get(name)?.owner === owner) registry.byName.delete(name);
	}
	registry.byOwner.delete(owner);
}

/**
 * Offers the chat's renderers to the Agents preview and returns the tool names
 * accepted. A registration describes the owner's current cards: names it offered
 * before and no longer offers are withdrawn, and a name offered again resolves to
 * the newest renderer (last-writer-wins across owners too). A renderer pi would
 * wrap in its own shell, or one with no call slot, cannot be reused as a whole row
 * and is skipped rather than approximated.
 */
export function registerAgentToolRenderers(
	renderers: Readonly<Record<string, AgentToolRenderer | undefined>>,
	registration: AgentToolRendererRegistration = {},
): string[] {
	const owner = registration.owner ?? UNNAMED_OWNER;
	const current = registry();
	withdrawOwner(current, owner);
	const accepted = new Set<string>();
	for (const [name, renderer] of Object.entries(renderers)) {
		if (renderer === undefined) continue;
		if (renderer.renderShell !== "self" || typeof renderer.renderCall !== "function") continue;
		current.byName.set(name, { renderer, owner });
		accepted.add(name);
	}
	current.byOwner.set(owner, accepted);
	return [...accepted];
}

/** The tool names the preview can draw with the chat's renderers. */
export function agentToolRendererNames(): string[] {
	return [...registry().byName.keys()];
}

/**
 * Forget registered renderers: one owner's offers when `owner` is named, every
 * owner's otherwise. A withdrawn tool falls back to the preview's own card.
 */
export function clearAgentToolRenderers(owner?: string): void {
	const current = registry();
	if (owner === undefined) {
		current.byName.clear();
		current.byOwner.clear();
		return;
	}
	withdrawOwner(current, owner);
}

/**
 * The retained call, as the chat's result renderer receives it: the text the
 * child's tool returned, and the bounded display details the thread kept for that
 * tool — an edit's own diff, which is what its card counts and expands to, plus the
 * whole edit's totals when that diff had to be cut to fit its budget.
 *
 * The details are validated here rather than trusted: the item may have been
 * restored from a history file, copied out of a hand-built thread, or written by
 * a later version, so the drawing boundary re-applies the protocol's per-tool
 * whitelist, shape checks, sanitizer and cap — and re-checks that a truncation
 * claim's numbers are a whole diff's totals rather than ones an item invented. A
 * call that carries nothing valid is handed none, and its card states only what the
 * retained text supports.
 *
 * The text is cleaned for the same reason, and by the same sanitizer the pane's own
 * card applies to an output before painting it
 * (lib/agents-thread-view.ts printableOutput): a restored item is not evidence that
 * its strings went through the store's sanitizer, and a chat card draws the text it
 * is handed, so a control byte left here would reach the terminal.
 */
function retainedResult(item: ToolItem): AgentToolResult<unknown> {
	const details = toolItemDetails(item.name, item.details);
	return { content: [{ type: "text", text: sanitizeTerminalText(item.output) }], details: details === undefined ? undefined : { ...details } };
}

/**
 * The call's arguments as the chat's renderer may read them: every string cleaned,
 * at any depth, because a card names a path or a command on its heading and draws a
 * written file's content itself.
 *
 * Why here: the protocol retains the child's arguments as they arrived, so an item
 * restored from disk, copied from a hand-built thread, or written by a later version
 * may carry control bytes no store sanitiser has seen. A container nothing changed in
 * is returned as it is, so the common case allocates nothing and a renderer that
 * compares arguments by identity still sees one object.
 */
function printableArgs(args: Record<string, unknown>): Record<string, unknown> {
	return printable(args) as Record<string, unknown>;
}

function printable(value: unknown): unknown {
	if (typeof value === "string") return sanitizeTerminalText(value);
	if (Array.isArray(value)) {
		const rows = value.map(printable);
		return rows.every((row, index) => row === value[index]) ? value : rows;
	}
	if (value === null || typeof value !== "object") return value;
	// Validated JSON payloads only: plain objects, arrays, strings, numbers, booleans
	// and null, so walking own enumerable entries covers everything a card can read.
	// `Object.fromEntries` defines each key instead of assigning it, so an argument
	// named `__proto__` stays an own property rather than reaching the prototype.
	const source = value as Record<string, unknown>;
	const entries = Object.entries(source).map(([key, entry]) => [key, printable(entry)] as const);
	const changed = entries.some(([key, entry]) => entry !== source[key]);
	return changed ? Object.fromEntries(entries) : source;
}

/**
 * The preview theme as a chat renderer reads it. Roles are forwarded to the
 * theme the overlay was handed, and an attribute the theme does not carry is the
 * text itself — the chat's own renderers style a tool name with `bold`, so a
 * missing attribute may not throw.
 *
 * A card names theme roles, never a color of its own, so an adapter that forwards
 * them draws the card exactly as the transcript does — including the ODD file
 * card's `mdHeading` heading and rail.
 */
function rendererTheme(theme: AgentToolRendererTheme): AgentToolRendererTheme {
	const attribute = (apply?: (text: string) => string) => (text: string) => (typeof apply === "function" ? apply.call(theme, text) : text);
	return {
		fg: (color, text) => theme.fg(color, text),
		...(typeof theme.bg === "function" ? { bg: (color, text) => theme.bg!(color, text) } : {}),
		bold: attribute(theme.bold),
		italic: attribute(theme.italic),
		underline: attribute(theme.underline),
		strikethrough: attribute(theme.strikethrough),
	};
}

/**
 * The elapsed time the card may draw, or `undefined`: the child's own measurement
 * of a call that finished. A running call has not been timed yet, and a value
 * that is not a real measurement is never passed on as one.
 */
function retainedDuration(item: ToolItem): number | undefined {
	const value = item.durationMs;
	return !item.running && typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Draws one retained tool call with the chat's renderers: the call slot, then the
 * result slot that closes the row, at the preview's width.
 *
 * Returns `undefined` when no reusable renderer owns this tool name, or when the
 * renderer cannot draw the retained call — the caller then draws its own card. An
 * empty array is a renderer that legitimately draws nothing for this call, which
 * is kept rather than replaced.
 */
export function renderAgentToolItem(
	item: ToolItem,
	theme: AgentToolRendererTheme,
	width: number,
	options: AgentToolRenderOptions,
): string[] | undefined {
	const renderer = registry().byName.get(item.name)?.renderer;
	if (renderer === undefined || renderer.renderCall === undefined) return undefined;
	const target = Math.max(0, Math.floor(width));
	if (target === 0) return [];
	// One fresh row state per draw: the card's reveal hints and the "a result is in"
	// mark live there, and the preview keeps no host row between frames.
	const state: Record<PropertyKey, unknown> = {};
	// The call's arguments are cleaned once and the same copy reaches the call slot
	// and the context, so a renderer that reads either sees what the other did.
	const args = printableArgs(item.args);
	const context: AgentToolRenderContext = {
		args,
		toolCallId: item.callId,
		// The preview owns its own cache and repaints on its own request, so the row
		// has nothing to invalidate; the no-op keeps the context honest.
		invalidate: () => {},
		lastComponent: undefined,
		state,
		// The protocol retains no working directory, so there is none to hand down: a
		// card names the call's own arguments, never a path resolved against a guess.
		cwd: "",
		executionStarted: !item.running,
		argsComplete: true,
		isPartial: item.running,
		expanded: options.expanded,
		showImages: false,
		isError: item.isError,
		// The elapsed time the chat's card draws comes from the child's own measurement,
		// retained with the call; a call it did not time draws none here either. The
		// preview has no host padding to hand down.
		durationMs: retainedDuration(item),
		outputPad: 0,
	};
	const adapted = rendererTheme(theme);
	try {
		const call = renderer.renderCall(args, adapted, context);
		// A call still running with nothing yet retained has no result slot, exactly
		// as the transcript draws it: the call closes its own frame until output
		// arrives.
		const result = item.running && item.output.length === 0
			? undefined
			: renderer.renderResult?.(retainedResult(item), { expanded: options.expanded, isPartial: item.running }, adapted, context);
		// The result slot is built before either is drawn: it marks the shared row
		// state with the reveal hints the call slot reads.
		return [...call.render(target), ...(result === undefined ? [] : result.render(target))];
	} catch {
		return undefined;
	}
}
