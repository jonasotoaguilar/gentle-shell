import { Markdown, type Color, type MarkdownTheme } from "@earendil-works/pi-tui";
import { THREAD_ITEM, type ThreadItem, type ToolItem } from "./agents-protocol.ts";
import { contentLines, line } from "./agents-thread-rows.ts";
import { renderThreadLogItem } from "./agents-thread-log-view.ts";
import { SHELL_ACTIVITY_IDENTITY, inferShellActivity } from "./odd-phase-inference.ts";
import { renderAgentToolItem } from "./agents-tool-renderers.ts";
import { CARD_TONE, cardBodyRows, cardBottom, cardElapsed, cardInnerWidth, cardLine, cardRunningLine, cardTopLine, cardTopRows, diffRows, floatRows, type CardTone } from "./shell-card.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { versioningCardPreview } from "./versioning-card-preview.ts";
import { FILE_CARD_IDENTITY, fileCardIdentity, fileCardLineRange, fileCardMarkdownRows, fileCardMarkdownTheme, fileCardName, markdownDocumentSource, type FileCardMark } from "./skill-odd-card.ts";

export interface AgentsThreadTheme {
	fg(color: string, text: string): string;
	/** Pi themes carry it; a float card needs it to paint its tone background. */
	bg?(color: string, text: string): string;
	/** Pi themes carry the text attributes the Markdown renderer applies. */
	bold?(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
	strikethrough?(text: string): string;
}

/** Presentation state the overlay renders a thread item with. */
export interface ThreadItemOptions {
	/**
	 * Whether this item's card is expanded. The overlay passes its own state,
	 * initialized from the chat when it opens; false shows the collapsed preview.
	 */
	toolsExpanded?: boolean;
	/** Whether thinking is shown; false collapses a thinking run to its label. */
	thinkingVisible?: boolean;
	/**
	 * How the host displays the chat's tool-expansion toggle — the key Pi resolved
	 * for `app.tools.expand`, so a user remap reaches the card — or "" when the
	 * action is bound to no key. A card the preview draws itself names it on its
	 * heading only when the two expansion levels draw different rows: a key that
	 * reveals nothing is not advertised. A chat renderer carries its own hint and
	 * never reads this.
	 */
	expandLabel?: string;
}

const ROLE = {
	TEXT: "text",
	THINKING: "thinkingText",
	NOTE: "muted",
	INPUT_TEXT: "userMessageText",
} as const;

// A thread tool call wears the same mark its card uses in the conversation, so
// a preview row and the transcript row it mirrors never read as two tools.
const TOOL_GLYPH: Record<string, string> = {
	bash: "$",
	read: "≡",
	grep: "⌕",
	find: "⌖",
	ls: "☷",
	edit: "✎",
	write: "+",
	codegraph: "󰆼", // U+F01BC
	subagent_run: "→",
	subagent_status: "◎",
	subagent_result: "↩",
	subagent_cancel: "⨯",
	subagent_send_message: "✉",
	subagent_reply: "✉",
	subagent_continue: "↻",
	subagent_list_tasks: "☰",
	subagent_list_agents: "☰",
};
const TOOL_GLYPH_FALLBACK = "✻";
// A shell call heads its card with the activity its own command names, exactly as
// the chat's bash card does (lib/odd-phase-inference.ts SHELL_ACTIVITY_IDENTITY):
// the same mark, the same theme role, and the same role on the rail that leads its
// rows, so one call reads the same in the pane and in the transcript. The activity
// is derived from the retained call's own arguments — never from a stored or
// reconstructed session state — and an ambiguous command claims none. Preparing,
// formatting, destructive, versioning and publishing are card identities only;
// none of them is an ODD phase or an authorization.
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);
// The tools whose call names one file: a skill or an ODD artifact heads as that
// file, through the same classification the chat's card uses
// (lib/skill-odd-card.ts), so one call reads the same in the pane and in the
// transcript.
const FILE_CARD_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write"]);
// Pi renders assistant prose through its Markdown component. Below this many
// columns that renderer's own chrome (a padding column, fence rules) leaves no
// room for the text, so the pane keeps plain wrapped prose instead.
const MARKDOWN_MIN_WIDTH = 12;
// The chat's Markdown theme maps every element to a theme role; the pane builds
// the same mapping from the theme it was handed, so both render alike.
const markdownThemes = new WeakMap<AgentsThreadTheme, MarkdownTheme>();
// A fence whose language names no syntax carries prose, not a code sample: the
// chat draws it as a code block — the `text` label, the code palette and a
// two-column indent — which inside the pane reads as an answer boxed in. A
// subagent's handoff arrives exactly that way, so the pane unwraps those
// containers and shows the prose itself. Every real language, and a fence with
// no language at all, keeps its code block.
const PLAIN_TEXT_LANGUAGES: ReadonlySet<string> = new Set(["text", "txt", "plain", "plaintext"]);
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
// The input block's card is the chat's own Messaging agent card: the same iris
// heading, glyph, rail and tint extensions/gentle-agents.ts paints for a
// message between the parent and its child. The theme roles the card asks for
// are remapped to that identity here, so the pane never invents a second one.
// U+2709 is drawn two cells wide by an emoji-fallback font while pi-tui counts
// it as one, so a single space after it is painted inside the glyph's second
// cell and reads as `✉Messaging`. The envelope therefore carries its own gap —
// the two-cell glyph gap the sidebar widgets keep — so one column always shows
// and the heading's counted width matches what the terminal paints.
const MESSAGE_GLYPH = "✉ ";
const MESSAGE_TITLE = "Messaging agent";
const MESSAGE_LABEL = "note";
const IRIS_FG = "\x1b[38;2;185;167;242m";
const IRIS_DEEP_FG = "\x1b[38;2;143;122;217m";
const IRIS_TINT_BG = "\x1b[48;2;26;21;38m";
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";
// Arguments a card names on its heading, most specific first. Only these keys
// are read: a tool that passes a file body never puts it on the heading, and
// presence threads publish no arguments at all.
const DETAIL_KEYS = ["command", "path", "query", "task", "prompt", "url", "agent", "name", "title", "subject"] as const;
const MAX_DETAIL = 200;
// The label Pi puts in place of a thinking run while thinking is hidden.
const HIDDEN_THINKING_LABEL = "Thinking...";
// Body rows a collapsed tool card previews: the budget the chat's own cards use.
const COLLAPSED_TOOL_ROWS = 3;
/**
 * Marker `lib/agents-runner.ts` writes when it delivers a message to a running
 * child. The protocol carries no user-item kind, so a note that starts with
 * exactly this text is the retained form of an input message — and nothing
 * else is: every other note keeps its own label.
 */
