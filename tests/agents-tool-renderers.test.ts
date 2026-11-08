import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { createEditTool, initTheme } from "@earendil-works/pi-coding-agent";
import { applyTaskEvent, emptyThread, normalizeRpcEvent, TASK_EVENT, type ToolItem } from "../lib/agents-protocol.ts";
import { TOOL_DETAIL_MAX_CHARS } from "../lib/agents-protocol.ts";
import { createQuietToolRenderer } from "../extensions/quiet-tools.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import {
	agentToolRendererNames,
	clearAgentToolRenderers,
	registerAgentToolRenderers,
	renderAgentToolItem,
	type AgentToolRendererTheme,
} from "../lib/agents-tool-renderers.ts";

// The chat's own renderers resolve their key hints through pi's theme singleton,
// exactly as they do in the transcript; a case that draws them initializes it.
initTheme("dark");

// The registry is process-wide (extensions load in their own module cache), so
// every case starts from an empty one instead of inheriting its neighbour's.
test.afterEach(() => clearAgentToolRenderers());

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => `<b>${text}</b>`,
};
const bareTheme = { fg: (color: string, text: string) => `[${color}]${text}` };

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
	return { kind: "tool", callId: "call-1", name: "read", args: { path: "lib/x.ts" }, output: "line one", running: false, isError: false, ...overrides };
}

/** The drawn rows, without the padding a component adds to its width. */
function drawn(item: ToolItem, theme: AgentToolRendererTheme, expanded = false): string[] | undefined {
	return renderAgentToolItem(item, theme, 40, { expanded })?.map((row) => row.trimEnd());
}

interface Seen {
	kind: "call" | "result";
	args?: unknown;
	result?: unknown;
	options?: unknown;
	theme?: unknown;
	context?: Record<string, unknown>;
}

/** A stand-in for a chat renderer: draws the whole row itself and records what it was handed. */
function fakeRenderers(callText = "CALL", resultText = "RESULT", extra: Record<string, unknown> = {}) {
	const seen: Seen[] = [];
	return {
		seen,
		renderers: {
			renderShell: "self" as const,
			renderCall(args: unknown, theme: unknown, context: Record<string, unknown>) {
				seen.push({ kind: "call", args, theme, context });
				return new Text(callText, 0, 0);
			},
			renderResult(result: unknown, options: unknown, theme: unknown, context: Record<string, unknown>) {
				seen.push({ kind: "result", result, options, theme, context });
				return new Text(resultText, 0, 0);
			},
			...extra,
		},
	};
}

test("a tool with no reusable chat renderer is left to the preview's own card", () => {
	assert.equal(drawn(tool(), plainTheme), undefined, "nothing is invented for a tool the chat does not draw");
	assert.deepEqual(agentToolRendererNames(), []);
});

test("a retained call hands the chat's renderer the display details the thread kept", () => {
	// An edit's card counts the rows of its display diff and draws that diff when
	// expanded. Both are details, not text, so the pane passes the diff the child
	// produced instead of letting the card fall back to `✓ applied`.
	const { renderers, seen } = fakeRenderers();
	registerAgentToolRenderers({ edit: renderers as never });
	const diff = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-1 old\n+1 new";
	drawn(tool({ name: "edit", args: { path: "a.ts" }, details: { diff } }), plainTheme);
	assert.deepEqual(seen[1]!.result, { content: [{ type: "text", text: "line one" }], details: { diff } }, "the edit's own diff reaches the card that counts it");
	// A call carrying no details is handed none, exactly as before: the card states
	// what it can and never a diff the preview would have had to invent.
	drawn(tool({ name: "edit", args: { path: "a.ts" } }), plainTheme);
	assert.deepEqual(seen[3]!.result, { content: [{ type: "text", text: "line one" }], details: undefined });
});

