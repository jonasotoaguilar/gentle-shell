import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
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
	/** The path this picker is listing, painted next to the title (S42). */
	root?: string;
	/**
	 * The library name of a previewed path (Pi's `getLanguageFromPath`, wired by
	 * the extension). Absent, or returning nothing, leaves the preview plain (S39).
	 */
	languageForPath?(path: string): string | undefined;
	/**
	 * The syntax highlighter (Pi's `highlightCode`, wired by the extension): code
	 * and language in, already-ANSI-painted lines out. Absent leaves the preview
	 * plain, and the view never imports Pi itself (S39).
	 */
	highlight?(code: string, lang?: string): string[];
}

// The card fills the terminal like the Commands palette instead of a fixed
// height (S22).
const HEIGHT_RATIO = 0.85;
// Two card borders plus the header, the search row, the info row, the rule
// that closes the body and the footer.
const CHROME_ROWS = 7;
// The smallest card that still paints the frame, header, search row, info row,
// one body row, the closing rule and the footer.
const MIN_CARD_HEIGHT = CHROME_ROWS + 2;
// The first painted row of the body — top border, header, search, info — and
// the first row a list row or a click on it can land on (S47).
const BODY_TOP = 4;
// One two-space gap between the title and the listing path it names (S42).
const TITLE_ROOT_GAP = 2;
const MIN_WIDTH = CARD_PADDING + 4;
// Below this the title row drops the listing path rather than eliding it to
// nothing useful, so the title and the close hint stay legible.
const MIN_ROOT_WIDTH = 8;
const LIST_RATIO = 0.45;
const LIST_MAX_WIDTH = 64;
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
// The preview's own rounded box (S38): its corners, its horizontal and vertical
// border cells and the two border columns they spend.
const BOX_TOP_LEFT = "╭";
const BOX_TOP_RIGHT = "╮";
const BOX_BOTTOM_LEFT = "╰";
const BOX_BOTTOM_RIGHT = "╯";
const BOX_HORIZONTAL = "─";
const BOX_VERTICAL = "│";
const BOX_COLUMNS = 2;
// The box paints its top border on the info row above the list and its bottom
// border on the list's last row, so the body has to hold the two border rows
// plus one content row between them; a shorter body keeps the unbordered
// preview (S47).
const BOX_MIN_BODY_ROWS = 2;
const BOX_MIN_WIDTH = BOX_COLUMNS + 1;
const SEPARATOR_WIDTH = SEPARATOR.length;
const LOADING_FILES = "Loading files …";
const LOADING_PREVIEW = "Loading preview …";
const NO_FILES = "No files in this repository.";
const TRUNCATED_NOTICE = "… preview truncated.";
// Every painted cell ends its own colour run, so a highlighted preview row can
// never tint the rule, the border or the padding after it (S39).
const ANSI_RESET = "\u001b[0m";
// One option per action (S19): ctrl+c, ctrl+shift+j/k and home/end keep working
// but are not advertised. Keys paint in the theme's key colour and the labels
// in the neutral tone, one painted cell per role (S31).
const FOOTER_HINTS: readonly (readonly [string, string])[] = [
	["↑/↓", "move"],
	["ctrl+j/k", "scroll"],
	["tab", "select"],
	["space", "fold"],
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
// The row's change letters, borrowed from `/changes` so the two views never
// spell the same state differently: `U` for a file Git does not track yet and
// `M` for a tracked file with an uncommitted change (S12). There is no `N`:
// `/changes` has no such state (lib/shell-changes-view.ts).
const UNTRACKED_BADGE = "U";
const MODIFIED_BADGE = "M";
// The tone `/changes` paints the trailing parent directory with (ROLE.EMPTY),
// so the name reads as the label and the path as its context (S37).
const DIRECTORY_TONE = "dim";

/**
 * The listing orders ctrl+o cycles through (S29): `modified` is the listing's own
 * changed-first recency order, painted flat, while `tree` and `ext` paint a
 * foldable tree — `tree` a folder tree with group rows nested by path segment,
 * `ext` one level of extension groups (S35). The folder order is named `tree`
 * because that is the name the user reads (S45).
 */
export type FilePickerOrder = "modified" | "tree" | "ext";
const ORDER_CYCLE: readonly FilePickerOrder[] = ["modified", "tree", "ext"];
const DEFAULT_ORDER: FilePickerOrder = "modified";
// The tree `tree` and `ext` paint (S35): the indent one nesting level costs, and
// the name of the extensionless group, which always paints last.
const GROUP_INDENT = 2;
const EXTENSIONLESS_GROUP = "(none)";

type Tone = "border" | "accent" | "muted" | "dim" | "text" | "error";

/**
 * One row the list paints (S35): a foldable group of the `tree` or `ext` tree, or
 * a file. `depth` is the nesting level the row is indented at, and a group's
 * `key` is what the fold state remembers for the order painting it.
 */
type ListRow =
	| { kind: "group"; key: string; label: string; depth: number }
	| { kind: "file"; entry: FileEntry; depth: number };

interface PaneLayout {
	contentWidth: number;
	listWidth: number;
	previewStart: number;
	previewWidth: number;
	/** True when the preview paints inside its own rounded box (S38). */
	boxed: boolean;
	/** The box's usable columns between its two border cells; the pane's own width when unbordered. */
	previewInteriorWidth: number;
	/** The preview's own content rows inside whatever frame is painted. */
	previewContentRows: number;
	/** The text column left for a line once a gutter of `gutterWidth` sits inside the frame. */
	wrapWidth(gutterWidth: number): number;
}

interface PreviewLine {
	text: string;
	tone: Tone;
	/** Real file line number; absent on a notice row. */
	number?: number;
	/** The text already carries the highlighter's colour, so it is not re-toned (S39). */
	highlighted?: boolean;
}

/**
 * The preview's lines flattened into the rows they paint at the interior width
 * of the pane's box. A line wider than that continues on the following rows
 * under the same text column, so `rowStarts` maps a painted row back to the line
 * that owns it and `rows` holds the text each row paints, whole graphemes only
 * (S30, S38).
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

type PreviewEntry = { status: "loading" } | { status: "ready"; preview: FilePreview; highlighted?: string[] };

interface PointerHit {
	y: number;
	index: number;
}

interface PointerFrame {
	width: number;
	height: number;
	/** The rows the list rows paint at; the first is `BODY_TOP`. */
	bodyTop: number;
	bodyRows: number;
	listStart: number;
	listEnd: number;
	/** The columns the preview pane paints at. */
	previewStart: number;
	previewEnd: number;
	/** The rows the preview pane spans: the info row through the list's last row. */
	previewTop: number;
	previewBottom: number;
	hits: PointerHit[];
}

