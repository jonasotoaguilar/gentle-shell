import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { posix } from "node:path";
import { CARD_PADDING, rankPaletteGroups, renderPaletteCard, renderPaletteSelection, type CommandPaletteGroup } from "./command-palette.ts";
import { FILE_PREVIEW_BINARY_NOTICE, type FilePreview, type RepositoryListing } from "./file-index.ts";
import { paintHoverable } from "./shell-hover.ts";
import { sanitizeTerminalText, stripAnsi } from "./terminal-theme.ts";

// Gentle Shell file picker: a framed list+preview overlay with search always
// active. Listing and preview reads are injected (lib/file-index.ts), so the
// panel renders and routes input without a repository or a Pi session.

export interface FilePickerTheme {
	fg(color: string, text: string): string;
	/** When present, the selected row is a full-width highlighted bar. */
	bg?(color: string, text: string): string;
}

// pi-tui's public mouse shapes. The installed 0.74.0 in this worktree does
// not export them from the package root yet, so mirror the interface the
// repository targets; the method surface stays identical for callers.
type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
type TuiMouseButton = "left" | "middle" | "right" | "none";

interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	x: number;
	y: number;
	screenX: number;
	screenY: number;
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	wheelDelta?: number;
	clickCount?: number;
}

interface TuiMouseEventResult {
	handled?: boolean;
	capture?: boolean;
	focus?: boolean;
	render?: boolean;
}

export interface FilePickerDeps {
	theme: FilePickerTheme;
	rows: number | (() => number);
	listFiles(): Promise<RepositoryListing>;
	loadPreview(relativePath: string): Promise<FilePreview>;
	/** ctrl+e on the highlighted file. */
	onOpen(relativePath: string): void;
	/** Enter on the highlighted file. */
	onInsert(relativePath: string): void;
	onClose(): void;
	requestRender(): void;
}

const MAX_CARD_HEIGHT = 24;
// Two card borders plus the header and the footer.
const CHROME_ROWS = 4;
const MIN_CARD_HEIGHT = 4;
const MIN_WIDTH = CARD_PADDING + 4;
const LIST_RATIO = 0.4;
const LIST_MAX_WIDTH = 48;
const SEPARATOR = " │ ";
const SEPARATOR_WIDTH = SEPARATOR.length;
const LOADING_FILES = "Loading files …";
const LOADING_PREVIEW = "Loading preview …";
const NO_FILES = "No files in this repository.";
const TRUNCATED_NOTICE = "… preview truncated.";
const FOOTER = "type to search • ctrl+j/k move • ctrl+shift+j/k scroll • enter insert • ctrl+e editor • esc close";

type Tone = "border" | "accent" | "muted" | "text" | "error";

interface PaneLayout {
	contentWidth: number;
	listWidth: number;
	previewStart: number;
	previewWidth: number;
}

interface PreviewLine {
	text: string;
	tone: Tone;
}

type PreviewEntry = { status: "loading" } | { status: "ready"; preview: FilePreview };

interface PointerHit {
	y: number;
	index: number;
}

interface PointerFrame {
	width: number;
	height: number;
	bodyTop: number;
	bodyRows: number;
	listStart: number;
	listEnd: number;
	previewStart: number;
	previewEnd: number;
	hits: PointerHit[];
}

// One geometry feeds painting and hit-testing, so a click always lands on the
// row or pane that is actually visible.
function paneLayout(width: number): PaneLayout {
	const contentWidth = Math.max(1, width - CARD_PADDING);
	const maxList = Math.max(1, contentWidth - SEPARATOR_WIDTH - 1);
	const listWidth = Math.max(1, Math.min(LIST_MAX_WIDTH, Math.floor(contentWidth * LIST_RATIO), maxList));
	const previewStart = listWidth + SEPARATOR_WIDTH;
	return { contentWidth, listWidth, previewStart, previewWidth: Math.max(0, contentWidth - previewStart) };
}

function displayText(text: string): string {
	return sanitizeTerminalText(text);
}

function displayPreviewText(text: string): string {
	return sanitizeTerminalText(text).replace(/\t/g, "  ");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(stripAnsi(clipped))));
}

export class FilePickerView {
	private query = "";
	private selected = 0;
	private previewScroll = 0;
	private hovered: number | undefined;
	private pointerFrame: PointerFrame | undefined;
	private files: string[] = [];
	private loaded = false;
	private listingError: string | undefined;
	private readonly previews = new Map<string, PreviewEntry>();
	private completed = false;
	private disposed = false;
	private readonly deps: FilePickerDeps;