// Details are re-validated where they are handed over, because the item may have
// been restored from disk, copied from a hand-built thread, or written by a later
// version: the item is not evidence that its payload is well formed.
test("details are re-validated at the drawing boundary, so no item can smuggle a payload", () => {
	const { renderers, seen } = fakeRenderers();
	registerAgentToolRenderers({ edit: renderers as never });
	const handed = (item: ToolItem) => {
		drawn(item, plainTheme);
		return (seen.at(-1)!.result as { details?: unknown }).details;
	};
	const diff = "-1 old\n+1 new";
	assert.deepEqual(handed(tool({ name: "edit", details: { diff } })), { diff });
	// Untrusted bytes are removed before the card sees them, and the text stays.
	assert.deepEqual(handed(tool({ name: "edit", details: { diff: "\u001b[31m-1 old\u001b[0m" } })), { diff: "-1 old" });
	for (const details of [
		{ diff: 7 }, { diff: null }, { diff: ["-1"] }, { patch: "x" },
		"diff", 7, [],
	]) {
		assert.equal(handed(tool({ name: "edit", details: details as never })), undefined, `${JSON.stringify(details)?.slice(0, 40)} is not a diff`);
	}
	// The field is per tool: a diff under another tool's name has no card here.
	assert.equal(handed(tool({ name: "read", args: { path: "a.ts" }, details: { diff } })), undefined);
	// A cut diff's whole-edit totals ride along as structured numbers, re-checked here so a
	// hand-built or restored item cannot hand the card a count the edit never produced.
	const cut = { diff: " … diff truncated: 1 of 5 rows shown; the whole edit is +2 / -1\n+1 new", truncated: { rows: 5, additions: 2, removals: 1 } };
	assert.deepEqual(handed(tool({ name: "edit", details: cut })), cut);
	assert.deepEqual(handed(tool({ name: "edit", details: { ...cut, truncated: { rows: "2" } } as never })), { diff: cut.diff }, "a malformed claim is dropped and the diff kept");
});

/** The rows and the added/removed counts the chat's edit card reads off a display diff. */
function counted(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const row of diff.split("\n")) {
		if (row.startsWith("+") && !row.startsWith("+++")) additions += 1;
		if (row.startsWith("-") && !row.startsWith("---")) removals += 1;
	}
	return { additions, removals };
}

/**
 * One delegated edit, end to end and with nothing fabricated: the child's native
 * edit tool executes on a real file, the protocol normalizes the event it produced,
 * the store keeps the item, and the pane draws it with the chat's own edit card.
 */
async function delegatedEdit(t: { after(fn: () => Promise<void>): void }, lines: number, blocks: number): Promise<{ item: ToolItem; childDiff: string }> {
	const dir = await mkdtemp(join(tmpdir(), "gentle-pane-edit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const source = Array.from({ length: lines }, (_row, index) => `export function fn${index}(value: number): number { return value + ${index}; }`).join("\n");
	await writeFile(join(dir, "src.ts"), `${source}\n`, "utf8");
	const edits = Array.from({ length: blocks }, (_block, index) => ({
		oldText: `export function fn${index}(value: number): number { return value + ${index}; }`,
		newText: `export function fn${index}(value: number): number {\n  const scaled = value * ${index};\n  return scaled + ${index};\n}`,
	}));
	const result = await createEditTool(dir).execute("call-1", { path: "src.ts", edits } as never, undefined, undefined);
	const thread = [
		{ type: TASK_EVENT.TOOL_START, callId: "call-1", name: "edit", args: { path: "src.ts", edits: [] } },
		...normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result, isError: false }),
	].reduce((current, event) => applyTaskEvent(current, event as never), emptyThread());
	return { item: thread.items[0] as ToolItem, childDiff: (result.details as { diff: string }).diff };
}

