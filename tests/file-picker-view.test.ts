import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FilePickerView, type FilePickerDeps, type FilePickerTheme } from "../lib/file-picker-view.ts";
import { FILE_PREVIEW_BINARY_NOTICE, type FilePreview, type RepositoryListing } from "../lib/file-index.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The file picker overlay: repository files on the left, a lazy preview on
// the right, search always active. Rendering and pointer routing are pure;
// listing and preview reads are injected, so no repository is needed.

const CTRL_SHIFT_J = "\x1b[106;6u";
const CTRL_SHIFT_K = "\x1b[107;6u";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

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

const FILES = ["README.md", "src/app.ts", "src/lib/util.ts"];

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
	insert: string[];
	close: number;
	render: number;
	trace: string[];
}

function listing(files: string[]): RepositoryListing {
	return { ok: true, files };
}

function preview(lines: string[], truncated = false): FilePreview {
	return { kind: "text", lines, truncated };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createView(overrides: Partial<FilePickerDeps> = {}, files = FILES): { view: FilePickerView; calls: Calls } {
	const calls: Calls = { open: [], insert: [], close: 0, render: 0, trace: [] };
	const deps: FilePickerDeps = {
		theme: plainTheme,
		rows: 20,
		async listFiles() {
			return listing(files);
		},
		async loadPreview(relativePath) {
			return preview([`preview of ${relativePath}`, "second line"]);
		},
		onOpen(relativePath) {
			calls.open.push(relativePath);
			calls.trace.push(`open:${relativePath}`);
		},
		onInsert(relativePath) {
			calls.insert.push(relativePath);
			calls.trace.push(`insert:${relativePath}`);
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

async function openView(overrides: Partial<FilePickerDeps> = {}, files = FILES): Promise<{ view: FilePickerView; calls: Calls }> {
	const created = createView(overrides, files);
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

function mouse(lines: readonly string[], x: number, y: number, type: MouseEvent["type"] = "click", button: MouseEvent["button"] = "left", wheelDelta?: number, width = visibleWidth(lines[0] ?? "")): MouseEvent {
	const height = lines.length;
	return { type, button, x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

function previewTop(lines: readonly string[]): string {
	return stripAnsi(lines[2] ?? "");
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
	const footer = wide[wide.length - 2]!;
	for (const key of ["type to search", "ctrl+j/k move", "ctrl+shift+j/k scroll", "enter insert", "ctrl+e editor", "esc close"]) {
		assert.ok(footer.includes(key), `footer must list ${JSON.stringify(key)}: ${footer}`);
	}
});

test("the body is two panes split by one vertical rule, with the list and preview content", async () => {
	const { view } = await openView();
	const lines = view.render(120).map((line) => stripAnsi(line));
	const row = lines.find((line) => line.includes("README.md"));
	assert.ok(row, "the list shows the repository-relative path");
	assert.match(row!, /^│ .*README\.md.* │ .*preview of README\.md.* │$/, "the separator sits between the list and its preview");
	assert.equal((row!.match(/│/g) ?? []).length, 3, "the body row has the two card borders plus one pane separator");
});

test("typing narrows the list without navigating or firing an action, and resets the selection to the first match", async () => {
	const { view, calls } = await openView({}, ["alpha.ts", "alpine.ts", "src/beta.ts"]);
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

test("a failed listing shows its message and an empty repository shows an explicit line", async () => {
	const failed = await openView({ listFiles: async () => ({ ok: false, message: "Cannot list repository files: not a repository." }) });
	const failedBody = bodyText(failed.view.render(120));
	assert.ok(failedBody.includes("Cannot list repository files: not a repository."));
	assert.ok(!failedBody.includes("Loading files"));

	const empty = await openView({ listFiles: async () => listing([]) });
	const emptyBody = bodyText(empty.view.render(120));
	assert.ok(emptyBody.includes("No files in this repository."));
});

test("ctrl+j/ctrl+k and the arrows move the selection and clamp at both ends; a line feed moves rather than inserts", async () => {
	const { view, calls } = await openView({}, ["a.ts", "b.ts", "c.ts"]);
	const selected = () => selectedRow(view.render(120));
	assert.match(selected(), /a\.ts/);
	view.handleInput("\x1b[B");
	assert.match(selected(), /b\.ts/);
	view.handleInput("\n");
	assert.match(selected(), /c\.ts/, "a bare line feed is ctrl+j, not Enter");
	assert.deepEqual(calls.insert, []);
	view.handleInput("\x0b");
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

test("a long selection window keeps the selected row visible with the more indicators", async () => {
	const files = Array.from({ length: 30 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`);
	const { view } = await openView({ rows: 10 }, files);
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
	const { view } = await openView({ rows: 12, loadPreview: async () => preview(long) });
	assert.match(previewTop(view.render(120)), /line 0/);
	for (let index = 0; index < 3; index += 1) view.handleInput(CTRL_SHIFT_J);
	assert.match(previewTop(view.render(120)), /line 3/);
	view.handleInput(CTRL_SHIFT_K);
	assert.match(previewTop(view.render(120)), /line 2/);
	view.handleInput(PAGE_DOWN);
	assert.match(previewTop(view.render(120)), /line 10/, "a page moves one body height");
	view.handleInput(PAGE_UP);
	assert.match(previewTop(view.render(120)), /line 2/);
	for (let index = 0; index < 100; index += 1) view.handleInput(CTRL_SHIFT_K);
	assert.match(previewTop(view.render(120)), /line 0/, "scrolling clamps at the top");
	for (let index = 0; index < 100; index += 1) view.handleInput(CTRL_SHIFT_J);
	const clamped = view.render(120);
	assert.match(previewTop(clamped), /line 52/, "scrolling clamps at the last full page");
	assert.ok(bodyText(clamped).includes("line 59"));
	const settled = view.render(120).join("\n");
	view.handleInput(CTRL_SHIFT_J);
	assert.equal(view.render(120).join("\n"), settled, "a clamp does not repaint");
});

test("the wheel over the list moves the selection and the wheel over the preview scrolls it; the list wheel never scrolls the preview", async () => {
	const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	const { view } = await openView({ rows: 12, loadPreview: async () => preview(long) });
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
	const previewWheel = view.handleMouse(mouse(lines, previewX, 2, "wheel", "none", 1));
	assert.deepEqual(previewWheel, { handled: true, render: true });
	lines = view.render(120);
	assert.match(previewTop(lines), /line 1/, "the preview wheel scrolls the preview");
	assert.match(selectedRow(lines), /app\.ts/, "the preview wheel never moves the selection");

	for (let index = 0; index < 100; index += 1) view.handleMouse(mouse(lines, previewX, 2, "wheel", "none", 1));
	lines = view.render(120);
	assert.match(previewTop(lines), /line 52/);
	assert.deepEqual(view.handleMouse(mouse(lines, previewX, 2, "wheel", "none", 1)), { handled: true, render: false }, "the preview wheel clamps at the end");
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
	const { view, calls } = await openView({}, ["a.ts", "b.ts", "c.ts"]);
	let lines = view.render(120);
	const result = view.handleMouse(mouse(lines, 3, rowOf(lines, "b.ts")));
	assert.deepEqual(result, { handled: true, render: true });
	lines = view.render(120);
	assert.match(selectedRow(lines), /b\.ts/);
	assert.deepEqual(calls.insert, []);
	assert.deepEqual(calls.open, []);
	assert.equal(calls.close, 0);
	assert.deepEqual(view.handleMouse(mouse(lines, visibleWidth(lines[0]!) - 4, 2)), { handled: true, render: false }, "a preview click is absorbed");
});

test("Enter inserts the selected path then closes exactly once", async () => {
	const { view, calls } = await openView({}, ["a.ts", "b.ts"]);
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	assert.deepEqual(calls.insert, ["b.ts"]);
	assert.equal(calls.close, 1);
	assert.deepEqual(calls.trace, ["insert:b.ts", "close"]);
	view.handleInput("\r");
	view.handleInput("\x05");
	view.handleInput("\x1b");
	assert.deepEqual(calls.insert, ["b.ts"], "a completed panel cannot fire again");
	assert.equal(calls.close, 1);
	assert.deepEqual(calls.open, []);
});

test("ctrl+e opens the selected path then closes exactly once", async () => {
	const { view, calls } = await openView({}, ["a.ts", "b.ts"]);
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
	for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("the async listing and preview loads request a render, and the first render before they resolve does not crash", async () => {
	let resolveList: (result: RepositoryListing) => void = () => {};
	let resolvePreview: (result: FilePreview) => void = () => {};
	const previewCalls: string[] = [];
	let renders = 0;
	const { view } = createView({
		listFiles: () => new Promise<RepositoryListing>((resolve) => { resolveList = resolve; }),
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

	resolveList(listing(["a.ts"]));
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
		async listFiles() {
			listCalls += 1;
			return listing(["a.ts", "b.ts"]);
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
