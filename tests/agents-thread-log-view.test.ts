import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderThreadLogItem } from "../lib/agents-thread-log-view.ts";

// The registry view is the pane's original renderer, kept whole: a labelled log
// of the retained items, four spaces of indentation inside a tool's output, no
// cards, no Markdown and no inference about what a call was doing. These are the
// exact rows the design drew before the chat view existed, so they are pinned
// here rather than described.

const plainTheme = { fg: (_color: string, text: string) => text };
const rows = (item: Parameters<typeof renderThreadLogItem>[0], width = 40) => renderThreadLogItem(item, plainTheme, width);

test("prose, thinking and notes keep their own labelled rows and two-column indent", () => {
	assert.deepEqual(rows({ kind: "text" as const, text: "hello\nworld" }), ["Text", "  hello", "  world"]);
	assert.deepEqual(rows({ kind: "thinking" as const, text: "weighing options" }), ["Thinking", "  weighing options"]);
	assert.deepEqual(rows({ kind: "note" as const, text: "a note" }), ["Note", "  a note"]);
});

test("a blank line inside an item is kept as the indented blank row it was", () => {
	assert.deepEqual(rows({ kind: "text" as const, text: "a\n\nb" }), ["Text", "  a", "  ", "  b"]);
});

test("a tool call keeps the original status header and its four-column output block", () => {
	const completed = { kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: "suite 1\nsuite 2", running: false, isError: false };
	assert.deepEqual(rows(completed), ["Tool · bash · Complete", "  Output", "    suite 1", "    suite 2"]);
	assert.deepEqual(rows({ ...completed, running: true }), ["Tool · bash · Running", "  Output", "    suite 1", "    suite 2"]);
	assert.deepEqual(rows({ ...completed, isError: true }), ["Tool · bash · Error", "  Output", "    suite 1", "    suite 2"]);
	assert.deepEqual(rows({ ...completed, output: "" }), ["Tool · bash · Complete"], "a call with no output is its header alone");
});

test("the registry view infers nothing from a call's arguments", () => {
	// The chat view heads a shell call with its ODD phase and a file call with the
	// file it names. The original view never did: the row names the tool, its
	// status, and nothing else.
	assert.deepEqual(rows({ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: "", running: false, isError: false })[0], "Tool · bash · Complete");
	assert.deepEqual(rows({ kind: "tool" as const, callId: "r", name: "read", args: { path: "lib/x.ts" }, output: "", running: false, isError: false })[0], "Tool · read · Complete");
});

test("a note the chat draws as an input card is a plain labelled note here", () => {
	assert.deepEqual(rows({ kind: "note" as const, text: "steered: try the parser" }), ["Note", "  steered: try the parser"]);
});

test("every row fits the width it was given, however narrow", () => {
	for (const width of [1, 3, 10, 40]) {
		for (const item of [
			{ kind: "text" as const, text: "aaa bbb ccc ddd" },
			{ kind: "thinking" as const, text: "aaa bbb ccc ddd" },
			{ kind: "note" as const, text: "aaa bbb ccc ddd" },
			{ kind: "tool" as const, callId: "c", name: "bash", args: {}, output: "aaa bbb ccc ddd", running: false, isError: false },
		]) {
			const drawn = rows(item, width);
			assert.ok(drawn.length > 0, `width ${width} still draws the item`);
			for (const row of drawn) assert.ok(visibleWidth(row) <= width, `${JSON.stringify(row)} exceeds ${width} columns`);
		}
	}
	const wrapped = rows({ kind: "text" as const, text: "aaa bbb ccc ddd eee" }, 12).join("\n");
	assert.match(wrapped, /aaa/, "content that does not fit wraps instead of disappearing");
	assert.match(wrapped, /eee/);
	assert.deepEqual(rows({ kind: "text" as const, text: "hello" }, 0), [], "no columns means no rows");
});
