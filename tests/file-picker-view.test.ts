import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FilePickerView, type FilePickerDeps, type FilePickerTheme } from "../lib/file-picker-view.ts";
import { FILE_PREVIEW_BINARY_NOTICE, type FileEntry, type FilePreview, type RepositoryEntriesResult } from "../lib/file-index.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The file picker overlay: repository files on the left, a lazy preview on
// the right, search always active. Rendering and pointer routing are pure;
// listing and preview reads are injected, so no repository is needed.

const CTRL_SHIFT_J = "\x1b[106;6u";
const CTRL_SHIFT_K = "\x1b[107;6u";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const TAB = "\t";

// Card rows: top border, header, search row, blank separator, count row, body.
const SEARCH_ROW = 2;
const COUNT_ROW = 4;
const BODY_TOP = 5;
// A selected row's marker cell: the accent bar that joins across adjacent rows.
const SELECTION_BAR = "▏";
const FOOTER_TEXT = "↑/↓ move • ctrl+j/k scroll • tab select • ctrl+u clear • enter insert • ctrl+e editor • esc close";
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

/** The left pane cell of the row showing `text`, without the card border. */
function listCell(lines: readonly string[], text: string): string {
	const row = stripAnsi(lines[rowOf(lines, text)] ?? "");
	const cell = row.split(" │ ")[0] ?? "";
	return cell.replace(/^│ /, "");
}

function mouse(lines: readonly string[], x: number, y: number, type: MouseEvent["type"] = "click", button: MouseEvent["button"] = "left", wheelDelta?: number, width = visibleWidth(lines[0] ?? "")): MouseEvent {
	const height = lines.length;
	return { type, button, x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

/** The right pane cell at `offset` rows into the body; 0 is the position row. */
function previewCell(lines: readonly string[], offset: number): string {
	const row = stripAnsi(lines[BODY_TOP + offset] ?? "");
	const cells = row.replace(/^│ /, "").replace(/ │$/, "").split(" │ ");
	return cells[1] ?? "";
}

/** The first preview content row, under the position indicator. */
function previewTop(lines: readonly string[]): string {
	return previewCell(lines, 1);
}

/** The same cell with its escape sequences intact, for role assertions. */
function rawPreviewCell(lines: readonly string[], offset: number): string {
	const row = lines[BODY_TOP + offset] ?? "";
	const cells = row.replace(/^│ /, "").replace(/ │$/, "").split(" │ ");
	return cells[1] ?? "";
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
		assert.match(stripAnsi(lines[SEARCH_ROW]!), /^│ › Search +│$/);
		assert.ok(stripAnsi(lines[BODY_TOP]!).includes("README.md"), "the list is painted");
		assert.ok(footerText(lines).startsWith("↑/↓ move"), "the footer is painted");
		previous = lines.length;
	}

	const { view } = await openView({ rows: 9 });
	const smallest = view.render(120);
	assert.equal(smallest.length, 9, "the smallest supported card fills the rows it is given");
	for (const line of smallest) assert.equal(visibleWidth(line), 120);
	assert.match(stripAnsi(smallest[1]!), /File picker/);
	assert.match(stripAnsi(smallest[SEARCH_ROW]!), /› Search/);
	assert.ok(footerText(smallest).startsWith("↑/↓ move"), "the footer survives the smallest card");
});