// The reported failure: an expanded delegated edit showed `✓ applied` and no diff in
// the Agents pane while the transcript counted and drew the same change. The pane
// reuses the chat's card, so the same real edit has to read the same way in both.
test("a realistic large delegated edit draws the chat's own counts and diff, not an acknowledgement", async (t) => {
	const { item, childDiff } = await delegatedEdit(t, 400, 60);
	assert.ok(childDiff.length > 8_000, `the case is a real large diff: ${childDiff.length} characters`);
	registerAgentToolRenderers({ edit: createQuietToolRenderer("edit") }, { owner: "quiet-tools" });
	const rows = (expanded: boolean) => renderAgentToolItem(item, plainTheme, 100, { expanded })!.map((row) => stripAnsi(row).trimEnd());
	// Collapsed: the same `✓ +N / -M` the transcript states, from the diff itself.
	const collapsed = rows(false).join("\n");
	const { additions, removals } = counted(childDiff);
	assert.match(collapsed, new RegExp(`✓ \\+${additions} / -${removals}`), "the pane states the counts the edit really produced");
	assert.doesNotMatch(collapsed, /applied/, "an acknowledgement is not the card the transcript draws");
	// Expanded: the child's own diff rows, styled as the transcript styles them.
	const expanded = rows(true).join("\n");
	const firstRemoved = childDiff.split("\n").find((row) => row.startsWith("-"))!;
	const firstAdded = childDiff.split("\n").find((row) => row.startsWith("+"))!;
	assert.ok(expanded.includes(firstRemoved.trimEnd()), `the expanded card is the child's diff: ${firstRemoved}`);
	assert.ok(expanded.includes(firstAdded.trimEnd()), `including every added row: ${firstAdded}`);
	assert.doesNotMatch(expanded, /Successfully replaced/, "the acknowledgement is not what the expanded card shows");
	assert.doesNotMatch(expanded, /diff truncated/, "a diff inside the budget is drawn whole");
});

// The budget is a bound, not a cliff: a real diff past it is cut at a row boundary and
// opens with a marker row, and the whole edit's own totals travel as structured numbers
// the protocol counted — so the collapsed card states the edit's real totals and says the
// diff is truncated, and never presents the rows it happens to hold as the whole edit.
test("a delegated edit past the budget states its truncation instead of dropping its diff", async (t) => {
	const { item, childDiff } = await delegatedEdit(t, 2_000, 400);
	assert.ok(childDiff.length > TOOL_DETAIL_MAX_CHARS, `the case is over the budget: ${childDiff.length} characters`);
	const whole = counted(childDiff);
	assert.equal(item.details?.truncated?.additions, whole.additions, "the whole edit's totals are carried, not parsed from the diff text");
	assert.equal(item.details?.truncated?.removals, whole.removals);
	registerAgentToolRenderers({ edit: createQuietToolRenderer("edit") }, { owner: "quiet-tools" });
	const rows = (expanded: boolean) => renderAgentToolItem(item, plainTheme, 100, { expanded })!.map((row) => stripAnsi(row).trimEnd());
	// Expanded: the truncation is stated before the rows, with the edit's whole totals.
	const expanded = rows(true).join("\n");
	const firstRemoved = childDiff.split("\n").find((row) => row.startsWith("-"))!;
	assert.match(expanded, /diff truncated/, "the pane says the diff was truncated");
	assert.match(expanded, new RegExp(`\\+${whole.additions} / -${whole.removals}`), "and states the edit's whole totals");
	assert.ok(expanded.includes(firstRemoved.trimEnd()), `it still draws the child's own rows: ${firstRemoved}`);
	assert.doesNotMatch(expanded, /applied/);
	// Collapsed: the summary is the whole edit's totals plus the truncation itself, so a
	// partial count is never presented as the edit's own.
	const collapsed = rows(false).join("\n");
	assert.ok(collapsed.includes(`✓ +${whole.additions} / -${whole.removals} · truncated`), `the collapsed card states the whole totals and the truncation: ${collapsed}`);
	assert.doesNotMatch(collapsed, /applied/);
	const keptAdditions = counted(item.details!.diff).additions;
	assert.ok(keptAdditions < whole.additions, "the rows the pane holds really are fewer than the edit made");
	assert.equal(collapsed.includes(`+${keptAdditions} /`), false, "and the partial count is not what the card states");
});