	constructor(deps: FilePickerDeps) {
		this.deps = deps;
		void this.loadListing();
	}

	render(width: number): string[] {
		const height = this.cardHeight();
		if (width <= 0 || height <= 0) {
			this.pointerFrame = undefined;
			return [];
		}
		if (width < MIN_WIDTH || height < MIN_CARD_HEIGHT) {
			this.pointerFrame = undefined;
			return [fit(this.renderText("File picker", "accent"), width)];
		}
		const layout = paneLayout(width);
		const bodyRows = Math.max(0, height - CHROME_ROWS);
		const lines: string[] = [this.headerRow(layout.contentWidth)];
		const hits: PointerHit[] = [];
		const state = this.emptyState();
		if (state) {
			lines.push(fit(this.renderText(state.text, state.tone), layout.contentWidth));
			for (let index = 1; index < bodyRows; index += 1) lines.push("");
		} else {
			const left = this.listColumn(layout, bodyRows, hits);
			const right = this.previewColumn(layout, bodyRows);
			for (let index = 0; index < bodyRows; index += 1) {
				lines.push(`${fit(left[index] ?? "", layout.listWidth)}${this.renderText(SEPARATOR, "border")}${fit(right[index] ?? "", layout.previewWidth)}`);
			}
		}
		lines.push(fit(this.renderText(FOOTER, "muted"), layout.contentWidth));
		const frame = renderPaletteCard(lines, width, this.deps.theme);
		this.pointerFrame = this.completed || this.disposed ? undefined : {
			width,
			height: frame.length,
			bodyTop: 2,
			bodyRows,
			listStart: 2,
			listEnd: 2 + layout.listWidth,
			previewStart: 2 + layout.previewStart,
			previewEnd: 2 + layout.contentWidth,
			hits,
		};
		return frame;
	}

