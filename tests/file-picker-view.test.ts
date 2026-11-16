import assert from "node:assert/strict";
import test from "node:test";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { FilePickerView, type FilePickerDeps, type FilePickerTheme } from "../lib/file-picker-view.ts";
import { FILE_PREVIEW_BINARY_NOTICE, type FileEntry, type FilePreview, type RepositoryEntriesResult } from "../lib/file-index.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The file picker overlay: repository files on the left, a lazy preview on
// the right, search always active. Rendering and pointer routing are pure;
// listing and preview reads are injected, so no repository is needed.

const CTRL_SHIFT_J = "\x1b[106;6u";
const CTRL_SHIFT_K = "\x1b[107;6u";
// ctrl+o cycles the listing order (S29).
const CTRL_O = "\x0f";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const TAB = "\t";
// space folds the focused group row and never reaches the query (S5, S35).
const SPACE = " ";

// Home/End compatibility (S28): the encodings a terminal really sends for
// those keys — the CSI letter form, the SS3 form, the tilde form and the rxvt
// form — plus the ctrl spellings (xterm `1;5`, the `7;5`/`8;5` tilde keys and
// the rxvt ctrl form). `ESC [ 1 ; 5 ~` / `ESC [ 4 ; 5 ~` are not accepted by
// Pi's key helpers, so they cannot be covered here.
const HOME_SEQUENCES = ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"];
const END_SEQUENCES = ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"];
const CTRL_HOME_SEQUENCES = ["\x1b[1;5H", "\x1b[7;5~", "\x1b[7^", "\x1b[57423;5u"];
const CTRL_END_SEQUENCES = ["\x1b[1;5F", "\x1b[8;5~", "\x1b[8^", "\x1b[57424;5u"];

// The Pi theme's key colour (accent) and the neutral label tone (muted), so a
// painted cell can be asserted the way the terminal receives it.
const KEY_ROLE = "\x1b[35m";
const LABEL_ROLE = "\x1b[90m";
const ROLE_END = "\x1b[39m";

// Card rows: top border, header, search row, info row, body, closing rule.
const SEARCH_ROW = 2;
const INFO_ROW = 3;
const BODY_TOP = 4;
// The card's own rows: the search row is the list column's alone, the preview
// box starts on the info row below it and its bottom border lands on the list's
// last row (S47).
const PREVIEW_TOP = 2;
const BOX_TOP_ROW = 3;
// A selected row's marker cell: the accent bar that joins across adjacent rows.
const SELECTION_BAR = "▏";
const FOOTER_TEXT = "↑/↓ move • ctrl+j/k scroll • tab select • space fold • ctrl+o order • ctrl+u clear • enter insert • ctrl+e editor • esc close";
// The marker column every list row spends before its label, and the indent one
// level of the `path`/`ext` tree costs (S20, S35).
const MARKER_COLUMN = 3;
const GROUP_INDENT = 2;
const ROOT = "/home/dev/projects/gentle-shell-worktrees/file-picker";

// A fixed clock: the row ages are computed once when the panel opens, so a
// test can advance the clock and prove the painted ages never move.
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const plainTheme: FilePickerTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

const taggedTheme: FilePickerTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

const FILES: FileEntry[] = [{ path: "README.md", state: "clean" }, { path: "src/app.ts", state: "clean" }, { path: "src/lib/util.ts", state: "clean" }];

type MouseEvent = {
	type: "press" | "release" | "move" | "drag" | "click" | "wheel";
	button: "left" | "middle" | "right" | "none";
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
};

interface Calls {
	open: string[];
	insert: string[][];
	close: number;
	render: number;
	trace: string[];
}

function entry(path: string, state: FileEntry["state"] = "clean", mtimeMs?: number): FileEntry {
	return mtimeMs === undefined ? { path, state } : { path, state, mtimeMs };
}

function entries(list: FileEntry[]): RepositoryEntriesResult {
	return { ok: true, entries: list };
}