test("a registered renderer draws the call and then its result, exactly as the chat composes one row", () => {
	const { renderers, seen } = fakeRenderers("TOP", "BODY");
	assert.deepEqual(registerAgentToolRenderers({ read: renderers as never }), ["read"], "the registration names what it accepted");
	assert.deepEqual(drawn(tool(), plainTheme), ["TOP", "BODY"]);
	// The row is one tool call: the call slot, then the result that closes it.
	assert.deepEqual(seen.map((entry) => entry.kind), ["call", "result"]);
	// Both slots are handed the retained call, its expansion and the preview's own state.
	const call = seen[0]!;
	assert.deepEqual(call.args, { path: "lib/x.ts" });
	assert.equal(call.context?.expanded, false);
	assert.equal(call.context?.isPartial, false);
	assert.equal(call.context?.isError, false);
	assert.equal(call.context?.argsComplete, true);
	// The result slot gets the retained text result, never a reconstructed one.
	const result = seen[1]!;
	assert.deepEqual(result.result, { content: [{ type: "text", text: "line one" }], details: undefined });
	assert.deepEqual(result.options, { expanded: false, isPartial: false });
	// `expanded` follows the preview, so one card never reads two ways.
	assert.deepEqual(drawn(tool(), plainTheme, true), ["TOP", "BODY"]);
	assert.equal(seen[2]!.context?.expanded, true, "the call slot sees the expanded state");
	assert.deepEqual(seen[3]!.options, { expanded: true, isPartial: false }, "and so does the result slot");
});

test("a call still running with no output draws only its call, as the transcript does", () => {
	const { renderers, seen } = fakeRenderers("TOP", "BODY");
	registerAgentToolRenderers({ read: renderers as never });
	assert.deepEqual(drawn(tool({ running: true, output: "" }), plainTheme), ["TOP"]);
	assert.deepEqual(seen.map((entry) => entry.kind), ["call"], "no result exists yet, so none is invented");
	assert.equal(seen[0]!.context?.isPartial, true, "the call slot knows the row is still running");
});

test("a finished call with no output still draws its result, because that row closes the card", () => {
	const { renderers, seen } = fakeRenderers("TOP", "BODY");
	registerAgentToolRenderers({ read: renderers as never });
	assert.deepEqual(drawn(tool({ output: "" }), plainTheme), ["TOP", "BODY"]);
	assert.deepEqual(seen.map((entry) => entry.kind), ["call", "result"]);
});

test("a running call that already streamed output draws its partial result too", () => {
	const { renderers, seen } = fakeRenderers("TOP", "BODY");
	registerAgentToolRenderers({ read: renderers as never });
	assert.deepEqual(drawn(tool({ running: true, output: "partial" }), plainTheme), ["TOP", "BODY"]);
	assert.deepEqual(seen[1]!.options, { expanded: false, isPartial: true });
});

test("a renderer that pi wraps in its own shell is not reused verbatim", () => {
	// Only a renderer that draws the whole row can be reused as it stands: for any
	// other, pi adds a shell and padding this preview cannot reproduce, so reusing
	// the component would show a row the chat never draws.
	const { renderers } = fakeRenderers();
	assert.deepEqual(registerAgentToolRenderers({
		wrapped: { ...renderers, renderShell: undefined } as never,
		headless: { renderShell: "self", renderResult: renderers.renderResult } as never,
		read: renderers as never,
	}), ["read"]);
	assert.equal(drawn(tool({ name: "wrapped" }), plainTheme), undefined);
	assert.equal(drawn(tool({ name: "headless" }), plainTheme), undefined, "a renderer with no call slot is not a whole row");
});

test("a renderer that throws leaves the row to the preview's own card instead of a half-drawn one", () => {
	const failing = {
		renderShell: "self" as const,
		renderCall() { throw new Error("boom"); },
		renderResult() { return new Text("BODY", 0, 0); },
	};
	registerAgentToolRenderers({ read: failing as never });
	assert.equal(drawn(tool(), plainTheme), undefined);

	const failingResult = {
		renderShell: "self" as const,
		renderCall() { return new Text("TOP", 0, 0); },
		renderResult() { throw new Error("boom"); },
	};
	clearAgentToolRenderers();
	registerAgentToolRenderers({ read: failingResult as never });
	assert.equal(drawn(tool(), plainTheme), undefined);
});

