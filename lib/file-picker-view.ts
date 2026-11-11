import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { posix } from "node:path";
import { CARD_PADDING, rankPaletteGroups, renderPaletteCard, type CommandPaletteGroup } from "./command-palette.ts";
import { FILE_PREVIEW_BINARY_NOTICE, formatAge, type FileEntry, type FilePreview, type RepositoryEntriesResult } from "./file-index.ts";
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

export interface FilePickerDeps {
	theme: FilePickerTheme;
	rows: number | (() => number);
	listEntries(): Promise<RepositoryEntriesResult>;
	loadPreview(relativePath: string): Promise<FilePreview>;
	/** ctrl+e on the highlighted file. */
	onOpen(relativePath: string): void;
	/** Enter: every file to insert, in list order. Never empty. */
	onInsert(relativePaths: string[]): void;
	onClose(): void;
	requestRender(): void;
	/** Clock for the row ages, read once when the panel opens (S12). Defaults to Date.now. */
	now?(): number;
	/** The path this picker is listing, painted in the title's top-right corner. */
	root?: string;
}

// The card fills the terminal like the Commands palette instead of a fixed
// height (S22).
const HEIGHT_RATIO = 0.85;
// Two card borders plus the header, the search row, its blank separator row,
// the count row and the footer.
const CHROME_ROWS = 7;
// The smallest card that still paints the frame, header, search row, blank
// row, count row, one body row and the footer.
const MIN_CARD_HEIGHT = CHROME_ROWS + 2;
// The first painted row of the body: top border, header, search, blank, count.
const BODY_TOP = 5;
const MIN_WIDTH = CARD_PADDING + 4;
// Below this the title row drops the listing path rather than eliding it to
// nothing useful, so the title and the close hint stay legible.
const MIN_ROOT_WIDTH = 8;
const LIST_RATIO = 0.4;
const LIST_MAX_WIDTH = 48;
// Cursor cell, selection cell and the space before the name. Constant in
// every row state, so Tab repaints a row in place (S20).
const MARKER_WIDTH = 3;
// A selected row shows this accent bar in the selection cell; on adjacent rows
// the bars join into one continuous line.
const SELECTION_BAR = "▏";
const SEPARATOR = " │ ";
const SEARCH_PROMPT = "›";
const SEARCH_PLACEHOLDER = "Search";
// One space between the preview's line-number gutter and its text.
const PREVIEW_GUTTER_GAP = 1;
const SEPARATOR_WIDTH = SEPARATOR.length;
const LOADING_FILES = "Loading files …";
const LOADING_PREVIEW = "Loading preview …";
const NO_FILES = "No files in this repository.";
const TRUNCATED_NOTICE = "… preview truncated.";
// One option per action (S19): ctrl+c, ctrl+shift+j/k and home/end keep working
// but are not advertised. Keys paint in the theme's key colour and the labels
// in the neutral tone, one painted cell per role (S31).
const FOOTER_HINTS: readonly (readonly [string, string])[] = [
	["↑/↓", "move"],
	["ctrl+j/k", "scroll"],
	["tab", "select"],
	["ctrl+o", "order"],
	["ctrl+u", "clear"],
	["enter", "insert"],
	["ctrl+e", "editor"],
	["esc", "close"],
];
const FOOTER_SEPARATOR = " • ";
// The theme role the hints paint a key with (the /agents panel's convention).
const KEY_TONE = "accent";
const LABEL_TONE = "muted";
const NEW_BADGE = "new";
const UPDATED_BADGE = "upd";

/**
 * The listing orders ctrl+o cycles through (S29): the listing's own
 * changed-first recency order, directory-major path order and extension
 * groups.
 */
export type FilePickerOrder = "modified" | "path" | "ext";
const ORDER_CYCLE: readonly FilePickerOrder[] = ["modified", "path", "ext"];
const DEFAULT_ORDER: FilePickerOrder = "modified";
// Separates the counts from the active order in the info row (S29).
const INFO_SEPARATOR = " · ";

type Tone = "border" | "accent" | "muted" | "dim" | "text" | "error";

