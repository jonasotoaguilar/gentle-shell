import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CARD_PADDING, renderPaletteCard, renderPaletteSelection } from "./command-palette.ts";
import type { FilePickerTheme } from "./file-picker-view.ts";
import { paintHoverable } from "./shell-hover.ts";
import { sanitizeTerminalText, stripAnsi } from "./terminal-theme.ts";

// Gentle Shell worktree scope step: the single-choice card the file picker
// opens behind when the session has registered worktrees (S15). It knows only
// about scopes -- never about Git or the Pi session -- so the caller resolves
// the session repository and its registered worktrees and this component just
// orders, paints and routes them.

export interface FileScope {
	/** Stable identifier for the scope: the session repository or a worktree root. */
	root: string;
	/** Row label: `main` for the session repository, otherwise the same identity /changes shows (branch · directory name). */
	label: string;
	kind: "main" | "worktree";
	/** Recency used for ordering only; never rendered. */
	lastModifiedMs: number;
}

/**
 * Changed worktrees first, most recently modified first; the session
 * repository keeps its place when its recency ties. The input array and its
 * entries are left untouched.
 */
export function orderScopes(scopes: readonly FileScope[]): FileScope[] {
	return scopes
		.map((scope, index) => ({ scope, index }))
		.sort((a, b) => (b.scope.lastModifiedMs - a.scope.lastModifiedMs) || (a.index - b.index))
		.map((entry) => entry.scope);
}

export interface FileScopeDeps {
	theme: FilePickerTheme;
	rows: number | (() => number);
	scopes: readonly FileScope[];
	onSelect(scope: FileScope): void;
	onClose(): void;
	requestRender(): void;
}

const TITLE = "File picker";
const SUBTITLE = "Choose a scope";
const NO_SCOPES = "No worktrees registered.";
const FOOTER = "↑/↓ move • enter choose scope • esc close";
const MAX_CARD_HEIGHT = 24;
// Header, step subtitle and footer, plus the two card borders.
const CHROME_ROWS = 5;
const MIN_CARD_HEIGHT = CHROME_ROWS + 1;
const MIN_WIDTH = CARD_PADDING + 4;
// Card border, header and subtitle precede the first scope row.
const BODY_TOP = 3;

type Tone = "accent" | "muted";

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
	private readonly deps: FileScopeDeps;
	private readonly scopes: FileScope[];

	constructor(deps: FileScopeDeps) {
		this.deps = deps;
		this.scopes = orderScopes(deps.scopes);
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
			fit(this.renderText(FOOTER, "muted"), innerWidth),
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
		if (this.scopes.length === 0) return 0;
		return Math.max(0, Math.min(this.scopes.length - 1, this.selected));
	}

	private moveSelection(delta: number): boolean {
		if (this.scopes.length === 0) return false;
		const next = Math.max(0, Math.min(this.scopes.length - 1, this.selected + delta));
		if (next === this.selected) return false;
		this.selected = next;
		return true;
	}

	private setHover(index: number | undefined): boolean {
		if (this.hovered === index) return false;
		this.hovered = index;
		return true;
	}

	// One single-shot flag covers both exits: this step is used once.
	private finish(action: "select" | "close"): void {
		if (this.completed || this.disposed) return;
		const scope = action === "select" ? this.scopes[this.clampedSelected()] : undefined;
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
		if (this.scopes.length === 0) {
			lines.push(fit(this.renderText(NO_SCOPES, "muted"), width));
		} else if (bodyRows > 0) {
			const selected = this.clampedSelected();
			const showIndicators = this.scopes.length > bodyRows && bodyRows >= 4;
			const windowSize = showIndicators ? Math.max(1, bodyRows - 2) : bodyRows;
			const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), Math.max(0, this.scopes.length - windowSize)));
			const end = Math.min(this.scopes.length, start + windowSize);
			if (showIndicators && start > 0) lines.push(fit(this.renderText(`  ↑ ${start} more`, "muted"), width));
			for (let index = start; index < end; index += 1) {
				hits.push({ y: BODY_TOP + lines.length, index });
				lines.push(this.renderScopeRow(this.scopes[index]!, index, selected, width));
			}
			if (showIndicators && end < this.scopes.length) lines.push(fit(this.renderText(`  ↓ ${this.scopes.length - end} more`, "muted"), width));
		}
		while (lines.length < bodyRows) lines.push("");
		return lines.slice(0, bodyRows);
	}

	private renderScopeRow(scope: FileScope, index: number, selectedIndex: number, width: number): string {
		const label = sanitizeTerminalText(scope.label);
		if (index === selectedIndex) return fit(renderPaletteSelection(label, width, true, this.deps.theme), width);
		const text = truncateToWidth(label, Math.max(0, width - 2), "…", true);
		return fit(`  ${paintHoverable(this.deps.theme, text, index === this.hovered, "muted")}`, width);
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