test("the preview's theme reaches the chat renderer with the attributes a card may ask for", () => {
	const first = fakeRenderers();
	registerAgentToolRenderers({ read: first.renderers as never });
	drawn(tool(), plainTheme);
	const theme = first.seen[0]!.theme as Record<string, (text: string) => string> & { fg: (color: string, text: string) => string };
	// A chat card names its roles and bolds its tool name; a theme without a
	// background must still answer every one of those without inventing paint.
	assert.equal(theme.fg("accent", "x"), "x");
	assert.equal(theme.bold("read"), "<b>read</b>", "an attribute the theme has is kept");
	// A theme carrying no attribute at all degrades to the text, never to an error.
	clearAgentToolRenderers();
	const second = fakeRenderers();
	registerAgentToolRenderers({ read: second.renderers as never });
	drawn(tool(), bareTheme);
	const bare = second.seen[0]!.theme as Record<string, (text: string) => string> & { fg: (color: string, text: string) => string };
	assert.equal(bare.fg("mdCode", "y"), "[mdCode]y");
	assert.equal(bare.bold("edit"), "edit");
	assert.equal(bare.italic("edit"), "edit");
});

test("a retained call hands the chat's renderer the child's own measured duration", () => {
	// The card draws an elapsed time from the render context's `durationMs`, and the
	// protocol retains exactly one source for it: the child's own measurement on its
	// `tool_execution_end`. Anything else would be a time the preview made up.
	const measured = fakeRenderers();
	registerAgentToolRenderers({ read: measured.renderers as never });
	drawn(tool({ durationMs: 1234 }), plainTheme);
	assert.equal(measured.seen[0]!.context?.durationMs, 1234, "the number the child measured reaches the card unchanged");
	drawn(tool({ durationMs: 0 }), plainTheme);
	assert.equal(measured.seen[2]!.context?.durationMs, 0, "zero is a measurement, not an absence");

	// A call the child did not measure is handed nothing, so its card draws no time.
	clearAgentToolRenderers();
	const unmeasured = fakeRenderers();
	registerAgentToolRenderers({ read: unmeasured.renderers as never });
	drawn(tool(), plainTheme);
	assert.equal(unmeasured.seen[0]!.context?.durationMs, undefined);

	// A running call has not finished, so no measurement exists to hand down.
	clearAgentToolRenderers();
	const running = fakeRenderers();
	registerAgentToolRenderers({ read: running.renderers as never });
	drawn(tool({ running: true, output: "partial", durationMs: 900 }), plainTheme);
	assert.equal(running.seen[0]!.context?.durationMs, undefined);

	// A malformed number is not a measurement, so the pane never draws a made-up time.
	for (const malformed of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		clearAgentToolRenderers();
		const seenBad = fakeRenderers();
		registerAgentToolRenderers({ read: seenBad.renderers as never });
		drawn(tool({ durationMs: malformed }), plainTheme);
		assert.equal(seenBad.seen[0]!.context?.durationMs, undefined, `${String(malformed)} is not a duration`);
	}
});

test("one registration replaces the previous one and clearing empties the registry", () => {
	registerAgentToolRenderers({ read: fakeRenderers("FIRST").renderers as never });
	assert.deepEqual(agentToolRendererNames(), ["read"]);
	registerAgentToolRenderers({ read: fakeRenderers("SECOND").renderers as never });
	assert.deepEqual(drawn(tool(), plainTheme), ["SECOND", "RESULT"], "the newest win: a re-registration is the chat's current renderer");
	clearAgentToolRenderers();
	assert.deepEqual(agentToolRendererNames(), []);
	assert.equal(drawn(tool(), plainTheme), undefined);
});

test("an owner's next registration withdraws the cards it no longer draws", () => {
	// quiet-tools withdraws its offers when a load disables it, so a card the
	// transcript stopped drawing may not linger in the pane.
	registerAgentToolRenderers({ read: fakeRenderers("READ").renderers as never, edit: fakeRenderers("EDIT").renderers as never }, { owner: "quiet-tools" });
	assert.deepEqual(agentToolRendererNames().sort(), ["edit", "read"]);

	assert.deepEqual(
		registerAgentToolRenderers({ read: fakeRenderers("READ").renderers as never }, { owner: "quiet-tools" }),
		["read"],
		"the registration reports what this owner still offers",
	);
	assert.deepEqual(agentToolRendererNames(), ["read"], "edit was dropped without being re-offered");
	assert.equal(drawn(tool({ name: "edit", args: { path: "a.ts" } }), plainTheme), undefined, "and the preview draws its own card for it again");

	clearAgentToolRenderers("quiet-tools");
	assert.deepEqual(agentToolRendererNames(), [], "an empty offer withdraws the rest");
});

