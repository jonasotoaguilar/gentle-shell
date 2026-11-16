import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CARD_PADDING, renderPaletteCard, renderPaletteSelection } from "./command-palette.ts";
import { countCell, scopeDetailLine, type ScopeDetail } from "./file-scope-detail.ts";
import type { FilePickerTheme } from "./file-picker-view.ts";
import { paintHoverable } from "./shell-hover.ts";
import { sanitizeTerminalText, stripAnsi } from "./terminal-theme.ts";

// Gentle Shell worktree scope step: the single-choice card every file picker
// invocation opens behind (S41). It knows only about scopes -- never about Git or
// the Pi session -- so the caller resolves the session repository, its
// registered worktrees, the clone's other worktrees, their uncommitted files
// (S32) and their Git detail (S33), and this component just orders, paints and
// routes them.

export interface FileScope {
	/** Stable identifier for the scope: the session repository or a worktree root. */
	root: string;
	/** Row label: `main` for the session repository, otherwise the same identity /changes shows (branch · directory name). */
	label: string;
	kind: "main" | "worktree";
	/** Recency used for ordering only; never rendered. */
	lastModifiedMs: number;
	/** The focused-scope line above the footer (S33); absent when nothing was measured. */
	detail?: ScopeDetail;
}

/**
 * `main` keeps the first row (S32) and the registered worktrees follow it,
 * most recently changed first; recency ties keep their input order. The input
 * array and its entries are left untouched.
 */
export function orderScopes(scopes: readonly FileScope[]): FileScope[] {
	const ranked = scopes.map((scope, index) => ({ scope, index }));
	const byRecency = (a: { scope: FileScope; index: number }, b: { scope: FileScope; index: number }): number =>
		(b.scope.lastModifiedMs - a.scope.lastModifiedMs) || (a.index - b.index);
	const main = ranked.filter((entry) => entry.scope.kind === "main").sort(byRecency);
	const worktrees = ranked.filter((entry) => entry.scope.kind !== "main").sort(byRecency);
	return [...main, ...worktrees].map((entry) => entry.scope);
}

export interface FileScopeDeps {
	theme: FilePickerTheme;
	rows: number | (() => number);
	/** The default list: the current checkout and the registered worktrees (S41). */
	scopes: readonly FileScope[];
	/**
	 * Every worktree of the clone, built before the step opens so `a` needs no
	 * Git and this view stays synchronous (S41). Absent means the toggle offers
	 * the registered list it already has.
	 */
	allScopes?: readonly FileScope[];
	/** Clock for the detail line's age, read once when the step opens (S33). Defaults to Date.now. */
	now?: number;
	onSelect(scope: FileScope): void;
	onClose(): void;
	requestRender(): void;
}

const TITLE = "File picker";
const SUBTITLE = "Choose a scope";
const NO_SCOPES = "No worktrees registered.";
// One option per action (S19): ctrl+j/k and ctrl+c keep working but are not
// advertised. The keys take the theme's key colour, the labels stay neutral (S32).
// The `a` label names the list the key switches TO, so the active state always
// says what pressing it does next (S41).
const footerHints = (showingAll: boolean): ReadonlyArray<readonly [string, string]> => [
	["↑/↓", "move"],
	["enter", "choose scope"],
	["a", showingAll ? "registered" : "all"],
	["esc", "close"],
];
const TOGGLE_KEY = "a";
const FOOTER_SEPARATOR = " • ";
const KEY_ROLE = "accent";
const KEY_LABEL_ROLE = "dim";
const MAX_CARD_HEIGHT = 24;
// Header, step subtitle, the focused-scope detail line and footer, plus the two
// card borders.
const CHROME_ROWS = 6;
const MIN_CARD_HEIGHT = CHROME_ROWS + 1;
const MIN_WIDTH = CARD_PADDING + 4;
// Card border, header and subtitle precede the first scope row.
const BODY_TOP = 3;

type Tone = "accent" | "muted" | "dim" | "text";

interface PointerHit {
	y: number;
	index: number;
}

interface PointerFrame {
	width: number;
	height: number;
	bodyTop: number;
	bodyRows: number;
	hits: PointerHit[];
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(stripAnsi(clipped))));
}

export class FileScopeView {
	private selected = 0;
	private hovered: number | undefined;
	private pointerFrame: PointerFrame | undefined;
	private completed = false;
	private disposed = false;
	/** Which built list the step paints: the registered one, or every worktree (S41). */
	private showingAll = false;
	private readonly deps: FileScopeDeps;
	private readonly registered: FileScope[];
	private readonly all: FileScope[];
	private readonly now: number;

	constructor(deps: FileScopeDeps) {
		this.deps = deps;
		this.registered = orderScopes(deps.scopes);
		this.all = orderScopes(deps.allScopes ?? deps.scopes);
		// The age is computed once when the step opens and never refreshed live.
		this.now = deps.now ?? Date.now();
	}