interface PaneLayout {
	contentWidth: number;
	listWidth: number;
	previewStart: number;
	previewWidth: number;
}

interface PreviewLine {
	text: string;
	tone: Tone;
	/** Real file line number; absent on a notice row. */
	number?: number;
}

/**
 * The preview's lines flattened into the rows they paint at one pane width. A
 * line wider than the pane continues on the following rows under the same text
 * column, so `rowStarts` maps a painted row back to the line that owns it and
 * `rows` holds the text each row paints, whole graphemes only (S30).
 */
interface PreviewWindow {
	lines: PreviewLine[];
	gutterWidth: number;
	textWidth: number;
	rows: string[];
	rowStarts: number[];
	totalRows: number;
}

/** What the preview can honestly claim about the file's line numbering. */
interface PreviewMeta {
	total: number;
	truncated: boolean;
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

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The rows one line wraps into at `width` text cells, cut on grapheme
 * boundaries only: a grapheme that does not fit in the cells left on a row
 * starts the next row instead of being split across two rows or dropped from
 * both (S30). A grapheme wider than a whole row still gets a row of its own, so
 * the row count always matches what the rows paint. A non-positive width never
 * wraps.
 */
function wrapByCells(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const rows: string[] = [];
	let row = "";
	let used = 0;
	for (const { segment } of graphemes.segment(text)) {
		const cells = visibleWidth(segment);
		if (used > 0 && used + cells > width) {
			rows.push(row);
			row = "";
			used = 0;
		}
		row += segment;
		used += cells;
	}
	rows.push(row);
	return rows;
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(stripAnsi(clipped))));
}