test("withdrawing one owner never takes a card another owner offered away", () => {
	// Two modules can draw one tool name while an override is loading or being
	// replaced; the newest offer wins, and only the owner that made it can drop it.
	registerAgentToolRenderers({ read: fakeRenderers("OWNER-A").renderers as never }, { owner: "a" });
	registerAgentToolRenderers({ read: fakeRenderers("OWNER-B").renderers as never }, { owner: "b" });
	assert.deepEqual(drawn(tool(), plainTheme), ["OWNER-B", "RESULT"], "the newest offer for a name is the one drawn");

	clearAgentToolRenderers("a");
	assert.deepEqual(agentToolRendererNames(), ["read"], "owner A's withdrawal leaves owner B's offer in place");
	assert.deepEqual(drawn(tool(), plainTheme), ["OWNER-B", "RESULT"]);

	clearAgentToolRenderers("b");
	assert.deepEqual(agentToolRendererNames(), []);
});

test("the registry is one per process, so a separately loaded module copy sees it", async () => {
	// pi loads every extension with its own module cache, so the extension that
	// owns a renderer and the extension that draws the pane may hold two copies of
	// this module. A registry kept per module instance would leave the pane empty.
	registerAgentToolRenderers({ read: fakeRenderers("SHARED").renderers as never });
	// A query string is a second module instance to the loader, and a variable
	// specifier keeps this file from resolving one at all in the type checker.
	const secondInstance = "../lib/agents-tool-renderers.ts?second-instance";
	const copy: typeof import("../lib/agents-tool-renderers.ts") = await import(secondInstance);
	assert.deepEqual(copy.agentToolRendererNames(), ["read"]);
	assert.deepEqual(copy.renderAgentToolItem(tool(), plainTheme, 40, { expanded: false })?.map((row: string) => row.trimEnd()), ["SHARED", "RESULT"]);
});

test("the preview draws the ODD card's heading role, not a color of its own", () => {
	// The card names a theme role, so the adapter only forwards roles and the pane reads
	// the heading and the rail exactly as the transcript does.
	registerAgentToolRenderers({ read: createQuietToolRenderer("read") }, { owner: "quiet-tools" });
	const tagged = { fg: (color: string, text: string) => `[${color}]${text}`, bold: (text: string) => text };
	const rows = drawn(tool({ args: { path: "odd/work/design.md" } }), tagged as never) ?? [];
	const heading = rows.find((row) => row.includes("📑")) ?? "";
	assert.match(heading, /\[mdHeading\]📑 odd/, "the heading wears the theme's heading role");
	const rail = rows.find((row) => row.includes("line one")) ?? "";
	assert.match(rail, /\[mdHeading\]/, "and so does the rail that leads its rows");
});