export const STEERED_NOTE_PREFIX = "steered: ";

function clean(value: string): string {
	return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

/** Pi's Markdown theme, built from the theme the pane was handed. */
function markdownTheme(theme: AgentsThreadTheme): MarkdownTheme {
	const cached = markdownThemes.get(theme);
	if (cached) return cached;
	// The chat's file cards build their Markdown theme the same way, so prose and a
	// rendered Markdown file read alike in both places.
	const built = fileCardMarkdownTheme(theme);
	markdownThemes.set(theme, built);
	return built;
}

// Assistant prose is Markdown everywhere in Pi, so the pane renders it with the
// same component instead of echoing its source (`## Handoff`, a raw ``` fence).
function markdownLines(text: string, theme: AgentsThreadTheme, width: number): string[] {
	const source = sanitizeTerminalText(unwrapPlainTextFences(text));
	if (width < MARKDOWN_MIN_WIDTH) return contentLines(theme, ROLE.TEXT, source, width, 1);
	return new Markdown(source, 1, 0, markdownTheme(theme)).render(width);
}

/**
 * Drops the fences that only group prose: a ```text (or txt/plain/plaintext)
 * container adds a label, a palette and an indent to text that needed none, so
 * its body is left in place and rendered as the prose it already is. Every other
 * fence — a real language, or none — is kept as the code block it declares.
 */
function unwrapPlainTextFences(source: string): string {
	const kept: string[] = [];
	// The fence we are inside, and whether it was dropped on the way in.
	let open: { plain: boolean } | undefined;
	for (const row of source.split("\n")) {
		if (open !== undefined) {
			if (FENCE_CLOSE.test(row)) {
				if (!open.plain) kept.push(row);
				open = undefined;
				continue;
			}
			kept.push(row);
			continue;
		}
		const opener = FENCE_OPEN.exec(row);
		if (opener === null) {
			kept.push(row);
			continue;
		}
		const plain = PLAIN_TEXT_LANGUAGES.has((opener[2] ?? "").toLowerCase());
		if (!plain) kept.push(row);
		open = { plain };
	}
	return kept.join("\n");
}

/** The chat's agent-card identity applied to the theme the pane was handed. */
function messageTheme(theme: AgentsThreadTheme): AgentsThreadTheme {
	const paint = theme.bg;
	return {
		fg: (color, text) => color === "accent" ? `${IRIS_FG}${text}${FG_RESET}`
			: color === "border" ? `${IRIS_DEEP_FG}${text}${FG_RESET}`
			: theme.fg(color, text),
		...(typeof paint === "function" ? { bg: (color, text) => color === "toolSuccessBg" ? `${IRIS_TINT_BG}${text}${BG_RESET}` : paint.call(theme, color, text) } : {}),
	};
}

function field(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (typeof value !== "string") return undefined;
	const text = clean(value);
	return text.length === 0 ? undefined : text.slice(0, MAX_DETAIL);
}

/**
 * A retained shell command, whole: terminal escapes stripped, runs of whitespace
 * folded, blank edge rows dropped, and every line of a multi-line command kept.
 * The command is the call itself, not an argument a heading may abbreviate — the
 * chat's bash card names the complete command too — so it is never cut here: an
 * expanded card continues it on the rows below, and the collapsed heading folds
 * those lines back onto one row that ends in an ellipsis.
 */
function commandText(args: Record<string, unknown>): string | undefined {
	const value = args.command;
	if (typeof value !== "string") return undefined;
	const rows = sanitizeTerminalText(value).split("\n").map((row) => row.replace(/\s+/gu, " ").trim());
	while (rows.length > 0 && rows[0] === "") rows.shift();
	while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return rows.length === 0 ? undefined : rows.join("\n");
}

/** The command a shell call ran, whole; nothing for any other tool or an absent command. */
function shellCommand(item: ToolItem): string | undefined {
	return SHELL_TOOLS.has(item.name) ? commandText(item.args ?? {}) : undefined;
}

/** The file card a retained call wears, or undefined when it names no skill or ODD file. */
function fileCard(item: ToolItem): FileCardMark | undefined {
	return FILE_CARD_TOOLS.has(item.name) ? fileCardIdentity((item.args ?? {}).path) : undefined;
}

/**
 * The detail a CodeGraph call heads with: its operation, and the query that
 * operation acted on. The chat's card names both (`󰆼 codegraph · init`,
 * `󰆼 codegraph · query postEntry`), so the pane names both too — an init call
 * has no query, and a row that dropped the operation would read as the bare
 * tool with no access to name of the work it did.
 */
function codeGraphDetail(item: ToolItem): string | undefined {
	if (item.name !== "codegraph") return undefined;
	const args = item.args ?? {};
	const operation = field(args, "operation");
	if (operation === undefined) return undefined;
	const query = field(args, "query");
	return query === undefined ? operation : `${operation} ${query}`;
}

/** The one argument a card names, or nothing when the thread carried none. */
function toolDetail(item: ToolItem, theme: AgentsThreadTheme, expanded: boolean): string | undefined {
	const args = item.args ?? {};
	// A shell call heads with the command it ran, shown whole rather than bounded
	// like another tool's path or query.
	const command = shellCommand(item);
	if (command !== undefined) return command;
	// A file card heads as the file kind, so its detail names the tool, the path
	// and the range the call reads or writes, in the chat's own roles.
	const card = fileCard(item);
	if (card !== undefined) {
		const full = field(args, "path") ?? "";
		// The same rule the chat's card follows: collapsed an ODD card names the file, and
		// expanding it is what states the path and the range together.
		const path = card.identity === FILE_CARD_IDENTITY.ODD && !expanded ? fileCardName(full) || full : full;
		const range = fileCardLineRange(item.name, args);
		return `${item.name} ${theme.fg("accent", path)}${range === undefined ? "" : theme.fg("warning", range)}`;
	}
	const pattern = field(args, "pattern");
	if (pattern !== undefined) {
		const where = field(args, "path");
		return where === undefined ? `/${pattern}/` : `/${pattern}/ in ${where}`;
	}
	const codeGraph = codeGraphDetail(item);
	if (codeGraph !== undefined) return codeGraph;
	for (const key of DETAIL_KEYS) {
		const value = field(args, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

function toolTone(item: ToolItem): CardTone {
	if (item.isError) return CARD_TONE.ERROR;
	return item.running ? CARD_TONE.WARNING : CARD_TONE.SUCCESS;
}

/** The card's heading: the activity a shell command names, the file kind a call touches, or the tool itself. */
function toolHeading(item: ToolItem): { title: string; glyph: string; titleRole?: string; railRole?: string } {
	if (SHELL_TOOLS.has(item.name)) {
		const command = item.args?.command;
		const activity = typeof command === "string" ? inferShellActivity(command) : undefined;
		if (activity !== undefined) {
			const identity = SHELL_ACTIVITY_IDENTITY[activity];
			// A phase card paints the rail that leads its rows in its own role; the
			// label and the rail are two halves of one heading.
			return { title: activity, glyph: identity.glyph, titleRole: identity.titleRole, railRole: identity.titleRole };
		}
	}
	const card = fileCard(item);
	if (card !== undefined) return { title: card.title, glyph: card.glyph, titleRole: card.titleRole, railRole: card.railRole };
	return { title: clean(item.name) || "tool", glyph: TOOL_GLYPH[item.name] ?? TOOL_GLYPH_FALLBACK };
}

// A tool call is one card in the conversation's own card style: the tool (or the
// phase its command implies, or the file kind a skill/ODD call touches) and the
// call on the heading, the retained output inside, and a tone that tells a
// running, finished and failed call apart. The rail down the card is painted in
// the heading's own role on a phase card, so its left edge reads as part of its
// label while the frame keeps the status tone; every other card's rail stays in
// the tone. The card follows the overlay's own expansion state, so a collapsed
// preview and an expanded one are the same card.
//
// This is the fallback: a tool whose chat renderer was registered (see
// lib/agents-tool-renderers.ts) is drawn by that renderer instead, and the pane
// never keeps a second card in step by hand. Only a tool the chat does not draw —
// a subagent call, a remote presence row, a host without the chat's renderers —
// reaches this card, which carries the two facts the transcript's cards carry: the
// key that toggles it (when toggling reveals rows) and the time the child measured.
function toolCard(item: ToolItem, theme: AgentsThreadTheme, width: number, expanded: boolean, expandLabel?: string): string[] {
	const drawn = toolCardRows(item, theme, width, expanded);
	// The key is named on the heading only when it does something, and the other
	// level is the only way to know: a running card has not decided what it reveals
	// yet (the transcript withholds its hint until the result arrives), and a host
	// that left the action unbound names no key at all. Both levels are measured as
	// rows, where they are drawn, because expanding may reveal rows the preview hid
	// or continue a shell command the collapsed heading folded onto one row.
	const label = clean(expandLabel ?? "");
	if (label.length === 0 || item.running) return drawn;
	const other = toolCardRows(item, theme, width, !expanded);
	if (drawn.join("\n") === other.join("\n")) return drawn;
	return toolCardRows(item, theme, width, expanded, `${label} to ${expanded ? "collapse" : "expand"}`);
}

// One expansion level of the pane's own card, at the width it is drawn on. The
// closing rule carries the elapsed time the child measured (lib/shell-card.ts
// owns the wording), and the heading carries `hint` when the card has one.
function toolCardRows(item: ToolItem, theme: AgentsThreadTheme, width: number, expanded: boolean, hint?: string): string[] {
	const tone = toolTone(item);
	const heading = toolHeading(item);
	const card = {
		title: heading.title,
		subtitle: toolDetail(item, theme, expanded),
		body: [],
		tone,
		glyph: heading.glyph,
		titleRole: heading.titleRole,
	};
	// A running call is not timed yet, and a value that is not a measurement draws
	// nothing: the pane never shows an elapsed time the child did not report.
	const elapsed = cardElapsed(item.running ? undefined : item.durationMs);
	return floatRows(tone, theme, width, (inner) => ({
		// Collapsed, the heading is the chat's one row and an over-wide call ends in
		// an ellipsis. A shell call's command is shown whole, so expanding continues
		// it on the rows below instead of cutting the command the child ran; every
		// other card keeps its bounded one-row detail.
		head: expanded && shellCommand(item) !== undefined ? cardTopRows(card, theme, inner, hint) : [cardTopLine(card, theme, inner, hint)],
		body: item.output.length > 0
			? toolBody(item, tone, theme, inner, expanded)
			: item.running ? [cardRunningLine(tone, theme, inner)] : [],
		bottom: cardBottom(tone, theme, inner, elapsed),
	}), heading.railRole);
}

// A versioning call previews the shape its own command named through the chat's
// shared helper (lib/versioning-card-preview.ts), so a commit and a silent add read
// the same in the pane and in the transcript; every other shell call — a gh read or
// a gh create included — keeps the rows the child printed. The pane keeps its own
// marker: a preview that leaves rows behind says so — because the preview reads less
// than the whole output, or because the rows it does keep no longer fit once wrapped
// — and one that shows the result whole adds nothing to reveal.
function toolBody(item: ToolItem, tone: CardTone, theme: AgentsThreadTheme, width: number, expanded: boolean): string[] {
	// The output as the call produced it, for everything that reads its shape; and the
	// rows this card draws, where an edit's diff is painted row by row.
	const output = printableOutput(item);
	const drawn = diffPainted(item, output, theme);
	if (expanded) {
		// An expanded read of a Markdown file — and an expanded write to one, drawing the
		// content it wrote — renders through the same shared Markdown renderer the chat's
		// card uses. The rule that decides it lives beside the file-card classification,
		// so the pane and the transcript cannot disagree about which call draws a document
		// and which keeps its rows: an edit keeps its diff, a failed call keeps its error,
		// and a collapsed card keeps the preview.
		const markdownSource = markdownDocumentSource(item.name, item.args, output, { expanded, isError: item.isError });
		if (markdownSource !== undefined) {
			const rows = fileCardMarkdownRows(markdownSource, theme, cardInnerWidth(width));
			if (rows.length > 0) return cardBodyRows([rows.join("\n")], tone, theme, width, { expanded: true });
		}
		return cardBodyRows([drawn], tone, theme, width, { expanded: true });
	}
	const command = shellCommand(item) ?? "";
	const preview = versioningCardPreview({ command, output, failed: item.isError, limit: COLLAPSED_TOOL_ROWS });
	if (preview === undefined) return collapsedBody(drawn, tone, theme, width);
	if (preview.text === "") return [];
	const wrapped = cardBodyRows([preview.text], tone, theme, width, { expanded: true });
	// A preview says which end of its rows it is: an inspection keeps the last, while a
	// failure leads with its cause and so keeps the first — that is what stops wrapping
	// on a narrow pane from hiding the reason the call failed.
	const rows = preview.tail ? wrapped.slice(-COLLAPSED_TOOL_ROWS) : wrapped.slice(0, COLLAPSED_TOOL_ROWS);
	const hides = preview.reveals || wrapped.length > COLLAPSED_TOOL_ROWS;
	return hides ? [...rows, cardLine(theme.fg(ROLE.NOTE, "…"), tone, theme, width)] : rows;
}

/**
 * The retained output as the pane may draw it.
 *
 * A tool's output is arbitrary text, and a control byte can reach a retained thread
 * even though the store sanitizes what it keeps: a payload's own JSON escape (`\u001b[31m`,
 * `\u0007`) is text until something decodes it, and JSON leaves the C1 block raw. The
 * store's copy is never rewritten — a resumed session must show what was kept — so this
 * is a presentation copy: the untrusted bytes are removed here, and the theme's own
 * escapes are painted afterwards, where sanitizing a drawn row would have taken them too.
 */
function printableOutput(item: ToolItem): string {
	return sanitizeTerminalText(item.output);
}

/**
 * The rows this card draws for a sanitized output: for an edit, painted row by row
 * through the shared diff helper (lib/shell-card.ts), so the rows the edit added
 * wear the theme's added role and the rows it removed its removed role, exactly as
 * they do in the chat. Every other call, and a failed edit whose rows are its error
 * rather than a diff, keeps one color for the whole output, and the rows no diff
 * mark names are left as they arrived.
 */
function diffPainted(item: ToolItem, output: string, theme: AgentsThreadTheme): string {
	return item.name === "edit" && !item.isError ? diffRows(output, theme) : output;
}

// A collapsed card keeps the chat's bounded preview and says that rows remain,
// so nothing disappears from the pane without a sign it did. Only the rows the
// preview can show are wrapped, never a retained output whose tail stays hidden.
function collapsedBody(output: string, tone: CardTone, theme: AgentsThreadTheme, width: number): string[] {
	const lines = output.split("\n");
	const rows = cardBodyRows([lines.slice(0, COLLAPSED_TOOL_ROWS).join("\n")], tone, theme, width, { expanded: true });
	const shown = rows.slice(0, COLLAPSED_TOOL_ROWS);
	return lines.length > COLLAPSED_TOOL_ROWS || rows.length > COLLAPSED_TOOL_ROWS
		? [...shown, cardLine(theme.fg(ROLE.NOTE, "…"), tone, theme, width)]
		: shown;
}

/**
 * A message the subagent received, drawn as the chat's own Messaging agent
 * card: the iris heading `✉  Messaging agent · note`, the iris rail on the left
 * and the whole message below it on the card's tint. It borrows that card's
 * design, not its behavior — a message has no preview to open, so it is always
 * shown whole and carries no expansion hint. Used only for text the store holds
 * as input: a task's own prompt (`TaskRecord.prompt`) and the messages the
 * runner records for a running child — never for assistant output.
 */
export function renderInputMessage(text: string, theme: AgentsThreadTheme, width: number): string[] {
	const target = Math.max(0, Math.floor(width));
	const source = sanitizeTerminalText(text);
	if (target <= 0 || source.trim().length === 0) return [];
	const painted = messageTheme(theme);
	const card = { title: MESSAGE_TITLE, subtitle: MESSAGE_LABEL, body: [], tone: CARD_TONE.INFO, glyph: MESSAGE_GLYPH };
	// One span per row, so no row leaves a colour open behind the card's padding.
	const rows = source.split("\n").map((row) => (row.trim().length === 0 ? "" : theme.fg(ROLE.INPUT_TEXT, row)));
	return floatRows(CARD_TONE.INFO, painted, target, (inner) => ({
		head: [cardTopLine(card, painted, inner)],
		body: cardBodyRows(rows, CARD_TONE.INFO, painted, inner, { expanded: true }),
		bottom: cardBottom(CARD_TONE.INFO, painted, inner),
	}));
}

/** Whether a retained note is the store's form of a message sent to the child. */
function steeredText(item: ThreadItem): string | undefined {
	if (item.kind !== THREAD_ITEM.NOTE || !item.text.startsWith(STEERED_NOTE_PREFIX)) return undefined;
	return item.text.slice(STEERED_NOTE_PREFIX.length);
}

/** Render already-sanitized, bounded protocol items without inferring content roles. */
export function renderThreadItem(item: ThreadItem, theme: AgentsThreadTheme, width: number, options: ThreadItemOptions = {}): string[] {
	if (width <= 0) return [];
	switch (item.kind) {
		case THREAD_ITEM.TEXT:
		// The chat prints assistant prose as Markdown at a one-column pad.
		return markdownLines(item.text, theme, width);
		case THREAD_ITEM.THINKING:
			// Visible thinking is inline prose like the chat's; hidden thinking is
			// the chat's one-row label instead of the reasoning it stands for.
			return options.thinkingVisible === false
				? [line(theme, ROLE.THINKING, HIDDEN_THINKING_LABEL, width)]
				: contentLines(theme, ROLE.THINKING, item.text, width, 1);
		case THREAD_ITEM.NOTE: {
			const steered = steeredText(item);
			if (steered !== undefined) return renderInputMessage(steered, theme, width);
			// A plain note has no card in the conversation, so it keeps the log view's
			// labelled meta row -- drawn by that renderer, not copied here, so the one
			// item the two views share cannot drift apart.
			return renderThreadLogItem(item, theme, width);
		}
		case THREAD_ITEM.TOOL:
			// The chat already draws this tool: reuse its renderers verbatim, so a call
			// reads the same in the pane and in the transcript. A tool the chat has no
			// reusable renderer for keeps the pane's own card, which names the host's
			// expand key when expanding reveals rows and the child's measured time.
			return renderAgentToolItem(item, theme, width, { expanded: options.toolsExpanded !== false }) ?? toolCard(item, theme, width, options.toolsExpanded !== false, options.expandLabel);
		default:
			return [];
	}
}