test("the title row shows the path being listed at its top-right, next to the esc hint", async () => {
	const { view } = await openView({ root: ROOT });
	const line = view.render(120)[1]!;
	assert.equal(visibleWidth(line), 120);
	const header = stripAnsi(line);
	assert.ok(header.includes(ROOT), `the whole path is painted when it fits: ${header}`);
	assert.match(header, /^│ File picker +.*file-picker esc +│$/, "the path sits between the title and the close hint");

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

test("a count row under the blank line reports the files listed and the Tab selection, and updates at once", async () => {
	const { view } = await openView({}, [entry("a.ts"), entry("b.ts"), entry("c.ts")]);
	let lines = view.render(120);
	assert.match(stripAnsi(lines[COUNT_ROW - 1]!), /^│ +│$/, "the blank row stays between the search row and the count");
	assert.match(stripAnsi(lines[COUNT_ROW]!), /^│ 3 files \(0 selected\) +│$/, "the count row sits under the blank line");
	assert.ok(stripAnsi(lines[BODY_TOP]!).includes("a.ts"), "the list starts under the count row");
	view.handleInput(TAB);
	lines = view.render(120);
	assert.match(stripAnsi(lines[COUNT_ROW]!), /^│ 3 files \(1 selected\) +│$/, "Tab updates the selection count immediately");
	view.handleInput("\x1b[B");
	view.handleInput(TAB);
	lines = view.render(120);
	assert.match(stripAnsi(lines[COUNT_ROW]!), /^│ 3 files \(2 selected\) +│$/, "a second Tab counts too");
	for (const character of "b") view.handleInput(character);
	lines = view.render(120);
	assert.match(stripAnsi(lines[COUNT_ROW]!), /^│ 1 file \(2 selected\) +│$/, "filtering updates the file count at once, and the selection count never lies about the whole selection");
});

test("the count row keeps the card geometry at a narrow width and at the smallest height", async () => {
	const { view } = await openView({}, [entry("a.ts")]);
	const narrow = view.render(40);
	assert.equal(visibleWidth(narrow[COUNT_ROW]!), 40);
	assert.match(stripAnsi(narrow[COUNT_ROW]!), /^│ 1 file \(0 selected\) +│$/, "a single file reads as one file");
	assert.equal(narrow.length, view.render(120).length, "the count row never adds a row");

	const small = (await openView({ rows: 9 }, [entry("a.ts")])).view.render(120);
	assert.equal(small.length, 9);
	assert.match(stripAnsi(small[COUNT_ROW]!), /1 file \(0 selected\)/, "the count row survives the smallest card");
	assert.ok(footerText(small).startsWith("↑/↓ move"));
	for (const line of small) assert.equal(visibleWidth(line), 120);
});

test("the search row sits directly under the title and shows the placeholder or the typed query, then a blank row and the list", async () => {
	const { view } = await openView({}, [entry("app.ts"), entry("src/app-store.ts")]);
	let lines = view.render(120);
	assert.match(stripAnsi(lines[1]!), /^│ File picker +esc +│$/, "the title row stays on top");
	assert.match(stripAnsi(lines[SEARCH_ROW]!), /^│ › Search +│$/, "the empty search row shows the placeholder");
	assert.match(stripAnsi(lines[SEARCH_ROW + 1]!), /^│ +│$/, "a blank row follows the search row");
	assert.ok(stripAnsi(lines[BODY_TOP]!).includes("app.ts"), "the list starts under the count row");
	for (const character of "app") view.handleInput(character);
	lines = view.render(120);
	assert.match(stripAnsi(lines[SEARCH_ROW]!), /^│ › app +│$/, "the search row shows exactly what was typed");
	assert.doesNotMatch(stripAnsi(lines[SEARCH_ROW]!), /Search/, "the placeholder gives way to the query");
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
	assert.match(row!, /^│ .*README\.md.* │ .*│$/, "the separator sits between the list and its preview");
	assert.equal((row!.match(/│/g) ?? []).length, 3, "the body row has the two card borders plus one pane separator");
	assert.match(previewTop(lines), /^1 preview of README\.md/, "the preview paints its first line, numbered, beside the list");
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
	assert.match(stripAnsi(lines[rowOf(lines, "app.ts")]!), new RegExp(SELECTION_BAR), "clearing the query keeps the selection");
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

test("a changed row shows its state badge and the age computed once when the panel opened", async () => {
	let clock = NOW;
	const list = [
		entry("fresh.ts", "new", NOW - 5_000),
		entry("edited.ts", "updated", NOW - 3 * HOUR - 5 * MINUTE),
		entry("stale.ts", "updated", NOW - 2 * DAY - HOUR),
		entry("untouched.ts", "clean", NOW - 4 * MINUTE),
	];
	const { view } = await openView({ now: () => clock }, list);
	const first = view.render(120);
	assert.match(listCell(first, "fresh.ts"), /^▸ {2}fresh\.ts +new 5s$/, "the age is right-aligned after the badge");
	assert.match(listCell(first, "edited.ts"), /^ {3}edited\.ts +upt 3h$/);
	assert.match(listCell(first, "stale.ts"), /^ {3}stale\.ts +upt 2d$/);
	assert.match(listCell(first, "untouched.ts"), /^ {3}untouched\.ts *$/, "a clean row shows neither badge nor age");

	clock = NOW + 30 * DAY;
	assert.match(listCell(view.render(120), "edited.ts"), /^ {3}edited\.ts +upt 3h$/, "ages are never recomputed");
});

test("a changed row without an mtime shows its badge and no age", async () => {
	const { view } = await openView({}, [entry("brand-new.ts", "new"), entry("plain.ts")]);
	const changed = listCell(view.render(120), "brand-new.ts");
	assert.match(changed, /brand-new\.ts +new$/);
	assert.doesNotMatch(changed, /\b\d+[smhd]\b/, "no age without an mtime");
	assert.doesNotMatch(listCell(view.render(120), "plain.ts"), /\bnew\b|\bupt\b/);
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
	const changed = stripAnsi(lines[rowOf(lines, "new")]!);
	assert.match(changed, /new 5m/);
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

test("the preview gutter numbers every visible row with its real file line number, also after scrolling", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `entry ${index}`);
	const { view } = await openView({ rows: 16, loadPreview: async () => preview(long) });
	let lines = view.render(120);
	assert.match(previewTop(lines), /^ 1 entry 0 +$/, "the first content row is file line 1");
	for (let index = 1; index < 5; index += 1) {
		assert.match(previewCell(lines, 1 + index), new RegExp(`^ ${index + 1} entry ${index} `), "every visible row carries its own line number");
	}
	for (let index = 0; index < 10; index += 1) view.handleInput(CTRL_SHIFT_J);
	lines = view.render(120);
	for (let index = 0; index < 5; index += 1) {
		assert.match(previewCell(lines, 1 + index), new RegExp(`^${11 + index} entry ${10 + index} `), "the gutter keeps the real line number after scrolling");
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
	assert.match(rawPreviewCell(lines, 0), /\x1b\[90m1\/2\x1b\[0m/, "the position uses the muted role");
	assert.match(rawPreviewCell(lines, 1), /\x1b\[2m1\x1b\[0m alpha/, "the gutter number uses the dim role");
	assert.match(rawPreviewCell(lines, 2), /\x1b\[2m2\x1b\[0m beta/);
});

test("the preview shows the top visible line over the total at its top-right, adding + only when the reader truncated", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const whole = await openView({ rows: 12, loadPreview: async () => preview(long) });
	let lines = whole.view.render(120);
	assert.match(previewCell(lines, 0), /^ *1\/60$/, "the indicator starts at line 1 of the 60 known lines");
	for (let index = 0; index < 10; index += 1) whole.view.handleInput(CTRL_SHIFT_J);
	lines = whole.view.render(120);
	assert.match(previewCell(lines, 0), /^ *11\/60$/, "the indicator follows the top visible line");

	const truncated = await openView({ rows: 12, loadPreview: async () => preview(long, true) });
	lines = truncated.view.render(120);
	assert.match(previewCell(lines, 0), /^ *1\/60\+$/, "a truncated preview never claims the real total");
	for (let index = 0; index < 5; index += 1) truncated.view.handleInput(CTRL_SHIFT_J);
	assert.match(previewCell(truncated.view.render(120), 0), /^ *6\/60\+$/, "the + survives scrolling");

	const binary = await openView({ loadPreview: async () => ({ kind: "binary", message: "unused" }) });
	assert.doesNotMatch(previewCell(binary.view.render(120), 0), /\d+\/\d+/, "a binary preview has no line position to claim");
});

test("an error preview renders its message", async () => {
	const { view } = await openView({ loadPreview: async () => ({ kind: "error", message: "Cannot read src/app.ts (EACCES)." }) });
	assert.ok(bodyText(view.render(120)).includes("Cannot read src/app.ts (EACCES)."));
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
	const row = lines[rowOf(lines, "README.md")]!;
	assert.match(row, /\x1b\[44m/, "the selected row uses the selected background");
	assert.doesNotMatch(row, /▸/, "a full-width bar replaces the marker");
	view.handleInput(TAB);
	assert.match(view.render(120)[rowOf(lines, "README.md")]!, new RegExp(SELECTION_BAR), "a marked row keeps its bar inside the highlight");
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