	/** The list the step is painting; both were built before it opened (S41). */
	private scopes(): readonly FileScope[] {
		return this.showingAll ? this.all : this.registered;
	}

	render(width: number): string[] {
		const height = this.cardHeight();
		if (width <= 0 || height <= 0) {
			this.pointerFrame = undefined;
			return [];
		}
		if (width < MIN_WIDTH || height < MIN_CARD_HEIGHT) {
			this.pointerFrame = undefined;
			return [fit(this.renderText(TITLE, "accent"), width)];
		}
		const innerWidth = Math.max(1, width - CARD_PADDING);
		const bodyRows = Math.max(0, height - CHROME_ROWS);
		const hits: PointerHit[] = [];
		const body = this.scopeRows(innerWidth, bodyRows, hits);
		const lines = [
			this.headerRow(innerWidth),
			fit(this.renderText(SUBTITLE, "muted"), innerWidth),
			...body,
			this.detailRow(innerWidth),
			this.footerRow(innerWidth),
		];
		const frame = renderPaletteCard(lines, width, this.deps.theme);
		this.pointerFrame = this.completed || this.disposed ? undefined : {
			width,
			height: frame.length,
			bodyTop: BODY_TOP,
			bodyRows: body.length,
			hits,
		};
		return frame;
	}

