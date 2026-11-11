import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { FilePickerTheme } from "../lib/file-picker-view.ts";
import { loadScopeDetail, parseAheadBehind, scopeDetailLine } from "../lib/file-scope-detail.ts";
import { FileScopeView, orderScopes, type FileScope, type FileScopeDeps } from "../lib/file-scope-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The scope step that precedes the file picker when the session has
// registered worktrees: one framed, single-choice list of roots. Rendering
// and pointer routing are pure; the scopes are injected.

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

// A theme with real escape sequences: widths and stripping stay exact, so a
// colour can be asserted on a full-width row.
const ANSI_ACCENT = "\x1b[36m";
const ROLE_COLOUR: Record<string, string> = { accent: ANSI_ACCENT, text: "\x1b[37m", muted: "\x1b[90m", dim: "\x1b[2m", border: "\x1b[34m" };
const ansiTheme: FilePickerTheme = {
	fg(color: string, text: string) {
		return `${ROLE_COLOUR[color] ?? ""}${text}\x1b[0m`;
	},
};

const REPO = "/work/repo";
const ALPHA = "/work/repo-worktrees/alpha";
const BETA = "/work/repo-worktrees/beta";

const SCOPES: readonly FileScope[] = [
	{ root: REPO, label: "main", kind: "main", lastModifiedMs: 1_700_000_000_000 },
	{ root: ALPHA, label: "feat/alpha · alpha", kind: "worktree", lastModifiedMs: 1_700_000_900_000 },
	{ root: BETA, label: "fix/beta · beta", kind: "worktree", lastModifiedMs: 1_700_000_500_000 },
];

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
	select: FileScope[];
	close: number;
	render: number;
	trace: string[];
}