	handleInput(data: string): void {
		if (this.completed || this.disposed || isKeyRelease(data)) return;
		this.pointerFrame = undefined;
		this.hovered = undefined;
		// A bare line feed ("\n") is both ctrl+j and, on non-Kitty terminals,
		// a synonym for Enter: the scroll and selection keys are checked before
		// Enter so ctrl+j moves instead of inserting (same ordering as
		// CommandPalette.handleInput and lib/shell-changes-view.ts).
		if (matchesKey(data, Key.ctrlShift("j"))) {
			this.scrollPreview(1);
			return;
		}
		if (matchesKey(data, Key.ctrlShift("k"))) {
			this.scrollPreview(-1);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollPreview(this.bodyRows());
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollPreview(-this.bodyRows());
			return;
		}
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
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.finish("insert");
			return;
		}
		if (matchesKey(data, Key.ctrl("e"))) {
			this.finish("open");
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			if (this.query.length > 0) this.setQuery(this.query.slice(0, -1));
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			if (this.query.length > 0) this.setQuery("");
			return;
		}
		if (this.isSingleBmpPrintable(data)) this.setQuery(this.query + data);
	}

	/** Mouse events are local to the last painted card, including its borders. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.completed || this.disposed) return undefined;
		const moving = event.type === "move" && event.button === "none";
		const frame = this.pointerFrame;
		if (!frame || event.width !== frame.width || event.height !== frame.height) {
			this.pointerFrame = undefined;
			const changed = this.hovered !== undefined;
			this.hovered = undefined;
			return changed && moving ? { handled: true, render: true } : undefined;
		}
		const inBody = event.y >= frame.bodyTop && event.y < frame.bodyTop + frame.bodyRows;
		const inList = inBody && event.x >= frame.listStart && event.x < frame.listEnd;
		const inPreview = inBody && event.x >= frame.previewStart && event.x < frame.previewEnd;
		const hit = inList ? frame.hits.find((candidate) => candidate.y === event.y) : undefined;
		if (moving) {
			const changed = this.hovered !== hit?.index;
			this.hovered = hit?.index;
			return { handled: true, render: changed };
		}
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = Math.sign(event.wheelDelta);
			if (inList) return { handled: true, render: this.moveSelection(delta) };
			if (inPreview) return { handled: true, render: this.scrollPreview(delta) };
			return undefined;
		}
		if (event.button !== "left") return undefined;
		if (inPreview) return { handled: true, render: false };
		if (!inList) return undefined;
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click" || !hit) return undefined;
		return { handled: true, render: this.select(hit.index) };
	}

	invalidate(): void {
		this.pointerFrame = undefined;
		this.hovered = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.pointerFrame = undefined;
		this.hovered = undefined;
		this.previews.clear();
	}

	private cardHeight(): number {
		const available = typeof this.deps.rows === "function" ? this.deps.rows() : this.deps.rows;
		if (!Number.isFinite(available)) return 0;
		return Math.max(0, Math.min(MAX_CARD_HEIGHT, Math.floor(available)));
	}

	private bodyRows(): number {
		return Math.max(0, this.cardHeight() - CHROME_ROWS);
	}

	private async loadListing(): Promise<void> {
		try {
			const result = await this.deps.listFiles();
			if (this.disposed || this.completed) return;
			this.loaded = true;
			if (result.ok === false) {
				this.files = [];
				this.listingError = result.message;
			} else {
				this.files = result.files;
				this.listingError = undefined;
			}
			this.selected = 0;
			this.previewScroll = 0;
			this.ensurePreviewLoaded();
			this.deps.requestRender();
		} catch (error) {
			if (this.disposed || this.completed) return;
			this.loaded = true;
			this.files = [];
			this.listingError = `Cannot list repository files: ${errorMessage(error)}`;
			this.deps.requestRender();
		}
	}

	private matches(): string[] {
		if (!this.loaded || this.files.length === 0) return [];
		// rankPaletteGroups already ranks basename starts-with, then basename
		// contains, then subsequence, then full-path contains (the directory).
		const group: CommandPaletteGroup = {
			title: "Files",
			items: this.files.map((path) => ({ command: path, label: posix.basename(path) })),
		};
		const ranked = rankPaletteGroups([group], this.query)[0];
		return ranked ? ranked.items.map((item) => item.command) : [];
	}

	private selectedPath(): string | undefined {
		const matches = this.matches();
		if (matches.length === 0) return undefined;
		return matches[Math.max(0, Math.min(matches.length - 1, this.selected))];
	}

	private setQuery(query: string): void {
		this.query = query;
		this.selected = 0;
		this.previewScroll = 0;
		this.ensurePreviewLoaded();
	}

	private moveSelection(delta: number): boolean {
		const total = this.matches().length;
		if (total === 0) return false;
		return this.select(Math.max(0, Math.min(total - 1, this.selected + delta)));
	}

	private select(index: number): boolean {
		const total = this.matches().length;
		if (total === 0) return false;
		const next = Math.max(0, Math.min(total - 1, index));
		if (next === this.selected) return false;
		this.selected = next;
		this.previewScroll = 0;
		this.ensurePreviewLoaded();
		return true;
	}

	private scrollPreview(delta: number): boolean {
		if (delta === 0) return false;
		const total = this.selectedPath() ? this.previewLines(this.selectedPath()!).length : 0;
		const visible = this.bodyRows();
		const next = Math.max(0, Math.min(Math.max(0, total - visible), this.previewScroll + Math.trunc(delta)));
		if (next === this.previewScroll) return false;
		this.previewScroll = next;
		return true;
	}

	private ensurePreviewLoaded(): void {
		const path = this.selectedPath();
		if (!path || this.previews.has(path)) return;
		this.previews.set(path, { status: "loading" });
		let pending: Promise<FilePreview>;
		try {
			pending = this.deps.loadPreview(path);
		} catch (error) {
			this.previews.set(path, { status: "ready", preview: { kind: "error", message: `Cannot read ${path}: ${errorMessage(error)}` } });
			this.deps.requestRender();
			return;
		}
		void pending.then(
			(preview) => {
				if (this.disposed || this.completed) return;
				this.previews.set(path, { status: "ready", preview });
				this.deps.requestRender();
			},
			(error: unknown) => {
				if (this.disposed || this.completed) return;
				this.previews.set(path, { status: "ready", preview: { kind: "error", message: `Cannot read ${path}: ${errorMessage(error)}` } });
				this.deps.requestRender();
			},
		);
	}

	/**
	 * True for a single Basic-Multilingual-Plane printable character. Pasting
	 * several characters in one `handleInput` call does not append, exactly
	 * like CommandPalette.
	 */
	private isSingleBmpPrintable(data: string): boolean {
		if (data.length !== 1) return false;
		const codePoint = data.codePointAt(0) ?? 0;
		return codePoint >= 0x20 && codePoint !== 0x7f;
	}

	private finish(action: "insert" | "open" | "close"): void {
		if (this.completed || this.disposed) return;
		const path = action === "close" ? undefined : this.selectedPath();
		if (action !== "close" && path === undefined) return;
		this.completed = true;
		this.pointerFrame = undefined;
		this.hovered = undefined;
		if (action === "insert") {
			this.deps.onInsert(path!);
			this.deps.onClose();
		} else if (action === "open") {
			this.deps.onOpen(path!);
			this.deps.onClose();
		} else {
			this.deps.onClose();
		}
	}

	private emptyState(): { text: string; tone: Tone } | undefined {
		if (this.listingError !== undefined) return { text: this.listingError, tone: "error" };
		if (!this.loaded) return { text: LOADING_FILES, tone: "muted" };
		if (this.files.length === 0) return { text: NO_FILES, tone: "muted" };
		if (this.matches().length === 0) return { text: `No files match "${this.query}"`, tone: "muted" };
		return undefined;
	}

	private headerRow(width: number): string {
		const left = this.renderText("File picker", "accent");
		const right = this.renderText("esc", "muted");
		const leftWidth = visibleWidth(stripAnsi(left));
		const rightWidth = visibleWidth(stripAnsi(right));
		const gap = Math.max(1, width - leftWidth - rightWidth);
		return fit(`${left}${" ".repeat(gap)}${right}`, width);
	}

	private listColumn(layout: PaneLayout, bodyRows: number, hits: PointerHit[]): string[] {
		const matches = this.matches();
		if (bodyRows <= 0 || matches.length === 0) return [];
		const lines: string[] = [];
		const selected = Math.max(0, Math.min(matches.length - 1, this.selected));
		const showIndicators = matches.length > bodyRows && bodyRows >= 4;
		const windowSize = showIndicators ? Math.max(1, bodyRows - 2) : bodyRows;
		const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), Math.max(0, matches.length - windowSize)));
		const end = Math.min(matches.length, start + windowSize);
		if (showIndicators && start > 0) lines.push(fit(this.renderText(`  ↑ ${start} more`, "muted"), layout.listWidth));
		for (let index = start; index < end; index += 1) {
			hits.push({ y: 2 + lines.length, index });
			lines.push(this.renderListRow(matches[index]!, index, selected, layout.listWidth));
		}
		if (showIndicators && end < matches.length) lines.push(fit(this.renderText(`  ↓ ${matches.length - end} more`, "muted"), layout.listWidth));
		while (lines.length < bodyRows) lines.push("");
		return lines.slice(0, bodyRows);
	}

	private renderListRow(path: string, index: number, selectedIndex: number, listWidth: number): string {
		const selected = index === selectedIndex;
		const hovered = !selected && index === this.hovered;
		const name = displayText(posix.basename(path));
		const directory = posix.dirname(path);
		const label = directory === "." ? name : `${name}  ${displayText(directory)}`;
		if (selected) return fit(renderPaletteSelection(label, listWidth, true, this.deps.theme), listWidth);
		const text = truncateToWidth(label, Math.max(0, listWidth - 2), "…", true);
		return fit(`  ${paintHoverable(this.deps.theme, text, hovered, "muted")}`, listWidth);
	}

	private previewColumn(layout: PaneLayout, bodyRows: number): string[] {
		const path = this.selectedPath();
		if (!path || bodyRows <= 0) return [];
		const entries = this.previewLines(path);
		this.previewScroll = Math.max(0, Math.min(this.previewScroll, Math.max(0, entries.length - bodyRows)));
		const lines: string[] = [];
		for (let index = 0; index < bodyRows; index += 1) {
			const entry = entries[this.previewScroll + index];
			lines.push(entry ? fit(this.renderText(entry.text, entry.tone), layout.previewWidth) : "");
		}
		return lines;
	}

	private previewLines(path: string): PreviewLine[] {
		const entry = this.previews.get(path);
		if (!entry || entry.status === "loading") return [{ text: LOADING_PREVIEW, tone: "muted" }];
		const preview = entry.preview;
		if (preview.kind === "binary") return [{ text: FILE_PREVIEW_BINARY_NOTICE, tone: "muted" }];
		if (preview.kind === "error") return [{ text: preview.message, tone: "error" }];
		const lines: PreviewLine[] = preview.lines.map((line) => ({ text: displayPreviewText(line), tone: "text" }));
		if (preview.truncated) lines.push({ text: TRUNCATED_NOTICE, tone: "muted" });
		return lines;
	}

	private renderText(text: string, tone: Tone): string {
		return this.deps.theme.fg(tone, text);
	}
}