function preview(lines: string[], truncated = false): FilePreview {
	return { kind: "text", lines, truncated };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createView(overrides: Partial<FilePickerDeps> = {}, list: FileEntry[] = FILES): { view: FilePickerView; calls: Calls } {
	const calls: Calls = { open: [], insert: [], close: 0, render: 0, trace: [] };
	const deps: FilePickerDeps = {
		theme: plainTheme,
		rows: 20,
		now: () => NOW,
		async listEntries() {
			return entries(list);
		},
		async loadPreview(relativePath) {
			return preview([`preview of ${relativePath}`, "second line"]);
		},
		onOpen(relativePath) {
			calls.open.push(relativePath);
			calls.trace.push(`open:${relativePath}`);
		},
		onInsert(relativePaths) {
			calls.insert.push(relativePaths);
			calls.trace.push(`insert:${relativePaths.join(",")}`);
		},
		onClose() {
			calls.close += 1;
			calls.trace.push("close");
		},
		requestRender() {
			calls.render += 1;
		},
		...overrides,
	};
	return { view: new FilePickerView(deps), calls };
}

async function openView(overrides: Partial<FilePickerDeps> = {}, list: FileEntry[] = FILES): Promise<{ view: FilePickerView; calls: Calls }> {
	const created = createView(overrides, list);
	created.view.render(120);
	await settle();
	created.view.render(120);
	return created;
}

function bodyText(lines: readonly string[]): string {
	return lines.map((line) => stripAnsi(line)).join("\n");
}

function selectedRow(lines: readonly string[]): string {
	const row = lines.map((line) => stripAnsi(line)).find((line) => line.includes("▸"));
	assert.ok(row, "a selected row must be painted");
	return row;
}

function rowOf(lines: readonly string[], text: string): number {
	const y = lines.findIndex((line) => stripAnsi(line).includes(text));
	assert.ok(y >= 0, `missing ${JSON.stringify(text)} in rendered frame`);
	return y;
}

/** The left pane cell of the list row showing `text`, without the card border. */
function listCell(lines: readonly string[], text: string): string {
	const row = stripAnsi(lines[listRowOf(lines, text)] ?? "");
	const cell = row.split(" │ ")[0] ?? "";
	return cell.replace(/^│ /, "");
}

/** The same list cell with its escape sequences intact, for tone assertions. */
function rawListCell(lines: readonly string[], text: string): string {
	const row = lines[listRowOf(lines, text)] ?? "";
	return (row.split(" │ ")[0] ?? "").replace(/^│ /, "");
}

/**
 * The painted width of the list pane: the columns between the card border and
 * the ` │ ` pane separator. It is measured from the frame, so it is the same
 * geometry a click is routed through.
 */
function listPaneWidth(lines: readonly string[]): number {
	return stripAnsi(lines[BODY_TOP] ?? "").indexOf(" │ ") - 2;
}

function mouse(lines: readonly string[], x: number, y: number, type: MouseEvent["type"] = "click", button: MouseEvent["button"] = "left", wheelDelta?: number, width = visibleWidth(lines[0] ?? "")): MouseEvent {
	const height = lines.length;
	return { type, button, x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

/** The first column of the preview pane, measured from the painted frame. */
function previewPaneStart(lines: readonly string[]): number {
	return stripAnsi(lines[BODY_TOP] ?? "").indexOf(" │ ") + 3;
}

/** The preview pane's painted width, the preview box's own outer columns included. */
function previewPaneWidth(lines: readonly string[]): number {
	return visibleWidth(lines[0] ?? "") - 2 - previewPaneStart(lines);
}

/** The preview pane's cells at `offset` body rows, box borders included, escapes intact. */
function rawPreviewPane(lines: readonly string[], offset: number): string {
	return sliceByColumn(lines[PREVIEW_TOP + offset] ?? "", previewPaneStart(lines), previewPaneWidth(lines));
}

/** The same cells without their escape sequences. */
function previewPane(lines: readonly string[], offset: number): string {
	return stripAnsi(rawPreviewPane(lines, offset));
}

/** True when the preview paints inside its own rounded box (S38). */
function previewPaintsBox(lines: readonly string[]): boolean {
	return previewPane(lines, BOX_TOP_ROW - PREVIEW_TOP).startsWith("╭");
}

/**
 * The preview's own content rows: what the scroll keys and the wheel can move
 * through. The box's top border rides the info row and its bottom border the
 * list's last row, so a boxed preview keeps one content row fewer than the list
 * paints body rows; the unbordered fallback spends one row on the position
 * indicator and keeps every body row for content (S47).
 */
function previewRowCount(lines: readonly string[]): number {
	const bodyRows = lines.length - 7;
	return Math.max(0, previewPaintsBox(lines) ? bodyRows - 1 : bodyRows);
}

/** The box's interior at `offset` content rows, escapes intact; 0 is the first content row. */
function rawPreviewCell(lines: readonly string[], offset: number): string {
	return sliceByColumn(rawPreviewPane(lines, offset + BOX_TOP_ROW - PREVIEW_TOP + 1), 1, Math.max(0, previewPaneWidth(lines) - 2));
}

/** The box's interior at `offset` content rows; 0 is the first content row. */
function previewCell(lines: readonly string[], offset: number): string {
	return stripAnsi(rawPreviewCell(lines, offset));
}

/** The first content row, under the box's top border. */
function previewTop(lines: readonly string[]): string {
	return previewCell(lines, 0);
}

/**
 * The `line/total` indicator itself, wherever the frame paints it: inside the
 * box's top border when there is one, on the pane's own first row when the body
 * is too short to box the preview.
 */
function positionCell(lines: readonly string[]): string {
	const pane = previewPane(lines, BOX_TOP_ROW - PREVIEW_TOP);
	return (previewPaintsBox(lines) ? pane.replace(/^╭─*/, "").replace(/╮$/, "") : pane).trim();
}

/**
 * The info row's list cell: `listed/total (selected)`, the rule that fills the
 * rest and the active order at the list pane's right edge (S43).
 */
function infoCell(lines: readonly string[]): string {
	const cell = (stripAnsi(lines[INFO_ROW] ?? "").split(" │ ")[0] ?? "").replace(/^│ /, "");
	return cell.trimEnd();
}

/** The search row's list cell, which the preview's box now starts beside (S47). */
function searchCell(lines: readonly string[]): string {
	const cell = (stripAnsi(lines[SEARCH_ROW] ?? "").split(" │ ")[0] ?? "").replace(/^│ /, "");
	return cell.trimEnd();
}

/** The row that closes the body: a rule under the list and the preview's own last row (S47). */
function ruleRow(lines: readonly string[]): string {
	return stripAnsi(lines[lines.length - 3] ?? "").replace(/^│ /, "").replace(/ │$/, "");
}

/** The body rows the list pane is given, which the card's own height decides. */
function bodyRowsOf(lines: readonly string[]): number {
	return lines.length - 7;
}

/**
 * The basenames the list pane paints, top to bottom. Group rows carry no
 * basename, so the painted rows are the whole file order the user sees.
 */
function paintedList(lines: readonly string[], names: readonly string[]): string[] {
	const painted: string[] = [];
	for (let index = BODY_TOP; index <= lines.length - 4; index += 1) {
		const cell = stripAnsi(lines[index] ?? "").split(" │ ")[0] ?? "";
		const name = names.find((candidate) => cell.includes(candidate));
		if (name !== undefined && !painted.includes(name)) painted.push(name);
	}
	return painted;
}

/**
 * The frame row whose list pane paints `text`, so a search never matches the
 * preview's own copy of a path.
 */
function listRowOf(lines: readonly string[], text: string): number {
	for (let index = BODY_TOP; index <= lines.length - 4; index += 1) {
		const cell = stripAnsi(lines[index] ?? "").split(" │ ")[0] ?? "";
		if (cell.includes(text)) return index;
	}
	assert.fail(`missing ${JSON.stringify(text)} in the list pane`);
}

/**
 * The list pane as the tree it paints (S35): each row's indent level and the
 * label it starts with, the marker column and the trailing badge and age left
 * out. Padding rows are skipped.
 */
function listTree(lines: readonly string[]): { depth: number; label: string }[] {
	const rows: { depth: number; label: string }[] = [];
	for (let index = BODY_TOP; index <= lines.length - 4; index += 1) {
		const cell = (stripAnsi(lines[index] ?? "").split(" │ ")[0] ?? "").replace(/^│ /, "");
		const text = cell.slice(MARKER_COLUMN);
		if (text.trim().length === 0) continue;
		const indent = text.length - text.trimStart().length;
		rows.push({ depth: indent / GROUP_INDENT, label: (text.trimStart().split("  ")[0] ?? "").trimEnd() });
	}
	return rows;
}

function footerText(lines: readonly string[]): string {
	return stripAnsi(lines[lines.length - 2] ?? "").replace(/^│ /, "").replace(/ +│$/, "");
}

/** The column where a list row's name starts, i.e. the marker column width. */
function labelColumn(lines: readonly string[], text: string): number {
	return listCell(lines, text).indexOf(text);
}

test("the card frame is exact at two widths, with the title, esc hint and key footer", async () => {
	const { view } = await openView();
	for (const width of [120, 80]) {
		const lines = view.render(width);
		for (const line of lines) assert.equal(visibleWidth(line), width, `every painted line must be exactly ${width} columns`);
		assert.match(stripAnsi(lines[0]!), /^╭─+╮$/);
		assert.match(stripAnsi(lines[lines.length - 1]!), /^╰─+╯$/);
	}
	const wide = view.render(120).map((line) => stripAnsi(line));
	assert.match(wide[1]!, /^│ File picker +esc +│$/, "the header carries the title on the left and esc on the right");
});

test("the footer is exactly one option per action and never advertises the functional alternates", async () => {
	const { view } = await openView();
	const roomy = footerText(view.render(200));
	assert.equal(roomy, FOOTER_TEXT, "the footer is the whole key list, one option per action");
	assert.doesNotMatch(roomy, /ctrl\+shift/, "the Linux fallback scrolls but is not advertised");
	assert.doesNotMatch(roomy, /esc\/ctrl\+c/, "ctrl+c closes but is not advertised");
	assert.doesNotMatch(roomy, /type to search/, "the search row replaced the old hint");

	const narrow = view.render(80);
	const footer = footerText(narrow);
	assert.ok(footer.endsWith("…"), `a narrow footer is truncated instead of wrapping: ${footer}`);
	assert.ok(FOOTER_TEXT.startsWith(footer.slice(0, -1)), "the truncated footer is a prefix of the same line");
	assert.equal(narrow.length, view.render(120).length, "the truncated footer never adds a row");
	for (const line of narrow) assert.equal(visibleWidth(line), 80);
});

test("the card grows with the terminal, never exceeds the rows it is given, and keeps the footer at the smallest height", async () => {
	let previous = 0;
	for (const rows of [20, 40, 60]) {
		const { view } = await openView({ rows });
		const lines = view.render(120);
		for (const line of lines) assert.equal(visibleWidth(line), 120, `no line is ragged at ${rows} rows`);
		assert.ok(lines.length > previous, `the card grows with ${rows} rows`);
		assert.ok(lines.length <= rows, `the card never exceeds the ${rows} rows it is given`);
		assert.match(stripAnsi(lines[1]!), /^│ File picker .*esc +│$/, "the header is painted");
		assert.equal(searchCell(lines), "› Search", "the search row is painted in the list column");
		assert.ok(stripAnsi(lines[BODY_TOP]!).includes("README.md"), "the list is painted");
		assert.ok(footerText(lines).startsWith("↑/↓ move"), "the footer is painted");
		previous = lines.length;
	}

	const { view } = await openView({ rows: 9 });
	const smallest = view.render(120);
	assert.equal(smallest.length, 9, "the smallest supported card fills the rows it is given");
	for (const line of smallest) assert.equal(visibleWidth(line), 120);
	assert.match(stripAnsi(smallest[1]!), /File picker/);
	assert.equal(searchCell(smallest), "› Search");
	assert.ok(footerText(smallest).startsWith("↑/↓ move"), "the footer survives the smallest card");
});

test("the title row paints the listing path next to the title and leaves esc alone in the far corner", async () => {
	const { view } = await openView({ root: ROOT });
	const line = view.render(120)[1]!;
	assert.equal(visibleWidth(line), 120);
	const header = stripAnsi(line);
	assert.ok(header.startsWith(`│ File picker  ${ROOT} `), `the path follows the title after one two-space gap: ${header}`);
	assert.ok(header.trimEnd().endsWith(" esc │"), "esc keeps the far-right corner to itself");
	assert.doesNotMatch(header, new RegExp(`${ROOT.replace(/[/-]/g, "\\$&")} esc`), "the path no longer sits beside esc");

	const plain = await openView();
	assert.match(stripAnsi(plain.view.render(120)[1]!), /^│ File picker +esc +│$/, "no path leaves the header unchanged");
});

test("a narrow title row elides the path from the left and keeps the title and esc legible", async () => {
	const { view } = await openView({ root: ROOT });
	const roomy = stripAnsi(view.render(80)[1]!);
	assert.ok(roomy.includes(ROOT), "the whole path still fits at 80 columns");
	assert.ok(roomy.trimEnd().endsWith("esc │"), "the close hint stays at the right edge");
	for (const width of [60, 40]) {
		const line = view.render(width)[1]!;
		assert.equal(visibleWidth(line), width, `the header is exactly ${width} columns`);
		const header = stripAnsi(line);
		assert.ok(header.startsWith("│ File picker "), "the title keeps its place");
		assert.ok(header.includes("…"), "the path is elided instead of overflowing");
		assert.ok(!header.includes("/home/dev"), "only the identifying tail of the path is kept");
		assert.ok(header.includes(ROOT.slice(-10)), "the tail — the part that identifies the scope — survives");
		assert.ok(header.trimEnd().endsWith("esc │"), "the close hint stays at the right edge");
	}

	const tiny = view.render(24);
	assert.equal(visibleWidth(tiny[1]!), 24);
	assert.match(stripAnsi(tiny[1]!), /^│ File picker +esc +│$/, "too narrow a card drops the path, never the title or esc");
});

test("the info row reports the files listed against the whole listing and the Tab selection, with the order at its right edge", async () => {
	const { view } = await openView({}, [entry("a.ts"), entry("b.ts"), entry("c.ts")]);
	let lines = view.render(120);
	assert.match(infoCell(lines), /^3\/3 \(0\) ─+ modified$/, "the counts, the rule that fills the row and the order at its right edge");
	assert.match(stripAnsi(lines[INFO_ROW]!), /^│ 3\/3 \(0\) ─+ modified │ /, "the rule separates the counts from the order");
	assert.ok(stripAnsi(lines[BODY_TOP]!).includes("a.ts"), "the list starts under the info row");
	view.handleInput(TAB);
	lines = view.render(120);
	assert.match(infoCell(lines), /^3\/3 \(1\) ─+ modified$/, "Tab updates the selection count immediately");
	view.handleInput("\x1b[B");
	view.handleInput(TAB);
	lines = view.render(120);
	assert.match(infoCell(lines), /^3\/3 \(2\) ─+ modified$/, "a second Tab counts too");
	for (const character of "b") view.handleInput(character);
	lines = view.render(120);
	assert.match(infoCell(lines), /^1\/3 \(2\) ─+ modified$/, "filtering repaints the listed count against the whole listing, and the selection count never lies about the whole selection");
});

test("the info row takes the list pane's width, right-aligns the order at its edge and never names the retired path order", async () => {
	const { view } = await openView({}, [entry("a.ts"), entry("b.ts")]);
	const lines = view.render(120);
	const listWidth = listPaneWidth(lines);
	const row = stripAnsi(lines[INFO_ROW]!);
	// The card's own content is wider than the list pane: the info row stops at
	// the pane separator instead of running under the preview (S47).
	assert.ok(listWidth < visibleWidth(lines[0]!) - 4, "the list pane is narrower than the card's content");
	const infoEnd = 2 + listWidth;
	assert.equal(row.slice(infoEnd - "modified".length, infoEnd), "modified", "the active order ends at the list pane's right edge");
	assert.equal(row.slice(2, 2 + "2/2 (0)".length), "2/2 (0)", "the counts start at the pane's left edge");
	assert.equal(row.slice(2 + "2/2 (0)".length, 2 + "2/2 (0)".length + 1), " ", "one space separates the counts from the rule");
	assert.equal(row.slice(infoEnd - "modified".length - 1, infoEnd - "modified".length), " ", "one space separates the rule from the order");
	for (const character of "a.ts") view.handleInput(character);
	const filtered = view.render(120);
	assert.equal(stripAnsi(filtered[INFO_ROW]!).slice(2, 2 + "1/2 (0)".length), "1/2 (0)", "the counts compare what the query lists with the whole listing");
	assert.doesNotMatch(infoCell(filtered), /path/, "the retired order name never paints");
});

test("the info row keeps the card geometry at a narrow width and at the smallest height", async () => {
	const { view } = await openView({}, [entry("a.ts")]);
	const narrow = view.render(40);
	assert.equal(visibleWidth(narrow[INFO_ROW]!), 40);
	assert.match(infoCell(narrow), /^1\/1 \(0\)/, "the counts survive a narrow list pane");
	assert.equal(narrow.length, view.render(120).length, "the info row never adds a row");

	const small = (await openView({ rows: 9 }, [entry("a.ts")])).view.render(120);
	assert.equal(small.length, 9);
	assert.match(infoCell(small), /^1\/1 \(0\) ─+ modified$/, "the info row survives the smallest card");
	assert.ok(footerText(small).startsWith("↑/↓ move"));
	for (const line of small) assert.equal(visibleWidth(line), 120);
});

test("the info row paints nothing while the listing is unloaded or failed", async () => {
	let resolveList: (result: RepositoryEntriesResult) => void = () => {};
	const pending = createView({ listEntries: () => new Promise<RepositoryEntriesResult>((resolve) => { resolveList = resolve; }) });
	const loading = pending.view.render(120);
	assert.equal(infoCell(loading), "", "a pending listing counts nothing");
	assert.match(stripAnsi(loading[INFO_ROW]!).split(" │ ")[0]!.replace(/^│ /, ""), /^ +$/, "the row stays blank, never a claimed zero");
	resolveList({ ok: false, message: "Cannot list repository files: not a repository." });
	await settle();
	const failed = pending.view.render(120);
	assert.equal(infoCell(failed), "", "a failed listing counts nothing either");
	assert.ok(bodyText(failed).includes("Cannot list repository files: not a repository."));
});

test("the search row sits directly under the title, the info row under it, and the list under both", async () => {
	const { view } = await openView({}, [entry("app.ts"), entry("src/app-store.ts")]);
	let lines = view.render(120);
	assert.match(stripAnsi(lines[1]!), /^│ File picker +esc +│$/, "the title row stays on top");
	assert.equal(searchCell(lines), "› Search", "the empty search row shows the placeholder");
	assert.match(infoCell(lines), /^2\/2 \(0\) .* modified$/, "the info row follows the search row");
	assert.ok(stripAnsi(lines[BODY_TOP]!).includes("app.ts"), "the list starts under the info row");
	for (const character of "app") view.handleInput(character);
	lines = view.render(120);
	assert.equal(searchCell(lines), "› app", "the search row shows exactly what was typed");
	assert.doesNotMatch(searchCell(lines), /Search/, "the placeholder gives way to the query");
});

test("the search row paints its prompt and placeholder from the theme roles", async () => {
	const empty = await openView({ theme: taggedTheme });
	assert.match(stripAnsi(empty.view.render(120)[SEARCH_ROW]!), /<muted>› Search<\/muted>/);
	const typed = await openView({ theme: taggedTheme }, [entry("app.ts")]);
	typed.view.handleInput("a");
	assert.match(stripAnsi(typed.view.render(120)[SEARCH_ROW]!), /<muted>›<\/muted> a/);
});

test("the body is two panes split by one vertical rule, with the list and preview content", async () => {
	const { view } = await openView();
	const lines = view.render(120).map((line) => stripAnsi(line));
	const row = lines.find((line) => line.includes("README.md"));
	assert.ok(row, "the list shows the repository-relative path");
	assert.match(row!, /^│ .*README\.md.* │ .*╮?.*│$/, "the separator sits between the list and its preview");
	assert.equal((row!.match(/│/g) ?? []).length, 5, "a body row has the card borders, the pane separator and the preview box's two border columns");
	const contentRow = lines.find((line) => line.includes("1 preview of README.md"));
	assert.ok(contentRow, "the preview paints its first line beside the list");
	assert.equal((contentRow!.match(/│/g) ?? []).length, 5, "a content row has the card borders, the pane separator and the preview box's two border columns");
	assert.match(contentRow!, / │ │1 preview of README\.md/, "the preview's first line is numbered and boxed");
});

test("the list pane takes 45% of the card content with a 64-column cap at a narrow, a middle and a wide terminal, and a click still lands on the row it looks like", async () => {
	const { view } = await openView({}, [entry("a.ts"), entry("b.ts"), entry("c.ts")]);
	// The card's content is width - CARD_PADDING; the list takes 45% of it and
	// the preview keeps the rest (S36). Below the cap the card's own width and
	// height never change.
	for (const [width, expected] of [[72, 30], [120, 52], [200, 64]] as const) {
		const lines = view.render(width);
		for (const line of lines) assert.equal(visibleWidth(line), width, `no row is ragged at ${width} columns`);
		assert.equal(listPaneWidth(lines), expected, `at ${width} columns the list pane takes its 45% share, capped at 64`);
		const previewStart = stripAnsi(lines[BODY_TOP] ?? "").indexOf(" │ ") + 3;
		assert.equal(width - 2 - previewStart, width - 4 - expected - 3, "the preview keeps the rest of the content width");
	}

	// Painting and hit-testing share paneLayout: the last column of the wider
	// list pane is still a list column, and it selects the row painted under it (S6).
	let lines = view.render(120);
	const lastListColumn = 2 + listPaneWidth(lines) - 1;
	const target = rowOf(lines, "b.ts");
	assert.deepEqual(view.handleMouse(mouse(lines, lastListColumn, target)), { handled: true, render: true }, "a click in the pane's last column is a list click");
	lines = view.render(120);
	assert.equal(rowOf(lines, "▸"), target, "the selection lands on the row that was under the pointer");
	assert.match(selectedRow(lines), /b\.ts/);

	lines = view.render(200);
	const wideLastColumn = 2 + listPaneWidth(lines) - 1;
	const wideTarget = rowOf(lines, "c.ts");
	assert.deepEqual(view.handleMouse(mouse(lines, wideLastColumn, wideTarget)), { handled: true, render: true }, "the 64-column cap keeps its last column clickable");
	lines = view.render(200);
	assert.match(selectedRow(lines), /c\.ts/);
	assert.equal(rowOf(lines, "▸"), wideTarget);
});

test("typing narrows the list without navigating or firing an action, and resets the selection to the first match", async () => {
	const { view, calls } = await openView({}, [entry("alpha.ts"), entry("alpine.ts"), entry("src/beta.ts")]);
	view.handleInput("\x1b[B");
	assert.match(selectedRow(view.render(120)), /alpine\.ts/);
	for (const character of "al") view.handleInput(character);
	const lines = view.render(120);
	const body = bodyText(lines);
	assert.ok(body.includes("alpha.ts"));
	assert.ok(body.includes("alpine.ts"));
	assert.ok(!body.includes("beta.ts"), "non-matching files disappear immediately");
	assert.match(selectedRow(lines), /alpha\.ts/, "filtering resets the selection to the first match");
	assert.deepEqual(calls.insert, []);
	assert.deepEqual(calls.open, []);
	assert.equal(calls.close, 0, "typing never closes the panel");
});

test("a query matching nothing shows an explicit empty-state line instead of a blank card", async () => {
	const { view } = await openView();
	for (const character of "zzz") view.handleInput(character);
	const lines = view.render(120);
	const body = bodyText(lines);
	assert.ok(body.includes('No files match "zzz"'));
	assert.ok(lines.length > 2, "the card still has chrome");
});

test("backspace edits the query, ctrl+u clears it, and a multi-character paste never lands in the query", async () => {
	const { view } = await openView();
	for (const character of "app") view.handleInput(character);
	assert.ok(bodyText(view.render(120)).includes("app.ts"));
	view.handleInput("x");
	assert.ok(bodyText(view.render(120)).includes('No files match "appx"'));
	view.handleInput("\x7f");
	assert.ok(bodyText(view.render(120)).includes("app.ts"), "backspace edits one character");
	view.handleInput("\x15");
	assert.ok(bodyText(view.render(120)).includes("README.md"), "ctrl+u clears the query");
	view.handleInput("app");
	assert.ok(bodyText(view.render(120)).includes("README.md"), "a multi-character paste is not a keystroke");
	view.handleInput("\x7f");
	assert.ok(bodyText(view.render(120)).includes("README.md"), "backspace on an empty query is a no-op");
});

test("ctrl+u restores the whole listing and keeps the Tab selection", async () => {
	const { view } = await openView({}, [entry("app.ts"), entry("README.md")]);
	view.handleInput(TAB);
	assert.match(selectedRow(view.render(120)), new RegExp(SELECTION_BAR), "the highlighted row is now selected");
	for (const character of "app") view.handleInput(character);
	assert.ok(!bodyText(view.render(120)).includes("README.md"), "the query filters the list");
	view.handleInput("\x15");
	const lines = view.render(120);
	assert.ok(bodyText(lines).includes("README.md"), "ctrl+u clears the query");
	assert.match(stripAnsi(lines[listRowOf(lines, "app.ts")]!), new RegExp(SELECTION_BAR), "clearing the query keeps the selection");
});

test("a failed listing shows its message and an empty repository shows an explicit line", async () => {
	const failed = await openView({ listEntries: async () => ({ ok: false, message: "Cannot list repository files: not a repository." }) });
	const failedBody = bodyText(failed.view.render(120));
	assert.ok(failedBody.includes("Cannot list repository files: not a repository."));
	assert.ok(!failedBody.includes("Loading files"));

	const empty = await openView({ listEntries: async () => entries([]) });
	const emptyBody = bodyText(empty.view.render(120));
	assert.ok(emptyBody.includes("No files in this repository."));
});

test("the arrows move the selection and clamp at both ends", async () => {
	const { view, calls } = await openView({}, [entry("a.ts"), entry("b.ts"), entry("c.ts")]);
	const selected = () => selectedRow(view.render(120));
	assert.match(selected(), /a\.ts/);
	view.handleInput("\x1b[B");
	assert.match(selected(), /b\.ts/);
	view.handleInput("\x1b[A");
	assert.match(selected(), /a\.ts/);
	view.handleInput("\x1b[A");
	assert.match(selected(), /a\.ts/, "the selection clamps at the top");
	for (let index = 0; index < 6; index += 1) view.handleInput("\x1b[B");
	assert.match(selected(), /c\.ts/, "the selection clamps at the bottom");
	assert.deepEqual(calls.insert, []);
	assert.equal(calls.close, 0);
});

test("ctrl+j/k and ctrl+shift+j/k all scroll the preview without moving the selection; a line feed scrolls instead of inserting", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const { view, calls } = await openView({ rows: 16, loadPreview: async () => preview(long) }, [entry("a.ts"), entry("b.ts")]);
	assert.match(selectedRow(view.render(120)), /a\.ts/);
	assert.match(previewTop(view.render(120)), /line 0/);
	view.handleInput("\n");
	assert.match(previewTop(view.render(120)), /line 1/, "a bare line feed is ctrl+j and scrolls the preview");
	assert.match(selectedRow(view.render(120)), /a\.ts/, "a line feed never moves the selection");
	view.handleInput("\x0b");
	assert.match(previewTop(view.render(120)), /line 0/, "ctrl+k scrolls back up");
	view.handleInput(CTRL_SHIFT_J);
	assert.match(previewTop(view.render(120)), /line 1/, "ctrl+shift+j is the same scroll action");
	view.handleInput(CTRL_SHIFT_K);
	assert.match(previewTop(view.render(120)), /line 0/, "ctrl+shift+k is the same scroll action");
	view.handleInput("\x1b[B");
	assert.match(selectedRow(view.render(120)), /b\.ts/, "the arrows still move the selection");
	await settle();
	assert.match(previewTop(view.render(120)), /line 0/, "moving the selection resets the preview");
	assert.deepEqual(calls.insert, [], "no scroll key inserts");
	assert.equal(calls.close, 0);
});

test("a long selection window keeps the selected row visible with the more indicators", async () => {
	const files = Array.from({ length: 30 }, (_, index) => entry(`file-${String(index).padStart(2, "0")}.ts`));
	const { view } = await openView({ rows: 20 }, files);
	for (let index = 0; index < 20; index += 1) view.handleInput("\x1b[B");
	const lines = view.render(120);
	const body = bodyText(lines);
	assert.match(selectedRow(lines), /file-20\.ts/);
	assert.match(body, /↑ \d+ more/);
	assert.match(body, /↓ \d+ more/);
	for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("ctrl+shift+j/k and pageUp/pageDown scroll the preview and clamp to its content", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const { view } = await openView({ rows: 16, loadPreview: async () => preview(long) });
	assert.match(previewTop(view.render(120)), /line 0/);
	for (let index = 0; index < 3; index += 1) view.handleInput(CTRL_SHIFT_J);
	assert.match(previewTop(view.render(120)), /line 3/);
	view.handleInput(CTRL_SHIFT_K);
	assert.match(previewTop(view.render(120)), /line 2/);
	view.handleInput(PAGE_DOWN);
	assert.match(previewTop(view.render(120)), /line 7/, "a page moves one preview height");
	view.handleInput(PAGE_UP);
	assert.match(previewTop(view.render(120)), /line 2/);
	for (let index = 0; index < 100; index += 1) view.handleInput(CTRL_SHIFT_K);
	assert.match(previewTop(view.render(120)), /line 0/, "scrolling clamps at the top");
	for (let index = 0; index < 100; index += 1) view.handleInput(CTRL_SHIFT_J);
	const clamped = view.render(120);
	assert.match(previewTop(clamped), /line 55/, "scrolling clamps at the last full page");
	assert.ok(bodyText(clamped).includes("line 59"));
	const settled = view.render(120).join("\n");
	view.handleInput(CTRL_SHIFT_J);
	assert.equal(view.render(120).join("\n"), settled, "a clamp does not repaint");
});

test("the wheel over the list moves the selection and the wheel over the preview scrolls it; the list wheel never scrolls the preview", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const { view } = await openView({ rows: 16, loadPreview: async () => preview(long) });
	let lines = view.render(120);
	assert.match(previewTop(lines), /line 0/);
	for (let index = 0; index < 5; index += 1) view.handleInput(CTRL_SHIFT_J);
	lines = view.render(120);
	assert.match(previewTop(lines), /line 5/);

	const listWheel = view.handleMouse(mouse(lines, 3, rowOf(lines, "README.md"), "wheel", "none", 1));
	assert.deepEqual(listWheel, { handled: true, render: true });
	await settle();
	lines = view.render(120);
	assert.match(selectedRow(lines), /app\.ts/, "the list wheel moves the selection");
	assert.match(previewTop(lines), /line 0/, "the list wheel never scrolls the preview");

	const previewX = visibleWidth(lines[0]!) - 4;
	const previewWheel = view.handleMouse(mouse(lines, previewX, BODY_TOP, "wheel", "none", 1));
	assert.deepEqual(previewWheel, { handled: true, render: true });
	lines = view.render(120);
	assert.match(previewTop(lines), /line 1/, "the preview wheel scrolls the preview");
	assert.match(selectedRow(lines), /app\.ts/, "the preview wheel never moves the selection");

	for (let index = 0; index < 100; index += 1) view.handleMouse(mouse(lines, previewX, BODY_TOP, "wheel", "none", 1));
	lines = view.render(120);
	assert.match(previewTop(lines), /line 55/);
	assert.deepEqual(view.handleMouse(mouse(lines, previewX, BODY_TOP, "wheel", "none", 1)), { handled: true, render: false }, "the preview wheel clamps at the end");
});

test("hover paints the shared hover role over an unselected row and clears when the pointer leaves", async () => {
	const { view } = await openView({ theme: taggedTheme });
	let lines = view.render(120);
	const target = rowOf(lines, "app.ts");
	const selected = rowOf(lines, "README.md");
	assert.equal(view.handleMouse(mouse(lines, 3, target, "move", "none", undefined, 120))?.render, true);
	lines = view.render(120);
	assert.match(lines[target]!, /<warning>/, "the hovered row is visible");
	assert.doesNotMatch(lines[selected]!, /<warning>/, "the selected row keeps its own role");
	assert.equal(view.handleMouse(mouse(lines, 3, 1, "move", "none", undefined, 120))?.render, true);
	assert.doesNotMatch(view.render(120).join("\n"), /<warning>/, "leaving the rows clears hover");
});

test("a click on a row selects it without inserting or closing", async () => {
	const { view, calls } = await openView({}, [entry("a.ts"), entry("b.ts"), entry("c.ts")]);
	let lines = view.render(120);
	const result = view.handleMouse(mouse(lines, 3, rowOf(lines, "b.ts")));
	assert.deepEqual(result, { handled: true, render: true });
	lines = view.render(120);
	assert.match(selectedRow(lines), /b\.ts/);
	assert.deepEqual(calls.insert, []);
	assert.deepEqual(calls.open, []);
	assert.equal(calls.close, 0);
	assert.deepEqual(view.handleMouse(mouse(lines, visibleWidth(lines[0]!) - 4, BODY_TOP)), { handled: true, render: false }, "a preview click is absorbed");
});

test("Enter inserts the selected path then closes exactly once", async () => {
	const { view, calls } = await openView({}, [entry("a.ts"), entry("b.ts")]);
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	assert.deepEqual(calls.insert, [["b.ts"]]);
	assert.equal(calls.close, 1);
	assert.deepEqual(calls.trace, ["insert:b.ts", "close"]);
	view.handleInput("\r");
	view.handleInput("\x05");
	view.handleInput("\x1b");
	assert.deepEqual(calls.insert, [["b.ts"]], "a completed panel cannot fire again");
	assert.equal(calls.close, 1);
	assert.deepEqual(calls.open, []);
});

// A real ANSI accent, so the painted marker can be asserted the way the
// terminal receives it (a fake tag theme would count as visible text).
const accentTheme: FilePickerTheme = {
	fg(color: string, text: string) {
		return color === "accent" ? `\x1b[35m${text}\x1b[39m` : text;
	},
};

test("Tab marks the highlighted row with an accent bar, distinct from the plain highlight", async () => {
	const list = [entry("a.ts"), entry("b.ts"), entry("c.ts")];
	const { view } = await openView({ theme: accentTheme }, list);
	view.handleInput("\x1b[B");
	let lines = view.render(120);
	assert.match(lines[rowOf(lines, "b.ts")]!, /▸/, "the highlight alone keeps the cursor marker");
	assert.doesNotMatch(bodyText(lines), /\x1b\[35m▏/, "nothing is selected before Tab");
	view.handleInput(TAB);
	lines = view.render(120);
	assert.match(lines[rowOf(lines, "b.ts")]!, /\x1b\[35m▏\x1b\[39m/, "Tab draws the selection bar in the accent role");
	assert.doesNotMatch(lines[rowOf(lines, "a.ts")]!, /▏/, "other rows stay unmarked");
	view.handleInput(TAB);
	lines = view.render(120);
	assert.doesNotMatch(bodyText(lines), /▏/, "Tab twice clears the selection");
	assert.match(lines[rowOf(lines, "b.ts")]!, /▸/, "the highlight survives the toggle");
});

test("adjacent selected rows paint the bar in one column, so the bars join into a single line", async () => {
	const list = [entry("a.ts"), entry("b.ts"), entry("c.ts")];
	const { view } = await openView({ theme: accentTheme }, list);
	view.handleInput(TAB);
	view.handleInput("\x1b[B");
	view.handleInput(TAB);
	const lines = view.render(120);
	const first = stripAnsi(lines[rowOf(lines, "a.ts")]!);
	const second = stripAnsi(lines[rowOf(lines, "b.ts")]!);
	const third = stripAnsi(lines[rowOf(lines, "c.ts")]!);
	assert.ok(first.includes(SELECTION_BAR), "the first selected row shows the bar");
	assert.ok(second.includes(SELECTION_BAR), "the adjacent selected row shows the bar");
	assert.doesNotMatch(third, /▏/, "an unselected row shows no bar");
	assert.equal(first.indexOf(SELECTION_BAR), second.indexOf(SELECTION_BAR), "both bars start in the same column");
	assert.equal(rowOf(lines, "b.ts"), rowOf(lines, "a.ts") + 1, "selected rows are painted on adjacent lines, so the bars touch");
	assert.match(second, /▸/, "the focused row keeps its own highlight next to the bar");
});

test("the marker column has one width, so Tab repaints the marked row in place in every state", async () => {
	const list = [entry("a.ts"), entry("b.ts"), entry("c.ts")];
	const bgTheme: FilePickerTheme = {
		fg(_color, text) {
			return text;
		},
		bg(_color, text) {
			return `\x1b[44m${text}\x1b[49m`;
		},
	};
	for (const theme of [plainTheme, bgTheme]) {
		const { view } = await openView({ theme }, list);
		let lines = view.render(120);
		assert.equal(labelColumn(lines, "a.ts"), 3, "the highlighted row starts its name after the marker column");
		view.handleInput("\x1b[B");
		lines = view.render(120);
		assert.equal(labelColumn(lines, "a.ts"), 3, "a plain row aligns with the highlighted one");
		assert.equal(labelColumn(lines, "b.ts"), 3);
		const before = listCell(lines, "b.ts");
		view.handleInput(TAB);
		lines = view.render(120);
		const marked = listCell(lines, "b.ts");
		assert.equal(labelColumn(lines, "b.ts"), 3, "marking never moves the row");
		assert.equal(marked.length, before.length, "the marked row keeps its width");
		assert.match(marked, new RegExp(`▸${SELECTION_BAR} b\\.ts| ${SELECTION_BAR} b\\.ts`), "the bar lands in its own column");
		assert.equal(listCell(view.render(120), "b.ts"), marked, "the next render without a key does not move it either");
		view.handleInput("\x1b[B");
		lines = view.render(120);
		assert.equal(labelColumn(lines, "b.ts"), 3, "a marked row without the cursor keeps the marker column");
	}
});

test("Tab does not type into the query and moves to a second row without losing the first mark", async () => {
	const list = [entry("a.ts"), entry("b.ts"), entry("c.ts")];
	const { view } = await openView({}, list);
	view.handleInput(TAB);
	assert.match(bodyText(view.render(120)), /c\.ts/, "Tab never becomes query text");
	view.handleInput("\x1b[B");
	view.handleInput(TAB);
	const lines = view.render(120);
	assert.match(stripAnsi(lines[rowOf(lines, "a.ts")]!), new RegExp(SELECTION_BAR), "the first mark stays");
	assert.match(stripAnsi(lines[rowOf(lines, "b.ts")]!), new RegExp(SELECTION_BAR), "the second mark lands on the moved-to row");
	view.handleInput("b");
	const filtered = view.render(120);
	assert.match(bodyText(filtered), /b\.ts/, "the query is still the only thing typing changes");
	assert.doesNotMatch(bodyText(filtered), /a\.ts/, "a filtered-out row is not painted");
});

test("Enter emits every selected path in list order and never duplicates the highlighted one", async () => {
	const list = [entry("a.ts"), entry("b.ts"), entry("c.ts"), entry("d.ts")];
	const { view, calls } = await openView({}, list);
	for (let index = 0; index < 3; index += 1) view.handleInput("\x1b[B");
	view.handleInput(TAB);
	view.handleInput("\x1b[A");
	view.handleInput("\x1b[A");
	view.handleInput(TAB);
	assert.deepEqual(calls.insert, [], "Tab never inserts");
	view.handleInput("\r");
	assert.deepEqual(calls.insert, [["b.ts", "d.ts"]], "selection order is the list order, not the marking order");
	assert.equal(calls.close, 1);
});

test("Enter includes the highlighted path when it was never selected", async () => {
	const list = [entry("a.ts"), entry("b.ts"), entry("c.ts")];
	const { view, calls } = await openView({}, list);
	view.handleInput("\x1b[B");
	view.handleInput(TAB);
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	assert.deepEqual(calls.insert, [["b.ts", "c.ts"]]);
	assert.equal(calls.close, 1);
});

test("Enter never duplicates a highlighted path that is already selected", async () => {
	const { view, calls } = await openView({}, [entry("a.ts"), entry("b.ts")]);
	view.handleInput(TAB);
	view.handleInput("\r");
	assert.deepEqual(calls.insert, [["a.ts"]]);
	assert.equal(calls.close, 1);
});

test("a selection filtered out of view is emitted after the visible ones", async () => {
	const list = [entry("alpha.ts"), entry("beta.ts"), entry("gamma.ts")];
	const { view, calls } = await openView({}, list);
	view.handleInput("\x1b[B");
	view.handleInput(TAB);
	for (const character of "al") view.handleInput(character);
	view.handleInput(TAB);
	view.handleInput("\r");
	assert.deepEqual(calls.insert, [["alpha.ts", "beta.ts"]], "the hidden selection keeps its marking order after the visible rows");
	assert.equal(calls.close, 1);
});

test("ctrl+e opens the selected path then closes exactly once", async () => {
	const { view, calls } = await openView({}, [entry("a.ts"), entry("b.ts")]);
	view.handleInput("\x1b[B");
	view.handleInput("\x05");
	assert.deepEqual(calls.open, ["b.ts"]);
	assert.equal(calls.close, 1);
	assert.deepEqual(calls.trace, ["open:b.ts", "close"]);
	assert.deepEqual(calls.insert, []);
	view.handleInput("\x05");
	assert.deepEqual(calls.open, ["b.ts"]);
	assert.equal(calls.close, 1);
});

test("esc and ctrl+c close exactly once", async () => {
	const escape = await openView();
	escape.view.handleInput("\x1b");
	assert.equal(escape.calls.close, 1);
	escape.view.handleInput("\x1b");
	assert.equal(escape.calls.close, 1);

	const ctrlC = await openView();
	ctrlC.view.handleInput("\x03");
	assert.equal(ctrlC.calls.close, 1);
});

test("a throwing paste or editor callback still closes the panel exactly once", async () => {
	const insert = await openView({ onInsert() { throw new Error("paste failed"); } }, [entry("a.ts")]);
	assert.throws(() => insert.view.handleInput("\r"), /paste failed/);
	assert.equal(insert.calls.close, 1, "onClose runs even when the paste throws");
	insert.view.handleInput("\r");
	assert.equal(insert.calls.close, 1, "a completed panel never closes twice");

	const open = await openView({ onOpen() { throw new Error("editor failed"); } }, [entry("a.ts")]);
	assert.throws(() => open.view.handleInput("\x05"), /editor failed/);
	assert.equal(open.calls.close, 1, "onClose runs even when the editor handoff throws");
	open.view.handleInput("\x05");
	assert.equal(open.calls.close, 1);
});

test("a changed row shows its state letter and the age computed once when the panel opened", async () => {
	let clock = NOW;
	const list = [
		entry("fresh.ts", "new", NOW - 5_000),
		entry("edited.ts", "updated", NOW - 3 * HOUR - 5 * MINUTE),
		entry("stale.ts", "updated", NOW - 2 * DAY - HOUR),
		entry("untouched.ts", "clean", NOW - 4 * MINUTE),
	];
	const { view } = await openView({ now: () => clock }, list);
	const first = view.render(120);
	assert.match(listCell(first, "fresh.ts"), /^▸ {2}fresh\.ts +U 5s$/, "an untracked file paints /changes' U and the age right-aligned after it");
	assert.match(listCell(first, "edited.ts"), /^ {3}edited\.ts +M 3h$/);
	assert.match(listCell(first, "stale.ts"), /^ {3}stale\.ts +M 2d$/);
	assert.match(listCell(first, "untouched.ts"), /^ {3}untouched\.ts *$/, "a clean row shows neither a letter nor an age");
	assert.doesNotMatch(bodyText(first), /\bnew\b|\bupd\b/, "the word badges are gone from the whole frame");

	clock = NOW + 30 * DAY;
	assert.match(listCell(view.render(120), "edited.ts"), /^ {3}edited\.ts +M 3h$/, "ages are never recomputed");
});

test("a changed row without an mtime shows its state letter and no age", async () => {
	const { view } = await openView({}, [entry("brand-new.ts", "new"), entry("plain.ts")]);
	const changed = listCell(view.render(120), "brand-new.ts");
	assert.match(changed, /brand-new\.ts +U$/, "an untracked file paints U, never N or new");
	assert.doesNotMatch(changed, /\b\d+[smhd]\b/, "no age without an mtime");
	assert.doesNotMatch(listCell(view.render(120), "plain.ts"), /\bnew\b|\bupd\b/, "a clean file paints neither a letter nor a word badge");
});

test("a row paints its name in the row role and its directory in dim, without moving a painted cell", async () => {
	const roleTheme: FilePickerTheme = {
		fg(color: string, text: string) {
			if (color === "text") return `\x1b[37m${text}\x1b[0m`;
			if (color === "muted") return `\x1b[90m${text}\x1b[0m`;
			if (color === "dim") return `\x1b[2m${text}\x1b[0m`;
			if (color === "accent") return `\x1b[35m${text}\x1b[0m`;
			if (color === "warning") return `\x1b[33m${text}\x1b[0m`;
			return text;
		},
	};
	const list = [entry("src/cursor.ts"), entry("src/idle.ts"), entry("README.md")];
	const { view } = await openView({ theme: roleTheme }, list);
	const plain = await openView({}, list);
	let lines = view.render(120);

	// The cursor row: the name takes the row's own role, the directory is dim.
	assert.match(rawListCell(lines, "cursor.ts"), /\x1b\[37mcursor\.ts\x1b\[0m/, "the highlighted name keeps the row's text role");
	assert.match(rawListCell(lines, "cursor.ts"), / {2}\x1b\[2msrc\x1b\[0m/, "the trailing directory paints in dim");
	// An idle row: muted name, still a dim directory.
	assert.match(rawListCell(lines, "idle.ts"), /\x1b\[90midle\.ts\x1b\[0m/, "an unselected name keeps the idle role");
	assert.match(rawListCell(lines, "idle.ts"), / {2}\x1b\[2msrc\x1b\[0m/);
	assert.doesNotMatch(rawListCell(lines, "idle.ts"), /\x1b\[90msrc\x1b\[0m/, "the directory is never painted in the name's tone");
	// A file at the repository root paints no directory at all.
	assert.equal(stripAnsi(rawListCell(lines, "README.md")).trimEnd(), "   README.md", "a root file paints its name alone");
	assert.doesNotMatch(rawListCell(lines, "README.md"), /\x1b\[2m/, "a root file has no directory to paint dim");
	// Tone only: the painted cells are exactly the ones the plain theme paints.
	for (const name of ["cursor.ts", "idle.ts", "README.md"]) assert.equal(stripAnsi(rawListCell(lines, name)), listCell(plain.view.render(120), name), `the ${name} row paints the same cells as before`);

	// A hovered row: the shared hover role on the name, the directory still dim.
	const idleRow = rowOf(lines, "idle.ts");
	assert.equal(view.handleMouse(mouse(lines, 3, idleRow, "move", "none", undefined, 120))?.render, true);
	lines = view.render(120);
	assert.match(rawListCell(lines, "idle.ts"), /\x1b\[33midle\.ts\x1b\[0m/, "hover paints the shared hover role on the name");
	assert.match(rawListCell(lines, "idle.ts"), / {2}\x1b\[2msrc\x1b\[0m/, "hover never repaints the directory");

	// A marked row: the accent the selection bar uses, the directory still dim.
	view.handleInput(TAB);
	lines = view.render(120);
	assert.match(rawListCell(lines, "cursor.ts"), /\x1b\[35mcursor\.ts\x1b\[0m/, "a marked name takes the accent role");
	assert.match(rawListCell(lines, "cursor.ts"), / {2}\x1b\[2msrc\x1b\[0m/, "a marked row's directory stays dim");
});

test("an empty query keeps the order the listing returned and a query still ranks", async () => {
	const list = [entry("z-changed.ts", "new", NOW - MINUTE), entry("m-updated.ts", "updated", NOW - 2 * MINUTE), entry("a-clean.ts")];
	const { view } = await openView({}, list);
	let lines = view.render(120);
	assert.ok(rowOf(lines, "z-changed.ts") < rowOf(lines, "m-updated.ts"));
	assert.ok(rowOf(lines, "m-updated.ts") < rowOf(lines, "a-clean.ts"), "the listing order is painted, never re-sorted alphabetically");
	for (const character of "clean") view.handleInput(character);
	lines = view.render(120);
	assert.match(selectedRow(lines), /a-clean\.ts/, "ranking still chooses the match");
	assert.doesNotMatch(bodyText(lines), /z-changed\.ts/);
});

test("a narrow list pane truncates the name and keeps the badge", async () => {
	const { view } = await openView({}, [entry("a-very-long-file-name.ts", "new", NOW - 5 * MINUTE), entry("b.ts")]);
	const lines = view.render(40);
	const changed = stripAnsi(lines[rowOf(lines, "U 5m")]!);
	assert.match(changed, /U 5m/);
	assert.ok(!changed.includes("a-very-long-file-name.ts"), "the name gives way first");
	assert.match(changed, /…/, "the name is elided");
	for (const line of lines) assert.equal(visibleWidth(line), 40, "no row is ragged");
});

test("a binary preview renders the binary notice, not its bytes", async () => {
	const { view } = await openView({ loadPreview: async () => ({ kind: "binary", message: "unused" }) });
	const body = bodyText(view.render(120));
	assert.ok(body.includes(FILE_PREVIEW_BINARY_NOTICE));
});

test("a truncated preview appends an explicit truncation notice; a whole file does not", async () => {
	const truncated = await openView({ loadPreview: async () => preview(["one", "two"], true) });
	const truncatedBody = bodyText(truncated.view.render(120));
	assert.ok(truncatedBody.includes("one"));
	assert.ok(truncatedBody.includes("two"));
	assert.match(truncatedBody, /truncated/i);

	const whole = await openView({ loadPreview: async () => preview(["one", "two"], false) });
	assert.doesNotMatch(bodyText(whole.view.render(120)), /truncated/i);
});

test("the search row keeps the list's width and the preview box rides the info row through the last list row", async () => {
	const { view } = await openView({}, [entry("a.ts"), entry("b.ts"), entry("c.ts")]);
	const lines = view.render(120);
	const bodyRows = bodyRowsOf(lines);
	const listWidth = listPaneWidth(lines);
	assert.equal(bodyRows, 10, "the card keeps its body rows");
	assert.equal(lines.length, bodyRows + 7, "the card's chrome is still the seven rows S47 fixes");

	// The search row belongs to the list column alone: its right side is filler.
	assert.equal(searchCell(lines), "› Search");
	assert.equal(previewPane(lines, 0), " ".repeat(previewPaneWidth(lines)), "the search row paints no box cell");
	assert.equal(stripAnsi(lines[SEARCH_ROW]!).slice(2 + listWidth, 2 + listWidth + 3), " │ ", "the list's search row ends at the pane separator");
	// The info row carries the counts on its left and the box's top border beside it.
	assert.match(infoCell(lines), /^3\/3 \(0\) ─+ modified$/);
	assert.match(previewPane(lines, 1), /^╭─+ \d+\/\d+╮$/, "the box's top border rides the info row, with the position at its right");
	// The bottom border lands on the list's last row, the one the more indicator
	// would sit on when the list overflows.
	assert.match(previewPane(lines, bodyRows + 1), /^╰─+╯$/, "the box's bottom border rides the last list row");
	assert.equal(BODY_TOP + bodyRows - 1, lines.length - 4, "the last list row is the row above the closing rule");
	// A list that overflows paints its `↓ n more` indicator on that same last row,
	// and the box still closes there.
	const overflow = await openView({}, Array.from({ length: 20 }, (_, index) => entry(`file-${String(index).padStart(2, "0")}.ts`)));
	for (let step = 0; step < 15; step += 1) overflow.view.handleInput("\x1b[B");
	const overflowing = overflow.view.render(120);
	const lastList = overflowing.length - 4;
	assert.match((stripAnsi(overflowing[lastList]!).split(" │ ")[0] ?? ""), /↓ \d+ more/, "the list's last row carries the more indicator when it overflows");
	assert.match(previewPane(overflowing, bodyRows + 1), /^╰─+╯$/, "the box closes on the row the list's indicator sits on");
	assert.equal(previewRowCount(lines), bodyRows - 1, "the box leaves one content row fewer than the list paints body rows");
	// One rule closes the body across the whole card content, the preview included.
	const rule = stripAnsi(lines[BODY_TOP + bodyRows]!).replace(/^│ /, "").replace(/ │$/, "");
	assert.equal(rule, "─".repeat(visibleWidth(lines[0]!) - 4), "the closing rule spans the whole card content, list and preview alike");
	for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("wheel and click geometry follow the corrected rows: the first list row is frame row 4 and the box's own rows absorb the wheel", async () => {
	const long = Array.from({ length: 40 }, (_, index) => `line ${index}`);
	const { view, calls } = await openView({ rows: 20, loadPreview: async () => preview(long) }, [entry("a.ts"), entry("b.ts")]);
	let lines = view.render(120);
	const previewX = previewPaneStart(lines) + 3;
	assert.match(previewTop(lines), /line 0/);
	// The wheel over the info row — the box's top border — scrolls the preview.
	assert.deepEqual(view.handleMouse(mouse(lines, previewX, INFO_ROW, "wheel", "none", 1)), { handled: true, render: true });
	lines = view.render(120);
	assert.match(previewTop(lines), /line 1/, "the box's top border row is part of the scrollable preview");
	// The search row's right side is filler: it is nobody's click target.
	assert.equal(view.handleMouse(mouse(lines, previewX, SEARCH_ROW)), undefined, "the search row's right column is not a preview click");
	// A click on the first list row selects the first file.
	assert.deepEqual(view.handleMouse(mouse(lines, 3, BODY_TOP)), { handled: true, render: false }, "a click on the first list row is a list click");
	await settle();
	lines = view.render(120);
	assert.match(selectedRow(lines), /a\.ts/, "the first list row is frame row 4");
	assert.deepEqual(calls.insert, []);
	assert.equal(calls.close, 0);
});

test("the smallest card still boxes the preview, with exactly one content row inside it", async () => {
	const smallest = (await openView({ rows: 9 }, [entry("a.ts")])).view.render(120);
	assert.equal(smallest.length, 9, "the smallest card fills the rows it is given");
	const bodyRows = bodyRowsOf(smallest);
	assert.equal(bodyRows, 2, "the smallest card has two body rows");
	assert.equal(previewPaintsBox(smallest), true, "the box only needs one content row between its borders");
	assert.equal(previewRowCount(smallest), 1, "one content row sits between the borders");
	assert.match(previewPane(smallest, 1), /^╭─+ \d+\/\d+╮$/, "the top border rides the info row");
	assert.match(previewPane(smallest, 3), /^╰─+╯$/, "the bottom border rides the second, last list row");
	assert.match(previewCell(smallest, 0), /^ *1 preview of a\.ts/);
	for (const line of smallest) assert.equal(visibleWidth(line), 120);
});

test("the preview gutter numbers every visible row with its real file line number, also after scrolling", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `entry ${index}`);
	const { view } = await openView({ rows: 16, loadPreview: async () => preview(long) });
	let lines = view.render(120);
	assert.match(previewTop(lines), /^ 1 entry 0 +$/, "the first content row is file line 1");
	const rows = previewRowCount(lines);
	assert.equal(rows, 5, "the box's two border rows come out of the info row and the last list row, leaving five content rows at this height");
	for (let index = 1; index < rows; index += 1) {
		assert.match(previewCell(lines, index), new RegExp(`^ ${index + 1} entry ${index} `), "every visible row carries its own line number");
	}
	for (let index = 0; index < 10; index += 1) view.handleInput(CTRL_SHIFT_J);
	lines = view.render(120);
	for (let index = 0; index < rows; index += 1) {
		assert.match(previewCell(lines, index), new RegExp(`^${11 + index} entry ${10 + index} `), "the gutter keeps the real line number after scrolling");
	}
});

test("the preview gutter and position indicator use the theme roles", async () => {
	const roleTheme: FilePickerTheme = {
		fg(color: string, text: string) {
			if (color === "dim") return `\x1b[2m${text}\x1b[0m`;
			if (color === "muted") return `\x1b[90m${text}\x1b[0m`;
			return text;
		},
	};
	const { view } = await openView({ theme: roleTheme, loadPreview: async () => preview(["alpha", "beta"]) });
	const lines = view.render(120);
	assert.match(rawPreviewPane(lines, BOX_TOP_ROW - PREVIEW_TOP), /\x1b\[90m1\/2\x1b\[0m/, "the position uses the muted role");
	assert.match(rawPreviewCell(lines, 0), /\x1b\[2m1\x1b\[0m alpha/, "the gutter number uses the dim role");
	assert.match(rawPreviewCell(lines, 1), /\x1b\[2m2\x1b\[0m beta/);
});

test("the preview shows the top visible line over the total in its top border's right end, adding + only when the reader truncated", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const whole = await openView({ rows: 12, loadPreview: async () => preview(long) });
	let lines = whole.view.render(120);
	assert.match(positionCell(lines), /^1\/60$/, "the indicator starts at line 1 of the 60 known lines, in the box's top border");
	for (let index = 0; index < 10; index += 1) whole.view.handleInput(CTRL_SHIFT_J);
	lines = whole.view.render(120);
	assert.match(positionCell(lines), /^11\/60$/, "the indicator follows the top visible line");

	const truncated = await openView({ rows: 12, loadPreview: async () => preview(long, true) });
	lines = truncated.view.render(120);
	assert.match(positionCell(lines), /^1\/60\+$/, "a truncated preview never claims the real total");
	for (let index = 0; index < 5; index += 1) truncated.view.handleInput(CTRL_SHIFT_J);
	assert.match(positionCell(truncated.view.render(120)), /^6\/60\+$/, "the + survives scrolling");

	const binary = await openView({ loadPreview: async () => ({ kind: "binary", message: "unused" }) });
	assert.doesNotMatch(previewPane(binary.view.render(120), 0), /\d+\/\d+/, "a binary preview has no line position to claim");
});

// The preview's own box (S38): rounded corners and border columns in the card's
// border tone, the position indicator embedded in the top border, and the
// gutter, the text and the wrap all inside the frame.
const BORDER_TONE = "\x1b[94m";

const boxTheme: FilePickerTheme = {
	fg(color: string, text: string) {
		if (color === "border") return `${BORDER_TONE}${text}${ROLE_END}`;
		if (color === "muted") return `${LABEL_ROLE}${text}${ROLE_END}`;
		if (color === "dim") return `${DIM_TONE}${text}${ROLE_END}`;
		return text;
	},
};

test("the preview sits in its own rounded box in the border tone, with the position in its top border", async () => {
	const { view } = await openView({ theme: boxTheme, loadPreview: async () => preview(["alpha", "beta"]) });
	const lines = view.render(120);
	for (const line of lines) assert.equal(visibleWidth(line), 120, "the box never makes a row ragged");
	const paneStart = previewPaneStart(lines);
	const paneWidth = previewPaneWidth(lines);
	const interiorWidth = paneWidth - 2;
	const bodyRows = lines.length - 7;
	assert.equal(bodyRows, 10, "the list keeps its ten body rows");
	// The box rides the info row and the list's last row (S47), so its borders
	// take one row of the body block and the search row above keeps no box cell.
	const boxTop = BOX_TOP_ROW - PREVIEW_TOP;
	const boxBottom = bodyRows + 1;
	assert.equal(boxBottom, 11);

	// The four corners land on the pane's own columns, and the card's frame is untouched.
	const top = previewPane(lines, boxTop);
	const bottom = previewPane(lines, boxBottom);
	assert.equal(top.length, paneWidth, "the top border spans exactly the preview pane");
	assert.equal(top[0], "╭", "the top-left corner sits in the pane's first column");
	assert.equal(top[paneWidth - 1], "╮", "the top-right corner closes the box at the pane's last column");
	assert.equal(bottom[0], "╰", "the bottom border starts with its own corner");
	assert.equal(bottom[paneWidth - 1], "╯");
	assert.equal(stripAnsi(lines[BODY_TOP]!).slice(paneStart - 3, paneStart), " │ ", "the pane separator sits immediately left of the box's first column");
	assert.equal(stripAnsi(lines[BODY_TOP]!)[0], "│", "the card's own left border is untouched");
	assert.equal(stripAnsi(lines[BODY_TOP]!).at(-1), "│", "the card's own right border is untouched");
	for (let offset = boxTop + 1; offset < boxBottom; offset += 1) {
		const row = previewPane(lines, offset);
		assert.equal(row[0], "│", `the left border column runs down preview row ${offset}`);
		assert.equal(row[paneWidth - 1], "│", `the right border column runs down preview row ${offset}`);
	}
	assert.equal(previewPane(lines, 0), " ".repeat(paneWidth), "the search row's right column is blank filler, never a box cell");

	// Every border cell paints in the theme's border tone.
	const dashes = interiorWidth - 1 - "1/2".length;
	const rawTop = rawPreviewPane(lines, boxTop);
	assert.ok(rawTop.includes(`${BORDER_TONE}╭`), "the top-left corner starts a border-tone run");
	assert.ok(rawTop.includes(`${BORDER_TONE}${"─".repeat(dashes)}`), "the top border's dashes are one border-tone run of the interior the indicator leaves");
	assert.ok(rawTop.includes(` ${LABEL_ROLE}1/2${ROLE_END}`), "the embedded indicator paints in the muted role inside the border");
	assert.ok(rawTop.includes(`${BORDER_TONE}╮`), "the top-right corner is a border cell too");
	assert.ok(!rawTop.includes(`${LABEL_ROLE}╭`) && !rawTop.includes(`${LABEL_ROLE}╮`), "no corner takes the label tone");
	const rawBottom = rawPreviewPane(lines, boxBottom);
	assert.ok(rawBottom.includes(`${BORDER_TONE}╰`), "the bottom-left corner is a border cell");
	assert.ok(rawBottom.includes(`${BORDER_TONE}${"─".repeat(interiorWidth)}`), "the bottom border is one continuous border-tone run");
	assert.ok(rawBottom.includes(`${BORDER_TONE}╯`), "the bottom-right corner is a border cell");
	assert.equal(rawPreviewPane(lines, boxTop + 1).split(`${BORDER_TONE}│`).length - 1, 2, "both border columns of a content row paint in the border tone");

	// The position moved out of the content and into the top border's right end.
	assert.equal(positionCell(lines), "1/2", "the position sits in the top border");
	assert.equal(top.indexOf("1/2") + "1/2".length, paneWidth - 1, "the indicator ends against the top-right corner");
	for (let offset = 0; offset < previewRowCount(lines); offset += 1) {
		assert.doesNotMatch(previewCell(lines, offset), /\d+\/\d+/, "no content row carries the position any more");
	}

	// The gutter numbers, the file's text and the wrap all live inside the box.
	assert.equal(previewCell(lines, 0).slice(0, 1), "1", "the gutter number sits in the first interior cell");
	assert.equal(previewCell(lines, 0).slice(2, 7), "alpha", "the text starts two cells in: the gutter, then its gap");
	assert.equal(previewCell(lines, 1).slice(2, 6), "beta");
	for (const offset of [0, 1]) {
		const row = previewPane(lines, offset + boxTop + 1);
		assert.ok(row.startsWith("│") && row.endsWith("│"), "every content row is framed by the box's border columns");
		assert.ok(!row.includes("╭") && !row.includes("╮"), "only the top border carries corners");
	}
});

test("the box's two border columns come out of the wrap width, for a plain line and for a coloured line", async () => {
	// 58 cells fill the pane's own text column in one row but need two once the
	// box's border columns are taken out, so the painted rows prove the width.
	const wide = "x".repeat(58);
	const variants: Partial<FilePickerDeps>[] = [
		{},
		{ languageForPath: () => "typescript", highlight: (code) => code.split("\n").map((line) => `${CODE_TONE}${line}${CODE_RESET}`) },
	];
	for (const variant of variants) {
		const { view } = await openView({ rows: 20, loadPreview: async () => preview([wide, "next"]), ...variant }, [entry("src/app.ts")]);
		const lines = view.render(120);
		assert.equal(previewPaintsBox(lines), true, "a boxed pane at this height");
		const paneWidth = previewPaneWidth(lines);
		const interiorWidth = paneWidth - 2;
		const gutterWidth = 1;
		const textWidth = interiorWidth - gutterWidth - 1;
		const first = previewCell(lines, 0);
		const continuation = previewCell(lines, 1).trimEnd();
		assert.equal(first.indexOf("x"), gutterWidth + 1, "the text starts after the gutter and its gap, inside the frame");
		assert.equal(first.trimEnd().length - first.indexOf("x"), textWidth, "a row fills exactly the box's interior text column");
		assert.ok(textWidth < paneWidth - gutterWidth - 1, "the wrap is narrower than the pane by the box's two border columns");
		assert.equal(continuation.search(/\S/), gutterWidth + 1, "the continuation row keeps the same text column");
		assert.equal(continuation.slice(gutterWidth + 1), "x".repeat(wide.length - textWidth), "the tail continues inside the box");
		assert.match(previewCell(lines, 2), /^ *2 next/, "the next file line keeps its own row");
		for (const line of lines) assert.equal(visibleWidth(line), 120, "a wrapped row of the boxed pane is never ragged");
	}
});

test("a click on the box's border or inside it is absorbed, and the wheel inside the box scrolls the preview", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const { view, calls } = await openView({ rows: 16, loadPreview: async () => preview(long) }, [entry("a.ts"), entry("b.ts")]);
	let lines = view.render(120);
	assert.equal(previewPaintsBox(lines), true);
	const paneStart = previewPaneStart(lines);
	const paneWidth = previewPaneWidth(lines);
	const bodyRows = lines.length - 7;
	const firstListRow = rowOf(lines, "a.ts");

	for (const y of [BODY_TOP, BODY_TOP + 2, BODY_TOP + bodyRows - 1]) {
		for (const x of [paneStart, paneStart + 3, paneStart + paneWidth - 1]) {
			assert.deepEqual(view.handleMouse(mouse(lines, x, y)), { handled: true, render: false }, `a click at ${x},${y} is absorbed by the preview`);
		}
	}
	const afterClicks = view.render(120);
	assert.equal(afterClicks.join("\n"), lines.join("\n"), "a box click never repaints or breaks the panel");
	assert.match(selectedRow(afterClicks), /a\.ts/, "a box click never selects a list row");
	assert.equal(rowOf(afterClicks, "▸"), firstListRow);
	assert.deepEqual(calls.insert, []);
	assert.equal(calls.close, 0);

	// A list row click still lands on the row painted under the pointer.
	const target = rowOf(lines, "b.ts");
	assert.deepEqual(view.handleMouse(mouse(lines, 3, target)), { handled: true, render: true });
	lines = view.render(120);
	assert.match(selectedRow(lines), /b\.ts/, "a list click is unaffected by the box");
	await settle();
	lines = view.render(120);
	assert.match(previewTop(lines), /line 0/, "the clicked file's preview starts at its top inside the box");

	// The wheel inside the frame scrolls the preview and moves no selection.
	assert.deepEqual(view.handleMouse(mouse(lines, paneStart + 3, BODY_TOP + 2, "wheel", "none", 1)), { handled: true, render: true });
	const scrolled = view.render(120);
	assert.match(previewTop(scrolled), /line 1/, "the wheel inside the box scrolls the preview");
	assert.match(selectedRow(scrolled), /b\.ts/, "the preview wheel never moves the selection");

	// Hover inside the box leaves every list row alone.
	assert.notEqual(view.handleMouse(mouse(scrolled, paneStart + 3, BODY_TOP + 2, "move", "none"))?.render, true, "hovering inside the box never lights a list row");
});

test("a preview pane too narrow for the box paints the unbordered fallback on the same spanned height", async () => {
	// The box needs one cell between its two border columns, so a card narrow
	// enough to leave the preview pane two cells keeps today's unbordered preview
	// instead of squeezing the content (S38). The box no longer depends on the
	// body's height: it spans the search, info, body and rule rows (S47).
	const { view } = await openView({ rows: 20, loadPreview: async () => preview(["alpha", "beta"]) });
	const lines = view.render(13);
	const bodyRows = bodyRowsOf(lines);
	assert.equal(bodyRows, 10, "the card keeps its ten body rows");
	assert.equal(previewPaintsBox(lines), false, "no box when the pane cannot hold its border columns and one cell");
	for (let offset = 0; offset < bodyRows + 3; offset += 1) {
		for (const glyph of ["╭", "╮", "╰", "╯"]) {
			assert.ok(!previewPane(lines, offset).includes(glyph), `no box glyph is painted on preview row ${offset}`);
		}
	}
	// The shape the pane painted before the box existed: the position indicator
	// on its own row at the pane's right, then the content rows under it — now
	// using the whole span the box would have taken.
	assert.match(previewPane(lines, 0), /^ +$/, "the search row keeps no preview cell at all");
	assert.match(previewPane(lines, 1), /^1…$/, "the position keeps a row of its own at the pane's right, beside the info row");
	assert.match(previewPane(lines, 2), /^1 /, "the first content row sits under the indicator, beside the first list row");
	assert.equal(previewRowCount(lines), bodyRows, "the unbordered preview fills the same rows, less the single position row");
	assert.match(selectedRow(lines), /▸/, "the list pane keeps its highlighted row");
	for (const line of lines) assert.equal(visibleWidth(line), 13);
});

test("the preview's notices paint inside the box when there is one", async () => {
	const binary = await openView({ loadPreview: async () => ({ kind: "binary", message: "unused" }) });
	const binaryLines = binary.view.render(120);
	assert.equal(previewPaintsBox(binaryLines), true);
	assert.equal(previewCell(binaryLines, 0).trim(), FILE_PREVIEW_BINARY_NOTICE, "the binary notice paints inside the box");
	assert.equal(positionCell(binaryLines), "", "a file with no lines shows no position in the top border");
	assert.match(previewPane(binaryLines, BOX_TOP_ROW - PREVIEW_TOP), /^╭─+╮$/, "the top border is a whole frame with no indicator");

	const truncated = await openView({ loadPreview: async () => preview(["one", "two"], true) });
	const truncatedLines = truncated.view.render(120);
	assert.equal(previewCell(truncatedLines, 2).trim(), "… preview truncated.", "the truncation notice paints inside the box");

	const failing = await openView({ loadPreview: async () => ({ kind: "error", message: "Cannot read a.ts (EACCES)." }) });
	assert.equal(previewCell(failing.view.render(120), 0).trim(), "Cannot read a.ts (EACCES).", "an error paints inside the box");

	let resolvePreview: (value: FilePreview) => void = () => {};
	const pending = await openView({ loadPreview: () => new Promise<FilePreview>((resolve) => { resolvePreview = resolve; }) }, [entry("a.ts")]);
	const loadingLines = pending.view.render(120);
	assert.equal(previewPaintsBox(loadingLines), true);
	assert.equal(previewCell(loadingLines, 0).trim(), "Loading preview …", "the loading notice paints inside the box");
	resolvePreview(preview(["one"]));
	await settle();

	const empty = await openView({ listEntries: async () => entries([]) });
	assert.ok(bodyText(empty.view.render(120)).includes("No files in this repository."), "an empty repository keeps its own line");
});

test("home and end jump the selection to the first and last file for every terminal encoding, and stay out of the footer", async () => {
	const list = [entry("a.ts"), entry("b.ts"), entry("c.ts")];
	const { view, calls } = await openView({}, list);
	for (const sequence of END_SEQUENCES) {
		view.handleInput("\x1b[A");
		view.handleInput(sequence);
		assert.match(selectedRow(view.render(120)), /c\.ts/, `end jumps to the last file for ${JSON.stringify(sequence)}`);
	}
	for (const sequence of HOME_SEQUENCES) {
		view.handleInput("\x1b[B");
		view.handleInput(sequence);
		assert.match(selectedRow(view.render(120)), /a\.ts/, `home jumps to the first file for ${JSON.stringify(sequence)}`);
	}
	assert.deepEqual(calls.insert, [], "the compatibility bindings never insert");
	assert.equal(calls.close, 0);
	const footer = footerText(view.render(200));
	assert.equal(footer, FOOTER_TEXT, "the footer text is unchanged");
	assert.doesNotMatch(footer, /home|end/i, "home and end are compatibility bindings and are never named");
});

test("ctrl+home and ctrl+end jump the preview to its first line and its last page for every terminal encoding", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const { view, calls } = await openView({ rows: 16, loadPreview: async () => preview(long) });
	for (const sequence of CTRL_END_SEQUENCES) {
		view.handleInput(sequence);
		const lines = view.render(120);
		assert.match(positionCell(lines), /^56\/60$/, `ctrl+end shows the last page for ${JSON.stringify(sequence)}`);
		assert.match(previewCell(lines, previewRowCount(lines) - 1), /60 line 59/, "the end of the file is on screen");
		view.handleInput(CTRL_HOME_SEQUENCES[0]!);
	}
	for (const sequence of CTRL_HOME_SEQUENCES) {
		view.handleInput(CTRL_END_SEQUENCES[0]!);
		view.handleInput(sequence);
		const lines = view.render(120);
		assert.match(positionCell(lines), /^1\/60$/, `ctrl+home shows the first line for ${JSON.stringify(sequence)}`);
		assert.match(previewCell(lines, 0), /1 line 0/, "the top of the file is on screen");
	}
	assert.match(selectedRow(view.render(120)), /README\.md/, "the preview jumps never move the selection");
	assert.deepEqual(calls.insert, []);
	assert.equal(calls.close, 0);
});

test("the esc hint and every footer key token paint in the theme key colour, with the labels in the neutral tone", async () => {
	const roleTheme: FilePickerTheme = {
		fg(color: string, text: string) {
			if (color === "accent") return `${KEY_ROLE}${text}${ROLE_END}`;
			if (color === "muted") return `${LABEL_ROLE}${text}${ROLE_END}`;
			return text;
		},
	};
	const keys = ["↑/↓", "ctrl+j/k", "tab", "ctrl+o", "ctrl+u", "enter", "ctrl+e", "esc"];
	const labels = ["move", "scroll", "select", "order", "clear", "insert", "editor", "close"];
	const { view } = await openView({ theme: roleTheme });
	const lines = view.render(200);
	assert.ok(lines[1]!.includes(`${KEY_ROLE}esc${ROLE_END}`), "the title row's esc hint uses the key role");
	const footer = lines[lines.length - 2]!;
	for (const key of keys) {
		assert.ok(footer.includes(`${KEY_ROLE}${key}${ROLE_END}`), `the ${key} token is painted in the key role`);
		assert.ok(!footer.includes(`${LABEL_ROLE}${key}`), `the ${key} token is not painted in the label role`);
	}
	for (const label of labels) {
		assert.ok(footer.includes(`${LABEL_ROLE}${label}${ROLE_END}`), `the ${label} label keeps the neutral tone`);
		assert.ok(!footer.includes(`${KEY_ROLE}${label}`), `the ${label} label is not painted in the key role`);
	}
	assert.equal(footerText(lines), FOOTER_TEXT, "the painted footer still reads as the same key list");
	for (const line of lines) assert.equal(visibleWidth(line), 200);

	const narrow = view.render(80);
	assert.ok(footerText(narrow).endsWith("…"), "the painted footer still truncates on one row");
	assert.equal(narrow.length, lines.length, "the role-split footer never adds a row");
});

test("a preview line wider than the box's interior wraps onto continuation rows under one gutter number, and the next line keeps its own", async () => {
	const wide = "abcdefghij".repeat(18);
	const { view } = await openView({ rows: 20, loadPreview: async () => preview(["first", wide, "second"]) });
	const lines = view.render(120);
	for (const line of lines) assert.equal(visibleWidth(line), 120, "a wrapped row is never ragged");
	assert.match(positionCell(lines), /^1\/3$/, "the position counts file lines, not painted rows");

	const firstRow = previewCell(lines, 0)!;
	// How many rows the line needs follows from the wrap width inside the box,
	// which the pane width, the box's two border columns and the list pane's 45%
	// share of the card decide (S30, S36, S38).
	const wrappedCount = Math.ceil(wide.length / (await previewRoom()));
	const wrappedRows = Array.from({ length: wrappedCount }, (_, index) => previewCell(lines, 1 + index)!);
	const nextRow = previewCell(lines, 1 + wrappedCount)!;
	assert.match(firstRow, /^ *1 first *$/, "the first line keeps its own number");
	assert.match(wrappedRows[0]!, /^ *2 abcdefghij/, "the wide line's number sits on its first row");
	const textColumn = wrappedRows[0]!.indexOf("abcdefghij");
	for (const row of wrappedRows.slice(1)) {
		assert.equal(row.slice(0, textColumn).trim(), "", "a continuation row leaves the gutter blank");
		assert.equal(row.search(/\S/), textColumn, "a continuation row aligns under the same text column");
		assert.doesNotMatch(row, /…/, "a wrapped line is never truncated with an ellipsis");
	}
	const reassembled = wrappedRows.map((row) => row.slice(textColumn)).join("").trimEnd();
	assert.equal(reassembled, wide, "the whole line is painted across the rows");
	assert.match(nextRow, /^ *3 second/, "the following file line keeps its own number");

	// Six painted rows against five content rows, so a clamped scroll really stops
	// inside the wrapped line rather than at its start.
	const scrolledView = await openView({ rows: 16, loadPreview: async () => preview(["first", wide, "second"]) });
	for (let index = 0; index < 5; index += 1) scrolledView.view.handleInput(CTRL_SHIFT_J);
	const scrolled = scrolledView.view.render(120);
	assert.match(positionCell(scrolled), /^2\/3$/, "a scroll into a wrapped line still reports the file line it belongs to");
	assert.match(previewCell(scrolled, previewRowCount(scrolled) - 1), /^ *3 second/, "scrolling to the last page reaches the end of the file");
});

/** The text column inside the box, in cells, measured from a painted row at `width`. */
async function previewRoom(width = 120): Promise<number> {
	const { view } = await openView({ rows: 20, loadPreview: async () => preview(["x".repeat(400)]) });
	const painted = previewCell(view.render(width), 0) ?? "";
	return painted.trimEnd().length - painted.indexOf("x");
}

test("a double-width grapheme that straddles a wrap boundary starts the next row instead of vanishing", async () => {
	// A line fills the text column short of the two cells its last grapheme
	// needs, so the wrap boundary falls inside that grapheme.
	const room = await previewRoom();
	const prefix = "a".repeat(room - 1);
	const line = `${prefix}漢字`;
	const { view } = await openView({ rows: 20, loadPreview: async () => preview(["first", line, "second"]) });
	const lines = view.render(120);
	for (const painted of lines) assert.equal(visibleWidth(painted), 120, "a wrapped frame of wide graphemes is still exact");
	assert.match(positionCell(lines), /^1\/3$/, "the position still counts file lines");

	const wrapped = [1, 2].map((offset) => previewCell(lines, offset)!);
	const column = wrapped[0]!.indexOf("a");
	assert.equal(wrapped[0]!.slice(column).trimEnd(), prefix, "the first row stops before the grapheme it cannot fit");
	assert.equal(wrapped[1]!.slice(column).trim(), "漢字", "both graphemes of the broken boundary are painted on the next row");
	const reassembled = wrapped.map((row) => row.slice(column).trimEnd()).join("");
	assert.equal(reassembled, line, "the whole line is painted, with no CJK grapheme dropped");
	assert.equal(wrapped[1]!.slice(0, column).trim(), "", "the continuation row leaves the gutter blank");
	assert.match(previewCell(lines, 3), /^ *3 second/, "the next file line keeps its own row");
});

test("an emoji that straddles a wrap boundary is painted whole on the next row, including a joined sequence", async () => {
	const room = await previewRoom();
	const prefix = "b".repeat(room - 1);
	const family = "👨‍👩‍👧";
	const line = `${prefix}${family}c`;
	const { view } = await openView({ rows: 20, loadPreview: async () => preview([line]) });
	const lines = view.render(120);
	for (const painted of lines) assert.equal(visibleWidth(painted), 120, "the wrapped frame of emoji is still exact");
	assert.match(positionCell(lines), /^1\/1$/, "the position still counts the file's single line");

	const wrapped = [0, 1].map((offset) => previewCell(lines, offset)!);
	const column = wrapped[0]!.indexOf("b");
	assert.equal(wrapped[0]!.slice(column).trimEnd(), prefix, "the first row stops before the emoji it cannot fit");
	assert.equal(wrapped[1]!.slice(column).trim(), `${family}c`, "the joined emoji sequence is painted intact and is never split");
	const reassembled = wrapped.map((row) => row.slice(column).trimEnd()).join("");
	assert.equal(reassembled, line, "the whole line is painted, with the emoji present exactly once");
});

test("a box interior narrower than a double-width grapheme paints it on its own row instead of dropping it", async () => {
	// At 20 columns the preview pane is six cells wide and the box's interior is
	// four: a gutter cell, the gap and a two-cell text column, so each CJK
	// grapheme takes a whole row of its own instead of being split or dropped.
	const { view } = await openView({ rows: 20, loadPreview: async () => preview(["漢字"]) });
	const lines = view.render(20);
	for (const painted of lines) assert.equal(visibleWidth(painted), 20, "the narrow card is still exact");
	assert.match(positionCell(lines), /^1\/1$/, "the position still counts the file's single line");
	assert.equal(previewCell(lines, 0), "1 漢", "the first grapheme is painted beside its line number, one row for it");
	assert.equal(previewCell(lines, 1), "  字", "the second grapheme gets its own row rather than being lost");
	assert.equal(previewCell(lines, 2), "    ", "the row count matches what is painted, so no extra row is left over");
});

// The injected highlighter (S39): the view never calls Pi, so these tests fake
// the already-ANSI lines Pi's own highlighter returns and assert the pane the
// way the terminal receives it.
const CODE_TONE = "\x1b[36m";

/** A painted sequence escaped for a regular expression. */
function roleRuns(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const CODE_RESET = "\x1b[39m";
const DIM_TONE = "\x1b[2m";
const MUTED_TONE = "\x1b[90m";
const CELL_RESET = "\x1b[0m";

const roleTheme: FilePickerTheme = {
	fg(color: string, text: string) {
		if (color === "dim") return `${DIM_TONE}${text}${ROLE_END}`;
		if (color === "muted") return `${MUTED_TONE}${text}${ROLE_END}`;
		return text;
	},
};

test("the preview paints the file's syntax through the injected highlighter and keeps the gutter dim", async () => {
	const highlighted: { code: string; lang?: string }[] = [];
	const { view } = await openView({
		theme: roleTheme,
		loadPreview: async () => preview(["const answer = 42;", "// done"], true),
		languageForPath: (path) => (path.endsWith(".ts") ? "typescript" : undefined),
		highlight(code, lang) {
			highlighted.push({ code, lang });
			return code.split("\n").map((line) => (line.startsWith("const") ? `${CODE_TONE}const${CODE_RESET}${line.slice("const".length)}` : `${CODE_TONE}${line}${CODE_RESET}`));
		},
	}, [entry("src/app.ts")]);
	const lines = view.render(120);
	assert.deepEqual(highlighted, [{ code: "const answer = 42;\n// done", lang: "typescript" }], "the already-bounded preview is highlighted with the language of the previewed path");
	// The painted cells end exactly where the dim gutter and the highlighted line
	// do; slicing the row's list column can leave empty role runs in front, which
	// paint nothing.
	assert.match(rawPreviewCell(lines, 0).trimEnd(), new RegExp(`${roleRuns(`${DIM_TONE}1${ROLE_END} ${CODE_TONE}const${CODE_RESET} answer = 42;${CELL_RESET}`)}$`), "the file line keeps the highlighter's colour and its number keeps the dim tone");
	assert.match(rawPreviewCell(lines, 1).trimEnd(), new RegExp(`${roleRuns(`${DIM_TONE}2${ROLE_END} ${CODE_TONE}// done${CODE_RESET}${CELL_RESET}`)}$`), "the gutter is painted after highlighting, never through it");
	assert.match(previewCell(lines, 0), /^1 const answer = 42; *$/, "the painted text is the file's own text");
	assert.match(positionCell(lines), /^1\/2\+$/, "the position indicator still counts the file's lines");
	assert.equal(previewCell(lines, 2).trim(), "… preview truncated.", "the truncation notice is a notice, not highlighted code");
});

test("a coloured line wider than the box's interior wraps onto continuation rows that each keep their fragment's colour", async () => {
	const wide = "abcdefghij".repeat(18);
	const { view } = await openView({
		rows: 20,
		loadPreview: async () => preview(["first", wide, "second"]),
		languageForPath: () => "typescript",
		highlight: (code) => code.split("\n").map((line) => `${CODE_TONE}${line}${CODE_RESET}`),
	}, [entry("src/app.ts")]);
	const lines = view.render(120);
	for (const painted of lines) assert.equal(visibleWidth(painted), 120, "a wrapped coloured row is never ragged");
	assert.match(positionCell(lines), /^1\/3$/, "the position still counts file lines, not painted rows");
	assert.match(previewCell(lines, 0), /^ *1 first */, "the first line keeps its own number");

	const stripped = Array.from({ length: Math.ceil(wide.length / (await previewRoom())) }, (_, index) => previewCell(lines, 1 + index)!);
	assert.match(stripped[0]!, /^ *2 abcdefghij/, "the wide line's number sits on its first row");
	const textColumn = stripped[0]!.indexOf("abcdefghij");
	for (const [index, row] of stripped.entries()) {
		const raw = rawPreviewCell(lines, 1 + index)!;
		const paintedRow = lines[BODY_TOP + 1 + index]!;
		assert.match(raw, new RegExp(`\\x1b\\[36m`), "a continuation row keeps the colour of its fragment");
		assert.ok(paintedRow.indexOf(CELL_RESET) > paintedRow.indexOf(CODE_TONE) && paintedRow.includes(CELL_RESET), "the colour run is closed with the row's own reset");
		assert.ok(paintedRow.indexOf(CELL_RESET) < paintedRow.lastIndexOf("│"), "the colour run ends inside the box's interior instead of bleeding into its border");
		assert.equal(raw.slice(0, raw.indexOf(CODE_TONE)).trim(), index === 0 ? "2" : "", "only the first row carries the line number; a continuation row leaves the gutter blank");
		assert.doesNotMatch(row, /…/, "a wrapped coloured line is never truncated with an ellipsis");
	}
	const reassembled = stripped.map((row) => row.slice(textColumn).trimEnd()).join("");
	assert.equal(reassembled, wide, "the whole coloured line is painted across the rows");
	assert.match(previewCell(lines, 1 + stripped.length), /^ *3 second/, "the following file line keeps its own number");
});

test("every highlighting failure paints exactly the plain preview the pane painted before", async () => {
	// The baseline is today's rendering: the same file, the same preview, and no
	// highlighter wired at all.
	const baseline = (await openView({}, [entry("src/app.ts")])).view.render(120);

	const withoutHighlighter = await openView({ languageForPath: () => "typescript" }, [entry("src/app.ts")]);
	assert.deepEqual(withoutHighlighter.view.render(120), baseline, "no highlighter paints the plain preview");

	let unknownCalls = 0;
	const unknownLanguage = await openView({ languageForPath: () => undefined, highlight: () => { unknownCalls += 1; return []; } }, [entry("src/app.ts")]);
	assert.equal(unknownCalls, 0, "an unknown language never asks the highlighter");
	assert.deepEqual(unknownLanguage.view.render(120), baseline, "an unknown language paints the plain preview");

	const throwing = await openView({ languageForPath: () => "typescript", highlight: () => { throw new Error("Theme not initialized. Call initTheme() first."); } }, [entry("src/app.ts")]);
	assert.deepEqual(throwing.view.render(120), baseline, "a highlighter that throws paints the plain preview rather than an error or a blank pane");

	const misaligned = await openView({ languageForPath: () => "typescript", highlight: () => [`${CODE_TONE}one line for two${CODE_RESET}`] }, [entry("src/app.ts")]);
	assert.deepEqual(misaligned.view.render(120), baseline, "painted lines that do not line up with the file are not used");
});

test("the preview is highlighted when it loads, never once per repaint", async () => {
	let calls = 0;
	const { view } = await openView({
		languageForPath: () => "typescript",
		highlight: (code) => {
			calls += 1;
			return code.split("\n").map((line) => `${CODE_TONE}${line}${CODE_RESET}`);
		},
	}, [entry("a.ts"), entry("b.ts")]);
	assert.equal(calls, 1, "the first preview is highlighted once when it lands");
	view.render(120);
	view.render(80);
	view.render(120);
	assert.equal(calls, 1, "repainting never highlights again");
	view.handleInput("\x1b[B");
	await settle();
	assert.equal(calls, 2, "a second file is its own preview load");
	view.render(120);
	assert.equal(calls, 2, "and that load is highlighted only once too");
});

test("an error preview renders its message", async () => {
	const { view } = await openView({ loadPreview: async () => ({ kind: "error", message: "Cannot read src/app.ts (EACCES)." }) });
	assert.ok(bodyText(view.render(120)).includes("Cannot read src/app.ts (EACCES)."));
});

test("the Tab bar of a marked row always carries a theme role, focused or not, with or without a background", async () => {
	const ACCENT_TONE = "\x1b[35m";
	const roleTheme = (withBackground: boolean): FilePickerTheme => ({
		fg(color: string, text: string) {
			if (color === "accent") return `${ACCENT_TONE}${text}${ROLE_END}`;
			if (color === "muted") return `${LABEL_ROLE}${text}${ROLE_END}`;
			return text;
		},
		...(withBackground ? { bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m` } : {}),
	});
	// The four states a marked row is painted in: focused or not, inside a theme
	// that highlights the focused row with a background or one that does not.
	for (const withBackground of [false, true]) {
		for (const focused of [true, false]) {
			const { view } = await openView({ theme: roleTheme(withBackground) }, [entry("a.ts"), entry("b.ts")]);
			view.handleInput(TAB);
			if (!focused) view.handleInput("\x1b[B");
			const lines = view.render(120);
			const row = rawListCell(lines, "a.ts");
			const where = `${focused ? "focused" : "idle"}, ${withBackground ? "with" : "without"} a background`;
			assert.ok(stripAnsi(row).includes(SELECTION_BAR), `the marked row paints its bar: ${where}`);
			assert.ok(row.includes(`${ACCENT_TONE}${SELECTION_BAR}${ROLE_END}`), `the bar cell carries the accent role: ${where}`);
			assert.equal(labelColumn(lines, "a.ts"), MARKER_COLUMN, `the marker column keeps its width: ${where}`);
		}
	}
});

test("a theme with a background paints the selected row as a full-width bar", async () => {
	const bgTheme: FilePickerTheme = {
		fg(_color, text) {
			return text;
		},
		bg(_color, text) {
			return `\x1b[44m${text}\x1b[49m`;
		},
	};
	const { view } = await openView({ theme: bgTheme });
	const lines = view.render(120);
	const row = lines[listRowOf(lines, "README.md")]!;
	assert.match(row, /\x1b\[44m/, "the selected row uses the selected background");
	assert.doesNotMatch(row, /▸/, "a full-width bar replaces the marker");
	view.handleInput(TAB);
	assert.match(view.render(120)[listRowOf(lines, "README.md")]!, new RegExp(SELECTION_BAR), "a marked row keeps its bar inside the highlight");
	for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("the async listing and preview loads request a render, and the first render before they resolve does not crash", async () => {
	let resolveList: (result: RepositoryEntriesResult) => void = () => {};
	let resolvePreview: (result: FilePreview) => void = () => {};
	const previewCalls: string[] = [];
	let renders = 0;
	const { view } = createView({
		listEntries: () => new Promise<RepositoryEntriesResult>((resolve) => { resolveList = resolve; }),
		loadPreview: (relativePath) => {
			previewCalls.push(relativePath);
			return new Promise<FilePreview>((resolve) => { resolvePreview = resolve; });
		},
		requestRender: () => { renders += 1; },
	});
	const first = view.render(120);
	assert.ok(first.length > 0);
	assert.match(bodyText(first), /Loading files/);
	assert.equal(renders, 0, "a pending listing does not spin");

	resolveList(entries([entry("a.ts")]));
	await settle();
	assert.equal(renders, 1, "the listing requests a render when it lands");
	assert.deepEqual(previewCalls, ["a.ts"]);
	assert.match(bodyText(view.render(120)), /Loading preview/, "a pending preview renders a loading line");

	resolvePreview(preview(["hello"]));
	await settle();
	assert.equal(renders, 2, "the preview requests a render when it lands");
	assert.match(bodyText(view.render(120)), /hello/);
});

test("the listing and each preview are loaded at most once and previews are cached per file", async () => {
	let listCalls = 0;
	const previewCalls: string[] = [];
	const { view } = createView({
		async listEntries() {
			listCalls += 1;
			return entries([entry("a.ts"), entry("b.ts")]);
		},
		async loadPreview(relativePath) {
			previewCalls.push(relativePath);
			return preview([`${relativePath} body`]);
		},
	});
	view.render(120);
	await settle();
	view.handleInput("\x1b[B");
	await settle();
	view.handleInput("\x1b[A");
	await settle();
	assert.equal(listCalls, 1);
	assert.deepEqual(previewCalls, ["a.ts", "b.ts"]);
	assert.match(bodyText(view.render(120)), /a\.ts body/);
});

// The listing order selector (S29): the exact orders and the exact rows they
// paint. `path` and `ext` paint a foldable tree (S35); `modified` stays flat.
const TREE_BASENAMES = ["CODEOWNERS", "bug.md", "ci.yml", ".gitignore", "AGENTS.md", "cli.ts", "reference.md", "guide.md", "app.ts", "util.ts"];
// The `path` tree: inside every folder its subfolders paint first and then its
// own files, each alphabetical, so the repository's own files paint last.
const PATH_ORDER = ["bug.md", "ci.yml", "CODEOWNERS", "cli.ts", "reference.md", "guide.md", "util.ts", "app.ts", ".gitignore", "AGENTS.md"];
const TREE_FILES = [
	entry("docs/guide.md"),
	entry("src/app.ts", "new", NOW - MINUTE),
	entry(".gitignore"),
	entry(".github/workflows/ci.yml"),
	entry(".github/CODEOWNERS"),
	entry(".github/ISSUE_TEMPLATE/bug.md"),
	entry("bin/cli.ts"),
	entry("AGENTS.md"),
	entry("src/lib/util.ts"),
	entry("docs/api/reference.md"),
];
const EXT_BASENAMES = ["alpha.md", "gamma.md", "beta.ts", "zeta.ts", "LICENSE", "Makefile"];
const EXT_FILES = [entry("zeta.ts"), entry("alpha.md"), entry("beta.ts"), entry("LICENSE"), entry("gamma.md"), entry("Makefile")];

test("the info row names the active order and ctrl+o cycles modified, path, ext and back to modified", async () => {
	const { view, calls } = await openView({}, [entry("b.ts"), entry("a.md")]);
	assert.match(infoCell(view.render(120)), /^2\/2 \(0\) ─+ modified$/, "modified is the default order");
	view.handleInput(CTRL_O);
	assert.match(infoCell(view.render(120)), /^2\/2 \(0\) ─+ tree$/, "the folder order is named tree (S45)");
	view.handleInput(CTRL_O);
	assert.match(infoCell(view.render(120)), /^2\/2 \(0\) ─+ ext$/);
	view.handleInput(CTRL_O);
	assert.match(infoCell(view.render(120)), /^2\/2 \(0\) ─+ modified$/, "the third press returns to modified");
	assert.deepEqual(calls.insert, [], "cycling never inserts");
	assert.deepEqual(calls.open, []);
	assert.equal(calls.close, 0, "cycling never closes the panel");
});

test("the default modified order keeps the listing order, and only ctrl+o re-sorts it", async () => {
	const list = [entry("z-newest.ts", "new", NOW - MINUTE), entry("m-older.ts", "updated", NOW - HOUR), entry("a-clean.ts")];
	const { view } = await openView({}, list);
	const lines = view.render(120);
	assert.deepEqual(paintedList(lines, ["a-clean.ts", "m-older.ts", "z-newest.ts"]), ["z-newest.ts", "m-older.ts", "a-clean.ts"], "the listing's changed-first, newest-first order is painted");
	assert.match(infoCell(lines), /^3\/3 \(0\) ─+ modified$/);
});

test("the tree order keeps every file of a folder and its subfolders together, like an IDE explorer, and still paints the badge", async () => {
	const { view } = await openView({ rows: 40 }, TREE_FILES);
	view.handleInput(CTRL_O);
	const lines = view.render(120);
	assert.match(infoCell(lines), /^10\/10 \(0\) ─+ tree$/);
	const painted = paintedList(lines, TREE_BASENAMES);
	assert.deepEqual(painted, PATH_ORDER, "every file of a folder and of its subfolders paints together, and the root's own files paint last");
	assert.match(listCell(lines, "app.ts"), /app\.ts +U 1m/, "a changed row keeps its letter and age");
	assert.match(listCell(lines, "util.ts"), /^ {3} {2} {2}util\.ts *$/, "a clean nested row paints neither letter nor age, and no directory");
	for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("the ext order groups every file by extension, alphabetical by extension and then by path, with no extension last", async () => {
	const { view } = await openView({ rows: 20 }, EXT_FILES);
	view.handleInput(CTRL_O);
	view.handleInput(CTRL_O);
	const lines = view.render(120);
	assert.match(infoCell(lines), /^6\/6 \(0\) ─+ ext$/);
	assert.deepEqual(paintedList(lines, EXT_BASENAMES), ["alpha.md", "gamma.md", "beta.ts", "zeta.ts", "LICENSE", "Makefile"], "grouped by extension, then by path, with the extensionless files last");
	assert.deepEqual(listTree(lines).filter((row) => row.depth === 0), [
		{ depth: 0, label: ".md" },
		{ depth: 0, label: ".ts" },
		{ depth: 0, label: "(none)" },
	], "one group per extension, named with its dot, and the extensionless group last");
});

test("cycling the order keeps the highlighted file highlighted, visible in the window, and its preview untouched", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const list = [entry("z/last.ts", "new", NOW - MINUTE), entry("m/mid.ts"), entry("a/first.ts")];
	const { view, calls } = await openView({ rows: 20, loadPreview: async () => preview(long) }, list);
	assert.match(selectedRow(view.render(120)), /last\.ts/);
	for (let index = 0; index < 3; index += 1) view.handleInput(CTRL_SHIFT_J);
	assert.match(previewTop(view.render(120)), /line 3/);
	view.handleInput(CTRL_O);
	let lines = view.render(120);
	assert.match(selectedRow(lines), /last\.ts/, "the same file stays highlighted when it moves in the new order");
	assert.equal(rowOf(lines, "last.ts"), BODY_TOP + 5, "the highlight moved with the file, not the index: it sits under its own folder group in the path tree");
	assert.match(previewTop(lines), /line 3/, "the preview keeps its scroll while the highlighted file is unchanged");
	view.handleInput(CTRL_O);
	lines = view.render(120);
	assert.match(selectedRow(lines), /last\.ts/);
	assert.match(previewTop(lines), /line 3/, "a second cycle keeps it too");
	assert.deepEqual(calls.insert, []);
	assert.equal(calls.close, 0);

	const many = Array.from({ length: 30 }, (_, index) => entry(`file-${String(29 - index).padStart(2, "0")}.ts`));
	const windowed = await openView({ rows: 20 }, many);
	for (let index = 0; index < 25; index += 1) windowed.view.handleInput("\x1b[B");
	windowed.view.handleInput(CTRL_O);
	const scrolled = windowed.view.render(120);
	assert.match(selectedRow(scrolled), /file-04\.ts/, "the file that moved to the end of the new order stays visible");
	assert.match(bodyText(scrolled), /file-04\.ts/);
});

test("a query filter applies to a non-default order and the info row names that order", async () => {
	const { view } = await openView({ rows: 40 }, TREE_FILES);
	view.handleInput(CTRL_O);
	view.handleInput(CTRL_O);
	for (const character of "util") view.handleInput(character);
	const lines = view.render(120);
	assert.match(infoCell(lines), /^1\/10 \(0\) ─+ ext$/, "the listed count is what the query lists out of the whole listing (S43)");
	assert.match(selectedRow(lines), /util\.ts/, "the filter still chooses the row, in the active order");
	assert.deepEqual(paintedList(lines, TREE_BASENAMES), ["util.ts"], "the query hides every other row in this order too");
});

// The foldable trees (S35): `path` nests folder groups, `ext` paints one level
// of extension groups, every group starts open, `space` and `enter` fold the
// focused group, and a query forces every group open. `modified` stays a flat
// file list, exactly as it painted before.

test("the tree order paints the tree: each folder's subfolders before its own files, the repository's own files last", async () => {
	const { view } = await openView({ rows: 40 }, TREE_FILES);
	view.handleInput(CTRL_O);
	const lines = view.render(120);
	assert.deepEqual(listTree(lines), [
		{ depth: 0, label: ".github" },
		{ depth: 1, label: "ISSUE_TEMPLATE" },
		{ depth: 2, label: "bug.md" },
		{ depth: 1, label: "workflows" },
		{ depth: 2, label: "ci.yml" },
		{ depth: 1, label: "CODEOWNERS" },
		{ depth: 0, label: "bin" },
		{ depth: 1, label: "cli.ts" },
		{ depth: 0, label: "docs" },
		{ depth: 1, label: "api" },
		{ depth: 2, label: "reference.md" },
		{ depth: 1, label: "guide.md" },
		{ depth: 0, label: "src" },
		{ depth: 1, label: "lib" },
		{ depth: 2, label: "util.ts" },
		{ depth: 1, label: "app.ts" },
		{ depth: 0, label: ".gitignore" },
		{ depth: 0, label: "AGENTS.md" },
	], "inside every folder its subfolders come first and then its own files, so the root's own files paint last");
	assert.match(infoCell(lines), /^10\/10 \(0\) ─+ tree$/, "the info row counts files, never the group rows");
	for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("space folds the group that owns the focused file and leaves the cursor on a file row", async () => {
	const { view, calls } = await openView({ rows: 40 }, TREE_FILES);
	view.handleInput(CTRL_O);
	let lines = view.render(120);
	assert.equal(listTree(lines).length, 18, "choosing an order never hides a file: every group starts expanded");
	assert.match(footerText(lines), /space fold/, "the footer names the fold key");
	view.handleInput(HOME_SEQUENCES[0]!);
	lines = view.render(120);
	assert.match(selectedRow(lines), /bug\.md/, "home lands on the first file row, never on a group row");
	view.handleInput(SPACE);
	lines = view.render(120);
	assert.deepEqual(listTree(lines)[0], { depth: 0, label: ".github" }, "the group rows stay painted");
	assert.ok(!listTree(lines).some((row) => row.label === "bug.md"), "the folded group's files disappear");
	assert.match(selectedRow(lines), /ci\.yml/, "the cursor follows the rows and lands on the file row that took the fold's place");
	assert.match(infoCell(lines), /^10\/10 \(0\) ─+ tree$/, "a fold hides rows but never recounts the files");
	assert.match(searchCell(lines), /^› Search$/, "space never becomes query text");
	assert.deepEqual(calls.insert, [], "space never inserts");
	assert.equal(calls.close, 0, "space never closes the panel");

	// The fold state is kept per order: another order starts expanded, and coming
	// back to this one restores the fold the user set here.
	view.handleInput(CTRL_O);
	assert.equal(listTree(view.render(120)).filter((row) => row.depth === 1).length, 10, "the ext order starts with every group expanded");
	view.handleInput(CTRL_O);
	view.handleInput(CTRL_O);
	assert.equal(listTree(view.render(120)).length, 17, "coming back to tree keeps the fold this order had");
});

test("the one exception to S46: with every group folded the cursor rests on a group row and space reopens the tree", async () => {
	// No file row is painted once every group is folded, so the group rows are the
	// only way back into the tree. That is the single state where the cursor may
	// rest on a group row, and the next space unfolds it (S46).
	const { view, calls } = await openView({ rows: 20 }, [entry("a.md"), entry("b.ts")]);
	view.handleInput(CTRL_O);
	view.handleInput(CTRL_O);
	view.handleInput(HOME_SEQUENCES[0]!);
	assert.match(selectedRow(view.render(120)), /a\.md/, "the cursor starts on the first file row");
	view.handleInput(SPACE);
	view.handleInput(SPACE);
	let lines = view.render(120);
	assert.deepEqual(listTree(lines), [{ depth: 0, label: ".md" }, { depth: 0, label: ".ts" }], "both groups are folded, so the list holds no file row at all");
	assert.match(selectedRow(lines), /\.ts/, "the cursor rests on the group row that owns the last file");
	assert.match(infoCell(lines), /^2\/2 \(0\) ─+ ext$/, "the counts still report every file");
	assert.deepEqual(calls.insert, [], "a folded tree never inserts");
	assert.equal(calls.close, 0);

	view.handleInput(SPACE);
	lines = view.render(120);
	assert.match(selectedRow(lines), /b\.ts/, "space on that group row unfolds it and the cursor lands on its first file");
	assert.deepEqual(listTree(lines), [{ depth: 0, label: ".md" }, { depth: 0, label: ".ts" }, { depth: 1, label: "b.ts" }]);
	assert.deepEqual(calls.insert, []);
	assert.equal(calls.close, 0);
});

test("arrows, home/end, the wheel and a query never leave the cursor on a group row in tree or ext", async () => {
	const names = TREE_BASENAMES;
	const onFileRow = (lines: readonly string[]): boolean => {
		const cell = (stripAnsi(selectedRow(lines)).split(" │ ")[0] ?? "").replace(/^│ /, "");
		return names.some((name) => cell.includes(name));
	};

	for (const presses of [1, 2] as const) {
		const { view } = await openView({ rows: 40 }, TREE_FILES);
		for (let index = 0; index < presses; index += 1) view.handleInput(CTRL_O);
		const order = presses === 1 ? "tree" : "ext";
		assert.match(infoCell(view.render(120)), new RegExp(`─+ ${order}$`));
		assert.ok(onFileRow(view.render(120)), "the first painted row of a tree can hold the cursor");
		view.handleInput(HOME_SEQUENCES[0]!);
		assert.ok(onFileRow(view.render(120)), `${order}: home lands on a file row`);
		for (let step = 0; step < 24; step += 1) {
			view.handleInput("\x1b[B");
			assert.ok(onFileRow(view.render(120)), `${order}: every step down lands on a file row`);
		}
		for (let step = 0; step < 24; step += 1) {
			view.handleInput("\x1b[A");
			assert.ok(onFileRow(view.render(120)), `${order}: every step up lands on a file row`);
		}
		view.handleInput(END_SEQUENCES[0]!);
		assert.ok(onFileRow(view.render(120)), `${order}: end lands on the last file row, never on a group row`);
		view.handleInput(HOME_SEQUENCES[0]!);
		let lines = view.render(120);
		assert.deepEqual(view.handleMouse(mouse(lines, 4, BODY_TOP, "wheel", "none", 1)), { handled: true, render: true });
		lines = view.render(120);
		assert.ok(onFileRow(lines), `${order}: the wheel lands on a file row`);
		for (const character of names[0]!.slice(0, 2)) view.handleInput(character);
		lines = view.render(120);
		assert.ok(onFileRow(lines), `${order}: typing lands on the first matching file row`);
		view.handleInput("\x15");
		assert.ok(onFileRow(view.render(120)), `${order}: clearing the query keeps the cursor on a file row`);
		await settle();
	}
});

test("space is never query text, so it no longer throws the highlight back to the first row", async () => {
	const { view, calls } = await openView({}, [entry("a.ts"), entry("b.ts"), entry("c.ts")]);
	view.handleInput("\x1b[B");
	assert.match(selectedRow(view.render(120)), /b\.ts/);
	view.handleInput(SPACE);
	let lines = view.render(120);
	assert.match(selectedRow(lines), /b\.ts/, "space leaves the highlight where it is on a flat list");
	assert.equal(searchCell(lines), "› Search", "space never reaches the search row");
	assert.match(infoCell(lines), /^3\/3 \(0\) ─+ modified$/);
	for (const character of "sp") view.handleInput(character);
	assert.equal(searchCell(view.render(120)), "› sp", "typing still reaches the query");
	view.handleInput(SPACE);
	lines = view.render(120);
	assert.equal(searchCell(lines), "› sp", "space is appended to no query, ever");
	assert.ok(bodyText(lines).includes('No files match "sp"'), "the query is still exactly what was typed");
	assert.deepEqual(calls.insert, [], "space never inserts");
	assert.equal(calls.close, 0);
});

test("a non-empty query forces every group open, and the fold keys do nothing until it is cleared", async () => {
	const { view, calls } = await openView({ rows: 40 }, TREE_FILES);
	view.handleInput(CTRL_O);
	view.handleInput(HOME_SEQUENCES[0]!);
	let lines = view.render(120);
	// A click on a group row folds it, which is how the tree folds without a
	// focusable group row (S46).
	view.handleMouse(mouse(lines, 4, listRowOf(lines, ".github")));
	lines = view.render(120);
	assert.equal(listTree(lines).length, 13, "the group and its whole subtree are folded before the query");
	for (const character of "bug") view.handleInput(character);
	lines = view.render(120);
	assert.deepEqual(listTree(lines), [
		{ depth: 0, label: ".github" },
		{ depth: 1, label: "ISSUE_TEMPLATE" },
		{ depth: 2, label: "bug.md" },
	], "a query forces the folded group open, so its match is never hidden");
	assert.match(selectedRow(lines), /bug\.md/, "the highlight lands on the first match, never on a group row");
	view.handleInput(HOME_SEQUENCES[0]!);
	assert.match(selectedRow(view.render(120)), /bug\.md/, "home still lands on a file row while the query holds the groups open");
	view.handleInput(SPACE);
	lines = view.render(120);
	assert.equal(listTree(lines).length, 3, "the fold keys do nothing while a query holds the groups open");
	assert.match(selectedRow(lines), /bug\.md/, "and nothing moves either");
	view.handleInput("\x15");
	lines = view.render(120);
	assert.equal(listTree(lines).length, 13, "clearing the query restores the fold the user set");
	assert.deepEqual(calls.insert, []);
	assert.equal(calls.close, 0);
});

test("a group row never marks, opens or inserts, and enter on a file row still inserts and closes", async () => {
	// The only state where a group row takes the cursor is the all-folded tree
	// (S46), so that is where tab and ctrl+e are proven to do nothing on one.
	const { view, calls } = await openView({ rows: 20 }, [entry("a.md"), entry("b.ts")]);
	view.handleInput(CTRL_O);
	view.handleInput(CTRL_O);
	view.handleInput(HOME_SEQUENCES[0]!);
	view.handleInput(SPACE);
	view.handleInput(SPACE);
	let lines = view.render(120);
	assert.match(selectedRow(lines), /\.ts/, "the cursor rests on a group row while every group is folded");
	view.handleInput(TAB);
	lines = view.render(120);
	assert.match(infoCell(lines), /^2\/2 \(0\) ─+ ext$/, "tab marks no group row");
	view.handleInput("\x05");
	lines = view.render(120);
	assert.deepEqual(calls.open, [], "ctrl+e opens nothing on a group row");
	assert.equal(calls.close, 0, "ctrl+e on a group row never closes the panel");
	assert.match(selectedRow(lines), /\.ts/, "and the cursor stays on the group row");
	view.handleInput("\r");
	lines = view.render(120);
	assert.deepEqual(calls.insert, [], "enter on a group row toggles it instead of inserting");
	assert.match(selectedRow(lines), /b\.ts/, "and the tree reopens on that group's first file");
	view.handleInput("\r");
	assert.deepEqual(calls.insert, [["b.ts"]], "enter on a file row inserts that file");
	assert.equal(calls.close, 1, "and closes the panel once");
});

test("a group row paints only its name, and the tree order paints no trailing directory", async () => {
	const { view } = await openView({ rows: 40 }, TREE_FILES);
	view.handleInput(CTRL_O);
	// The highlight sits on a group row, so no preview mentions a file name here.
	view.handleInput(HOME_SEQUENCES[0]!);
	const pathLines = view.render(120);
	const group = (stripAnsi(pathLines[rowOf(pathLines, ".github")]!).split(" │ ")[0] ?? "").replace(/^│ /, "");
	assert.equal(group.slice(MARKER_COLUMN).trimEnd(), ".github", "a group row paints its name at its depth and nothing else");
	assert.doesNotMatch(group, /\b[UM]\b/, "a group row never paints a badge");
	assert.doesNotMatch(group, /\d+[smhd]\b/, "a group row never paints an age");
	assert.match(listCell(pathLines, "app.ts"), new RegExp(`^ {${MARKER_COLUMN + GROUP_INDENT}}app\\.ts +U 1m$`), "a file row in tree order keeps the badge and the age");
	assert.doesNotMatch(listCell(pathLines, "app.ts"), /src/, "in path the tree already places the file in its folder, so no directory suffix");
	assert.equal(listCell(pathLines, "guide.md").trimEnd(), " ".repeat(MARKER_COLUMN + GROUP_INDENT) + "guide.md", "a clean nested file paints its name alone");

	const modified = await openView({ rows: 40 }, TREE_FILES);
	assert.match(listCell(modified.view.render(120), "app.ts"), /^ {3}app\.ts +src +U 1m$/, "modified keeps the trailing directory");
	const ext = await openView({ rows: 40 }, [entry("src/zeta.ts"), entry("src/app.ts", "new", NOW - MINUTE)]);
	ext.view.handleInput(CTRL_O);
	ext.view.handleInput(CTRL_O);
	assert.match(listCell(ext.view.render(120), "app.ts"), new RegExp(`^ {${MARKER_COLUMN + GROUP_INDENT}}app\\.ts +src +U 1m$`), "ext keeps the trailing directory");
});

test("the modified order stays a flat file list: changed files first, badge and age, and no group rows", async () => {
	const { view } = await openView({ rows: 40 }, TREE_FILES);
	const lines = view.render(120);
	assert.deepEqual(listTree(lines), [
		{ depth: 0, label: "guide.md" },
		{ depth: 0, label: "app.ts" },
		{ depth: 0, label: ".gitignore" },
		{ depth: 0, label: "ci.yml" },
		{ depth: 0, label: "CODEOWNERS" },
		{ depth: 0, label: "bug.md" },
		{ depth: 0, label: "cli.ts" },
		{ depth: 0, label: "AGENTS.md" },
		{ depth: 0, label: "util.ts" },
		{ depth: 0, label: "reference.md" },
	], "the default order paints its flat listing untouched: every row is a depth-zero file row");
	assert.match(infoCell(lines), /^10\/10 \(0\) ─+ modified$/);
	assert.match(listCell(lines, "app.ts"), /app\.ts +src +U 1m$/, "the changed row keeps its badge, its age and its directory");
});

test("a click, the wheel and hover land on the row actually painted, and a group row is never focused", async () => {
	// Only the hover role is tagged, so every painted cell keeps its width and
	// the pointer geometry is the one the plain theme paints.
	const hoverTheme: FilePickerTheme = {
		fg(color, text) {
			return color === "warning" ? `<warning>${text}</warning>` : text;
		},
	};
	const { view, calls } = await openView({ theme: hoverTheme, rows: 40 }, TREE_FILES);
	view.handleInput(CTRL_O);
	view.handleInput(HOME_SEQUENCES[0]!);
	let lines = view.render(120);
	assert.match(selectedRow(lines), /bug\.md/, "the cursor starts on the first file row, not on the first group row");
	const cursorRow = rowOf(lines, "▸");

	// A click on a group row folds it: it never takes the cursor (S46).
	const groupRow = listRowOf(lines, "docs");
	assert.deepEqual(view.handleMouse(mouse(lines, 4, groupRow)), { handled: true, render: true }, "a click on a group row is a list click");
	lines = view.render(120);
	assert.ok(!listTree(lines).some((row) => row.label === "guide.md" || row.label === "reference.md"), "the clicked group's files are hidden");
	assert.equal(rowOf(lines, "▸"), cursorRow, "the cursor never moves onto the group row that was clicked");
	assert.match(selectedRow(lines), /bug\.md/);
	assert.deepEqual(calls.insert, [], "a group click never inserts");
	assert.equal(calls.close, 0, "a group click never closes the panel");
	view.handleMouse(mouse(lines, 4, listRowOf(lines, "docs")));
	lines = view.render(120);
	assert.ok(listTree(lines).some((row) => row.label === "guide.md"), "a second click unfolds it again");

	const issueRow = listRowOf(lines, "ISSUE_TEMPLATE");
	assert.equal(view.handleMouse(mouse(lines, 4, issueRow, "move", "none"))?.render, true);
	lines = view.render(120);
	assert.match(lines[issueRow]!, /<warning>/, "a group row still takes the shared hover role");

	// The wheel steps over the group rows and only ever lands on a file row.
	for (let step = 0; step < 6; step += 1) {
		lines = view.render(120);
		assert.deepEqual(view.handleMouse(mouse(lines, 4, BODY_TOP, "wheel", "none", 1)), { handled: true, render: true });
		await settle();
		const painted = view.render(120);
		const cell = (stripAnsi(selectedRow(painted)).split(" │ ")[0] ?? "").replace(/^│ /, "");
		assert.ok(TREE_BASENAMES.some((name) => cell.includes(name)), "the wheel lands on a file row, never on a group row");
	}
	lines = view.render(120);
	assert.match(selectedRow(lines), /\.(md|yml|ts)/, "the wheel only ever lands on a file row");

	const fileRow = listRowOf(lines, "guide.md");
	assert.deepEqual(view.handleMouse(mouse(lines, 4, fileRow)), { handled: true, render: true }, "a click on a file row of the tree selects that file");
	lines = view.render(120);
	assert.equal(rowOf(lines, "▸"), fileRow, "the file row is the one the pointer was over");
	assert.match(selectedRow(lines), /guide\.md/);
	await settle();
	lines = view.render(120);
	assert.match(bodyText(lines), /preview of docs\/guide\.md/, "the preview follows the file row the pointer landed on");
});