	handleInput(data: string): void {
		if (this.completed || this.disposed || isKeyRelease(data)) return;
		this.pointerFrame = undefined;
		this.hovered = undefined;
		// A bare line feed ("\n") is both ctrl+j and, on non-Kitty terminals,
		// a synonym for Enter: the move keys are checked first so ctrl+j moves
		// instead of choosing (same ordering as CommandPalette.handleInput and
		// lib/file-picker-view.ts).
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish("close");
			return;
		}
		// Plain `a` and no modifier: the step has no search field, so no printable
		// key has another job here (S41).
		if (data === TOGGLE_KEY) {
			this.toggleList();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) this.finish("select");
	}

	/** Mouse events are local to the last painted card, including its borders. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.completed || this.disposed) return undefined;
		const moving = event.type === "move" && event.button === "none";
		const frame = this.pointerFrame;
		if (!frame || event.width !== frame.width || event.height !== frame.height) {
			this.pointerFrame = undefined;
			const changed = this.setHover(undefined);
			return changed && moving ? { handled: true, render: true } : undefined;
		}
		const inside = event.x >= 2 && event.x < frame.width - 2 && event.y >= 0 && event.y < frame.height;
		const inBody = inside && event.y >= frame.bodyTop && event.y < frame.bodyTop + frame.bodyRows;
		const hit = inBody ? frame.hits.find((candidate) => candidate.y === event.y) : undefined;
		if (moving) return { handled: true, render: this.setHover(hit?.index) };
		if (event.type === "wheel" && event.wheelDelta) {
			if (!inside) return undefined;
			const changed = this.moveSelection(Math.sign(event.wheelDelta));
			const hoverChanged = this.setHover(undefined);
			if (changed) this.pointerFrame = undefined;
			return { handled: true, render: changed || hoverChanged };
		}
		if (event.button !== "left" || !hit) return undefined;
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		this.selected = hit.index;
		this.finish("select");
		return { handled: true, render: true };
	}

	invalidate(): void {
		this.pointerFrame = undefined;
		this.hovered = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.pointerFrame = undefined;
		this.hovered = undefined;
	}

	private cardHeight(): number {
		const available = typeof this.deps.rows === "function" ? this.deps.rows() : this.deps.rows;
		if (!Number.isFinite(available)) return 0;
		return Math.max(0, Math.min(MAX_CARD_HEIGHT, Math.floor(available)));
	}

	private clampedSelected(): number {
		const scopes = this.scopes();
		if (scopes.length === 0) return 0;
		return Math.max(0, Math.min(scopes.length - 1, this.selected));
	}

	private moveSelection(delta: number): boolean {
		const scopes = this.scopes();
		if (scopes.length === 0) return false;
		const next = Math.max(0, Math.min(scopes.length - 1, this.selected + delta));
		if (next === this.selected) return false;
		this.selected = next;
		return true;
	}

	// S41: the focused root decides the new cursor. A root the other list also
	// carries stays focused, so the switch never loses the reader's place; a root
	// the other list lacks leaves the cursor on the first row instead of an index
	// that no longer means the same row.
	private toggleList(): void {
		const focused = this.scopes()[this.clampedSelected()]?.root;
		this.showingAll = !this.showingAll;
		const scopes = this.scopes();
		const at = focused === undefined ? -1 : scopes.findIndex((scope) => scope.root === focused);
		this.selected = at >= 0 ? at : 0;
		this.pointerFrame = undefined;
		this.hovered = undefined;
		this.deps.requestRender();
	}

	private setHover(index: number | undefined): boolean {
		if (this.hovered === index) return false;
		this.hovered = index;
		return true;
	}

	// One single-shot flag covers both exits: this step is used once.
	private finish(action: "select" | "close"): void {
		if (this.completed || this.disposed) return;
		const scope = action === "select" ? this.scopes()[this.clampedSelected()] : undefined;
		if (action === "select" && !scope) return;
		this.completed = true;
		this.pointerFrame = undefined;
		this.hovered = undefined;
		if (!scope) {
			this.deps.onClose();
			return;
		}
		// Choosing hands the scope to the picker, which closes this step. A
		// throwing handoff must not leave a completed step with dead input.
		try {
			this.deps.onSelect(scope);
		} catch (error) {
			this.deps.onClose();
			throw error;
		}
	}

	private scopeRows(width: number, bodyRows: number, hits: PointerHit[]): string[] {
		const lines: string[] = [];
		const scopes = this.scopes();
		if (scopes.length === 0) {
			lines.push(fit(this.renderText(NO_SCOPES, "muted"), width));
		} else if (bodyRows > 0) {
			const selected = this.clampedSelected();
			const showIndicators = scopes.length > bodyRows && bodyRows >= 4;
			const windowSize = showIndicators ? Math.max(1, bodyRows - 2) : bodyRows;
			const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), Math.max(0, scopes.length - windowSize)));
			const end = Math.min(scopes.length, start + windowSize);
			if (showIndicators && start > 0) lines.push(fit(this.renderText(`  ↑ ${start} more`, "muted"), width));
			for (let index = start; index < end; index += 1) {
				hits.push({ y: BODY_TOP + lines.length, index });
				lines.push(this.renderScopeRow(scopes[index]!, index, selected, width));
			}
			if (showIndicators && end < scopes.length) lines.push(fit(this.renderText(`  ↓ ${scopes.length - end} more`, "muted"), width));
		}
		while (lines.length < bodyRows) lines.push("");
		return lines.slice(0, bodyRows);
	}

	private renderScopeRow(scope: FileScope, index: number, selectedIndex: number, width: number): string {
		const theme = this.deps.theme;
		const label = sanitizeTerminalText(scope.label);
		const selected = index === selectedIndex;
		const changed = scope.detail?.changedFiles ?? 0;
		if (changed <= 0) {
			if (selected) return fit(renderPaletteSelection(label, width, true, theme), width);
			const text = truncateToWidth(label, Math.max(0, width - 2), "…", true);
			return fit(`  ${paintHoverable(theme, text, index === this.hovered, "muted")}`, width);
		}
		// With a count the label and the count share the row: the count is the same
		// `±n files` cell the detail line paints (S34), keeps the theme's key colour
		// at the right edge and the label gets what is left.
		const count = countCell(changed);
		const countText = this.renderText(count, KEY_ROLE);
		const countWidth = visibleWidth(stripAnsi(countText));
		const room = Math.max(0, width - 2 - countWidth - 1);
		const text = truncateToWidth(label, room, "…", true);
		const textCell = selected ? this.renderText(text, "text") : paintHoverable(theme, text, index === this.hovered, "muted");
		const marker = selected ? this.renderText("▸ ", KEY_ROLE) : "  ";
		const gap = Math.max(1, width - 2 - visibleWidth(stripAnsi(textCell)) - countWidth);
		const row = fit(`${marker}${textCell}${" ".repeat(gap)}${countText}`, width);
		return selected && theme.bg ? theme.bg("selectedBg", row) : row;
	}

	// S33: the focused scope's data on the line directly above the footer. An
	// empty line keeps the card's geometry stable when nothing was measured.
	private detailRow(width: number): string {
		const scope = this.scopes()[this.clampedSelected()];
		if (scope?.detail === undefined) return fit("", width);
		const text = sanitizeTerminalText(scopeDetailLine(scope.detail, this.now));
		if (text.length === 0) return fit("", width);
		return fit(this.renderText(truncateToWidth(text, width, "…"), "muted"), width);
	}

	private footerRow(width: number): string {
		const separator = this.renderText(FOOTER_SEPARATOR, KEY_LABEL_ROLE);
		const hints = footerHints(this.showingAll).map(([key, label]) => `${this.renderText(key, KEY_ROLE)} ${this.renderText(label, KEY_LABEL_ROLE)}`);
		return fit(hints.join(separator), width);
	}

	private headerRow(width: number): string {
		const left = this.renderText(TITLE, "accent");
		const right = this.renderText("esc", "muted");
		const leftWidth = visibleWidth(stripAnsi(left));
		const rightWidth = visibleWidth(stripAnsi(right));
		const gap = Math.max(1, width - leftWidth - rightWidth);
		return fit(`${left}${" ".repeat(gap)}${right}`, width);
	}

	private renderText(text: string, tone: Tone): string {
		return this.deps.theme.fg(tone, text);
	}
}