// The same two states the transcript draws, through the renderer the extension actually
// registers: collapsed the card names the file, expanded it states the whole path the call
// touched, and the read keeps the line range it asked for in both. Measured at the width
// the pane is drawn at, because an artifact mark is two columns wide.
test("a registered file renderer states the file collapsed and the path expanded, at every width", () => {
	const flatTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	registerAgentToolRenderers({
		read: createQuietToolRenderer("read"),
		edit: createQuietToolRenderer("edit"),
		write: createQuietToolRenderer("write"),
	}, { owner: "quiet-tools" });
	const rows = (name: string, args: Record<string, unknown>, expanded: boolean, width = 60) =>
		(renderAgentToolItem(tool({ name, args, output: "one" }), flatTheme, width, { expanded }) ?? []).map((row) => stripAnsi(row).trimEnd());
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["read", { path: "odd/work/design.md", offset: 142, limit: 4 }, "design.md:142-145"],
		["edit", { path: "odd/work/design.md", oldText: "a", newText: "b" }, "design.md"],
		["write", { path: "odd/work/design.md", content: "one\n" }, "design.md"],
	];
	for (const [name, args, collapsedDetail] of cases) {
		const collapsed = rows(name, args, false).join("\n");
		assert.match(collapsed, new RegExp(`📑 odd · ${name} ${collapsedDetail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w./:])`), `${name} collapsed names the file`);
		assert.doesNotMatch(collapsed, /odd\/work\/design\.md/, `${name} collapsed states no path`);
		const expanded = rows(name, args, true).join("\n");
		assert.match(expanded, new RegExp(`📑 odd · ${name} odd/work/design\\.md`), `${name} expanded states the path`);
	}
	// The mark is the user's, one space after it, and it is two columns wide.
	const heading = rows("read", { path: "odd/work/design.md" }, false)[0] ?? "";
	assert.match(heading, /📑 odd/, "the artifact mark leads the heading");
	assert.doesNotMatch(heading, /📑  odd/, "one space between the mark and the name");
	assert.equal(visibleWidth("📑"), 2, "an artifact mark is two columns, and the layout counts it");
	// A name with spaces stays whole, a Windows path reads like a POSIX one, and a long
	// name is truncated by the row rather than dropped: the card never exceeds its width.
	assert.match(rows("read", { path: "odd/my design doc.md" }, false, 60).join("\n"), /📑 odd · read my design doc\.md/);
	assert.match(rows("read", { path: "C:\\repo\\odd\\work\\x.md" }, false, 60).join("\n"), /📑 odd · read x\.md/);
	for (const width of [40, 24, 16, 12]) {
		for (const expanded of [false, true]) {
			const drawnRows = rows("read", { path: "odd/work/a-very-long-artifact-name-for-a-card.md", offset: 7, limit: 3 }, expanded, width);
			assert.ok(drawnRows.length > 0, `width ${width}: the card still draws`);
			for (const row of drawnRows) assert.ok(visibleWidth(row) <= width, `width ${width}: ${JSON.stringify(row)} fits`);
			if (width >= 16) assert.ok(drawnRows[0]!.includes("📑"), `width ${width}: the mark survives`);
		}
	}
});

// A retained call's own text is arbitrary: an item restored from a history file, copied
// out of a hand-built thread, or written by a later version has not been through the
// store's sanitizer. The pane's own card cleans what it draws
// (lib/agents-thread-view.ts printableOutput), so the chat's renderer is handed the same
// cleaned copy — otherwise a control byte reaches the terminal through a card the pane
// does not draw itself. The output and every string argument are cleaned where they
// cross that boundary; the call keeps the text it states, minus the bytes.
test("a restored call cannot hand the chat's renderer control bytes", () => {
	const handed = fakeRenderers();
	registerAgentToolRenderers({ write: handed.renderers as never });
	drawn(tool({ name: "write", args: { path: "a.ts", content: "safe\u001b[31mred\u001b[0m\u0007bell" }, output: "kept\u001b]0;title\u0007tail" }), plainTheme);
	assert.deepEqual(handed.seen[0]!.args, { path: "a.ts", content: "saferedbell" }, "the call's own arguments reach the card cleaned");
	assert.deepEqual(handed.seen[1]!.result, { content: [{ type: "text", text: "kepttail" }], details: undefined }, "and the retained output reaches it cleaned too");

	// A card that draws what it was handed therefore cannot emit them either.
	clearAgentToolRenderers();
	const echoing = {
		renderShell: "self" as const,
		renderCall: (args: Record<string, unknown>) => new Text(String(args.content ?? ""), 0, 0),
		renderResult: (result: { content?: Array<{ text?: string }> }) => new Text(result.content?.[0]?.text ?? "", 0, 0),
	};
	registerAgentToolRenderers({ write: echoing as never });
	assert.deepEqual(drawn(tool({ name: "write", args: { content: "ok\u001b[2Jgone" }, output: "line\u0000one" }), plainTheme), ["okgone", "lineone"]);
});