/** Byte order, not locale order, so an order is the same on every machine. */
function byCodePoint(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Directory-major alphabetical (S29): paths compare segment by segment, so
 * every file of a folder and of its subfolders stays together and the flat list
 * reads like an explorer's tree without folder header rows. A segment that
 * another merely extends keeps the folder ahead of the file sharing its name
 * (`src/…` before `src.ts`).
 */
function byDirectoryMajor(left: FileEntry, right: FileEntry): number {
	const leftSegments = left.path.split("/");
	const rightSegments = right.path.split("/");
	const shared = Math.min(leftSegments.length, rightSegments.length);
	for (let index = 0; index < shared; index += 1) {
		const compared = byCodePoint(leftSegments[index]!, rightSegments[index]!);
		if (compared !== 0) return compared;
	}
	return leftSegments.length - rightSegments.length;
}

/** A dotfile such as `.gitignore` has no extension; `a.tar.gz` groups under `gz`. */
function extensionOf(path: string): string {
	const extension = posix.extname(posix.basename(path));
	return extension.startsWith(".") ? extension.slice(1) : extension;
}

/** Extension groups, alphabetical by extension and then by path; no extension sorts last. */
function byExtension(left: FileEntry, right: FileEntry): number {
	const leftExtension = extensionOf(left.path);
	const rightExtension = extensionOf(right.path);
	if (leftExtension !== rightExtension) {
		if (leftExtension === "") return 1;
		if (rightExtension === "") return -1;
		return byCodePoint(leftExtension, rightExtension);
	}
	return byCodePoint(left.path, right.path);
}

/** Keep the tail of a path, which is what identifies the directory. */
function elideLeft(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const room = width - visibleWidth("…");
	if (room <= 0) return truncateToWidth("…", width, "");
	const characters = Array.from(text);
	let tail = "";
	for (let index = characters.length - 1; index >= 0; index -= 1) {
		const candidate = `${characters[index]}${tail}`;
		if (visibleWidth(candidate) > room) break;
		tail = candidate;
	}
	return `…${tail}`;
}

export class FilePickerView {
	private query = "";
	/** The active listing order; the info row names it and ctrl+o cycles it (S29). */
	private order: FilePickerOrder = DEFAULT_ORDER;
	private selected = 0;
	private previewScroll = 0;
	private hovered: number | undefined;
	private pointerFrame: PointerFrame | undefined;
	private entries: FileEntry[] = [];
	private loaded = false;
	private listingError: string | undefined;
	/** Tab multi-select (S14), in the order each file was marked. */
	private readonly selection = new Set<string>();
	private readonly openedAt: number;
	private readonly previews = new Map<string, PreviewEntry>();
	/** The preview pane width of the last painted frame, so a scroll clamps against what is on screen. */
	private previewPaneWidth = 0;
	private completed = false;
	private disposed = false;
	private readonly deps: FilePickerDeps;

	constructor(deps: FilePickerDeps) {
		this.deps = deps;
		this.openedAt = deps.now ? deps.now() : Date.now();
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
		const bodyRows = this.bodyRowCount();
		// Title, search row, a blank row, the count row and then the list (S18).
		const lines: string[] = [this.headerRow(layout.contentWidth), this.searchRow(layout.contentWidth), "", this.countRow(layout.contentWidth)];
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
		lines.push(this.footerRow(layout.contentWidth));
		const frame = renderPaletteCard(lines, width, this.deps.theme);
		this.pointerFrame = this.completed || this.disposed ? undefined : {
			width,
			height: frame.length,
			bodyTop: BODY_TOP,
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
		// ctrl+j/k scroll the preview and the arrows move the selection; the
		// ctrl+shift forms are the same scroll action for terminals where they
		// are the only deliverable shape (S24). A bare line feed ("\n") is both
		// ctrl+j and, on non-Kitty terminals, a synonym for Enter: the scroll
		// keys are checked before Enter so a line feed scrolls and never inserts
		// (same ordering as CommandPalette.handleInput and
		// lib/shell-changes-view.ts).
		if (matchesKey(data, Key.ctrlShift("j")) || matchesKey(data, Key.ctrl("j"))) {
			this.scrollPreview(1);
			return;
		}
		if (matchesKey(data, Key.ctrlShift("k")) || matchesKey(data, Key.ctrl("k"))) {
			this.scrollPreview(-1);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollPreview(this.previewRows());
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollPreview(-this.previewRows());
			return;
		}
		// home/end and ctrl+home/ctrl+end are compatibility bindings, so the
		// footer never names them (S28).
		if (matchesKey(data, Key.ctrl("home"))) {
			this.scrollPreviewTo("start");
			return;
		}
		if (matchesKey(data, Key.ctrl("end"))) {
			this.scrollPreviewTo("end");
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.select(0);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.select(this.matches().length - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.toggleSelection();
			return;
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			this.cycleOrder();
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
		const rows = Math.max(0, Math.floor(available));
		// The overlay gives the picker the whole terminal height, so the card
		// takes the palette's share of it and never more than it was given.
		return Math.min(rows, Math.max(MIN_CARD_HEIGHT, Math.floor(rows * HEIGHT_RATIO)));
	}

	private bodyRowCount(): number {
		return Math.max(0, this.cardHeight() - CHROME_ROWS);
	}

	/** Rows of preview text: the body minus the position indicator row. */
	private previewRows(): number {
		return Math.max(0, this.bodyRowCount() - 1);
	}

	private async loadListing(): Promise<void> {
		try {
			const result = await this.deps.listEntries();
			if (this.disposed || this.completed) return;
			this.loaded = true;
			if (result.ok === false) {
				this.entries = [];
				this.listingError = result.message;
			} else {
				this.entries = result.entries;
				this.listingError = undefined;
			}
			this.selected = 0;
			this.previewScroll = 0;
			this.ensurePreviewLoaded();
			this.deps.requestRender();
		} catch (error) {
			if (this.disposed || this.completed) return;
			this.loaded = true;
			this.entries = [];
			this.listingError = `Cannot list repository files: ${errorMessage(error)}`;
			this.deps.requestRender();
		}
	}

	/**
	 * The rows in the active order (S29). `modified` is the listing's own order —
	 * changed first, newest first (S12) — and is never re-sorted here.
	 */
	private orderedEntries(): FileEntry[] {
		if (this.order === "modified") return this.entries;
		const ordered = [...this.entries];
		ordered.sort(this.order === "path" ? byDirectoryMajor : byExtension);
		return ordered;
	}

	private matches(): FileEntry[] {
		const ordered = this.orderedEntries();
		if (!this.loaded || ordered.length === 0) return [];
		// rankPaletteGroups already ranks basename starts-with, then basename
		// contains, then subsequence, then full-path contains (the directory).
		// It keeps the input order for an empty query, so the active listing
		// order is what those rows paint.
		const group: CommandPaletteGroup = {
			title: "Files",
			items: ordered.map((entry) => ({ command: entry.path, label: posix.basename(entry.path) })),
		};
		const ranked = rankPaletteGroups([group], this.query)[0];
		if (!ranked) return [];
		const byPath = new Map(ordered.map((entry) => [entry.path, entry]));
		const matched: FileEntry[] = [];
		for (const item of ranked.items) {
			const entry = byPath.get(item.command);
			if (entry) matched.push(entry);
		}
		return matched;
	}

	private selectedPath(): string | undefined {
		const matches = this.matches();
		if (matches.length === 0) return undefined;
		return matches[Math.max(0, Math.min(matches.length - 1, this.selected))]?.path;
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

	private toggleSelection(): boolean {
		const path = this.selectedPath();
		if (path === undefined) return false;
		if (this.selection.has(path)) this.selection.delete(path);
		else this.selection.add(path);
		return true;
	}

	/**
	 * ctrl+o: the next order, with the highlight following the same file rather
	 * than the same index. The preview keeps its scroll unless the highlighted
	 * file actually changed (S29).
	 */
	private cycleOrder(): boolean {
		const previous = this.selectedPath();
		const position = ORDER_CYCLE.indexOf(this.order);
		this.order = ORDER_CYCLE[(position + 1) % ORDER_CYCLE.length]!;
		const total = this.matches().length;
		const moved = previous === undefined ? -1 : this.matches().findIndex((entry) => entry.path === previous);
		this.selected = moved >= 0 ? moved : Math.max(0, Math.min(total - 1, this.selected));
		if (this.selectedPath() !== previous) this.previewScroll = 0;
		this.ensurePreviewLoaded();
		return true;
	}

	/**
	 * Enter's payload (S14): the visible selections in list order, then the ones
	 * a query hid in their marking order, and the highlighted file last when Tab
	 * never selected it. A file is never emitted twice.
	 */
	private insertionPaths(): string[] {
		const paths: string[] = [];
		const visible = new Set<string>();
		for (const entry of this.matches()) {
			visible.add(entry.path);
			if (this.selection.has(entry.path)) paths.push(entry.path);
		}
		for (const path of this.selection) if (!visible.has(path)) paths.push(path);
		const highlighted = this.selectedPath();
		if (highlighted !== undefined && !this.selection.has(highlighted)) paths.push(highlighted);
		return paths;
	}

	private scrollPreview(delta: number): boolean {
		if (delta === 0) return false;
		return this.setPreviewScroll(this.previewScroll + Math.trunc(delta));
	}

	/** ctrl+home and ctrl+end: the first line and the last page of the file (S28). */
	private scrollPreviewTo(edge: "start" | "end"): boolean {
		const path = this.selectedPath();
		if (!path) return false;
		const window = this.previewWindow(path, this.previewPaneWidth);
		return this.setPreviewScroll(edge === "start" ? 0 : this.maxPreviewScroll(window));
	}

	private setPreviewScroll(next: number): boolean {
		const path = this.selectedPath();
		if (!path) return false;
		const window = this.previewWindow(path, this.previewPaneWidth);
		const clamped = Math.max(0, Math.min(this.maxPreviewScroll(window), Math.trunc(next)));
		if (clamped === this.previewScroll) return false;
		this.previewScroll = clamped;
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
		if (action === "insert") {
			const paths = this.insertionPaths();
			if (paths.length === 0) return;
			this.complete();
			// The overlay closes even when the paste throws: a completed panel
			// with dead input would otherwise strand the session in the picker.
			try {
				this.deps.onInsert(paths);
			} finally {
				this.deps.onClose();
			}
			return;
		}
		const path = action === "open" ? this.selectedPath() : undefined;
		if (action === "open" && path === undefined) return;
		this.complete();
		try {
			if (path !== undefined) this.deps.onOpen(path);
		} finally {
			this.deps.onClose();
		}
	}

	private complete(): void {
		this.completed = true;
		this.pointerFrame = undefined;
		this.hovered = undefined;
	}

	private emptyState(): { text: string; tone: Tone } | undefined {
		if (this.listingError !== undefined) return { text: this.listingError, tone: "error" };
		if (!this.loaded) return { text: LOADING_FILES, tone: "muted" };
		if (this.entries.length === 0) return { text: NO_FILES, tone: "muted" };
		if (this.matches().length === 0) return { text: `No files match "${this.query}"`, tone: "muted" };
		return undefined;
	}

	private headerRow(width: number): string {
		const title = this.renderText("File picker", "accent");
		const close = this.renderText("esc", KEY_TONE);
		const titleWidth = visibleWidth(stripAnsi(title));
		const closeWidth = visibleWidth(stripAnsi(close));
		const root = this.rootCell(width - titleWidth - closeWidth - 2);
		if (root === undefined) {
			const gap = Math.max(1, width - titleWidth - closeWidth);
			return fit(`${title}${" ".repeat(gap)}${close}`, width);
		}
		const gap = Math.max(1, width - titleWidth - visibleWidth(stripAnsi(root)) - closeWidth - 1);
		return fit(`${title}${" ".repeat(gap)}${root} ${close}`, width);
	}

	/** The listing path in the title's top-right; the title and `esc` win over it. */
	private rootCell(room: number): string | undefined {
		if (this.deps.root === undefined || room < MIN_ROOT_WIDTH) return undefined;
		const root = displayText(this.deps.root);
		if (root.length === 0) return undefined;
		return this.renderText(elideLeft(root, room), "dim");
	}

	/** Always-active search, painted exactly like the Commands palette (S18). */
	private searchRow(width: number): string {
		if (this.query.length === 0) return fit(this.renderText(`${SEARCH_PROMPT} ${SEARCH_PLACEHOLDER}`, "muted"), width);
		return fit(`${this.renderText(SEARCH_PROMPT, "muted")} ${displayText(this.query)}`, width);
	}

	/**
	 * The info row under the blank line: the counts and the active listing order,
	 * so the order is always visible without being a key hint (S29). The file
	 * count is what the query currently lists; the parenthesised count is the
	 * whole Tab selection, which can include files the query hides. A pending or
	 * failed listing counts nothing, so the row stays blank instead of claiming
	 * zero files.
	 */
	private countRow(width: number): string {
		if (!this.loaded || this.listingError !== undefined) return "".padEnd(width, " ");
		const files = this.matches().length;
		const selected = this.selection.size;
		const counts = `${files} ${files === 1 ? "file" : "files"} (${selected} selected)`;
		return fit(this.renderText(`${counts}${INFO_SEPARATOR}${this.order}`, "muted"), width);
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
			hits.push({ y: BODY_TOP + lines.length, index });
			lines.push(this.renderListRow(matches[index]!, index, selected, layout.listWidth));
		}
		if (showIndicators && end < matches.length) lines.push(fit(this.renderText(`  ↓ ${matches.length - end} more`, "muted"), layout.listWidth));
		while (lines.length < bodyRows) lines.push("");
		return lines.slice(0, bodyRows);
	}

	private rowLabel(entry: FileEntry): string {
		const name = displayText(posix.basename(entry.path));
		const directory = posix.dirname(entry.path);
		return directory === "." ? name : `${name}  ${displayText(directory)}`;
	}

	/** The trailing badge and age of a changed row; a clean row has neither (S12). */
	private rowSuffix(entry: FileEntry): string {
		if (entry.state === "clean") return "";
		const badge = entry.state === "new" ? NEW_BADGE : UPDATED_BADGE;
		const parts = [this.deps.theme.fg("accent", badge)];
		if (entry.mtimeMs !== undefined) parts.push(this.deps.theme.fg("muted", formatAge(entry.mtimeMs, this.openedAt)));
		return parts.join(" ");
	}

	// The name leads and the badge and age trail: the name is truncated first so
	// a narrow list pane never costs the row its state.
	private renderListRow(entry: FileEntry, index: number, selectedIndex: number, listWidth: number): string {
		const theme = this.deps.theme;
		const cursor = index === selectedIndex;
		const marked = this.selection.has(entry.path);
		const hovered = !cursor && !marked && index === this.hovered;
		const suffix = this.rowSuffix(entry);
		const suffixWidth = visibleWidth(stripAnsi(suffix));
		const showsSuffix = suffixWidth > 0 && suffixWidth + MARKER_WIDTH <= listWidth;
		const labelRoom = Math.max(0, listWidth - MARKER_WIDTH - (showsSuffix ? suffixWidth + 1 : 0));
		const label = truncateToWidth(this.rowLabel(entry), labelRoom, "…");
		const gap = " ".repeat(Math.max(0, listWidth - MARKER_WIDTH - visibleWidth(label) - (showsSuffix ? suffixWidth : 0)));
		// The marker column is three cells wide in every state: cursor cell,
		// selection cell, then the space before the name. A highlighted bar owns
		// the cursor, so that cell stays blank there.
		const marker = `${cursor && !theme.bg ? theme.fg("accent", "▸") : " "}${marked ? theme.fg("accent", SELECTION_BAR) : " "} `;
		if (cursor && theme.bg) {
			const inner = `${marker}${label}${showsSuffix ? `${gap}${stripAnsi(suffix)}` : ""}`;
			return theme.bg("selectedBg", inner + " ".repeat(Math.max(0, listWidth - visibleWidth(stripAnsi(inner)))));
		}
		const painted = marked ? theme.fg("accent", label) : cursor ? theme.fg("text", label) : paintHoverable(theme, label, hovered, "muted");
		return fit(`${marker}${painted}${gap}${showsSuffix ? suffix : ""}`, listWidth);
	}

	private previewColumn(layout: PaneLayout, bodyRows: number): string[] {
		const path = this.selectedPath();
		if (!path || bodyRows <= 0) return [];
		const contentRows = this.previewRows();
		const window = this.previewWindow(path, layout.previewWidth);
		this.previewPaneWidth = layout.previewWidth;
		// The painted window is what a scroll is clamped against, so the last
		// page is always full and the position indicator never lies.
		this.previewScroll = Math.max(0, Math.min(this.previewScroll, this.maxPreviewScroll(window)));
		// The position indicator owns the preview's first row (S21).
		const lines: string[] = [this.previewPositionRow(window, path, layout.previewWidth)];
		for (let offset = 0; offset < contentRows; offset += 1) {
			const row = this.previewScroll + offset;
			lines.push(row < window.totalRows ? this.previewRow(window, row, layout.previewWidth) : "");
		}
		return lines;
	}

	/**
	 * The preview flattened into painted rows at `width` pane cells. A line wider
	 * than the pane wraps instead of being truncated, so the scroll and page math
	 * counts rows while the gutter and the position count file lines (S30).
	 */
	private previewWindow(path: string, width: number): PreviewWindow {
		const lines = this.previewLines(path);
		const gutterWidth = this.previewGutterWidth(path);
		const textWidth = width - gutterWidth - PREVIEW_GUTTER_GAP;
		const rows: string[] = [];
		const rowStarts: number[] = [];
		for (const line of lines) {
			rowStarts.push(rows.length);
			rows.push(...wrapByCells(line.text, textWidth));
		}
		return { lines, gutterWidth, textWidth, rows, rowStarts, totalRows: rows.length };
	}

	private maxPreviewScroll(window: PreviewWindow): number {
		return Math.max(0, window.totalRows - this.previewRows());
	}

	/** The line that owns a painted row; the last line starting at or before it. */
	private lineAtRow(window: PreviewWindow, row: number): number {
		let low = 0;
		let high = Math.max(0, window.rowStarts.length - 1);
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (window.rowStarts[middle]! <= row) low = middle;
			else high = middle - 1;
		}
		return low;
	}

	/** File line numbers are only known for a text preview. */
	private previewMeta(path: string): PreviewMeta | undefined {
		const entry = this.previews.get(path);
		if (!entry || entry.status === "loading") return undefined;
		const preview = entry.preview;
		if (preview.kind !== "text") return undefined;
		return { total: preview.lines.length, truncated: preview.truncated };
	}

	private previewGutterWidth(path: string): number {
		return Math.max(1, String(this.previewMeta(path)?.total ?? 0).length);
	}

	/** `top/total` at the preview's top-right; `+` when the total is not known (S21). */
	private previewPositionRow(window: PreviewWindow, path: string, width: number): string {
		const meta = this.previewMeta(path);
		if (!meta) return "";
		const top = this.topLineNumber(window) ?? meta.total;
		const indicator = this.renderText(`${Math.min(meta.total, top)}/${meta.total}${meta.truncated ? "+" : ""}`, "muted");
		const used = visibleWidth(stripAnsi(indicator));
		if (used >= width) return truncateToWidth(indicator, width, "…");
		return `${" ".repeat(width - used)}${indicator}`;
	}

	/**
	 * The file line the top painted row belongs to, so a scroll that stops inside
	 * a wrapped line still reports that line rather than a painted row.
	 */
	private topLineNumber(window: PreviewWindow): number | undefined {
		if (window.lines.length === 0) return undefined;
		let index = this.lineAtRow(window, this.previewScroll);
		while (index > 0 && window.lines[index]!.number === undefined) index -= 1;
		return window.lines[index]!.number;
	}

	private previewRow(window: PreviewWindow, row: number, width: number): string {
		const index = this.lineAtRow(window, row);
		const entry = window.lines[index]!;
		const offset = row - window.rowStarts[index]!;
		// Only the first row of a line carries its number; a continuation row
		// leaves the gutter blank and starts its text in the same column.
		const gutter = offset === 0 && entry.number !== undefined
			? this.renderText(String(entry.number).padStart(window.gutterWidth), "dim")
			: " ".repeat(window.gutterWidth);
		const room = Math.max(0, window.textWidth);
		const text = room > 0 ? window.rows[row] ?? "" : "";
		const cells = visibleWidth(text);
		// A wrapped row is a run of whole graphemes, so it is painted as it is and
		// never truncated with an ellipsis. The one row wider than the text column
		// is a grapheme that fits in no row of its own: it borrows the single gap
		// cell so the pane can still show it. A grapheme wider than the whole pane
		// fits in no column at all, so that row paints its gutter alone rather than
		// a glyph that would break the frame.
		const borrowsGap = cells > room;
		const showsText = cells > 0 && (!borrowsGap || window.gutterWidth + cells <= width);
		const gap = borrowsGap ? "" : " ".repeat(PREVIEW_GUTTER_GAP);
		return fit(`${gutter}${gap}${showsText ? this.renderText(text, entry.tone) : ""}`, width);
	}

	private previewLines(path: string): PreviewLine[] {
		const entry = this.previews.get(path);
		if (!entry || entry.status === "loading") return [{ text: LOADING_PREVIEW, tone: "muted" }];
		const preview = entry.preview;
		if (preview.kind === "binary") return [{ text: FILE_PREVIEW_BINARY_NOTICE, tone: "muted" }];
		if (preview.kind === "error") return [{ text: preview.message, tone: "error" }];
		const lines: PreviewLine[] = preview.lines.map((line, index) => ({ text: displayPreviewText(line), tone: "text", number: index + 1 }));
		if (preview.truncated) lines.push({ text: TRUNCATED_NOTICE, tone: "muted" });
		return lines;
	}

	private renderText(text: string, tone: Tone): string {
		return this.deps.theme.fg(tone, text);
	}

	/** The key list, painted one cell per role so a key never carries the label tone (S31). */
	private footerRow(width: number): string {
		const hints = FOOTER_HINTS.map(([key, label]) => `${this.renderText(key, KEY_TONE)} ${this.renderText(label, LABEL_TONE)}`);
		return fit(hints.join(this.renderText(FOOTER_SEPARATOR, LABEL_TONE)), width);
	}
}