// One geometry feeds painting and hit-testing, so a click always lands on the
// row or pane that is actually visible. The preview's box spans the whole
// preview pane, so its two border columns come out of the wrap width and never
// out of the list, the separator or the card frame.
function paneLayout(width: number, bodyRows: number): PaneLayout {
	const contentWidth = Math.max(1, width - CARD_PADDING);
	const maxList = Math.max(1, contentWidth - SEPARATOR_WIDTH - 1);
	const listWidth = Math.max(1, Math.min(LIST_MAX_WIDTH, Math.floor(contentWidth * LIST_RATIO), maxList));
	const previewStart = listWidth + SEPARATOR_WIDTH;
	const previewWidth = Math.max(0, contentWidth - previewStart);
	// The box frames the info row above the list and the list's last row, so its
	// two border rows come out of the body plus that one row above it, and the
	// search row above and the closing rule below belong to the card (S47).
	const boxed = bodyRows >= BOX_MIN_BODY_ROWS && previewWidth >= BOX_MIN_WIDTH;
	const previewInteriorWidth = boxed ? previewWidth - BOX_COLUMNS : previewWidth;
	// The unbordered fallback spends one row on the position indicator and keeps
	// the rest for content, so it fills the same rows the box would (S38).
	const previewContentRows = Math.max(0, boxed ? bodyRows - 1 : bodyRows);
	return {
		contentWidth,
		listWidth,
		previewStart,
		previewWidth,
		boxed,
		previewInteriorWidth,
		previewContentRows,
		wrapWidth(gutterWidth: number) {
			return Math.max(0, previewInteriorWidth - gutterWidth - PREVIEW_GUTTER_GAP);
		},
	};
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

/** The last segment of a folder path, which is the name its group row paints. */
function lastSegment(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? path : path.slice(slash + 1);
}

/** A dotfile such as `.gitignore` has no extension; `a.tar.gz` groups under `gz`. */
function extensionOf(path: string): string {
	const extension = posix.extname(posix.basename(path));
	return extension.startsWith(".") ? extension.slice(1) : extension;
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
	/**
	 * The group keys folded per order (S35): every group starts expanded when an
	 * order is chosen, and the fold state lives as long as the panel does.
	 */
	private readonly foldedByOrder = new Map<FilePickerOrder, Set<string>>();
	/** Tab multi-select (S14), in the order each file was marked. */
	private readonly selection = new Set<string>();
	private readonly openedAt: number;
	private readonly previews = new Map<string, PreviewEntry>();
	/** The geometry of the last painted frame: what the box, the scroll and the pointer all follow. */
	private paintedLayout: PaneLayout | undefined;
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
		const bodyRows = this.bodyRowCount();
		const layout = paneLayout(width, bodyRows);
		// The list, the preview and the scroll math all read this one layout, so a
		// click, the wheel and a clamp land on what is painted (S6, S38).
		this.paintedLayout = layout;
		const hits: PointerHit[] = [];
		const state = this.emptyState();
		// The two columns are interleaved row by row instead of composed on their
		// own (S47): the search row is the list column's alone, the info row carries
		// the box's top border beside it, and one rule closes both below the body.
		const left = state ? this.emptyColumn(layout, state, bodyRows) : this.listColumn(layout, bodyRows, hits);
		const right = state ? [] : this.previewColumn(layout, bodyRows);
		const separator = this.renderText(SEPARATOR, "border");
		const paneRow = (list: string | undefined, preview: string | undefined): string => `${fit(list ?? "", layout.listWidth)}${separator}${fit(preview ?? "", layout.previewWidth)}`;
		// Title, the search row the preview leaves to the list, the info row the box
		// starts on, then the list rows against the preview's content rows.
		const lines: string[] = [this.headerRow(layout.contentWidth), paneRow(this.searchRow(layout.listWidth), ""), paneRow(this.infoRow(layout.listWidth), right[0])];
		for (let index = 0; index < bodyRows; index += 1) lines.push(paneRow(left[index], right[index + 1]));
		lines.push(this.closingRuleRow(layout));
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
			// The preview pane is the box itself: the info row above the list through
			// the list's last row.
			previewTop: BODY_TOP - 1,
			previewBottom: BODY_TOP + bodyRows,
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
			this.select(this.focusableRows()[0] ?? 0);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.select(this.focusableRows().at(-1) ?? 0);
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
		// space folds the group that owns the focused file and is the one printable
		// that never reaches the query, which is what used to reset the highlight
		// to the first row (S5, S46).
		if (matchesKey(data, Key.space)) {
			this.toggleFoldAt(this.selected);
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
			// A group row is never focusable, so the cursor is on a file row and
			// Enter inserts and closes (S8, S46). The one exception is a tree with
			// every group folded: no file row is painted then and the group row under
			// the cursor is the way back into the tree, so Enter toggles it.
			if (this.selectedRow()?.kind === "group") this.toggleFoldAt(this.selected);
			else this.finish("insert");
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
		const inList = event.y >= frame.bodyTop && event.y < frame.bodyTop + frame.bodyRows && event.x >= frame.listStart && event.x < frame.listEnd;
		const inPreview = event.y >= frame.previewTop && event.y < frame.previewBottom && event.x >= frame.previewStart && event.x < frame.previewEnd;
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
		// A group row folds or unfolds under the pointer instead of taking the
		// cursor, because it is never focusable (S46).
		if (this.rows()[hit.index]?.kind === "group") return { handled: true, render: this.toggleFoldAt(hit.index) };
		return { handled: true, render: this.select(hit.index) };
	}

	invalidate(): void {
		this.pointerFrame = undefined;
		this.hovered = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.pointerFrame = undefined;
		this.paintedLayout = undefined;
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

	/** Rows of preview content inside the frame the last render painted (S38, S47). */
	private previewRows(): number {
		return this.painted().previewContentRows;
	}

	/**
	 * The geometry of the last painted frame, which is what the box's wrap and the
	 * scroll clamp follow. A frame is painted before any key or wheel reaches the
	 * panel; the narrowest layout stands in if one somehow does not.
	 */
	private painted(): PaneLayout {
		return this.paintedLayout ?? paneLayout(MIN_WIDTH, this.bodyRowCount());
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
			this.clampCursor(0);
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
	 * The files the query matches, in the listing's own order (S29): changed
	 * first, newest first (S12). A non-empty query ranks them instead, and the
	 * `tree` and `ext` trees re-sort their own rows below.
	 */
	private matches(): FileEntry[] {
		if (!this.loaded || this.entries.length === 0) return [];
		// rankPaletteGroups already ranks basename starts-with, then basename
		// contains, then subsequence, then full-path contains (the directory).
		// It keeps the input order for an empty query, so the active listing
		// order is what those rows paint.
		const group: CommandPaletteGroup = {
			title: "Files",
			items: this.entries.map((entry) => ({ command: entry.path, label: posix.basename(entry.path) })),
		};
		const ranked = rankPaletteGroups([group], this.query)[0];
		if (!ranked) return [];
		const byPath = new Map(this.entries.map((entry) => [entry.path, entry]));
		const matched: FileEntry[] = [];
		for (const item of ranked.items) {
			const entry = byPath.get(item.command);
			if (entry) matched.push(entry);
		}
		return matched;
	}

	/**
	 * The rows the list paints in the active order (S29, S35). `modified` is a flat
	 * file list in the listing's own order and is never re-sorted or grouped here;
	 * `tree` and `ext` paint a tree of group rows and file rows.
	 */
	private rows(): ListRow[] {
		const matched = this.matches();
		if (this.order === "modified" || matched.length === 0) return matched.map((entry) => ({ kind: "file", entry, depth: 0 }));
		return this.order === "tree" ? this.treeRows(matched) : this.extensionRows(matched);
	}

	/**
	 * The `tree` order: inside every folder its subfolders come first and then its
	 * own files, each alphabetical by name, so at the top level every folder group
	 * paints before the files living at the repository root (S35). Every folder on
	 * the way down gets a group row, even one holding no file of its own.
	 */
	private treeRows(entries: FileEntry[]): ListRow[] {
		const ownFiles = new Map<string, FileEntry[]>();
		const subfolders = new Map<string, Set<string>>();
		for (const entry of entries) {
			const directory = posix.dirname(entry.path);
			const folder = directory === "." ? "" : directory;
			const files = ownFiles.get(folder);
			if (files) files.push(entry);
			else ownFiles.set(folder, [entry]);
			let current = folder;
			while (current !== "") {
				const slash = current.lastIndexOf("/");
				const parent = slash < 0 ? "" : current.slice(0, slash);
				const children = subfolders.get(parent);
				if (children) children.add(current);
				else subfolders.set(parent, new Set([current]));
				current = parent;
			}
		}
		const rows: ListRow[] = [];
		const paint = (folder: string, depth: number): void => {
			const children = [...(subfolders.get(folder) ?? [])].sort((left, right) => byCodePoint(lastSegment(left), lastSegment(right)));
			for (const child of children) {
				rows.push({ kind: "group", key: child, label: lastSegment(child), depth });
				if (this.groupExpanded(child)) paint(child, depth + 1);
			}
			const files = [...(ownFiles.get(folder) ?? [])].sort((left, right) => byCodePoint(posix.basename(left.path), posix.basename(right.path)));
			for (const entry of files) rows.push({ kind: "file", entry, depth });
		};
		paint("", 0);
		return rows;
	}

	/**
	 * The `ext` tree, one level deep (S35): one group per extension named with its
	 * dot, the files inside alphabetical by path, and the extensionless group last.
	 */
	private extensionRows(entries: FileEntry[]): ListRow[] {
		const groups = new Map<string, FileEntry[]>();
		for (const entry of entries) {
			const extension = extensionOf(entry.path);
			const files = groups.get(extension);
			if (files) files.push(entry);
			else groups.set(extension, [entry]);
		}
		const extensions = [...groups.keys()].sort((left, right) => (left === "" ? 1 : right === "" ? -1 : byCodePoint(left, right)));
		const rows: ListRow[] = [];
		for (const extension of extensions) {
			rows.push({ kind: "group", key: extension, label: extension === "" ? EXTENSIONLESS_GROUP : `.${extension}`, depth: 0 });
			if (!this.groupExpanded(extension)) continue;
			const files = [...(groups.get(extension) ?? [])].sort((left, right) => byCodePoint(left.path, right.path));
			for (const entry of files) rows.push({ kind: "file", entry, depth: 1 });
		}
		return rows;
	}

	/** The group keys the active order has folded (S35); a group is open until it is folded. */
	private foldedGroups(order: FilePickerOrder): Set<string> {
		let folded = this.foldedByOrder.get(order);
		if (!folded) {
			folded = new Set<string>();
			this.foldedByOrder.set(order, folded);
		}
		return folded;
	}

	/** A non-empty query forces every group open, so a match is never hidden behind a fold (S35). */
	private groupExpanded(key: string): boolean {
		if (this.query.length > 0) return true;
		return !this.foldedGroups(this.order).has(key);
	}

	private selectedRow(): ListRow | undefined {
		const rows = this.rows();
		if (rows.length === 0) return undefined;
		return rows[Math.max(0, Math.min(rows.length - 1, this.selected))];
	}

	private selectedPath(): string | undefined {
		const row = this.selectedRow();
		return row?.kind === "file" ? row.entry.path : undefined;
	}

	/**
	 * The first file row, so typing moves the highlight to a match and never to a
	 * group row, which has no file to preview (S5, S46).
	 */
	private firstFileRow(): number {
		const index = this.rows().findIndex((row) => row.kind === "file");
		return index < 0 ? 0 : index;
	}

	private setQuery(query: string): void {
		this.query = query;
		this.selected = this.firstFileRow();
		this.previewScroll = 0;
		this.ensurePreviewLoaded();
	}

	/**
	 * The rows the cursor may rest on (S46): file rows only, so every movement
	 * steps over a group row. The exception is a tree whose groups are all folded:
	 * no file row is painted then, and the group rows are the only way back into
	 * the tree, so they take the cursor until one of them reopens.
	 */
	private focusableRows(): number[] {
		const rows = this.rows();
		const files: number[] = [];
		for (let index = 0; index < rows.length; index += 1) {
			if (rows[index]!.kind === "file") files.push(index);
		}
		return files.length > 0 ? files : rows.map((_row, index) => index);
	}

	/**
	 * Put the cursor on a row it may rest on (S46), anchored at the row a change
	 * happened on: the first file row at or after `anchor` takes the place the
	 * hidden rows left, and when the fold hid the rest of the tree the nearest file
	 * row above it does. With no file row left at all the cursor stays on the group
	 * row, the one exception S46 allows.
	 */
	private clampCursor(anchor: number): void {
		const rows = this.rows();
		if (rows.length === 0) {
			this.selected = 0;
			return;
		}
		const start = Math.max(0, Math.min(rows.length - 1, anchor));
		let next = -1;
		for (let index = start; index < rows.length && next < 0; index += 1) {
			if (rows[index]!.kind === "file") next = index;
		}
		for (let index = start - 1; index >= 0 && next < 0; index -= 1) {
			if (rows[index]!.kind === "file") next = index;
		}
		this.selected = next >= 0 ? next : start;
	}

	private moveSelection(delta: number): boolean {
		const focusable = this.focusableRows();
		if (focusable.length === 0) return false;
		const current = focusable.indexOf(this.selected);
		if (current < 0) {
			// The cursor sits on a row it may not rest on: land on the nearest row it
			// may, in the direction of the movement.
			const next = delta > 0
				? focusable.find((index) => index > this.selected) ?? focusable[focusable.length - 1]!
				: [...focusable].reverse().find((index) => index < this.selected) ?? focusable[0]!;
			return this.select(next);
		}
		const position = Math.max(0, Math.min(focusable.length - 1, current + delta));
		return this.select(focusable[position]!);
	}

	private select(index: number): boolean {
		const total = this.rows().length;
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
	 * space and a click on a group row (S46): fold or unfold the tree group at
	 * `index` — the row itself when it is a group, and otherwise the group that
	 * owns the focused file, which is its folder in `tree` and its extension group
	 * in `ext`. A file at the repository root in `tree` has no group above it, and
	 * a query that holds every group open has nothing to toggle.
	 */
	private toggleFoldAt(index: number): boolean {
		if (this.query.length > 0) return false;
		const rows = this.rows();
		if (rows.length === 0) return false;
		const owner = this.owningGroup(rows, Math.max(0, Math.min(rows.length - 1, index)));
		if (!owner) return false;
		const focused = this.selectedPath();
		const folded = this.foldedGroups(this.order);
		if (folded.has(owner.key)) folded.delete(owner.key);
		else folded.add(owner.key);
		// A fold that hides the focused file moves the cursor to the row that took
		// the hidden rows' place; a fold elsewhere in the tree leaves it on the same
		// file, which the row indexes below have shifted (S46).
		const kept = focused === undefined ? -1 : this.rows().findIndex((row) => row.kind === "file" && row.entry.path === focused);
		if (kept >= 0) this.selected = kept;
		else this.clampCursor(owner.index);
		if (this.selectedPath() !== focused) {
			this.previewScroll = 0;
			this.ensurePreviewLoaded();
		}
		return true;
	}

	/**
	 * The group a row folds it through: the row itself when it is a group, and
	 * otherwise the nearest group row above it one nesting level up — the folder
	 * that holds the file, or its extension group in `ext` (S46).
	 */
	private owningGroup(rows: ListRow[], index: number): { key: string; index: number } | undefined {
		const row = rows[index];
		if (!row) return undefined;
		if (row.kind === "group") return { key: row.key, index };
		for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
			const candidate = rows[cursor]!;
			if (candidate.kind === "group" && candidate.depth === row.depth - 1) return { key: candidate.key, index: cursor };
		}
		return undefined;
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
		const rows = this.rows();
		const moved = previous === undefined ? -1 : rows.findIndex((row) => row.kind === "file" && row.entry.path === previous);
		this.selected = moved >= 0 ? moved : Math.max(0, Math.min(rows.length - 1, this.selected));
		// The new order can paint a group row where the old one painted a file, so
		// the cursor follows the rows and never the index (S46).
		this.clampCursor(this.selected);
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
		for (const row of this.rows()) {
			if (row.kind !== "file") continue;
			visible.add(row.entry.path);
			if (this.selection.has(row.entry.path)) paths.push(row.entry.path);
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
		const window = this.previewWindow(path, this.painted());
		return this.setPreviewScroll(edge === "start" ? 0 : this.maxPreviewScroll(window));
	}

	private setPreviewScroll(next: number): boolean {
		const path = this.selectedPath();
		if (!path) return false;
		const window = this.previewWindow(path, this.painted());
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
				this.previews.set(path, { status: "ready", preview, highlighted: this.highlightedLines(path, preview) });
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
	 * The preview's lines painted by the injected highlighter, computed once when
	 * the preview lands — on the text the byte budget already bounded, never per
	 * repaint (S3, S39). Every failure degrades to the plain preview the pane painted
	 * before colour existed: no highlighter, no language for the path, a highlighter
	 * that throws because no theme is initialised, and painted output that does not
	 * line up with the file (the gutter, the position and the truncation notice all
	 * count file lines).
	 */
	private highlightedLines(path: string, preview: FilePreview): string[] | undefined {
		const highlight = this.deps.highlight;
		const languageForPath = this.deps.languageForPath;
		if (preview.kind !== "text" || !highlight || !languageForPath) return undefined;
		const lines = preview.lines.map(displayPreviewText);
		try {
			const lang = languageForPath(path);
			if (!lang) return undefined;
			const painted = highlight(lines.join("\n"), lang);
			if (!Array.isArray(painted) || painted.length !== lines.length) return undefined;
			return painted;
		} catch {
			return undefined;
		}
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

	/**
	 * The title row: the listing path follows `File picker` after one two-space
	 * gap, so the scope reads as the title's own context, and `esc` keeps the
	 * far-right corner to itself (S42).
	 */
	private headerRow(width: number): string {
		const title = this.renderText("File picker", "accent");
		const close = this.renderText("esc", KEY_TONE);
		const titleWidth = visibleWidth(stripAnsi(title));
		const closeWidth = visibleWidth(stripAnsi(close));
		// The path may take the room between the title's gap and the space that
		// keeps `esc` in the corner; under the floor it is dropped, never elided to
		// nothing useful (S42).
		const root = this.rootCell(width - titleWidth - TITLE_ROOT_GAP - 1 - closeWidth);
		if (root === undefined) {
			const gap = Math.max(1, width - titleWidth - closeWidth);
			return fit(`${title}${" ".repeat(gap)}${close}`, width);
		}
		const gap = Math.max(1, width - titleWidth - TITLE_ROOT_GAP - visibleWidth(stripAnsi(root)) - closeWidth);
		return fit(`${title}${" ".repeat(TITLE_ROOT_GAP)}${root}${" ".repeat(gap)}${close}`, width);
	}

	/** The listing path next to the title, elided from its left; the title and `esc` win over it (S42). */
	private rootCell(room: number): string | undefined {
		if (this.deps.root === undefined || room < MIN_ROOT_WIDTH) return undefined;
		const root = displayText(this.deps.root);
		if (root.length === 0) return undefined;
		return this.renderText(elideLeft(root, room), "dim");
	}

	/**
	 * Always-active search, painted exactly like the Commands palette (S18) and
	 * narrowed to the list pane, which leaves the preview's right column blank on
	 * this row (S47).
	 */
	private searchRow(width: number): string {
		if (this.query.length === 0) return fit(this.renderText(`${SEARCH_PROMPT} ${SEARCH_PLACEHOLDER}`, "muted"), width);
		return fit(`${this.renderText(SEARCH_PROMPT, "muted")} ${displayText(this.query)}`, width);
	}

	/**
	 * The info row under the search: how many files the query lists out of the
	 * whole listing, the Tab selection in parentheses, and the active list nesting
	 * order right-aligned at the list pane's edge, so the order is always visible
	 * without being a key hint (S43). Only the list column paints it (S47). The
	 * listed count is files only, never the group rows the trees paint, and the
	 * parenthesised count is the whole selection, which can include files the query
	 * hides. A pending or failed listing counts nothing, so the row stays blank
	 * instead of claiming zero files.
	 */
	private infoRow(width: number): string {
		if (!this.loaded || this.listingError !== undefined) return "".padEnd(Math.max(0, width), " ");
		const listed = this.matches().length;
		const counts = this.renderText(`${listed}/${this.entries.length} (${this.selection.size})`, "muted");
		const order = this.renderText(this.order, "muted");
		// One space each side of the rule, which takes every cell the two labels
		// leave; a list pane too narrow for both drops the rule instead.
		const room = width - visibleWidth(stripAnsi(counts)) - visibleWidth(stripAnsi(order));
		if (room < 2) return fit(`${counts} ${order}`, width);
		return `${counts} ${this.renderText(BOX_HORIZONTAL.repeat(room - 2), "border")} ${order}`;
	}

	/**
	 * The list column while the listing is unloaded, failed or holds nothing: the
	 * state line takes the first list row, exactly where a painted list starts.
	 */
	private emptyColumn(layout: PaneLayout, state: { text: string; tone: Tone }, bodyRows: number): string[] {
		if (bodyRows <= 0) return [];
		const lines = [fit(this.renderText(state.text, state.tone), layout.listWidth)];
		while (lines.length < bodyRows) lines.push("");
		return lines;
	}

	/**
	 * The row that closes the body (S47): one rule across the whole card content,
	 * so the list column, the separator and the preview column read as one line.
	 */
	private closingRuleRow(layout: PaneLayout): string {
		const rule = this.renderText(BOX_HORIZONTAL, "border");
		return `${rule.repeat(layout.listWidth)}${rule.repeat(SEPARATOR_WIDTH)}${rule.repeat(layout.previewWidth)}`;
	}

	/**
	 * The list pane over the rows actually painted (S35), so the window, the
	 * pointer rows and the highlight all follow the tree, group rows included.
	 */
	private listColumn(layout: PaneLayout, bodyRows: number, hits: PointerHit[]): string[] {
		const rows = this.rows();
		if (bodyRows <= 0 || rows.length === 0) return [];
		const lines: string[] = [];
		const selected = Math.max(0, Math.min(rows.length - 1, this.selected));
		const showIndicators = rows.length > bodyRows && bodyRows >= 4;
		const windowSize = showIndicators ? Math.max(1, bodyRows - 2) : bodyRows;
		const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), Math.max(0, rows.length - windowSize)));
		const end = Math.min(rows.length, start + windowSize);
		if (showIndicators && start > 0) lines.push(fit(this.renderText(`  ↑ ${start} more`, "muted"), layout.listWidth));
		for (let index = start; index < end; index += 1) {
			hits.push({ y: BODY_TOP + lines.length, index });
			lines.push(this.renderListRow(rows[index]!, index, selected, layout.listWidth));
		}
		if (showIndicators && end < rows.length) lines.push(fit(this.renderText(`  ↓ ${rows.length - end} more`, "muted"), layout.listWidth));
		while (lines.length < bodyRows) lines.push("");
		return lines.slice(0, bodyRows);
	}

	/**
	 * The label a file row paints: its name, and — in `modified` and `ext` only —
	 * the trailing parent directory. In `tree` the tree already places the file
	 * under its folder, so that suffix would echo the row above it (S35).
	 */
	private rowLabel(entry: FileEntry): { text: string; nameLength: number } {
		const name = displayText(posix.basename(entry.path));
		const directory = this.order === "tree" ? undefined : posix.dirname(entry.path);
		if (directory === undefined || directory === ".") return { text: name, nameLength: name.length };
		return { text: `${name}  ${displayText(directory)}`, nameLength: name.length };
	}

	/** The trailing badge and age of a changed row; a clean row has neither (S12). */
	private rowSuffix(entry: FileEntry): string {
		if (entry.state === "clean") return "";
		const badge = entry.state === "new" ? UNTRACKED_BADGE : MODIFIED_BADGE;
		const parts = [this.deps.theme.fg("accent", badge)];
		if (entry.mtimeMs !== undefined) parts.push(this.deps.theme.fg("muted", formatAge(entry.mtimeMs, this.openedAt)));
		return parts.join(" ");
	}

	// The name leads and the badge and age trail: the name is truncated first so
	// a narrow list pane never costs the row its state. The name paints in the
	// row's role and the trailing parent directory in `dim`, the pair `/changes`
	// paints for the same information (S37); the label is composed and truncated
	// whole and only then split, so the tone split moves no cell and never
	// changes which part truncates first.
	private renderListRow(row: ListRow, index: number, selectedIndex: number, listWidth: number): string {
		const theme = this.deps.theme;
		const cursor = index === selectedIndex;
		const indent = " ".repeat(row.depth * GROUP_INDENT);
		const indentWidth = row.depth * GROUP_INDENT;
		if (row.kind === "group") {
			// A group row paints only its name at its depth: no badge, no age and no
			// trailing directory, which the tree already expresses (S35). Space owns
			// no selection bar, so its middle cell stays blank like an unmarked row.
			const room = Math.max(0, listWidth - MARKER_WIDTH - indentWidth);
			const label = truncateToWidth(displayText(row.label), room, "…");
			const marker = `${cursor && !theme.bg ? theme.fg("accent", "▸") : " "}  `;
			if (cursor && theme.bg) {
				const inner = `${marker}${indent}${label}`;
				return theme.bg("selectedBg", inner + " ".repeat(Math.max(0, listWidth - visibleWidth(stripAnsi(inner)))));
			}
			const painted = cursor ? theme.fg("text", label) : paintHoverable(theme, label, !cursor && index === this.hovered, "muted");
			return fit(`${marker}${indent}${painted}`, listWidth);
		}
		const entry = row.entry;
		const marked = this.selection.has(entry.path);
		const hovered = !cursor && !marked && index === this.hovered;
		const suffix = this.rowSuffix(entry);
		const suffixWidth = visibleWidth(stripAnsi(suffix));
		const showsSuffix = suffixWidth > 0 && suffixWidth + MARKER_WIDTH + indentWidth <= listWidth;
		const labelRoom = Math.max(0, listWidth - MARKER_WIDTH - indentWidth - (showsSuffix ? suffixWidth + 1 : 0));
		const parts = this.rowLabel(entry);
		const label = truncateToWidth(parts.text, labelRoom, "…");
		// A file at the repository root has no directory, so the whole label is
		// the name (S37).
		const split = Math.min(label.length, parts.nameLength);
		const name = label.slice(0, split);
		const tail = label.slice(split);
		const gapEnd = tail.slice(0, 2) === "  " ? 2 : tail.search(/[^ ]/);
		const nameGap = gapEnd === -1 ? tail : tail.slice(0, gapEnd);
		const directory = tail.slice(nameGap.length);
		const gap = " ".repeat(Math.max(0, listWidth - MARKER_WIDTH - indentWidth - visibleWidth(label) - (showsSuffix ? suffixWidth : 0)));
		// The marker column is three cells wide in every state: cursor cell,
		// selection cell, then the space before the name. A highlighted bar owns
		// the cursor, so that cell stays blank there.
		const marker = `${cursor && !theme.bg ? theme.fg("accent", "▸") : " "}${marked ? theme.fg("accent", SELECTION_BAR) : " "} `;
		if (cursor && theme.bg) {
			const inner = `${marker}${indent}${label}${showsSuffix ? `${gap}${stripAnsi(suffix)}` : ""}`;
			return theme.bg("selectedBg", inner + " ".repeat(Math.max(0, listWidth - visibleWidth(stripAnsi(inner)))));
		}
		const paintedName = marked ? theme.fg("accent", name) : cursor ? theme.fg("text", name) : paintHoverable(theme, name, hovered, "muted");
		const paintedLabel = directory.length === 0 ? paintedName : `${paintedName}${nameGap}${theme.fg(DIRECTORY_TONE, directory)}`;
		return fit(`${marker}${indent}${paintedLabel}${gap}${showsSuffix ? suffix : ""}`, listWidth);
	}

	/**
	 * The preview pane's own cells for the info row and the list rows (S47): the
	 * box's top border beside the info row, a content row per list row, and the
	 * box's bottom border on the list's last row. The unbordered fallback keeps
	 * the position indicator on the info row and fills the same rows below it.
	 */
	private previewColumn(layout: PaneLayout, bodyRows: number): string[] {
		const path = this.selectedPath();
		if (!path || bodyRows <= 0) return [];
		const window = this.previewWindow(path, layout);
		// The painted window is what a scroll is clamped against, so the last page
		// is always full and the position indicator never lies.
		this.previewScroll = Math.max(0, Math.min(this.previewScroll, this.maxPreviewScroll(window)));
		const lines: string[] = [layout.boxed ? this.previewBoxTop(window, path, layout.previewWidth) : this.previewPositionRow(window, path, layout.previewWidth)];
		for (let offset = 0; offset < layout.previewContentRows; offset += 1) {
			const row = this.previewScroll + offset;
			const content = row < window.totalRows ? this.previewRow(window, row, layout.previewInteriorWidth) : "";
			lines.push(layout.boxed ? this.previewBoxRow(content, layout.previewInteriorWidth) : content);
		}
		if (layout.boxed) lines.push(this.previewBoxBottom(layout.previewWidth));
		return lines;
	}

	/**
	 * The box's top border with the position indicator at its right (S38): the
	 * dashes fill the interior the indicator leaves, one space separates them, and
	 * the corners close the pane's own columns.
	 */
	private previewBoxTop(window: PreviewWindow, path: string, width: number): string {
		const interiorWidth = Math.max(0, width - BOX_COLUMNS);
		const label = this.positionLabel(window, path);
		// A pane too narrow for the whole label keeps its right end rather than
		// overflowing the card's frame.
		const position = label === undefined ? undefined : truncateToWidth(this.renderText(label, "muted"), interiorWidth, "…");
		const positionWidth = position === undefined ? 0 : visibleWidth(stripAnsi(position));
		const gap = position === undefined ? 0 : Math.min(1, Math.max(0, interiorWidth - positionWidth));
		const fill = Math.max(0, interiorWidth - positionWidth - gap);
		return `${this.renderText(BOX_TOP_LEFT, "border")}${this.renderText(BOX_HORIZONTAL.repeat(fill), "border")}${" ".repeat(gap)}${position ?? ""}${this.renderText(BOX_TOP_RIGHT, "border")}`;
	}

	/** The box's bottom border: one border-tone run between its two corners. */
	private previewBoxBottom(width: number): string {
		const interiorWidth = Math.max(0, width - BOX_COLUMNS);
		return `${this.renderText(BOX_BOTTOM_LEFT, "border")}${this.renderText(BOX_HORIZONTAL.repeat(interiorWidth), "border")}${this.renderText(BOX_BOTTOM_RIGHT, "border")}`;
	}

	/** One boxed content row: the interior, padded to the box, framed by its two border columns. */
	private previewBoxRow(content: string, width: number): string {
		return `${this.renderText(BOX_VERTICAL, "border")}${fit(content, width)}${this.renderText(BOX_VERTICAL, "border")}`;
	}

	/**
	 * The preview flattened into painted rows at the layout's wrap width. A line
	 * wider than the box's interior wraps instead of being truncated, so the
	 * scroll and page math counts rows while the gutter and the position count
	 * file lines (S30, S38).
	 */
	private previewWindow(path: string, layout: PaneLayout): PreviewWindow {
		const lines = this.previewLines(path);
		const gutterWidth = this.previewGutterWidth(path);
		const textWidth = layout.wrapWidth(gutterWidth);
		const rows: string[] = [];
		const rowStarts: number[] = [];
		for (const line of lines) {
			rowStarts.push(rows.length);
			// A coloured line wraps through the ANSI-aware wrapper so a colour run
			// survives the break and each continuation row keeps its fragment's
			// colour; the plain path keeps its grapheme-exact cell wrap (S30, S39).
			rows.push(...(line.highlighted && textWidth > 0 ? wrapTextWithAnsi(line.text, textWidth) : wrapByCells(line.text, textWidth)));
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

	/** `top/total` plus `+` when the reader truncated; nothing when the total is not known (S21). */
	private positionLabel(window: PreviewWindow, path: string): string | undefined {
		const meta = this.previewMeta(path);
		if (!meta) return undefined;
		const top = this.topLineNumber(window) ?? meta.total;
		return `${Math.min(meta.total, top)}/${meta.total}${meta.truncated ? "+" : ""}`;
	}

	/** The unboxed position row at the pane's right; the box puts it in its top border instead (S38). */
	private previewPositionRow(window: PreviewWindow, path: string, width: number): string {
		const label = this.positionLabel(window, path);
		if (label === undefined) return "";
		const indicator = this.renderText(label, "muted");
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
		// The gutter is painted after highlighting and keeps its own dim tone, so a
		// line number is never coloured (S39). A highlighted row is painted as the
		// highlighter returned it and is closed with its own reset.
		const painted = entry.highlighted ? `${text}${ANSI_RESET}` : this.renderText(text, entry.tone);
		return fit(`${gutter}${gap}${showsText ? painted : ""}`, width);
	}

	private previewLines(path: string): PreviewLine[] {
		const entry = this.previews.get(path);
		if (!entry || entry.status === "loading") return [{ text: LOADING_PREVIEW, tone: "muted" }];
		const preview = entry.preview;
		if (preview.kind === "binary") return [{ text: FILE_PREVIEW_BINARY_NOTICE, tone: "muted" }];
		if (preview.kind === "error") return [{ text: preview.message, tone: "error" }];
		const lines: PreviewLine[] = preview.lines.map((line, index) => {
			const text = displayPreviewText(line);
			const painted = entry.highlighted?.[index];
			// A line the highlighter left untouched keeps the plain tone, so a file
			// it could not paint reads exactly as it did before (S39).
			if (painted === undefined || painted === text) return { text, tone: "text", number: index + 1 };
			return { text: painted, tone: "text", highlighted: true, number: index + 1 };
		});
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