function createView(overrides: Partial<FileScopeDeps> = {}, scopes: readonly FileScope[] = SCOPES): { view: FileScopeView; calls: Calls } {
	const calls: Calls = { select: [], close: 0, render: 0, trace: [] };
	const deps: FileScopeDeps = {
		theme: plainTheme,
		rows: 20,
		scopes,
		onSelect(scope) {
			calls.select.push(scope);
			calls.trace.push(`select:${scope.root}`);
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
	return { view: new FileScopeView(deps), calls };
}

function bodyText(lines: readonly string[]): string {
	return lines.map((line) => stripAnsi(line)).join("\n");
}

function selectedRow(lines: readonly string[]): string {
	const row = lines.map((line) => stripAnsi(line)).find((line) => line.includes("▸"));
	assert.ok(row, "a selected row must be painted");
	return row;
}

// The card frame is `│ ` + content + ` │`, so the hint text is the trimmed
// middle of the footer row.
function footerText(lines: readonly string[]): string {
	const footer = lines[lines.length - 2]!;
	return stripAnsi(footer).slice(2, -2).trim();
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

// S32: `main` is always the first row and the registered worktrees follow it,
// most recently changed first — the session repository never sorts away.
test("orderScopes keeps main first, then the most recently modified worktree, and never mutates its input", () => {
	const scopes: FileScope[] = [
		{ root: REPO, label: "main", kind: "main", lastModifiedMs: 10 },
		{ root: "/work/a", label: "old · a", kind: "worktree", lastModifiedMs: 5 },
		{ root: "/work/b", label: "new · b", kind: "worktree", lastModifiedMs: 30 },
	];
	const snapshot = scopes.map((scope) => ({ ...scope }));
	const ordered = orderScopes(scopes);
	assert.deepEqual(ordered.map((scope) => scope.root), [REPO, "/work/b", "/work/a"], "main keeps the first row and the newest worktree follows it");
	assert.deepEqual(scopes, snapshot, "ordering never mutates its input");
	assert.notEqual(ordered, scopes, "ordering returns a new array");
	assert.equal(ordered[1], scopes[2], "the same scope objects come back");

	const ties: FileScope[] = [
		{ root: "/work/b", label: "b", kind: "worktree", lastModifiedMs: 7 },
		{ root: REPO, label: "main", kind: "main", lastModifiedMs: 0 },
		{ root: "/work/a", label: "a", kind: "worktree", lastModifiedMs: 7 },
	];
	assert.deepEqual(orderScopes(ties).map((scope) => scope.root), [REPO, "/work/b", "/work/a"], "recency ties keep their input order, and a stale main stays first");
	assert.deepEqual(orderScopes([]), [], "no scopes order to nothing");
	assert.deepEqual(orderScopes([scopes[1]!]).map((scope) => scope.root), ["/work/a"], "a list without main keeps its own order");
});

test("the card frame is exact at two widths, with the title, esc hint, step subtitle and key footer", () => {
	const { view } = createView();
	for (const width of [100, 72]) {
		const lines = view.render(width);
		for (const line of lines) assert.equal(visibleWidth(line), width, `every painted line must be exactly ${width} columns`);
		assert.match(stripAnsi(lines[0]!), /^╭─+╮$/);
		assert.match(stripAnsi(lines[lines.length - 1]!), /^╰─+╯$/);
	}
	const wide = view.render(100).map((line) => stripAnsi(line));
	assert.match(wide[1]!, /^│ File picker +esc +│$/, "the header carries the title on the left and esc on the right");
	assert.match(wide[2]!, /Choose a scope/, "a muted subtitle line names the step");
	assert.equal(footerText(wide), "↑/↓ move • enter choose scope • esc close", "the footer names one option per action");
});

test("every scope renders its label, with main first and the worktrees by recency, and no recency value leaks into the output", () => {
	const { view } = createView();
	const lines = view.render(100);
	const body = bodyText(lines);
	for (const scope of SCOPES) assert.ok(body.includes(scope.label), `the label ${JSON.stringify(scope.label)} must be painted`);
	assert.doesNotMatch(body, /1700000/, "recency is never rendered");
	assert.match(stripAnsi(lines[3]!), /^│ ▸ main +│$/, "the session repository is selected and the row carries its label only");
	const alphaRow = rowOf(lines, "feat/alpha · alpha");
	const betaRow = rowOf(lines, "fix/beta · beta");
	const mainRow = rowOf(lines, "main");
	assert.ok(mainRow < alphaRow && alphaRow < betaRow, "main is the first row and the worktrees follow by recency");
});

test("↑/↓ and ctrl+j/ctrl+k move the selection and clamp at both ends; a line feed moves rather than choosing", () => {
	const { view, calls } = createView();
	const current = () => selectedRow(view.render(100));
	assert.match(current(), /│ ▸ main +│$/);
	view.handleInput("\x1b[B");
	assert.match(current(), /│ ▸ feat\/alpha · alpha +│$/);
	view.handleInput("\n");
	assert.match(current(), /│ ▸ fix\/beta · beta +│$/, "a bare line feed is ctrl+j, not Enter");
	view.handleInput("\x0b");
	assert.match(current(), /│ ▸ feat\/alpha · alpha +│$/);
	view.handleInput("\x1b[A");
	assert.match(current(), /│ ▸ main +│$/);
	view.handleInput("\x1b[A");
	assert.match(current(), /│ ▸ main +│$/, "the selection clamps at the top");
	for (let index = 0; index < 6; index += 1) view.handleInput("\x1b[B");
	assert.match(current(), /│ ▸ fix\/beta · beta +│$/, "the selection clamps at the bottom");
	assert.deepEqual(calls.select, []);
	assert.equal(calls.close, 0);
});

test("Enter chooses the highlighted scope exactly once and never closes the step", () => {
	const { view, calls } = createView();
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	assert.deepEqual(calls.select.map((scope) => scope.root), [ALPHA]);
	assert.deepEqual(calls.trace, [`select:${ALPHA}`], "choosing hands the scope over without closing it");
	view.handleInput("\r");
	view.handleInput("\x1b");
	assert.equal(calls.select.length, 1, "a chosen scope cannot fire again");
	assert.equal(calls.close, 0, "the single-shot guard also blocks a later close");
});

test("esc and ctrl+c close exactly once", () => {
	const escape = createView();
	escape.view.handleInput("\x1b");
	assert.equal(escape.calls.close, 1);
	escape.view.handleInput("\x1b");
	assert.equal(escape.calls.close, 1);
	assert.deepEqual(escape.calls.select, []);

	const ctrlC = createView();
	ctrlC.view.handleInput("\x03");
	assert.equal(ctrlC.calls.close, 1);
	ctrlC.view.handleInput("\x03");
	assert.equal(ctrlC.calls.close, 1);
});

// S19: the hint names a single binding per action even when several are
// functional, so the arrows are the only move option and esc the only close
// option shown while ctrl+j/k and ctrl+c keep working.
test("the scope footer names one option per action while every binding stays functional", () => {
	const { view, calls } = createView();
	const footer = footerText(view.render(100));
	assert.equal(footer, "↑/↓ move • enter choose scope • esc close");
	assert.doesNotMatch(footer, /esc\/ctrl\+c/, "esc is the only close option the footer names");
	assert.doesNotMatch(footer, /ctrl\+j/, "the arrows are the only move option the footer names");
	assert.doesNotMatch(footer, /\bor\b/, "no action is offered twice");

	view.handleInput("\x1b[B");
	assert.match(selectedRow(view.render(100)), /feat\/alpha · alpha/, "down still moves");
	view.handleInput("\x0b");
	assert.match(selectedRow(view.render(100)), /│ ▸ main +│$/, "the unhinted ctrl+k still moves up");
	view.handleInput("\x0a");
	assert.match(selectedRow(view.render(100)), /feat\/alpha · alpha/, "the unhinted ctrl+j still moves down");
	view.handleInput("\x03");
	assert.equal(calls.close, 1, "the unhinted ctrl+c still closes");
	assert.deepEqual(calls.select, []);
});

test("a throwing scope callback still closes the step exactly once", () => {
	const { view, calls } = createView({ onSelect() { throw new Error("picker failed"); } });
	assert.throws(() => view.handleInput("\r"), /picker failed/);
	assert.equal(calls.close, 1, "onClose runs even when choosing a scope throws");
	view.handleInput("\r");
	assert.equal(calls.close, 1, "a completed step never closes twice");
});

test("the wheel moves the selection and clamps at both ends", () => {
	const { view } = createView();
	let lines = view.render(100);
	assert.match(selectedRow(lines), /main/);
	assert.deepEqual(view.handleMouse(mouse(lines, 4, rowOf(lines, "fix/beta"), "wheel", "none", 1)), { handled: true, render: true });
	lines = view.render(100);
	assert.match(selectedRow(lines), /feat\/alpha · alpha/, "the wheel moves the selection");
	assert.deepEqual(view.handleMouse(mouse(lines, 4, rowOf(lines, "fix/beta"), "wheel", "none", 1)), { handled: true, render: true });
	lines = view.render(100);
	assert.match(selectedRow(lines), /fix\/beta · beta/);
	assert.deepEqual(view.handleMouse(mouse(lines, 4, rowOf(lines, "main"), "wheel", "none", 1)), { handled: true, render: false }, "the wheel clamps at the end");
	assert.match(selectedRow(view.render(100)), /│ ▸ fix\/beta · beta +│$/);
	assert.deepEqual(view.handleMouse(mouse(lines, 4, rowOf(lines, "fix/beta"), "wheel", "none", -1)), { handled: true, render: true });
	assert.match(selectedRow(view.render(100)), /feat\/alpha · alpha/, "a wheel up moves back");
});

test("hover paints the shared hover role over an unselected row and clears when the pointer leaves", () => {
	const { view } = createView({ theme: taggedTheme });
	let lines = view.render(100);
	const target = rowOf(lines, "fix/beta");
	const selected = rowOf(lines, "feat/alpha");
	assert.equal(view.handleMouse(mouse(lines, 4, target, "move", "none", undefined, 100))?.render, true);
	lines = view.render(100);
	assert.match(lines[target]!, /<warning>/, "the hovered row is visible");
	assert.doesNotMatch(lines[selected]!, /<warning>/, "the selected row keeps its own role");
	assert.equal(view.handleMouse(mouse(lines, 4, 1, "move", "none", undefined, 100))?.render, true);
	assert.doesNotMatch(view.render(100).join("\n"), /<warning>/, "leaving the rows clears hover");
});

test("a click on a row chooses that row, and a click off the rows chooses nothing", () => {
	const { view, calls } = createView();
	let lines = view.render(100);
	assert.equal(view.handleMouse(mouse(lines, 4, 1)), undefined, "the header row is not a scope");
	assert.equal(view.handleMouse(mouse(lines, 4, lines.length - 2)), undefined, "the footer row is not a scope");
	assert.equal(view.handleMouse(mouse(lines, 4, lines.length - 3)), undefined, "the focused-scope detail row is not a scope");
	assert.deepEqual(calls.select, []);
	assert.deepEqual(view.handleMouse(mouse(lines, 4, rowOf(lines, "fix/beta"))), { handled: true, render: true });
	assert.deepEqual(calls.select.map((scope) => scope.root), [BETA], "a click is a confirm on this single-choice step");
	assert.deepEqual(calls.trace, [`select:${BETA}`]);
	assert.equal(calls.close, 0);
	lines = view.render(100);
	assert.equal(view.handleMouse(mouse(lines, 4, rowOf(lines, "main"))), undefined, "a completed view keeps no pointer frame");
});

test("the pointer frame is rebuilt on render and dropped on invalidate, dispose and size change", () => {
	const invalidated = createView();
	let lines = invalidated.view.render(100);
	invalidated.view.invalidate();
	assert.equal(invalidated.view.handleMouse(mouse(lines, 4, rowOf(lines, "main"))), undefined, "invalidate drops the frame");
	assert.deepEqual(invalidated.calls.select, []);

	const disposed = createView();
	lines = disposed.view.render(100);
	disposed.view.dispose();
	assert.equal(disposed.view.handleMouse(mouse(lines, 4, rowOf(lines, "main"))), undefined, "dispose drops the frame");
	disposed.view.handleInput("\r");
	assert.deepEqual(disposed.calls.select, [], "a disposed view ignores input");

	const resized = createView();
	lines = resized.view.render(100);
	assert.equal(resized.view.handleMouse(mouse(lines, 4, rowOf(lines, "main"), "click", "left", undefined, 90)), undefined, "a size change drops the frame");
	lines = resized.view.render(100);
	assert.deepEqual(resized.view.handleMouse(mouse(lines, 4, rowOf(lines, "main"))), { handled: true, render: true }, "the next render rebuilds the frame");
});

test("an empty scope list renders its message instead of a blank card and never crashes", () => {
	const { view, calls } = createView({}, []);
	const lines = view.render(100);
	const body = bodyText(lines);
	assert.match(body, /No worktrees/);
	assert.match(body, /File picker/);
	assert.match(body, /↑\/↓ move • enter choose scope • esc close/);
	assert.equal(visibleWidth(lines[0]!), 100);
	view.handleInput("\r");
	view.handleInput("\x1b[B");
	assert.deepEqual(calls.select, [], "an empty step has nothing to choose");
	assert.equal(calls.close, 0);
	const single = createView({}, [SCOPES[0]!]).view.render(100);
	assert.match(bodyText(single), /main/);
});

test("a long scope list keeps the selected row visible with the more indicators and every line fits", () => {
	const scopes = Array.from({ length: 30 }, (_, index): FileScope => ({
		root: `/work/w${index}`,
		label: `branch-${index} · w${index}`,
		kind: "worktree",
		lastModifiedMs: 1000 - index,
	}));
	const { view } = createView({ rows: 12 }, scopes);
	for (let index = 0; index < 20; index += 1) view.handleInput("\x1b[B");
	const lines = view.render(100);
	const body = bodyText(lines);
	assert.match(selectedRow(lines), /branch-20 · w20/);
	assert.match(body, /↑ \d+ more/);
	assert.match(body, /↓ \d+ more/);
	for (const line of lines) assert.equal(visibleWidth(line), 100);
	const hit = rowOf(lines, "branch-20");
	assert.deepEqual(view.handleMouse(mouse(lines, 4, hit)), { handled: true, render: true }, "a windowed row is clickable where it is painted");
});

// S32: each row reports how many files the scope has changed in the working
// tree, right-aligned and in the theme's key colour, and a scope with no
// uncommitted file paints no count at all.
test("each scope row reports its uncommitted files at the right, in the theme's key colour", () => {
	const scopes: FileScope[] = [
		{ ...SCOPES[0]!, detail: { changedFiles: 3 } },
		{ ...SCOPES[1]!, detail: { changedFiles: 1 } },
		{ ...SCOPES[2]!, detail: { changedFiles: 0 } },
	];
	const { view } = createView({ theme: ansiTheme }, scopes);
	const lines = view.render(100);
	for (const line of lines) assert.equal(visibleWidth(line), 100, "a count never widens the card");
	const rows = lines.map((line) => stripAnsi(line));
	const mainRow = rowOf(lines, "main");
	assert.match(rows[mainRow]!, /^│ ▸ main +3 files changed │$/, `the count sits at the right edge of the selected row: ${rows[mainRow]}`);
	assert.match(rows[rowOf(lines, "feat/alpha")]!, /^│   feat\/alpha · alpha +1 file changed │$/, "one changed file is singular");
	assert.match(rows[rowOf(lines, "fix/beta")]!, /^│   fix\/beta · beta +│$/, "a scope with no uncommitted file paints no count");
	assert.ok(lines[mainRow]!.includes(`${ANSI_ACCENT}3 files changed`), "the count takes the theme's key colour");
	assert.ok(mainRow < rowOf(lines, "feat/alpha") && rowOf(lines, "feat/alpha") < rowOf(lines, "fix/beta"), "main is the first row and the worktrees follow by recency");
});

// S32: the scope step's keys are painted like the other panels' — the key in
// the theme's key colour, the label neutral — while the footer text is the
// same one option per action list.
test("the footer keys take the theme's key colour with neutral labels, keeping the text", () => {
	const tagged = createView({ theme: taggedTheme }).view.render(200);
	const footer = tagged[tagged.length - 2]!;
	assert.equal(footerText(createView().view.render(100)), "↑/↓ move • enter choose scope • esc close", "the footer text is unchanged");
	assert.match(footer, /<accent>↑\/↓<\/accent> <dim>move<\/dim>/, "the move key takes the key colour");
	assert.match(footer, /<accent>enter<\/accent> <dim>choose scope<\/dim>/, "the choose key takes the key colour");
	assert.match(footer, /<accent>esc<\/accent> <dim>close<\/dim>/, "the close key takes the key colour");
	assert.equal(tagged.filter((line) => line.includes("↑/↓ move") || line.includes("<accent>↑/↓</accent>")).length, 1, "the footer is the only row that names the keys");
});

// S33: the focused scope's data leaves the row and lands on one line directly
// above the footer — uncommitted files, last modification, last commit and the
// comparison with its reference — and a field that is zero or absent is silent.
test("the row above the footer paints the focused scope's detail and never a zero field", () => {
	const now = 1_700_010_000_000;
	const scopes: FileScope[] = [
		{ ...SCOPES[0]!, detail: { changedFiles: 3, lastModifiedMs: now - 5 * 3_600_000, lastCommitSubject: "feat: add the picker", ahead: 2, behind: 0, comparison: "main" } },
		{ ...SCOPES[1]!, detail: { changedFiles: 0, lastModifiedMs: now - 3 * 86_400_000, lastCommitSubject: "fix: alpha only", ahead: 0, behind: 1, comparison: "main" } },
		{ ...SCOPES[2]! },
	];
	const { view } = createView({ now }, scopes);
	const detail = (frame: readonly string[]): string => stripAnsi(frame[frame.length - 3]!).slice(2, -2).trim();
	let lines = view.render(120);
	assert.equal(detail(lines), "3 files changed · 5h · feat: add the picker · 2 ahead of main", "the zero `behind` field is not painted");
	assert.equal(footerText(lines), "↑/↓ move • enter choose scope • esc close", "the detail line sits directly above the footer");
	view.handleInput("\x1b[B");
	lines = view.render(120);
	assert.equal(detail(lines), "3d · fix: alpha only · 1 behind main", "a zero `changedFiles` field is not painted");
	view.handleInput("\x1b[B");
	lines = view.render(120);
	assert.equal(detail(lines), "", "a scope with no measured detail paints an empty line, not a fabricated zero");
	for (const line of lines) assert.equal(visibleWidth(line), 120);
});

test("a detail line wider than the card is elided instead of breaking the frame", () => {
	const scopes: FileScope[] = [{ ...SCOPES[0]!, detail: { changedFiles: 1, lastCommitSubject: "x".repeat(200), comparison: "main" } }];
	const { view } = createView({ now: 1_700_010_000_000 }, scopes);
	const lines = view.render(72);
	for (const line of lines) assert.equal(visibleWidth(line), 72);
	assert.match(stripAnsi(lines[lines.length - 3]!), /…/, "the over-long detail is elided, never wrapped or dropped");
});

// S33: the Git half of the detail line is injected, so one lookup that fails,
// is truncated or cannot be parsed must leave its field absent — a repository
// without a remote or without commits paints less, never a fabricated zero.
test("loadScopeDetail asks for the comparison range and the last commit subject through the injected runner", async () => {
	const calls: string[][] = [];
	const git = async (args: string[]) => {
		calls.push(args);
		return args[0] === "rev-list" ? { stdout: "3\t2\n", code: 0 } : { stdout: "fix: the thing\n", code: 0 };
	};
	assert.deepEqual(await loadScopeDetail(git, "main"), { comparison: "main", ahead: 2, behind: 3, lastCommitSubject: "fix: the thing" });
	assert.deepEqual(calls, [["rev-list", "--left-right", "--count", "main...HEAD"], ["log", "-1", "--format=%s"]], "one range and one subject, against the named comparison ref");
});

test("a failed, truncated or unparsable lookup leaves its field absent instead of a zero", async () => {
	const failing = async (): Promise<{ stdout: string; code: number }> => { throw new Error("git unavailable"); };
	assert.deepEqual(await loadScopeDetail(failing, "origin/main"), { comparison: "origin/main" }, "no remote at all paints no comparison");
	const noRef = async () => ({ stdout: "", code: 128 });
	assert.deepEqual(await loadScopeDetail(noRef, "origin/main"), { comparison: "origin/main" }, "a missing ref is absent, not level with main");
	const truncated = async (args: string[]) => args[0] === "rev-list" ? { stdout: "1\t0\n", code: 0, truncated: true } : { stdout: "", code: 0 };
	assert.deepEqual(await loadScopeDetail(truncated, "main"), { comparison: "main" }, "a truncated range is never read as a count");

	assert.deepEqual(parseAheadBehind("3\t2\n"), { ahead: 2, behind: 3 }, "the left count is behind and the right count ahead");
	assert.deepEqual(parseAheadBehind("0\t0"), { ahead: 0, behind: 0 }, "a zero range is data; the painter is what drops it");
	assert.equal(parseAheadBehind(""), undefined);
	assert.equal(parseAheadBehind("not\tcounts"), undefined);
	assert.equal(parseAheadBehind("1\t2\t3"), undefined);
});

test("scopeDetailLine names only the fields that carry a value", () => {
	const now = 1_700_010_000_000;
	assert.equal(scopeDetailLine({}, now), "");
	assert.equal(scopeDetailLine({ changedFiles: 1 }, now), "1 file changed");
	assert.equal(scopeDetailLine({ changedFiles: 2, ahead: 0, behind: 0, comparison: "main" }, now), "2 files changed", "level with main paints neither side");
	assert.equal(scopeDetailLine({ lastModifiedMs: now - 30_000 }, now), "30s");
	assert.equal(scopeDetailLine({ lastModifiedMs: now - 2 * 3_600_000 }, now), "2h");
	assert.equal(scopeDetailLine({ lastModifiedMs: now - 4 * 86_400_000 }, now), "4d");
	assert.equal(scopeDetailLine({ behind: 2, comparison: "origin/main" }, now), "2 behind origin/main");
	assert.equal(scopeDetailLine({ ahead: 1, comparison: "main" }, now), "1 ahead of main");
});
