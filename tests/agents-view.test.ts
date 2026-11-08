import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { emptyThread, TASK_EVENT, TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";
import { renderThreadItem } from "../lib/agents-thread-view.ts";
import { AgentsView, taskHeader, type AgentsViewDeps } from "../lib/agents-view.ts";
import { measureAgentsViewLayout } from "../lib/agents-view-layout.ts";
import { projectActivity } from "../lib/orchestrator-presence.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// Gentle Agents overlay: list left, selected thread right, tail-following,
// and only the selected task subscribed.

const plainTheme = { fg: (_color: string, text: string) => text };

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	return { id, agent: "explore", mode: "task", prompt: "p", label: "p", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "gpt-5.6-terra", thinking: undefined, sessionPath: "/sessions/x.jsonl", error: null, result: null, lastStep: "grep", lastActivityAt: 1000, turns: 0, toolCalls: 0, tokens: 34_000, cost: 0.27, ...overrides };
}

function harness(rows: number | (() => number) = 8, sessionId = "s", canCancel?: (task: TaskRecord) => boolean) {
	const store = new TaskStore();
	const events: string[] = [];
	let renders = 0;
	const view = new AgentsView({
		theme: plainTheme,
		rows,
		store,
		sessionId,
		now: () => 61_000,
		canCancel,
		onCancel: (entry) => events.push(`cancel:${entry.id}`),
		onOpen: (entry) => events.push(`open:${entry.id}`),
		onClose: () => events.push("close"),
		requestRender: () => (renders += 1),
	});
	return { store, view, events, renders: () => renders };
}

function viewWith(extra: Partial<AgentsViewDeps>, rows: number | (() => number) = 14) {
	const store = new TaskStore();
	const events: string[] = [];
	const view = new AgentsView({
		theme: plainTheme,
		rows,
		store,
		sessionId: "s",
		now: () => 61_000,
		onCancel: (entry) => events.push(`cancel:${entry.id}`),
		onOpen: (entry) => events.push(`open:${entry.id}`),
		onClose: () => events.push("close"),
		requestRender: () => {},
		...extra,
	});
	return { store, view, events };
}

function clickLabel(view: AgentsView, label: string, width = 60): void {
	const frame = view.render(width).map(stripAnsi);
	const y = frame.findIndex((line) => line.includes(label));
	assert.ok(y >= 0, `${label} must be mouse accessible at ${width} columns`);
	const x = visibleWidth(frame[y].slice(0, frame[y].indexOf(label)));
	assert.equal(view.handleMouse(mouse(x, y, width, frame.length, "click"))?.handled, true);
}

test("narrow navigation enters a direct child, retains manual thread position, and Escape backs out", () => {
	const { store, view, events } = harness(8);
	store.add(task("a"));
	store.add(task("other", { parentSessionId: "other", agent: "foreign" }));
	for (let i = 0; i < 30; i++) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${i}\n` }, 2000);
	assert.match(view.render(40).join("\n"), /Subagent explore/);
	assert.deepEqual(events, [], "rendering the direct list never activates a child");
	assert.doesNotMatch(view.render(40).join("\n"), /foreign/);
	clickLabel(view, "Subagent explore", 40);
	assert.match(view.render(40).join("\n"), /line 29/);
	view.handleInput("\x1b[5~");
	const manual = view.render(40).slice(1, 6);
	view.handleInput("\x1b");
	assert.deepEqual(events, []);
	assert.match(view.render(40).join("\n"), /Subagent explore/);
	clickLabel(view, "Subagent explore", 40);
	assert.deepEqual(view.render(40).slice(1, 6), manual);
	view.render(80);
	assert.equal(view.selectedTask()?.id, "a");
	assert.deepEqual(view.render(40).slice(1, 6), manual);
	view.handleInput("\x1b");
	assert.match(view.render(40).join("\n"), /Subagent explore/);
	view.handleInput("\x1b");
	assert.deepEqual(events, ["close"]);
	view.dispose();
});

test("desktop fullscreen and every task action have mouse controls at the split boundary", () => {
	const { store, view, events } = harness(8, "s");
	store.add(task("a"));
	for (let i = 0; i < 30; i++) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${i}\n` }, 2000);
	view.render(60);
	view.handleInput("F");
	assert.doesNotMatch(view.render(60).join("\n"), /Subagent explore/);
	view.handleInput("\x1b[5~");
	const manual = view.render(60).slice(1, 6);
	clickLabel(view, "Back");
	clickLabel(view, "Fullscreen");
	assert.deepEqual(view.render(60).slice(1, 6), manual);
	clickLabel(view, "Follow");
	assert.match(view.render(60).join("\n"), /line 29/);
	clickLabel(view, "Open");
	clickLabel(view, "Stop");
	clickLabel(view, "Scope");
	assert.deepEqual(events, ["open:a", "cancel:a"]);
	clickLabel(view, "Close");
	assert.deepEqual(events, ["open:a", "cancel:a", "close"]);
	view.dispose();
});

test("tiny frames stay bounded and Close remains clickable whenever a cell exists", () => {
	for (const rows of [0, 1, 2, 3, 8]) for (const width of [0, 1, 2, 11, 12, 23, 24, 59, 60]) {
		const { store, view, events } = harness(rows);
		store.add(task("a"));
		const frame = view.render(width);
		assert.ok(frame.length <= rows);
		for (const line of frame) assert.ok(visibleWidth(line) <= width);
		if (rows && width) clickLabel(view, "×", width);
		assert.deepEqual(events, rows && width ? ["close"] : []);
		view.dispose();
	}
});

test("compact footer cycles mouse actions without clipped hit regions", () => {
	const { store, view, events } = harness(8, "s");
	store.add(task("a"));
	view.render(12);
	view.handleInput("\r");
	clickLabel(view, "Follow", 12);
	clickLabel(view, ">", 12);
	clickLabel(view, "Open", 12);
	clickLabel(view, ">", 12);
	clickLabel(view, "Stop", 12);
	clickLabel(view, ">", 12);
	clickLabel(view, "Scope", 12);
	assert.deepEqual(events, ["open:a", "cancel:a"]);
	view.dispose();
});

test("manual list wheels remain independent of selection and survive Back and resize", () => {
	const { store, view } = harness(6);
	for (let i = 0; i < 10; i++) store.add(task(`t${i}`, { agent: `agent${i}`, createdAt: 1000 - i }));
	view.render(40);
	view.handleMouse(mouse(4, 2, 40, 6, "wheel", 5));
	const viewport = () => view.render(40).slice(1, 4).map((line) => stripAnsi(line).replace("▸", " "));
	const manual = viewport();
	assert.match(manual[0], /agent5/);
	assert.equal(view.selectedTask()?.id, "t0", "wheel scrolling does not change selection");
	clickLabel(view, "Subagent agent5", 40);
	view.handleInput("\x1b");
	assert.match(stripAnsi(view.render(40)[1]), /▸.*Subagent agent5/, "clicking selects the visible child");
	assert.deepEqual(viewport(), manual, "Back preserves viewport content apart from the intentional selection marker");
	view.render(80);
	assert.deepEqual(viewport(), manual);
	assert.equal(view.selectedTask()?.id, "t5");
	view.dispose();
});

test("activating a visible child preserves the manual list offset through Back and height resize", () => {
	for (const target of [4, 5]) {
		let rows = 6;
		const { store, view } = harness(() => rows);
		for (let i = 0; i < 10; i++) store.add(task(`t${i}`, { agent: `agent${i}`, createdAt: 1000 - i }));
		view.render(40);
		for (let i = 0; i < 4; i++) view.handleInput("j");
		view.render(40);
		view.handleMouse(mouse(4, 2, 40, rows, "wheel", 1));
		assert.match(view.render(40)[1], /agent3/);
		clickLabel(view, `Subagent agent${target}`, 40);
		assert.equal(view.selectedTask()?.id, `t${target}`);
		view.handleInput("\x1b");
		assert.match(view.render(40)[1], /agent3/, "Back restores the manual offset, not selection-following");
		rows = 20;
		view.render(40);
		rows = 6;
		assert.match(view.render(40)[1], /agent3/, "temporary height clamping must not replace the saved offset");
		assert.equal(view.selectedTask()?.id, `t${target}`);
		view.dispose();
	}
});

test("a task finishing while its details are open in narrow mode keeps its thread visible instead of kicking back to the list", () => {
	const { store, view, events } = harness(8);
	store.add(task("a"));
	view.render(40);
	clickLabel(view, "Fullscreen", 80);
	assert.deepEqual(events, []);
	store.update("a", { status: TASK_STATUS.COMPLETED, endedAt: 5000 });
	assert.equal(view.selectedTask()?.id, "a", "the finished task stays selected as history instead of disappearing");
	assert.match(view.render(80).join("\n"), /Back|Subagent explore/, "narrow details mode stays open on the now-finished task");
	assert.deepEqual(events, []);
	view.dispose();
});

test("fullscreen retains every semantic block and hides Stop for unowned active tasks", () => {
	const { store, view, events } = harness(8, "s", () => false);
	const thread = { ...emptyThread(), items: [
		{ kind: "thinking" as const, text: "reasoning retained" },
		{ kind: "text" as const, text: "answer retained" },
		{ kind: "tool" as const, callId: "call", name: "bash", args: {}, output: Array.from({ length: 40 }, (_, i) => `output ${i}`).join("\n"), running: false, isError: false },
		{ kind: "note" as const, text: "final retained note" },
	] };
	store.restore(task("a"), thread);
	view.render(60);
	view.handleInput("F");
	for (let i = 0; i < 12; i++) view.handleInput("\x1b[5~");
	const seen = new Set<string>();
	for (let i = 0; i < 50; i++) {
		const frame = view.render(60).map(stripAnsi);
		assert.doesNotMatch(frame.at(-2) ?? "", /\[Stop\]/);
		for (const line of frame.slice(1, 6)) seen.add(line);
		view.handleMouse(mouse(4, 2, 60, 8, "wheel", 1));
	}
	assert.match([...seen].join("\n"), /reasoning retained[\s\S]*answer retained[\s\S]*\$ bash[\s\S]*output 39[\s\S]*final retained note/);
	view.handleInput("s");
	assert.deepEqual(events, []);
	assert.deepEqual(store.thread("a"), thread, "presentation does not mutate retention");
	view.dispose();
});

test("the thread pane draws each tool call as its own card, distinct per tool", () => {
	const { store, view } = harness(14);
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "a", name: "bash", args: { command: "pnpm test" }, output: "PASS", running: false, isError: false },
		{ kind: "tool" as const, callId: "b", name: "read", args: { path: "lib/agents-view.ts" }, output: "file body", running: false, isError: false },
	] });
	const frame = view.render(80);
	const body = frame.map(stripAnsi).slice(1, -2);
	const joined = body.join("\n");
	assert.match(joined, /╭─ ✓ checking · pnpm test/, "the pane heads the call with the phase its command implies, as the chat does");
	assert.match(joined, /╭─ ≡ read · lib\/agents-view\.ts/, "a second tool keeps its own mark and name");
	assert.equal(joined.match(/╰─+╯/g)?.length, 2, "each call closes its own card");
	for (const line of frame) assert.equal(visibleWidth(line), 80, `"${stripAnsi(line)}" keeps the frame width`);
	view.dispose();
});

test("the thread pane separates two adjacent cards instead of merging them into one block", () => {
	const { store, view } = harness(16);
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "a", name: "bash", args: { command: "pnpm test" }, output: "PASS", running: false, isError: false },
		{ kind: "tool" as const, callId: "b", name: "read", args: { path: "lib/x.ts" }, output: "body", running: false, isError: false },
	] });
	const body = view.render(80).map(stripAnsi).slice(1, -2);
	const close = body.findIndex((row) => /╰─+╯/.test(row));
	assert.ok(close >= 0, "the first card closes inside the pane");
	assert.equal(body[close + 1].replace(/[│]/g, "").trim(), "", "a blank row stands between two cards");
	assert.equal(/[▎╭╮╰╯─$]/.test(body[close + 1]), false, "the separator carries no card chrome, so the cards never read as one block");
	assert.match(body[close + 2], /╭─ ≡ read/, "the next card starts its own frame after the gap");
	view.dispose();
});

test("the thread preview keeps its clear row below the header, never above it", () => {
	// The header leads the preview, so the pane never opens on emptiness; the clear
	// row that separates that header from the thread sits directly below it, and one
	// more closes the preview below the last thread row. The list keeps its own rows
	// untouched, starting at the top of the body.
	const { store, view } = harness(12);
	store.add(task("a"));
	for (let index = 0; index < 30; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	const body = view.render(80).map(stripAnsi).slice(1, -2);
	const thread = (row: string) => row.split("│")[2] ?? "";
	const listCell = (row: string) => row.split("│")[1] ?? "";
	assert.match(listCell(body[0]), /Subagent explore/, "the list still fills the body from its first row");
	assert.match(thread(body[0]), /explore · running/, "the task header takes the preview's first row");
	assert.equal(thread(body[1]).trim(), "", "and a clear row sits below the header, not above it");
	assert.match(body.slice(2, -1).join("\n"), /line 2[0-9]/, "the thread fills the rows below that gap");
	assert.match(thread(body.at(-2) ?? ""), /line 29/, "the tail is still the last visible thread row");
	assert.equal(thread(body.at(-1) ?? "").trim(), "", "and a clear row closes the preview below it");
	for (const row of body) assert.equal(visibleWidth(row), 80, "the margins never change the frame width");
	view.dispose();
});

test("a short thread preview keeps its rows instead of spending them on margins", () => {
	// Breathing room belongs to a tall preview. A short pane gives every body row
	// to its header and thread, so shrinking the terminal never hides content.
	const short = harness(11);
	short.store.add(task("a"));
	short.store.apply("a", { type: TASK_EVENT.TEXT, text: "only line\n" }, 2000);
	const shortBody = short.view.render(80).map(stripAnsi).slice(1, -2);
	assert.equal(shortBody.length, 8, "the whole body is available at this height");
	assert.match(shortBody[0].split("│")[2] ?? "", /explore · running/, "the header takes the first row");
	assert.match(shortBody.join("\n"), /only line/, "and the thread keeps the rows below it");
	short.view.dispose();
	const roomy = harness(12);
	roomy.store.add(task("a"));
	roomy.store.apply("a", { type: TASK_EVENT.TEXT, text: "only line\n" }, 2000);
	const roomyBody = roomy.view.render(80).map(stripAnsi).slice(1, -2);
	assert.match(roomyBody[0].split("│")[2] ?? "", /explore · running/, "a tall preview opens with its header");
	assert.equal((roomyBody[1].split("│")[2] ?? "").trim(), "", "and keeps the clear row below it, never above it");
	roomy.view.dispose();
});

test("the preview's clear rows keep pointer and keyboard geometry on the rows they pad", () => {
	// The blank rows are part of the preview, not holes in its hit geometry: a
	// wheel over the gap scrolls the thread, a click on it belongs to no card,
	// and a click on a card row still reaches its own card.
	const { store, view } = viewWith({ toolsExpanded: () => false }, 16);
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 6 }, (_, index) => `row ${index}`).join("\n"), running: false, isError: false },
	] });
	const frame = () => view.render(80).map(stripAnsi);
	const cardRow = frame().findIndex((row) => row.includes("checking · pnpm test"));
	assert.ok(cardRow > 2, "the card renders below the header and the clear row it keeps beside its thread");
	assert.equal(view.handleMouse(mouse(60, 2, 80, frame().length, "click")), undefined, "the clear row below the header belongs to no card");
	assert.equal(view.handleMouse(mouse(60, 2, 80, frame().length, "wheel", -1))?.handled, true, "a wheel over that row still scrolls the preview");
	assert.doesNotMatch(frame().join("\n"), /row 5/, "the card starts collapsed in the pane");
	assert.equal(view.handleMouse(mouse(60, cardRow, 80, frame().length, "click"))?.handled, true, "a card click keeps its own row after the gap");
	assert.match(frame().join("\n"), /row 5/, "and expands the card it landed on");
	// A page is still one whole visible thread window, clear rows excluded.
	view.handleInput("\x1b[1;5H");
	const top = frame().slice(1, -2);
	assert.match(top[0].split("│")[2] ?? "", /explore · running/, "ctrl+home keeps the header on the preview's first row");
	assert.equal((top[1].split("│")[2] ?? "").trim(), "", "with the clear row still below it");
	assert.match(top[2].split("│")[2] ?? "", /checking · pnpm test/, "and the thread's first row directly below that gap");
	view.dispose();
});

test("the narrow details preview keeps its clear row below the header and its bottom margin", () => {
	const { store, view } = harness(12);
	store.add(task("a"));
	for (let index = 0; index < 20; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	view.render(40);
	clickLabel(view, "Subagent explore", 40);
	const body = view.render(40).map(stripAnsi).slice(1, -2);
	const thread = (row: string) => row.split("│")[1] ?? "";
	assert.match(thread(body[0]), /explore · running/, "Details opens on the header");
	assert.equal(thread(body[1]).trim(), "", "with the clear row directly below it, never above it");
	assert.match(thread(body.at(-2) ?? ""), /line 19/, "the tail stays the last visible row");
	assert.equal(thread(body.at(-1) ?? "").trim(), "", "and the bottom margin closes the preview");
	clickLabel(view, "Back", 40);
	assert.match(view.render(40).map(stripAnsi).join("\n"), /Subagent explore/, "Back still leaves Details");
	view.dispose();
	// The padded rows stay out of the hit geometry in Details too: a card drawn
	// below the header's clear row still owns its own row.
	const card = viewWith({ toolsExpanded: () => true }, 12);
	card.store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 6 }, (_, index) => `output ${index}`).join("\n"), running: false, isError: false },
	] });
	card.view.render(40);
	clickLabel(card.view, "Subagent explore", 40);
	const details = () => card.view.render(40).map(stripAnsi);
	// The activity names the card's heading row; the call itself may continue on the
	// row below it once the card names the expand key beside it.
	const cardRow = () => details().findIndex((row) => row.includes("checking"));
	card.view.handleInput("\x1b[1;5H");
	assert.ok(cardRow() > 2, "the card's heading sits below the header and its clear row");
	assert.match(details().join("\n"), /output 3/, "the card renders expanded below that gap");
	assert.equal(card.view.handleMouse(mouse(4, cardRow(), 40, details().length, "click"))?.handled, true, "a card below the gap is still clickable");
	assert.doesNotMatch(details().join("\n"), /output 3/, "the click collapses that card");
	assert.equal((details().slice(1, -2)[1].split("│")[1] ?? "").trim(), "", "and the clear row below the header survives the redraw");
	card.view.dispose();
});

test("the thread pane opens with the message the subagent received, drawn as the chat's agent card", () => {
	const { store, view } = harness(20);
	store.restore(task("a", { prompt: "please inspect the parser\nand report" }), { ...emptyThread(), items: [
		{ kind: "text" as const, text: "working on it" },
		{ kind: "note" as const, text: "steered: also check the lexer" },
		{ kind: "note" as const, text: "error: boom" },
	] });
	const body = view.render(80).map(stripAnsi).slice(1, -2).join("\n");
	assert.match(body, /✉  Messaging agent · note/, "the task's own input wears the chat's Messaging agent heading");
	assert.match(body, /please inspect the parser/, "the task's own input is the pane's first block");
	assert.match(body, /and report/, "a multi-line input keeps its content");
	assert.equal(body.match(/✉  Messaging agent · note/g)?.length, 2, "a steering message is the same card as the launch prompt");
	assert.match(body, /also check the lexer/, "the steering message the child received is shown");
	assert.equal(body.includes("steered:"), false, "no transport marker is shown as content");
	assert.ok(body.indexOf("please inspect the parser") < body.indexOf("working on it"), "the input precedes the child's first output");
	assert.match(body, /Note[^\n]*\n[^\n]*error: boom/, "an unrelated note keeps its own label");
	// A peer presence task publishes no input, so the pane invents none.
	const peer = harness(8, "s");
	peer.store.restore(task("peer:x:1", { prompt: "" }), { ...emptyThread(), items: [{ kind: "text" as const, text: "peer activity" }] });
	const peerFrame = peer.view.render(80).map(stripAnsi).join("\n");
	assert.match(peerFrame, /peer activity/);
	assert.equal(peerFrame.includes("✉"), false, "a thread with no recorded input draws no message card");
	peer.view.dispose();
	view.dispose();
});

test("the received message is a message, not a card: it never collapses and ignores a click", () => {
	// The pane borrows the agent card's design for the message a child received,
	// but not its behavior: there is no preview to open, so nothing hides content
	// and nothing toggles it — not ctrl+o, not the chat's expansion state, not a
	// click on the card.
	const prompt = "please inspect the parser\nand report what you find";
	const thread = { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 8 }, (_, index) => `output ${index}`).join("\n"), running: false, isError: false },
	] };
	const pane = (toolsExpanded: boolean) => {
		const { store, view } = viewWith({ toolsExpanded: () => toolsExpanded }, 40);
		store.restore(task("a", { prompt }), thread);
		const frame = () => view.render(80).map(stripAnsi);
		const messageRows = () => frame().filter((row) => row.includes("Messaging agent") || row.includes("please inspect") || row.includes("report what"));
		return { view, frame, messageRows };
	};
	const open = pane(true);
	const closed = pane(false);
	assert.ok(open.messageRows().length >= 3, "the card carries its heading and the whole message");
	assert.deepEqual(closed.messageRows(), open.messageRows(), "the message reads the same whatever the cards' own state is");
	assert.equal(closed.frame().join("\n").includes("output 7"), false, "the cards still start collapsed, as the chat has them");
	assert.equal(open.frame().join("\n").includes("output 7"), true);
	// The overlay-wide toggle belongs to the cards; the message never moves with it.
	open.view.handleInput("\x0f");
	assert.deepEqual(open.messageRows(), closed.messageRows(), "ctrl+o leaves the message exactly as it was");
	assert.equal(open.frame().join("\n").includes("output 7"), false, "and still collapses the cards it does own");
	// A click on the message card toggles nothing: it is not a call.
	const before = open.frame();
	const row = before.findIndex((line) => line.includes("please inspect"));
	assert.ok(row > 0, "the message is on screen");
	assert.equal(open.view.handleMouse(mouse(20, row, 80, before.length, "click")), undefined, "the message card has no expansion to toggle");
	assert.deepEqual(open.frame(), before, "a click leaves the message card exactly as it was");
	open.view.dispose();
	closed.view.dispose();
});

test("the footer names what the two presentation keys will do next, and follows each toggle", () => {
	// A hint that only says "cards"/"thinking" makes the reader guess which way
	// the key goes. Each hint states the next action instead, and flips as soon
	// as the pane's own state changes.
	const keys = {
		expandsTools: (data: string) => data === "\u000f",
		togglesThinking: (data: string) => data === "\u0014",
		expandLabel: "ctrl+o",
		thinkingLabel: "ctrl+t",
	};
	const { store, view } = viewWith({ keys, toolsExpanded: () => true, thinkingVisible: () => true }, 30);
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 8 }, (_, index) => `output ${index}`).join("\n"), running: false, isError: false },
		{ kind: "thinking" as const, text: "private reasoning" },
	] });
	const frame = () => view.render(200).map(stripAnsi);
	const footer = () => frame().join("\n");
	assert.match(footer(), /ctrl\+o collapse/, "open cards advertise the way back");
	assert.match(footer(), /ctrl\+t hide thinking/, "visible thinking advertises hiding it");
	view.handleInput("\u000f");
	assert.match(footer(), /ctrl\+o expand/, "the hint flips the moment the cards collapse");
	assert.equal(footer().includes("ctrl+o collapse"), false, "the old action is never advertised beside the new one");
	assert.equal(frame().join("\n").includes("output 7"), false, "and the cards really are collapsed, as the hint says");
	view.handleInput("\u0014");
	assert.match(footer(), /ctrl\+t show thinking/, "hidden thinking advertises showing it");
	assert.equal(footer().includes("ctrl+t hide thinking"), false);
	assert.doesNotMatch(frame().join("\n"), /private reasoning/, "and the thinking really is hidden");
	view.handleInput("\u0014");
	view.handleInput("\u000f");
	assert.match(footer(), /ctrl\+o collapse/, "toggling back restores the original hint");
	assert.match(footer(), /ctrl\+t hide thinking/);
	assert.match(frame().join("\n"), /output 7/, "both states are the ones the hints promise");
	view.dispose();
	// The hint carries whatever key the host resolved, and says nothing for an
	// action the host left unbound.
	const remapped = viewWith({ keys: { ...keys, expandLabel: "ctrl+u" }, toolsExpanded: () => false }, 20);
	remapped.store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [] });
	assert.match(remapped.view.render(200).map(stripAnsi).join("\n"), /ctrl\+u expand/, "a remapped key keeps its own label");
	remapped.view.dispose();
	const unbound = viewWith({ keys: { ...keys, expandLabel: "", thinkingLabel: "" }, toolsExpanded: () => false }, 20);
	unbound.store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [] });
	const unboundFooter = unbound.view.render(200).map(stripAnsi).join("\n");
	assert.equal(/collapse|expand/.test(unboundFooter), false, "an unbound action advertises no next action");
	assert.equal(/show thinking|hide thinking/.test(unboundFooter), false);
	unbound.view.dispose();
	// A narrow footer keeps its own bounds and never leaves a half-drawn hint.
	const narrow = viewWith({ keys, toolsExpanded: () => false }, 20);
	narrow.store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [] });
	for (const width of [40, 60, 80]) {
		const rows = narrow.view.render(width);
		for (const row of rows) assert.equal(visibleWidth(row), width, `a ${width}-column footer keeps the frame width`);
	}
	narrow.view.dispose();
});

test("the footer ends with the two ways out, after the presentation toggles", () => {
	// Reading order: the key hints end with leaving the pane. The two
	// presentation toggles sit in front of them, so "esc back" and "q close" are
	// the last thing on the line rather than interrupting the action hints.
	const keys = {
		expandsTools: (data: string) => data === "\u000f",
		togglesThinking: (data: string) => data === "\u0014",
		expandLabel: "ctrl+o",
		thinkingLabel: "ctrl+t",
	};
	const { store, view } = viewWith({ keys, toolsExpanded: () => true, thinkingVisible: () => true }, 30);
	store.restore(task("a"), { ...emptyThread(), items: [] });
	// The hints are the row above the closing rule.
	const hints = () => view.render(240).map(stripAnsi).at(-2) ?? "";
	const order = () => {
		const row = hints();
		return ["ctrl+o collapse", "ctrl+t hide thinking", "esc back", "q close"].map((hint) => row.indexOf(hint));
	};
	assert.ok(order().every((index) => index >= 0), "every hint is advertised on a wide footer");
	assert.deepEqual([...order()].sort((left, right) => left - right), order(), "the toggles come first, then back, then close");
	assert.match(hints(), /q close\s*│\s*$/, "close is the last hint on the line");
	// The action hints still say what their keys do next, in front of the exits.
	view.handleInput("\u000f");
	view.handleInput("\u0014");
	assert.match(hints(), /ctrl\+o expand/, "the toggle hints flip in place");
	assert.match(hints(), /ctrl\+t show thinking/);
	assert.ok(hints().indexOf("ctrl+t show thinking") < hints().indexOf("esc back"), "and stay in front of the ways out");
	assert.match(hints(), /q close\s*│\s*$/, "close still ends the line after a toggle");
	view.dispose();
	// A narrow footer keeps its bounds; the tail yields, as every hint does.
	const narrow = viewWith({ keys, toolsExpanded: () => false }, 20);
	narrow.store.restore(task("a"), { ...emptyThread(), items: [] });
	for (const width of [40, 60, 80]) {
		for (const row of narrow.view.render(width)) assert.equal(visibleWidth(row), width, `a ${width}-column footer keeps the frame width`);
	}
	narrow.view.dispose();
});

test("ctrl+home and ctrl+end jump to the thread's start and tail", () => {
	const { store, view } = harness(12);
	store.add(task("a", { prompt: "the first input" }));
	for (let index = 0; index < 30; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	const window = () => view.render(80).map(stripAnsi).slice(1, -2).join("\n");
	assert.match(window(), /line 29/, "the pane starts at the tail");
	view.handleInput("\x1b[1;5H");
	const top = window();
	assert.match(top, /the first input/, "ctrl+home reaches the top of the thread, beginning with the input");
	assert.match(top, /line 0/);
	assert.doesNotMatch(top, /line 29/);
	// Jumping to the start leaves follow mode, so a live event never yanks the reader.
	store.apply("a", { type: TASK_EVENT.TEXT, text: "line 30\n" }, 2000);
	assert.doesNotMatch(window(), /line 30/);
	view.handleInput("\x1b[1;5F");
	assert.match(window(), /line 30/, "ctrl+end returns to the tail");
	store.apply("a", { type: TASK_EVENT.TEXT, text: "line 31\n" }, 2000);
	assert.match(window(), /line 31/, "ctrl+end resumes following the live thread");
	// The legacy xterm sequences reach the same two jumps.
	view.handleInput("\x1b[7^");
	assert.doesNotMatch(window(), /line 31/);
	view.handleInput("\x1b[8^");
	assert.match(window(), /line 31/);
	view.dispose();
});

test("the pane takes the chat's tool expansion and thinking visibility when it opens", () => {
	const store = new TaskStore();
	let toolsExpanded = false;
	let thinkingVisible = false;
	const view = new AgentsView({
		theme: plainTheme,
		rows: 20,
		store,
		sessionId: "s",
		now: () => 61_000,
		toolsExpanded: () => toolsExpanded,
		thinkingVisible: () => thinkingVisible,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "thinking" as const, text: "private reasoning" },
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 8 }, (_, index) => `output ${index}`).join("\n"), running: false, isError: false },
	] });
	const window = () => view.render(80).map(stripAnsi).slice(1, -2).join("\n");
	assert.match(window(), /Thinking\.\.\./, "the chat's hidden thinking becomes the chat's own label");
	assert.doesNotMatch(window(), /private reasoning/);
	assert.doesNotMatch(window(), /output 7/, "the chat's collapsed cards preview their first rows");
	// The overlay is a pane of its own: a later chat change does not reach it.
	toolsExpanded = true;
	thinkingVisible = true;
	assert.match(window(), /Thinking\.\.\./, "the open pane keeps the state it opened with");
	assert.doesNotMatch(window(), /output 7/);
	view.dispose();
});

test("ctrl+o expands the overlay's cards only, never the chat's own state", () => {
	let chatExpanded = false;
	let reads = 0;
	const { store, view } = viewWith({ toolsExpanded: () => { reads += 1; return chatExpanded; } });
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 8 }, (_, index) => `output ${index}`).join("\n"), running: false, isError: false },
	] });
	assert.equal(reads, 1, "the chat's expansion is read once, when the overlay opens");
	const window = () => view.render(80).map(stripAnsi).slice(1, -2).join("\n");
	assert.doesNotMatch(window(), /output 7/, "the pane opens with the chat's collapsed cards");
	view.handleInput("\x0f");
	assert.match(window(), /output 7/, "ctrl+o expands the overlay's cards");
	assert.equal(chatExpanded, false, "the chat's own expansion state is never written");
	assert.equal(reads, 1, "toggling the overlay reads no chat state again");
	view.handleInput("\x0f");
	assert.doesNotMatch(window(), /output 7/, "ctrl+o collapses them again");
	assert.equal(chatExpanded, false);
	view.dispose();
});

test("ctrl+t shows the overlay's thinking only, never the chat's own setting", () => {
	let chatThinking = false;
	let reads = 0;
	const { store, view } = viewWith({ thinkingVisible: () => { reads += 1; return chatThinking; } });
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [{ kind: "thinking" as const, text: "private reasoning" }] });
	assert.equal(reads, 1, "the chat's thinking setting is read once, when the overlay opens");
	const window = () => view.render(80).map(stripAnsi).slice(1, -2).join("\n");
	assert.match(window(), /Thinking\.\.\./, "the pane opens with the chat's hidden thinking");
	view.handleInput("\x14");
	assert.match(window(), /private reasoning/, "ctrl+t reveals the overlay's thinking");
	assert.equal(chatThinking, false, "the chat's own thinking setting is never written");
	view.handleInput("\x14");
	assert.match(window(), /Thinking\.\.\./, "ctrl+t hides it again");
	assert.equal(reads, 1);
	view.dispose();
});

test("reopening the overlay adopts the chat's current expansion and thinking state", () => {
	let chatExpanded = false;
	let chatThinking = false;
	const store = new TaskStore();
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "thinking" as const, text: "private reasoning" },
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 8 }, (_, index) => `output ${index}`).join("\n"), running: false, isError: false },
	] });
	const open = () => new AgentsView({
		theme: plainTheme,
		rows: 20,
		store,
		sessionId: "s",
		now: () => 61_000,
		toolsExpanded: () => chatExpanded,
		thinkingVisible: () => chatThinking,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	const window = (view: AgentsView) => view.render(80).map(stripAnsi).slice(1, -2).join("\n");
	const first = open();
	assert.doesNotMatch(window(first), /output 7/);
	// The overlay's own toggles never leave a mark on the next open.
	first.handleInput("\x0f");
	first.handleInput("\x14");
	assert.match(window(first), /output 7/);
	first.dispose();
	const second = open();
	assert.doesNotMatch(window(second), /output 7/, "a reopened overlay starts from the chat's collapsed cards");
	assert.match(window(second), /Thinking\.\.\./, "and from the chat's hidden thinking");
	second.dispose();
	chatExpanded = true;
	chatThinking = true;
	const third = open();
	assert.match(window(third), /output 7/, "a reopened overlay adopts a chat that now shows expanded cards");
	assert.match(window(third), /private reasoning/, "and a chat that now shows thinking");
	third.dispose();
});

test("a click on one card expands that card alone, leaving its siblings and the chat untouched", () => {
	let chatExpanded = false;
	const { store, view } = viewWith({ toolsExpanded: () => chatExpanded }, 24);
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "a", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 6 }, (_, index) => `suite ${index}`).join("\n"), running: false, isError: false },
		{ kind: "tool" as const, callId: "b", name: "read", args: { path: "lib/x.ts" }, output: Array.from({ length: 6 }, (_, index) => `body ${index}`).join("\n"), running: false, isError: false },
	] });
	const frame = () => view.render(80).map(stripAnsi);
	const calledRow = () => frame().findIndex((row) => row.includes("read · lib/x.ts"));
	assert.doesNotMatch(frame().join("\n"), /body 5/);
	assert.equal(view.handleMouse(mouse(60, calledRow(), 80, frame().length, "click"))?.handled, true, "the call's card is clickable");
	const opened = frame().join("\n");
	assert.match(opened, /body 5/, "the clicked card expands");
	assert.doesNotMatch(opened, /suite 5/, "its sibling stays collapsed");
	assert.equal(chatExpanded, false, "the chat's own expansion state is never written");
	// The overlay-wide toggle leaves a per-card override alone.
	view.handleInput("\x0f");
	assert.match(frame().join("\n"), /suite 5/, "ctrl+o still expands every other card");
	assert.match(frame().join("\n"), /body 5/, "the per-card override survives the overlay-wide toggle");
	view.handleInput("\x0f");
	assert.doesNotMatch(frame().join("\n"), /suite 5/, "the overlay-wide collapse applies to the cards it owns");
	assert.match(frame().join("\n"), /body 5/, "and still preserves the clicked card");
	// A second click collapses that same card, still without touching the other.
	assert.equal(view.handleMouse(mouse(60, calledRow(), 80, frame().length, "click"))?.handled, true);
	const closed = frame().join("\n");
	assert.doesNotMatch(closed, /body 5/, "a click collapses the card it opened");
	assert.doesNotMatch(closed, /suite 5/);
	assert.equal(chatExpanded, false);
	// A click that lands on the pane header toggles nothing.
	assert.equal(view.handleMouse(mouse(60, 1, 80, frame().length, "click")), undefined);
	view.dispose();
});

test("a click on a card expands it in the narrow details view too", () => {
	const { store, view } = viewWith({ toolsExpanded: () => false }, 10);
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 6 }, (_, index) => `row ${index}`).join("\n"), running: false, isError: false },
	] });
	clickLabel(view, "Subagent explore", 40);
	const frame = () => view.render(40).map(stripAnsi);
	assert.match(frame().join("\n"), /checking · pnpm test/, "the drilldown shows the retained card");
	assert.doesNotMatch(frame().join("\n"), /row 5/);
	const headingRow = frame().findIndex((row) => row.includes("checking · pnpm test"));
	assert.equal(view.handleMouse(mouse(4, headingRow, 40, frame().length, "click"))?.handled, true, "the card is clickable in Details");
	assert.match(frame().join("\n"), /row 5/, "the click expands that card");
	view.dispose();
});

test("the overlay uses the chat's own keybindings for its two presentation toggles", () => {
	// Pi resolves app.tools.expand / app.thinking.toggle, so a user remap reaches
	// the preview too; the overlay still changes only its own state.
	let chatExpanded = true;
	const keys = {
		expandsTools: (data: string) => data === "\u0015",
		togglesThinking: (data: string) => data === "\u0019",
		expandLabel: "ctrl+u",
		thinkingLabel: "ctrl+y",
	};
	const { store, view } = viewWith({ keys, toolsExpanded: () => chatExpanded });
	store.restore(task("a", { prompt: "" }), { ...emptyThread(), items: [
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: Array.from({ length: 8 }, (_, index) => `output ${index}`).join("\n"), running: false, isError: false },
	] });
	const window = () => view.render(80).map(stripAnsi).join("\n");
	assert.match(window(), /output 7/, "the pane opens expanded, as the chat is");
	view.handleInput("\x0f");
	assert.match(window(), /output 7/, "the host's binding replaces Pi's default key");
	view.handleInput("\u0015");
	assert.doesNotMatch(window(), /output 7/, "the remapped key collapses the overlay's cards");
	assert.equal(chatExpanded, true, "the chat's own state is untouched");
	// A wide footer has room for the hints; narrower ones keep today's ordering.
	assert.match(view.render(200).map(stripAnsi).join("\n"), /ctrl\+u/, "the footer advertises the binding the host resolved");	view.dispose();
});

test("a warm pane frame costs no per-item work and reads the chat state once", () => {
	// Representative frame: alternating thinking runs and finished tool cards, the
	// mix that made the pane feel slow. Every styled row is counted, so a per-item
	// re-render or a re-wrapped input block shows up as extra work.
	const cost = (items: number) => {
		const store = new TaskStore();
		let styledRows = 0;
		let stateReads = 0;
		const theme = { fg: (_color: string, text: string) => { styledRows += 1; return text; } };
		const view = new AgentsView({
			theme,
			rows: 24,
			store,
			sessionId: "s",
			now: () => 61_000,
			toolsExpanded: () => { stateReads += 1; return true; },
			thinkingVisible: () => { stateReads += 1; return true; },
			onCancel() {},
			onOpen() {},
			onClose() {},
			requestRender() {},
		});
		store.restore(task("a", { prompt: "inspect the parser" }), { ...emptyThread(), items: Array.from({ length: items }, (_, index) => (index % 2 === 0
			? { kind: "thinking" as const, text: `reasoning ${index}` }
			: { kind: "tool" as const, callId: `c${index}`, name: "bash", args: { command: `run ${index}` }, output: "one\ntwo\nthree", running: false, isError: false })) });
		assert.equal(stateReads, 2, "each chat presentation state is read once, when the overlay opens");
		view.render(80);
		styledRows = 0;
		stateReads = 0;
		view.render(80);
		const warm = { styledRows, stateReads };
		view.dispose();
		return warm;
	};
	const small = cost(4);
	const large = cost(120);
	assert.equal(small.stateReads, 0, "a warm frame reads no chat state at all");
	assert.equal(large.stateReads, 0, "reading the chat state never scales with retained items");
	assert.ok(large.styledRows <= small.styledRows + 4, `a warm 120-item frame (${large.styledRows} styled rows) costs no more than a warm 4-item frame (${small.styledRows})`);
});

test("a warm pane frame re-walks no retained item, and every row change re-assembles once", () => {
	// A frame is a pure function of the thread version, the width and the pane's own
	// presentation, so the assembled rows are kept until one of those changes. Each
	// read of the retained `items` array is counted: the walk is what made a long
	// thread's steady state scale with its size. A test double counts the walk at the
	// store boundary instead of timing it, so the rule is deterministic.
	class CountingStore extends TaskStore {
		itemReads = 0;
		private readonly proxies = new WeakMap<object, ReturnType<TaskStore["thread"]>>();
		override thread(id: string) {
			const target = super.thread(id);
			let proxy = this.proxies.get(target);
			if (!proxy) {
				// One stable proxy per thread version, so the pane's version identity is
				// the store's while the walk stays countable.
				proxy = new Proxy(target, {
					get: (source, property, receiver) => {
						if (property === "items") this.itemReads += 1;
						return Reflect.get(source, property, receiver);
					},
				});
				this.proxies.set(target, proxy);
			}
			return proxy;
		}
	}
	const store = new CountingStore();
	store.add(task("a"));
	for (let index = 0; index < 60; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}` }, 2000 + index);
	const view = new AgentsView({
		theme: plainTheme,
		rows: 12,
		store,
		sessionId: "s",
		now: () => 61_000,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	const frame = () => view.render(80).map(stripAnsi).join("\n");

	frame();
	assert.ok(store.itemReads >= 1, "the first frame assembles the retained thread");
	assert.match(frame(), /line 59/);
	store.itemReads = 0;
	assert.match(frame(), /line 59/, "a warm frame draws the same rows");
	assert.equal(store.itemReads, 0, "a warm frame re-walks no retained item");

	// Every input the rows depend on still re-assembles them: a new event, a width
	// change, the overlay-wide expansion toggle and one card's own toggle.
	store.apply("a", { type: TASK_EVENT.TEXT, text: "arrived later" }, 9000);
	store.itemReads = 0;
	assert.match(frame(), /arrived later/, "a new thread version is drawn");
	assert.ok(store.itemReads >= 1, "a new thread version re-assembles");
	store.itemReads = 0;
	view.render(72);
	assert.ok(store.itemReads >= 1, "a width change re-assembles");
	store.itemReads = 0;
	view.handleInput("\x0f");
	view.render(72);
	assert.ok(store.itemReads >= 1, "the expansion toggle re-assembles");
	view.dispose();
});

// A diff is file content, so it stays in the session that owns the task. Presence
// activity is written to a directory every session on the machine can read, and
// the tool item's field whitelist is what keeps one session's edit from becoming
// readable in another: a new display field on the item does not widen it.
test("a remote session's activity never carries the tool details the local pane keeps", () => {
	const activity = projectActivity([{
		task: { id: "t1", agent: "explore", label: "map", status: TASK_STATUS.RUNNING, model: "m", createdAt: 1, startedAt: 1, endedAt: null, lastActivityAt: 1 },
		thread: { version: 1, dropped: 0, items: [
			{ kind: "tool", callId: "c1", name: "edit", output: "ok", running: false, isError: false, details: { diff: "-1 the private line" } },
			{ kind: "text", text: "prose" },
		] },
	}]);
	const items = activity.tasks[0]?.thread.items ?? [];
	assert.deepEqual(items[0], { kind: "tool", callId: "c1", name: "edit", output: "ok", running: false, isError: false }, "the remote item is the shape the presence file always had");
	assert.deepEqual(items[1], { kind: "text", text: "prose" });
	assert.equal(JSON.stringify(activity).includes("details"), false, "no details field is published");
	assert.equal(JSON.stringify(activity).includes("private line"), false, "no diff content leaves the session that produced it");
});

test("narrow unknown origins stay isolated rather than sharing an inferred orchestrator", () => {
	const { store, view } = harness(8);
	store.add(task("a", { parentSessionId: "", agent: "alpha" }));
	store.add(task("b", { parentSessionId: " ", agent: "beta" }));
	view.handleInput("a");
	assert.doesNotMatch(view.render(40).join("\n"), /Unknown session|alpha|beta/);
	assert.equal(view.selectedTask(), undefined);
	assert.equal(store.list().length, 2, "unknown retained origins remain isolated from presence");
	view.dispose();
});

test("presentation changes invalidate pointer geometry before another frame", () => {
	const { store, view, events } = harness(8);
	store.add(task("a"));
	const frame = view.render(80);
	view.handleInput("F");
	assert.equal(view.handleMouse(mouse(4, 2, 80, frame.length, "click")), undefined);
	view.render(80);
	view.handleInput("\x1b");
	// A stale-geometry wheel is still claimed, never acted on: the fullscreen host
	// forwards an unclaimed wheel to the transcript underneath, so the pane has to
	// answer for the whole rectangle even while its own cells are out of date.
	assert.equal(view.handleMouse(mouse(40, 2, 80, frame.length, "wheel", 1))?.handled, true);
	assert.equal(view.handleMouse(mouse(40, 2, 80, frame.length, "wheel", 1))?.render, false);
	view.handleInput("F");
	view.handleInput("q");
	assert.deepEqual(events, ["close"]);
	view.dispose();
});

test("a wheel anywhere inside the overlay frame is claimed instead of scrolling the chat behind it", () => {
	const { store, view } = harness(10);
	store.add(task("a"));
	store.add(task("b", { agent: "b" }));
	for (let index = 0; index < 30; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	const frame = view.render(80);
	const height = frame.length;
	const thread = () => view.render(80).map(stripAnsi).slice(1, -2).join("\n");
	const tail = thread();
	// The frame's own cells -- both border columns, the divider between the panes,
	// the title row, the footer row and the closing rule -- sit inside the overlay's
	// rectangle too. The fullscreen host forwards a wheel no handler claims to the
	// transcript underneath, so each of them is claimed here even though none scrolls.
	const cells: Array<[number, number, string]> = [
		[0, 2, "left border"],
		[1, 2, "list padding"],
		[27, 2, "pane divider"],
		[79, 2, "right border"],
		[20, 0, "title row"],
		[79, 0, "title tail"],
		[60, height - 2, "footer row"],
		[60, height - 1, "closing rule"],
	];
	for (const [x, y, label] of cells) assert.equal(view.handleMouse(mouse(x, y, 80, height, "wheel", 1))?.handled, true, `a wheel on the ${label} is claimed`);
	assert.deepEqual(thread(), tail, "a wheel that finds nothing to scroll moves nothing");
	// The panes keep their own scrolling, and the thread's bottom is a claim as well.
	assert.equal(view.handleMouse(mouse(60, 2, 80, height, "wheel", -1))?.handled, true);
	const paged = thread();
	assert.notDeepEqual(paged, tail, "the thread's wheel still pages its own viewport");
	for (let index = 0; index < 40; index += 1) assert.equal(view.handleMouse(mouse(60, 2, 80, height, "wheel", 1))?.handled, true, "a wheel at the thread's bottom stays inside the pane");
	assert.deepEqual(thread(), tail, "and it lands back on the tail");
	assert.equal(view.handleMouse(mouse(4, 2, 80, height, "wheel", 1))?.handled, true, "the task list keeps its own wheel");
	assert.equal(view.selectedTask()?.id, "a", "a list wheel never changes the keyboard selection");
	view.dispose();
	assert.equal(view.handleMouse(mouse(60, 2, 80, height, "wheel", 1)), undefined, "a disposed pane hands the wheel back to the chat");
});

test("renderThreadItem renders unlabeled prose blocks and one card per tool call", () => {
	assert.deepEqual(renderThreadItem({ kind: "text", text: "one two three four" }, plainTheme, 9), [" one two", " three", " four"]);
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "deep\nthoughts" }, plainTheme, 20), [" deep", " thoughts"]);
	const output = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
	const tool = renderThreadItem({ kind: "tool", callId: "c", name: "bash", args: { command: "ls  -la" }, output, running: true, isError: false }, plainTheme, 30);
	assert.match(tool[0], /^╭─ ⌕ exploring · ls -la ─+╮$/, "the card heading names the phase the call's own command implies");
	assert.equal(tool.length, 12, "head, every retained output line, and the closing rule");
	assert.match(tool[1], /^│ line 0 +│$/);
	assert.match(tool[10], /^│ line 9 +│$/);
	assert.match(tool[11], /^╰─+╯$/);
	// A long output line wraps instead of being clipped, so nothing is hidden.
	const wide = renderThreadItem({ kind: "tool", callId: "c", name: "bash", args: {}, output: "alpha beta gamma delta", running: false, isError: false }, plainTheme, 12);
	assert.deepEqual(wide.slice(1, -1).map((row) => row.replace(/│/g, "").trim()), ["alpha", "beta", "gamma", "delta"]);
	assert.deepEqual(renderThreadItem({ kind: "note", text: "error: boom" }, plainTheme, 30), ["Note", "  error: boom"]);
	assert.equal(taskHeader(task("a"), 61_000), "explore · running · gpt-5.6-terra · r · 34k · $0.270 · 1m00s");
});

test("taskHeader names the working directory's last component after the model source and before tokens", () => {
	// The header answers "which worker, where" before it counts usage, so the
	// directory rides directly after the layer that supplied the model (`frozen:*`,
	// `binding`, `pin:*`, …) and ahead of the tokens, cost and elapsed time.
	const header = taskHeader(task("a", { modelSource: "frozen:user", cwd: "/repo/worktrees/feat-header" }), 61_000);
	assert.equal(header, "explore · running · gpt-5.6-terra · frozen:user · feat-header · 34k · $0.270 · 1m00s");
	assert.equal(taskHeader(task("a", { cwd: "/repo/gentle-shell" }), 61_000), "explore · running · gpt-5.6-terra · gentle-shell · 34k · $0.270 · 1m00s", "a record with no model source keeps the same position");
	const parts = header.split(" · ");
	assert.ok(parts.indexOf("frozen:user") < parts.indexOf("feat-header"), "the directory follows the model source");
	assert.ok(parts.indexOf("feat-header") < parts.indexOf("34k"), "and leads the tokens");
});

test("taskHeader reads a POSIX or Windows cwd alike and adds no segment when the path names none", () => {
	const bare = (cwd: string) => taskHeader(task("a", { cwd, tokens: 0, cost: 0 }), 61_000);
	for (const cwd of [
		"/repo/worktrees/feat-header",
		"/repo/worktrees/feat-header/",
		"C:\\repo\\worktrees\\feat-header",
		"C:\\repo\\worktrees\\feat-header\\",
		"C:/repo/worktrees/feat-header",
		"\\\\server\\share\\feat-header",
		"feat-header",
	]) assert.equal(bare(cwd), "explore · running · gpt-5.6-terra · feat-header · 1m00s", `"${cwd}" names its own last component`);
	for (const cwd of ["", "   ", "/", "\\\\", "C:\\", "C:/", "//"]) {
		assert.equal(bare(cwd), "explore · running · gpt-5.6-terra · 1m00s", `"${cwd}" names no component, so the header adds no segment`);
	}
	// A payload that carries no cwd at all is absent, not empty-looking: no segment
	// and no stray separator reaches the header.
	const absent = { ...task("a"), cwd: undefined } as unknown as TaskRecord;
	assert.equal(taskHeader(absent, 61_000), "explore · running · gpt-5.6-terra · 34k · $0.270 · 1m00s");
});

test("taskHeader keeps one over-long directory name bounded and its tail readable", () => {
	// A directory name is told apart by its end (siblings share the prefix), so the
	// abbreviation keeps the tail behind an ellipsis instead of cutting it off, and
	// the facts that follow keep their room on the line.
	const long = taskHeader(task("a", { cwd: "/repo/worktrees/feat-phase-aware-bash-cards", tokens: 0, cost: 0 }), 61_000);
	const segment = long.split(" · ")[3] ?? "";
	assert.ok(visibleWidth(segment) <= 24, `"${segment}" stays inside the header's bound`);
	assert.ok(segment.startsWith("…"), "the head is what the abbreviation drops");
	assert.ok(segment.endsWith("aware-bash-cards"), "and the distinguishing tail survives");
	assert.equal(long.split(" · ").at(-1), "1m00s", "the elapsed time keeps its own segment");
	// Wide characters are cut by terminal cells, so a wide name cannot widen the frame.
	const wide = taskHeader(task("a", { cwd: `/repo/${"指令目录".repeat(4)}`, tokens: 0, cost: 0 }), 61_000).split(" · ")[3] ?? "";
	assert.ok(visibleWidth(wide) <= 24, `"${wide}" counts cells, not characters`);
	assert.ok(wide.startsWith("…"));
});

test("taskHeader formats subagent cost with formatCost (three decimals below $1, two at or above $1)", () => {
	assert.match(taskHeader(task("small", { cost: 0.09 }), 1000), /\$0\.090/);
	assert.match(taskHeader(task("large", { cost: 12.5 }), 1000), /\$12\.50/);
	assert.doesNotMatch(taskHeader(task("zero", { cost: 0 }), 1000), /\$/);
});

test("the drawn header carries the working directory under the pane's own layout", () => {
	const { store, view } = harness(8);
	store.add(task("a", { modelSource: "frozen:user", cwd: "/repo/worktrees/feat-header" }));
	assert.match(view.render(160).map(stripAnsi).join("\n"), /frozen:user · feat-header · 34k · \$0\.270 · 1m00s/, "the pane draws the header `taskHeader` composes");
	for (const width of [60, 80, 120, 160]) for (const line of view.render(width)) assert.equal(visibleWidth(line), width, `a directory name never widens the frame at ${width}`);
	view.dispose();
});

test("the drawn header shows the whole working-directory name when the pane has room for it", () => {
	// The screenshot case: at a wide pane the header still abbreviated the checkout
	// to `…phase-aware-bash-cards` and left the rest of the row empty. The name is
	// only shortened while the line actually needs the cells.
	const { store, view } = harness(8);
	store.add(task("a", { modelSource: "frozen:user", cwd: "/repo/worktrees/feat-phase-aware-bash-cards" }));
	const plain = view.render(160).map(stripAnsi);
	assert.match(plain[1], /explore · running · gpt-5\.6-terra · frozen:user · feat-phase-aware-bash-cards · 34k · \$0\.270 · 1m00s/, "the whole component is shown when the width allows it");
	for (const line of view.render(160)) assert.equal(visibleWidth(line), 160, "and the frame stays at width");
	view.dispose();
});

test("a narrower pane abbreviates only the directory name and keeps the counters", () => {
	// 110 columns leaves the thread pane 70 cells: enough for every fact and only
	// part of the checkout's name, so the name yields -- behind an honest ellipsis
	// -- and the tokens, cost and elapsed time keep their own segments.
	const { store, view } = harness(8);
	store.add(task("a", { cwd: "/repo/worktrees/feat-phase-aware-bash-cards" }));
	const header = (view.render(110).map(stripAnsi)[1] ?? "").split("│")[2]?.trim() ?? "";
	assert.match(header, /^explore · running · gpt-5\.6-terra · …[^ ]+ · 34k · \$0\.270 · 1m00s$/, `"${header}" keeps every field but the name`);
	assert.ok(header.includes("…"), "the abbreviation is marked");
	assert.ok(header.split(" · ")[3]?.endsWith("ards"), "and keeps the tail that tells siblings apart");
	assert.ok(visibleWidth(header) <= 70, `"${header}" fits the pane`);
	view.dispose();
});

test("a wide-script directory name is counted in cells and shown whole when it fits", () => {
	const name = "指令目录".repeat(4);
	const { store, view } = harness(8);
	store.add(task("a", { cwd: `/repo/${name}` }));
	const plain = view.render(160).map(stripAnsi);
	assert.ok(plain[1].includes(` · ${name} · 34k`), "a wide name is kept whole while the pane holds it");
	assert.equal(plain[1].includes("…"), false, "so nothing is abbreviated there");
	for (const line of view.render(160)) assert.equal(visibleWidth(line), 160, "and its cells, not its characters, size the row");
	view.dispose();
});

test("taskHeader drops the directory whole when the facts alone fill the line", () => {
	// 110-112 columns leave the thread pane 70-72 cells: the facts alone are 70, so
	// one or two cells are left over. There is no room for a separator plus an
	// abbreviated name, so the name goes entirely and the line keeps every counter
	// instead of spending two ellipses on a name that no longer fits.
	const withSource = task("a", { modelSource: "frozen:user", cwd: "/repo/worktrees/feat-phase-aware-bash-cards" });
	const facts = "explore · running · gpt-5.6-terra · frozen:user · 34k · $0.270 · 1m00s";
	assert.equal(visibleWidth(facts), 70, "the facts alone fill 70 cells");
	for (const width of [70, 71, 72]) {
		const header = stripAnsi(taskHeader(withSource, 61_000, width));
		assert.equal(header, facts, `at ${width} cells the facts fit exactly, so the name yields whole`);
		assert.equal(header.includes("…"), false, "nothing is abbreviated, so nothing is marked");
		assert.ok(visibleWidth(header) <= width, `and the line fits ${width}`);
	}
	// Without the model source the name keeps its own room, and its tail survives.
	for (const width of [70, 71, 72]) {
		const header = stripAnsi(taskHeader(task("a", { cwd: "/repo/worktrees/feat-phase-aware-bash-cards" }), 61_000, width));
		assert.match(header, /^explore · running · gpt-5\.6-terra · …[-a-z]+ · 34k · \$0\.270 · 1m00s$/, `at ${width} cells the name is the only segment abbreviated`);
		assert.equal([...header].filter((char) => char === "…").length, 1, "one ellipsis, on the name");
		assert.ok(visibleWidth(header) <= width, `and the line fits ${width}`);
	}
	// A wide-script name is measured in cells, so the same rule holds for it.
	for (const width of [70, 71, 72]) {
		const abbreviated = stripAnsi(taskHeader(task("a", { cwd: `/repo/${"指令目录".repeat(3)}` }), 61_000, width));
		assert.equal([...abbreviated].filter((char) => char === "…").length, 1, `at ${width} cells a wide name is abbreviated once`);
		assert.match(abbreviated, / · …[^ ]* · 34k · \$0\.270 · 1m00s$/, `and the counters stay whole at ${width}`);
		assert.ok(visibleWidth(abbreviated) <= width, `a wide name is counted in cells at ${width}`);
		const dropped = stripAnsi(taskHeader(task("a", { modelSource: "frozen:user", cwd: `/repo/${"指令目录".repeat(3)}` }), 61_000, width));
		assert.equal(dropped, facts, `with a model source the facts fill the line, so the wide name is dropped at ${width}`);
	}
});

test("the drawn header keeps every fact at the widths where the directory cannot fit", () => {
	const { store, view } = harness(8);
	store.add(task("a", { modelSource: "frozen:user", cwd: "/repo/worktrees/feat-phase-aware-bash-cards" }));
	const facts = "explore · running · gpt-5.6-terra · frozen:user · 34k · $0.270 · 1m00s";
	const header = (width: number) => (view.render(width).map(stripAnsi)[1] ?? "").split("│")[2]?.trim() ?? "";
	for (const width of [110, 111, 112]) assert.equal(header(width), facts, `at ${width} columns every fact stays whole and the name is dropped`);
	for (const width of [113, 114, 115, 120]) {
		const line = header(width);
		assert.match(line, / · 34k · \$0\.270 · 1m00s$/, `at ${width} columns the counters survive`);
		assert.ok([...line].filter((char) => char === "…").length <= 1, `at ${width} columns at most one edge is marked`);
		assert.ok(visibleWidth(line) <= width - 40, `and the line fits the thread pane at ${width}`);
	}
	view.dispose();
});

test("taskHeader keeps its shape without a pane width and drops the segment when a path names none", () => {
	// The two-argument form is what callers outside the pane compose with; it keeps
	// the header's own bound. A record with no directory contributes no segment at
	// any width, and a width too small for the facts truncates honestly.
	const bounded = taskHeader(task("a", { cwd: "/repo/worktrees/feat-phase-aware-bash-cards" }), 61_000).split(" · ")[3] ?? "";
	assert.ok(visibleWidth(bounded) <= 24, `"${bounded}" stays inside the header's bound`);
	const noCwd = { ...task("a"), cwd: undefined } as unknown as TaskRecord;
	for (const width of [60, 120, 160]) assert.equal(taskHeader(noCwd, 61_000, width), "explore · running · gpt-5.6-terra · 34k · $0.270 · 1m00s", `nothing is added at ${width} columns`);
	const narrow = taskHeader(noCwd, 61_000, 20);
	assert.ok(visibleWidth(narrow) <= 20, `"${narrow}" fits the width it was given`);
	assert.ok(stripAnsi(narrow).endsWith("…"), "and its cut is marked");
});

test("AgentsView renders the frame with the task list and the selected thread's tail, at width", () => {
	const { store, view } = harness(8);
	store.add(task("a"));
	store.add(task("b", { agent: "worker", status: TASK_STATUS.COMPLETED, endedAt: 5000, createdAt: 900, lastActivityAt: 900 }));
	for (let index = 0; index < 6; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	const lines = view.render(90);
	for (const line of lines) assert.equal(visibleWidth(line), 90, `"${stripAnsi(line)}" is not 90 wide`);
	const plain = lines.map(stripAnsi);
	assert.equal(plain.length, 8);
	assert.match(plain[0], /^╭─ ❀ Agents · this session · 1 active · 1 finished ─+ \[F Fullscreen\] \[× Close\]╮$/);
	assert.match(plain[1], /▸ └ ◐ Subagent explore.*explore · running · gpt-5\.6-terra · 34k · \$0\.270 · 1m00s│$/, "at 56 thread cells the facts alone fill the row, so the one-cell directory yields whole rather than spending a counter's cells");
	assert.match(plain[2], /line 2/, "the thread window follows the tail");
	assert.match(plain[3], /line 3/);
	assert.match(plain.join("\n"), /Subagent worker/, "the session's own finished task now stays listed as history");
	assert.doesNotMatch(plain.join("\n"), /orchestrator/i);
	assert.match(plain[4], /line 4/);
	assert.match(plain[5], /line 5/);
	assert.match(plain[6], /\[ Follow \].*\[ Open session \].*\[Stop\]/);
	assert.match(plain[7], /^╰─+╯$/);
});

test("AgentsView keys move the selection, scroll, follow, cancel, open, and close", () => {
	const { store, view, events } = harness(8);
	store.add(task("a"));
	store.add(task("b", { createdAt: 900, lastActivityAt: 900, status: TASK_STATUS.WAITING }));
	assert.equal(view.selectedTask()?.id, "a");
	view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "b");
	view.handleInput("k");
	assert.deepEqual(events, [], "navigation alone does not cancel");
	view.handleInput("c");
	view.handleInput("o");
	assert.deepEqual(events, ["cancel:a", "open:a"]);
	for (let index = 0; index < 12; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `l${index}\n` }, 2000);
	view.handleInput("\x1b[5~");
	const window = () => view.render(80).map(stripAnsi).slice(2, -2).join("\n");
	const top = view.render(80).map(stripAnsi);
	assert.match(top[2], /✉  Messaging agent · note/, "page up leaves follow mode at the thread's first block, the input message");
	assert.match(window(), /│ p +│/, "the task's own prompt is below the message heading");
	assert.match(window(), /╰─+╯/, "the message is one closed card");
	view.handleInput("\x0a");
	assert.doesNotMatch(window(), /✉  Messaging agent/, "ctrl+j scrolls one page down through the retained text");
	assert.match(window(), /l0/, "the first retained text row follows the input message");
	view.handleInput("\x0b");
	assert.match(window(), /✉  Messaging agent · note/, "ctrl+k scrolls one page back up to the input message");
	view.handleInput("f");
	assert.match(window(), /l11/, "f follows the tail again");
	view.handleInput("\x1b");
	assert.deepEqual(events, ["cancel:a", "open:a", "close"]);
});

// What a terminal sends for Ctrl+Shift+J/K once it reports the Shift modifier
// separately: the Kitty-protocol CSI-u form, with the shifted (74/75) or the
// unshifted (106/107) codepoint, and the xterm modifyOtherKeys form. A legacy
// terminal folds them into the very byte Ctrl+J/K send, which is why the extra
// pair is an addition for Linux and never a replacement for the existing keys.
const CTRL_SHIFT_DOWN = ["\x1b[106;6u", "\x1b[74;6u", "\x1b[27;6;106~"] as const;
const CTRL_SHIFT_UP = ["\x1b[107;6u", "\x1b[75;6u", "\x1b[27;6;107~"] as const;

function scrollFixture(platform: NodeJS.Platform) {
	const { store, view } = viewWith({ platform }, 8);
	store.add(task("a"));
	for (let line = 0; line < 30; line += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${line}\n` }, 2000);
	return { store, view, window: () => view.render(80).map(stripAnsi).slice(1, -2).join("\n") };
}

test("a Linux pane pages the thread with ctrl+shift+j/k as well as ctrl+j/k", () => {
	for (const [index, down] of CTRL_SHIFT_DOWN.entries()) {
		const up = CTRL_SHIFT_UP[index];
		const { view, window } = scrollFixture("linux");
		const tail = window();
		view.handleInput(up);
		const paged = window();
		assert.notDeepEqual(paged, tail, `${JSON.stringify(up)} pages the thread back on Linux`);
		assert.doesNotMatch(paged, /line 29/, "a page, not a single row");
		view.handleInput(down);
		assert.deepEqual(window(), tail, `${JSON.stringify(down)} pages the thread forward again`);
		// The keys that page today keep paging on the same pane.
		view.handleInput("\x0b");
		assert.notDeepEqual(window(), tail, "ctrl+k still pages up");
		view.handleInput("\x0a");
		assert.deepEqual(window(), tail, "ctrl+j still pages down");
		view.dispose();
	}
});

test("the extra ctrl+shift keys are inert outside Linux and shadow nothing", () => {
	for (const platform of ["darwin", "win32"] as const) {
		const { view, window } = scrollFixture(platform);
		const tail = window();
		for (const sequence of [...CTRL_SHIFT_DOWN, ...CTRL_SHIFT_UP]) {
			view.handleInput(sequence);
			assert.deepEqual(window(), tail, `${JSON.stringify(sequence)} moves nothing on ${platform}`);
		}
		assert.equal(view.selectedTask()?.id, "a", "and never acts as navigation");
		view.handleInput("\x0b");
		assert.notDeepEqual(window(), tail, "ctrl+k keeps paging");
		view.handleInput("\x0a");
		assert.deepEqual(window(), tail, "ctrl+j keeps returning");
		view.dispose();
	}
});

test("the footer never advertises the extra ctrl+shift pair", () => {
	// The pair is a compatibility convenience for terminals where `ctrl+j/k` never
	// reaches the pane, so it is documented rather than drawn: the footer keeps one
	// wording on every platform and spends no cells on it.
	const hints = (platform: NodeJS.Platform) => {
		const { store, view } = viewWith({ platform }, 30);
		store.add(task("a"));
		const footer = view.render(300).map(stripAnsi).at(-2) ?? "";
		view.dispose();
		return footer;
	};
	for (const platform of ["linux", "darwin", "win32"] as const) {
		assert.match(hints(platform), /ctrl\+j\/k scroll/, `${platform} advertises the scroll keys it has`);
		assert.doesNotMatch(hints(platform), /ctrl\+shift\+j\/k|\(\+shift\)/, `${platform} never names the extra pair`);
	}
	assert.equal(hints("linux"), hints("darwin"), "the Linux footer is the row every platform draws");
});

test("the extra Linux pair never pushes the footer's ways out of reach", () => {
	// The platform-neutral footer draws both ways out from 198 columns on, where
	// its 151-cell hint row fits; the reported case is 200. On Linux the extra pair
	// is named in full while the row has room for it and left to the documentation
	// otherwise -- there is no shorthand, because the pair is a compatibility
	// convenience and a footer must never advertise a modifier by abbreviation
	// alone. The ways out keep their cells, and a non-Linux footer is the row it
	// always drew.
	const footer = (platform: NodeJS.Platform, width: number) => {
		const { store, view } = viewWith({ platform }, 30);
		store.add(task("a"));
		const row = view.render(width).map(stripAnsi).at(-2) ?? "";
		view.dispose();
		return row;
	};
	const exits = (row: string) => row.includes("esc back") && row.includes("q close");
	for (const width of [100, 120, 160, 190, 197, 198, 200, 206, 207, 209, 214, 215, 240, 300]) {
		assert.equal(exits(footer("linux", width)), exits(footer("darwin", width)), `at ${width} columns the Linux footer shows the ways out exactly where the platform-neutral one does`);
	}
	assert.equal(footer("linux", 215), footer("darwin", 215), "a wide Linux row is the neutral row too");
	for (const width of [198, 200, 207, 209, 214]) {
		assert.doesNotMatch(footer("linux", width), /ctrl\+shift\+j\/k|\(\+shift\)/, `at ${width} columns neither the pair nor any shorthand appears`);
		assert.match(footer("linux", width), /ctrl\+j\/k scroll/, "the platform-neutral scroll hint stays");
	}
	assert.match(footer("linux", 200), /esc back   q close/, "which is what the report asks for");
	assert.equal(footer("linux", 200), footer("darwin", 200), "the Linux row is the neutral row, with nothing added for the pair");
	// The non-Linux footer is byte-identical at the reported width.
	const neutral = "│ [ Follow ] [ Open session ] [Stop] [Scope] j/k task   ctrl+j/k scroll   f follow   o open session   s Stop selected   a all sessions   ctrl+o collapse   ctrl+t hide thinking   esc back   q close   │";
	assert.equal(footer("darwin", 200), neutral, "a non-Linux footer keeps the row it always drew");
	assert.equal(footer("win32", 200), neutral);
});

test("AgentsView clamps thread scrolling at the bottom so the first upward key moves", () => {
	for (const [down, up] of [["\x0a", "\x0b"], ["\x1b[6~", "\x1b[5~"]]) {
		const { store, view } = harness(8);
		try {
			store.add(task("a"));
			for (let i = 0; i < 30; i++) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${i}\n` }, 2000);
			const bottom = view.render(80).slice(1, 5);
			assert.match(bottom.join("\n"), /line 28/);
			view.handleInput(up);
			const previousPage = view.render(80).slice(1, 5);
			assert.notDeepEqual(previousPage, bottom, "ordinary upward scrolling still moves one page");
			view.handleInput(down);
			assert.deepEqual(view.render(80).slice(1, 5), bottom, "ordinary downward scrolling returns to the bottom");
			for (let i = 0; i < 7; i++) {
				view.handleInput(down);
				assert.deepEqual(view.render(80).slice(1, 5), bottom, "extra downward presses leave the bottom visible");
			}
			view.handleInput(up);
			assert.deepEqual(view.render(80).slice(1, 5), previousPage, "the first upward press moves immediately without consuming hidden offset");
			view.handleInput("f");
			assert.deepEqual(view.render(80).slice(1, 5), bottom, "follow still restores the tail");
		} finally {
			view.dispose();
		}
	}
});

test("AgentsView subscribes only to the selected task and survives an empty store", () => {
	const { store, view, renders } = harness(6);
	assert.match(stripAnsi(view.render(60)[1]), /no tasks yet/);
	store.add(task("a"));
	store.add(task("b", { createdAt: 900, lastActivityAt: 900 }));
	const before = renders();
	store.apply("b", { type: TASK_EVENT.TEXT, text: "quiet" }, 2000);
	assert.equal(renders(), before, "an event on the unselected task renders nothing");
	store.apply("a", { type: TASK_EVENT.TEXT, text: "loud" }, 2000);
	assert.equal(renders(), before + 1);
	view.dispose();
	store.apply("a", { type: TASK_EVENT.TEXT, text: "after" }, 2000);
	assert.equal(renders(), before + 1, "disposed views stay quiet");
});

test("current panel exposes active children directly at desktop and narrow widths, and keeps its own finished history", () => {
	for (const width of [40, 80]) {
		const { store, view, events } = harness(12, "s");
		try {
			for (const status of [TASK_STATUS.RUNNING, TASK_STATUS.QUEUED, TASK_STATUS.WAITING]) {
				store.add(task(status, { agent: status, status }));
			}
			for (const status of [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.TIMED_OUT]) {
				store.add(task(status, { agent: `history_${status}`, status, endedAt: 60_999 }));
			}
			store.add(task("foreign", { agent: "foreign", parentSessionId: "other" }));
			const frame = view.render(width).map(stripAnsi).join("\n");
			assert.doesNotMatch(frame, /orchestrator|foreign/i);
			for (const status of ["running", "queued", "waiting"]) assert.match(frame, new RegExp(`Subagent ${status}`));
			// The narrow list column truncates each "history_<status>" label to a
			// common "history_…" prefix, so count occurrences instead of matching
			// each one by its full name.
			assert.equal((frame.match(/Subagent history_/g) ?? []).length, 4, "all four finished tasks of this session stay listed as history");
			assert.match(stripAnsi(view.render(width)[1]), /Subagent queued/, "equal creation times sort by ID, with no parent wrapper");
			assert.equal(view.selectedTask()?.id, "running", "adding earlier-sorted children preserves the existing selection");
			view.handleInput("k");
			assert.equal(view.selectedTask()?.id, "queued", "Up selects the preceding live child");
			const selected = view.selectedTask()!;
			view.handleInput("k");
			assert.equal(view.selectedTask()?.id, selected.id, "Up at the first child cannot select a hidden parent wrapper");
			assert.match(stripAnsi(view.render(width)[1]), /▸.*Subagent queued/);
			if (width < 60) clickLabel(view, `Subagent ${selected.agent}`, width);
			view.handleInput("s");
			assert.deepEqual(events, [`cancel:${selected.id}`]);
			store.update(selected.id, { status: TASK_STATUS.COMPLETED, endedAt: 61_000 });
			assert.equal(view.selectedTask()?.id, selected.id, "completion keeps the task selected, now as finished history");
		} finally {
			view.dispose();
		}
	}
});

test("current panel never promotes retained foreign or unknown tasks into open sessions, but keeps its own finished history", () => {
	const { store, view } = harness(12, "s");
	try {
		store.add(task("foreign", { agent: "foreign", parentSessionId: "closed" }));
		store.add(task("unknown", { agent: "unknown", parentSessionId: "" }));
		store.add(task("finished", { agent: "finished", status: TASK_STATUS.COMPLETED, endedAt: 61_000 }));
		assert.equal(view.selectedTask()?.id, "finished", "the session's own finished task is selectable even with nothing active");
		view.handleInput("a");
		// The "Current orchestrator" heading starts collapsed here: it has no
		// active task to auto-expand it, only finished history.
		view.handleInput("\x1b[C");
		const rendered = view.render(80).map(stripAnsi).join("\n");
		assert.doesNotMatch(rendered, /Subagent (foreign|unknown)|Orchestrator closed|Unknown session/);
		assert.match(rendered, /Subagent finished/, "the session's own finished task shows under all sessions too, once its heading is expanded");
		assert.equal(store.list().length, 3, "panel filtering never deletes retained history");
	} finally {
		view.dispose();
	}
});

function mouse(x: number, y: number, width: number, height: number, type: TuiMouseEvent["type"] = "move", wheelDelta?: number): TuiMouseEvent {
	return { type, button: type === "move" || type === "wheel" ? "none" : "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

test("AgentsView pointer regions hover and select task rows without activating, and keep list and thread wheels independent", () => {
	const { store, view, events } = harness(6);
	for (const id of ["a", "b", "c", "d", "e"]) store.add(task(id, { agent: id }));
	for (let index = 0; index < 8; index += 1) store.apply("b", { type: TASK_EVENT.TEXT, text: `thread ${index}\n` }, 2000);
	const lines = view.render(80);

	assert.equal(view.handleMouse(mouse(4, 2, 80, lines.length))?.handled, true, "hover consumes only the task row");
	assert.equal(view.selectedTask()?.id, "a", "hover never changes keyboard selection or the displayed thread");
	assert.equal(view.handleMouse(mouse(4, 2, 80, lines.length, "click"))?.handled, true);
	assert.equal(view.selectedTask()?.id, "b", "click selects the task and displays its thread");
	assert.deepEqual(events, [], "click selects the task only; it never opens or cancels");
	view.render(80);
	assert.equal(view.handleMouse(mouse(50, 2, 80, lines.length, "wheel", -1))?.handled, true, "thread wheel is handled by its viewport");
	assert.match(stripAnsi(view.render(80)[2]), /thread 5/, "thread wheel moves only the selected thread");
	assert.equal(view.handleMouse(mouse(4, 2, 80, lines.length, "wheel", 1))?.handled, true, "list wheel is handled by its viewport");
	assert.match(stripAnsi(view.render(80)[1]), / b /, "list wheel changes only the task-list viewport");
	assert.equal(view.handleMouse(mouse(50, 2, 80, lines.length, "click")), undefined, "thread clicks are inert");
	view.dispose();
	assert.equal(view.handleMouse(mouse(4, 2, 80, lines.length)), undefined, "late pointer events are inert after disposal");
});

test("AgentsView retains narrow keyboard mode after selection and store invalidation", () => {
	const { store, view, events } = harness(6);
	store.add(task("a"));
	store.add(task("b", { agent: "b" }));
	for (let index = 0; index < 3; index += 1) store.apply("b", { type: TASK_EVENT.TEXT, text: `thread ${index}\n` }, 2000);
	view.render(40);
	view.handleInput("j");
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /thread 2/, "Tab still enters Details before a pointer-invalidating selection rerenders");
	view.handleInput("\t");
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /thread 2/, "repeated Tab toggles semantically before a frame");
	view.handleInput("\t");
	store.apply("b", { type: TASK_EVENT.TEXT, text: "after update\n" }, 2000);
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /after update/, "a selected-task update does not discard narrow keyboard knowledge");
	view.handleInput("\x1b");
	view.handleInput("\t");
	assert.equal(view.selectedTask()?.id, "b", "returning through the list retains its selected child");
	assert.deepEqual(events, [], "Tab never opens the editor");
	view.dispose();
});

test("AgentsView narrow drilldown has explicit Back, independent wheel and Open, and global close", () => {
	const { store, view, events } = harness(6);
	store.add(task("a"));
	store.add(task("b", { agent: "b" }));
	for (let index = 0; index < 8; index += 1) store.apply("b", { type: TASK_EVENT.TEXT, text: `thread ${index}\n` }, 2000);
	let frame = view.render(40);
	let top = stripAnsi(frame[0] ?? "");
	assert.match(top, /\[×\]/, "root has a compact global Close");
	clickLabel(view, "Subagent b", 40);
	assert.equal(view.selectedTask()?.id, "b");
	assert.deepEqual(events, [], "drilldown never opens or stops a task");
	assert.equal(view.handleMouse(mouse(4, 2, 40, frame.length, "click")), undefined, "a mode change invalidates old pointer bounds before render");
	frame = view.render(40);
	top = stripAnsi(frame[0] ?? "");
	assert.match(top, /\[← Back\]/);
	assert.match(frame.map(stripAnsi).join("\n"), /thread 7/, "Details is the local thread viewport");
	assert.equal(view.handleMouse(mouse(4, 2, 40, frame.length, "wheel", -1))?.handled, true, "the detail viewport owns its wheel");
	const backX = visibleWidth(top.slice(0, top.indexOf("[← Back]")));
	assert.equal(view.handleMouse(mouse(backX, 0, 40, frame.length, "click"))?.handled, true, "Back is an explicit pointer control");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /Subagent b/, "Back restores the local List viewport");
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /thread 6/, "Tab enters Details only for a selected task");
	view.handleInput("\t");
	assert.match(view.render(40).map(stripAnsi).join("\n"), /Subagent b/, "Tab returns to List");
	view.handleInput("\t");
	view.handleInput("o");
	view.handleInput("\x1b");
	view.handleInput("k");
	view.handleInput("\x0d");
	view.handleInput("o");
	assert.deepEqual(events, ["open:b", "open:a"], "Enter inspects locally; o remains the editor action");
	const fallback = view.render(11);
	assert.equal(fallback.length, 6, "width below 12 uses the bounded Close-only fallback, covering the terminal's rows so the wheel cannot reach the chat behind it");
	assert.equal(fallback.filter((line) => stripAnsi(line).trim().length > 0).length, 1, "and still draws one visible control");
	assert.equal(view.handleMouse(mouse(0, 2, 11, 6))?.handled, true, "the tiny Close cell remains hoverable, on the row the host would centre it on");
	view.handleInput("\x1b");
	view.handleInput("q");
	assert.deepEqual(events, ["open:b", "open:a", "close"], "q closes once from any level without cancelling");
	view.dispose();
});

test("AgentsView clears hover on leave, list scrolling, resize, updates, empty lists, and disposal", () => {
	const { store, view } = harness(6);
	store.add(task("a"));
	store.add(task("b", { agent: "b" }));
	store.add(task("c", { agent: "c" }));
	store.add(task("d", { agent: "d" }));
	const lines = view.render(80);
	const observer = view.mouseObserver();
	const dispatch = (event: TuiMouseEvent) => {
		observer.beforeMouse(event);
		try {
			return view.handleMouse(event);
		} finally {
			observer.afterMouse(event);
		}
	};
	dispatch(mouse(4, 3, 80, lines.length));
	assert.match(stripAnsi(view.render(80)[3]), /▹/, "the hovered row is styled without changing selection");
	dispatch(mouse(4, 3, 80, lines.length, "wheel", -1));
	assert.match(stripAnsi(view.render(80)[3]), /▹/, "a list wheel event at its boundary preserves hover");
	dispatch(mouse(4, 3, 80, lines.length, "wheel", 1));
	assert.doesNotMatch(stripAnsi(view.render(80).join("\n")), /▹/, "list scrolling clears hover so it cannot remain on the task formerly under the pointer");
	dispatch(mouse(4, 3, 80, lines.length));
	dispatch(mouse(50, 3, 80, lines.length));
	assert.doesNotMatch(stripAnsi(view.render(80)[3]), /▹/, "the root observer clears hover outside a child region");
	dispatch(mouse(4, 3, 80, lines.length));
	view.render(81);
	assert.doesNotMatch(stripAnsi(view.render(81)[3]), /▹/, "resize clears hover before the next frame");
	dispatch(mouse(4, 3, 81, lines.length));
	store.apply("a", { type: TASK_EVENT.TEXT, text: "update" }, 2000);
	assert.doesNotMatch(stripAnsi(view.render(81)[3]), /▹/, "task updates clear the actual hovered task row");
	view.dispose();
	const { view: empty } = harness(6);
	empty.render(80);
	assert.equal(empty.handleMouse(mouse(4, 1, 80, 6)), undefined, "empty task rows are inert");
	empty.dispose();
});

test("AgentsView advertises s to stop an active selection, retains c as an alias, and hides stopping for finished tasks", () => {
	const { store, view, events } = harness(8);
	store.add(task("active"));
	assert.match(stripAnsi(view.render(80).at(-2) ?? ""), /\[Stop\]/);
	view.handleInput("s");
	view.handleInput("c");
	assert.deepEqual(events, ["cancel:active", "cancel:active"]);
	store.update("active", { status: TASK_STATUS.CANCELLED, endedAt: 2000 });
	assert.doesNotMatch(stripAnsi(view.render(80).at(-2) ?? ""), /\[Stop\]/);
	view.handleInput("s");
	assert.deepEqual(events, ["cancel:active", "cancel:active"], "finished tasks never stop");
});

test("AgentsView close control, Escape, and q share rendered bounds and one idempotent close", () => {
	const { store, view, events } = harness(8);
	store.add(task("active"));
	const wide = 80;
	let lines = view.render(wide);
	let top = stripAnsi(lines[0]);
	assert.equal(visibleWidth(top), wide, "the full close header fits its rendered width");
	assert.match(top, /\[× Close\]/, "wide headers show the labelled close control");
	let closeX = visibleWidth(top.slice(0, top.indexOf("[× Close]")));
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length))?.render, true, "hover targets only the rendered close bounds");
	assert.equal(view.selectedTask()?.id, "active", "close hover never changes task selection");
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length, "press")), undefined, "press is inert");
	assert.equal(view.handleMouse({ ...mouse(closeX, 0, wide, lines.length, "click"), button: "right" }), undefined, "right click is inert");
	assert.equal(view.handleMouse({ ...mouse(closeX, 0, wide, lines.length, "click"), button: "middle" }), undefined, "middle click is inert");
	assert.equal(view.handleMouse(mouse(closeX, 0, wide + 1, lines.length, "click")), undefined, "stale width is inert");
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length + 1, "click")), undefined, "stale height is inert");

	lines = view.render(59);
	top = stripAnsi(lines[0]);
	assert.equal(visibleWidth(top), 59, "the narrow header fits its rendered width");
	assert.match(top, /\[×\]/, "width 59 uses its narrow root instead of the fallback");
	assert.doesNotMatch(top, /Follow|Open session/, "narrow mode keeps footer controls out when they do not fit");

	lines = view.render(wide);
	top = stripAnsi(lines[0]);
	closeX = visibleWidth(top.slice(0, top.indexOf("[× Close]")));
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length, "click"))?.handled, true);
	view.handleInput("\x1b");
	view.handleInput("q");
	assert.deepEqual(events, ["close"], "pointer and close keys share one idempotent close action without cancelling");
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length, "click")), undefined, "late pointer events are inert after close");
	const { store: keyStore, view: keyView, events: keyEvents } = harness(8);
	keyStore.add(task("key-close"));
	keyView.handleInput("\x1b");
	keyView.handleInput("q");
	assert.deepEqual(keyEvents, ["close"], "Escape and q themselves close only once");
	keyView.dispose();
	view.dispose();
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, lines.length)), undefined, "disposed close controls stay inert");
});

test("AgentsView scrolls the task list so the selection stays visible when there are more tasks than rows", () => {
	const { store, view } = harness(6);
	for (let index = 0; index < 6; index += 1) store.add(task(`t${index}`, { agent: `agent${index}`, createdAt: 1000 - index, lastActivityAt: 1000 - index }));
	const listed = () => view.render(80).slice(1, 4).map((line) => stripAnsi(line).slice(0, 24));
	assert.match(listed()[0], /▸ └ ◐ Subagent agent0/);
	assert.match(listed()[1], /Subagent agent1/);
	assert.match(listed()[2], /Subagent agent2/);
	for (let index = 0; index < 4; index += 1) view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "t4");
	assert.match(listed()[2], /▸ └ ◐ Subagent agent4/, "the list scrolls down until the selection is the last visible row");
	assert.match(listed()[0], /Subagent agent2/);
	view.handleInput("j");
	view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "t5", "the selection stops at the last task");
	assert.match(listed()[2], /▸ └ ◐ Subagent agent5/);
	for (let index = 0; index < 4; index += 1) view.handleInput("k");
	assert.match(listed()[0], /▸ └ ◐ Subagent agent1/, "moving up scrolls the list back");
	assert.match(listed()[2], /Subagent agent3/);
});

test("AgentsView scopes to this session's own children (active and finished) and toggles only the open-session directory", () => {
	const { store, view } = harness(12, "s");
	store.add(task("mine", { agent: "mine" }));
	store.add(task("theirs", { agent: "theirs", parentSessionId: "other", createdAt: 900, lastActivityAt: 900 }));
	store.add(task("fresh", { agent: "fresh", status: TASK_STATUS.COMPLETED, endedAt: 61_000 - 60_000, createdAt: 850, lastActivityAt: 850 }));
	store.add(task("stale", { agent: "stale", status: TASK_STATUS.COMPLETED, endedAt: 61_000 - 16 * 60_000, createdAt: 800, lastActivityAt: 800 }));
	const names = () => view.render(80).map(stripAnsi).filter((line) => /[◐✓] Subagent /.test(line)).map((line) => line.match(/[◐✓] Subagent (\w+)/)?.[1]);
	let plain = view.render(80).map(stripAnsi);
	assert.match(plain[0], /^╭─ ❀ Agents · this session · 1 active · 2 finished ─+ \[F Fullscreen\] \[× Close\]╮$/);
	assert.deepEqual(names(), ["mine", "fresh", "stale"], "the session's own history stays, newest ended first, after the active child; the foreign task stays out");
	assert.match(plain.at(-2) ?? "", /\[Scope\]/);
	view.handleInput("a");
	plain = view.render(80).map(stripAnsi);
	assert.match(plain[0], /^╭─ ❀ Agents · all sessions · 1 active · 2 finished ─+ \[F Fullscreen\] \[× Close\]╮$/);
	assert.deepEqual(names(), ["mine", "fresh", "stale"], "retained foreign tasks cannot manufacture open orchestrators");
	assert.match(plain.at(-2) ?? "", /\[Scope\]/);
	view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "fresh", "navigation moves to the session's own next-newest history entry");
	view.handleInput("a");
	assert.equal(view.selectedTask()?.id, "mine", "a new scope reads from the top");
	assert.deepEqual(names(), ["mine", "fresh", "stale"]);
});

test("AgentsView footer buttons follow, open only a session-backed selection, and clear stale geometry", () => {
	const { store, view, events } = harness(8, "s");
	store.add(task("a", { sessionPath: "/sessions/a.jsonl" }));
	for (let index = 0; index < 12; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	const width = 160;
	const lines = view.render(width);
	const footerY = lines.length - 2;
	const followX = 2;
	const openX = 13;
	assert.match(stripAnsi(lines.at(-2) ?? ""), /\[ Follow \].*\[ Open session \]/, "buttons render only after the full key-hint row fits");

	view.handleInput("\x1b[5~");
	assert.match(stripAnsi(view.render(width)[2]), /line 4/, "page up leaves follow mode before the button restores it");
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length))?.render, true, "button hover requests a distinct frame");
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "press")), undefined, "press is inert");
	assert.equal(view.handleMouse({ ...mouse(followX, footerY, width, lines.length, "click"), button: "right" }), undefined, "right click is inert");
	assert.equal(view.handleMouse({ ...mouse(followX, footerY, width, lines.length, "click"), button: "middle" }), undefined, "middle click is inert");
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "click"))?.handled, true);
	assert.match(stripAnsi(view.render(width)[2]), /line 8/, "Follow returns the selected thread to its tail");
	assert.equal(view.handleMouse(mouse(openX, footerY, width, lines.length, "click"))?.handled, true);
	assert.deepEqual(events, ["open:a"], "Open delegates the selected task to the existing callback");
	assert.equal(view.handleMouse(mouse(followX, footerY, width + 1, lines.length, "click")), undefined, "a pre-render resize makes the prior footer geometry inert");

	store.update("a", { sessionPath: null });
	view.render(width);
	assert.equal(view.handleMouse(mouse(openX, footerY, width, lines.length, "click")), undefined, "Open is disabled when the selected task loses its session path");
	assert.deepEqual(events, ["open:a"]);
	view.render(200);
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "click")), undefined, "resize discards the old footer geometry before routing clicks");
	assert.match(stripAnsi(view.render(44).at(-2) ?? ""), /Follow|Open/, "controls take priority over keyboard hints");
	view.handleInput("a");
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "click")), undefined, "a scope change clears old footer geometry until the next frame");
	view.dispose();
	assert.equal(view.handleMouse(mouse(followX, footerY, width, lines.length, "click")), undefined, "disposed footer controls stay inert");
	const { view: empty } = harness(8, "s");
	const emptyLines = empty.render(width);
	assert.equal(empty.handleMouse(mouse(followX, footerY, width, emptyLines.length, "click")), undefined, "Follow is disabled with no selected task");
	assert.equal(empty.handleMouse(mouse(openX, footerY, width, emptyLines.length, "click")), undefined, "Open is disabled with no selected session");
	empty.dispose();
});

test("AgentsView reads live rows, preserves manual scroll and selection, and invalidates stale pointer bounds", () => {
	const store = new TaskStore();
	let rows = 8;
	const view = new AgentsView({
		theme: plainTheme,
		rows: () => rows,
		store,
		sessionId: "s",
		now: () => 61_000,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	for (let index = 0; index < 6; index += 1) store.add(task(`t${index}`, { agent: `agent${index}`, createdAt: 1000 - index, lastActivityAt: 1000 - index }));
	for (let index = 0; index < 10; index += 1) store.apply("t4", { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000);
	for (let index = 0; index < 4; index += 1) view.handleInput("j");
	view.render(80);
	view.handleInput("\x1b[5~");
	rows = 6;
	const resized = view.render(80).map(stripAnsi);
	assert.equal(resized.length, 6, "the frame uses the live terminal height budget");
	assert.equal(view.selectedTask()?.id, "t4", "resize never changes the selected task");
	assert.match(resized[3] ?? "", /▸ └ ◐ Subagent agent4/, "the list scroll clamps while retaining the selected row");
	assert.doesNotMatch(resized.join("\n"), /line 9/, "manual thread scroll survives resize instead of returning to the tail");
	assert.equal(view.handleMouse(mouse(4, 2, 80, 8, "click")), undefined, "old-height pointer input is stale after resize");
	view.render(40);
	view.handleInput("\t");
	const narrow = view.render(40).map(stripAnsi);
	rows = 5;
	const narrower = view.render(40).map(stripAnsi);
	assert.equal(view.selectedTask()?.id, "t4", "a narrow resize retains the selection");
	assert.doesNotMatch(narrow.join("\n"), /line 9/);
	assert.doesNotMatch(narrower.join("\n"), /line 9/, "a narrow resize preserves manual detail scrolling");
	rows = 2;
	assert.equal(view.render(80).length, 2, "a tiny terminal covers its rows with the fallback instead of one bare line, and forces no chrome");
	view.dispose();
});

test("AgentsView rejects cached-height pointer input before the live resize renders", () => {
	const store = new TaskStore();
	let rows = 10;
	const view = new AgentsView({
		theme: plainTheme,
		rows: () => rows,
		store,
		sessionId: "s",
		now: () => 61_000,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	store.add(task("a"));
	for (let index = 0; index < 12; index += 1) store.apply("a", { type: TASK_EVENT.TEXT, text: `l${index}\n` }, 2000);
	view.handleInput("\x1b[5~");
	const oldFrame = view.render(80);
	const paneRows = (frame: string[]) => stripAnsi(frame.slice(2, -2).join("\n"));
	assert.match(paneRows(oldFrame), /l0/, "manual scrolling establishes a stable pre-resize position");
	rows = 8;
	const stale = view.handleMouse(mouse(50, 2, 80, oldFrame.length, "wheel", 1));
	assert.equal(stale?.handled, true, "old-height wheel input is claimed, so it can never reach the chat behind the pane");
	assert.equal(stale?.render, false, "and it moves nothing before the resize frame");
	const resized = view.render(80);
	assert.match(stripAnsi(resized[2] ?? ""), /✉  Messaging agent/, "the stale wheel leaves manual thread scroll unchanged");
	assert.equal(view.handleMouse(mouse(50, 2, 80, resized.length, "wheel", 1))?.handled, true, "the new-height wheel reaches the rendered thread region");
	assert.match(paneRows(view.render(80)), /l0/, "the live wheel moves the thread past the input message after the new frame");
	view.dispose();
});

// The cards inside the pane name the key that actually toggles them and the time
// the child actually measured. Both come from one place each — the host's
// resolved keybinding and the child's own tool event — never a second source.
test("thread cards name the host's configured key and the time the child measured", () => {
	const output = Array.from({ length: 6 }, (_, index) => `row ${index}`).join("\n");
	// `toggle` presses the resolved key, so each frame is read in the state the
	// overlay is actually in rather than in an assumed one.
	const frame = (expandLabel: string, toggle: boolean): string => {
		const { store, view } = viewWith({
			keys: { expandsTools: (data) => data === "\x0f", togglesThinking: () => false, expandLabel, thinkingLabel: "ctrl+t" },
		}, 20);
		store.add(task("a"));
		store.apply("a", { type: TASK_EVENT.TOOL_START, callId: "c1", name: "subagent_run", args: { task: "review" } }, 2000);
		store.apply("a", { type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output }, 2000);
		store.apply("a", { type: TASK_EVENT.TOOL_END, callId: "c1", output, isError: false, durationMs: 1234 }, 2000);
		if (toggle) view.handleInput("\x0f");
		const drawn = view.render(80).map(stripAnsi).join("\n");
		view.dispose();
		return drawn;
	};
	// A remapped toggle shows the remapped key on the card, and the card names the
	// action that key takes next.
	const open = frame("ctrl+e", false);
	assert.match(open, /ctrl\+e to collapse/, "the card names the key the host resolved");
	assert.equal(open.includes("ctrl+o"), false, "a hardcoded key never reaches a card");
	assert.match(open, /1\.2s/, "the measured elapsed time reaches the card");
	const collapsed = frame("ctrl+e", true);
	assert.match(collapsed, /ctrl\+e to expand/, "and the card follows the state the key put it in");

	// A host that left the toggle unbound advertises no key on its cards.
	for (const unbound of [frame("", false), frame("", true)]) {
		assert.equal(unbound.includes("ctrl+e"), false);
		assert.equal(unbound.includes("ctrl+o"), false);
	}
});

// The two agents views: the log view restores the pane's original labelled log,
// the cards view keeps the conversation's own rendering. The preference is
// resolved by the host and handed in, so one process can render either safely.

/** The selected thread's own cells, frame and list column removed. */
function threadRows(view: AgentsView, width = 80, height = 20): string[] {
	const layout = measureAgentsViewLayout(width, height);
	return view.render(width).map(stripAnsi).map((row) => row.slice(layout.threadX, layout.threadX + layout.threadWidth).trimEnd());
}

const threadFixture = () => ({ ...emptyThread(), items: [
	{ kind: "text" as const, text: "The parser is fine." },
	{ kind: "thinking" as const, text: "private reasoning" },
	{ kind: "note" as const, text: "a note" },
	{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: "suite 1\nsuite 2", running: false, isError: false },
] });

test("the log view restores the pane's original labelled thread rows", () => {
	const { store, view } = viewWith({ style: "log" }, 20);
	store.restore(task("a", { prompt: "inspect the parser" }), threadFixture());
	const rows = threadRows(view);
	for (const label of ["Text", "Thinking", "Note", "Tool · bash · Complete", "  Output"]) {
		assert.ok(rows.includes(label), `${label} is the log view's own row`);
	}
	assert.ok(rows.includes("  The parser is fine."), "prose is the original indented text");
	assert.ok(rows.includes("    suite 2"), "tool output keeps the original four-column indent");
	assert.ok(!rows.includes("inspect the parser"), "the input card belongs to the cards view alone");
	// The cards-only presentation keys are not advertised where they draw nothing.
	const logHints = view.render(240).map(stripAnsi).join("\n");
	assert.doesNotMatch(logHints, /ctrl\+o (expand|collapse)/, "the log view promises no card toggle");
	assert.doesNotMatch(logHints, /ctrl\+t (show|hide) thinking/, "and no thinking toggle");
	view.dispose();
	const cardsHints = viewWith({ style: "cards" }, 20);
	cardsHints.store.restore(task("a", { prompt: "" }), threadFixture());
	assert.match(cardsHints.view.render(240).map(stripAnsi).join("\n"), /ctrl\+o collapse/, "the cards view still names its own toggles");
	cardsHints.view.dispose();
	// A caller that names no style keeps the chat rendering it had before the
	// preference existed; the saved preference, which decides what a real session
	// draws, is owned by lib/agents-view-style-policy.ts and defaults to log.
	const unnamed = viewWith({}, 20);
	unnamed.store.restore(task("a", { prompt: "inspect the parser" }), threadFixture());
	assert.ok(!threadRows(unnamed.view).includes("Text"), "an unnamed style is not the log view");
	unnamed.view.dispose();
});

test("the cards view replaces those labels with the conversation's own rendering", () => {
	const { store, view } = viewWith({ style: "cards" }, 20);
	store.restore(task("a", { prompt: "inspect the parser" }), { ...emptyThread(), items: [
		{ kind: "text" as const, text: "The **parser** is fine." },
		{ kind: "tool" as const, callId: "c", name: "bash", args: { command: "pnpm test" }, output: "suite 1\nsuite 2", running: false, isError: false },
	] });
	const rows = threadRows(view);
	assert.ok(!rows.includes("Text"), "no log label survives in the cards view");
	assert.ok(!rows.includes("Output"), "a call is a card, not a labelled output block");
	assert.ok(rows.some((row) => row.includes("inspect the parser")), "the input card leads the cards view");
	assert.ok(rows.some((row) => row.includes("The parser is fine.")), "markdown prose is rendered as the chat renders it");
	view.dispose();
});

test("both views keep the pane's width, tail-following and page keys", () => {
	for (const style of ["log", "cards"] as const) {
		const { store, view } = viewWith({ style }, 12);
		store.restore(task("a", { prompt: "the first input" }), { ...emptyThread(), items: Array.from({ length: 40 }, (_, index) => ({ kind: "text" as const, text: `line ${index}` })) });
		for (const width of [40, 80]) for (const row of view.render(width)) assert.equal(visibleWidth(row), width, `${style} keeps ${width} columns`);
		const window = () => threadRows(view, 80, 12).join("\n");
		assert.match(window(), /line 39/, `${style} opens at the tail`);
		view.handleInput("\x1b[1;5H");
		assert.match(window(), /line 0/, `${style} jumps to the first row`);
		assert.doesNotMatch(window(), /line 39/);
		view.handleInput("\x1b[1;5F");
		assert.match(window(), /line 39/, `${style} returns to the tail`);
		// The page keys still move by a page, whatever the renderer drew.
		view.handleInput("\x0b");
		assert.doesNotMatch(window(), /line 39/, `${style} pages back through the thread`);
		view.handleInput("\x0a");
		assert.match(window(), /line 39/, `${style} pages forward to the tail`);
		view.dispose();
	}
});

test("both views render safely in the fallback and narrow geometries", () => {
	for (const style of ["log", "cards"] as const) {
		const thread = () => ({ ...emptyThread(), items: [{ kind: "text" as const, text: "hello" }] });
		// No room for a frame: one bounded control, and the rows the host drew.
		const tiny = viewWith({ style }, 3);
		tiny.store.restore(task("a", { prompt: "" }), thread());
		const fallback = tiny.view.render(10);
		assert.equal(fallback.length, 3, `${style} fallback fills the rows it owns`);
		assert.match(stripAnsi(fallback.join("\n")), /× Close/, `${style} fallback keeps its one way out`);
		tiny.view.dispose();
		// Too narrow for two panes: the list, then the selected thread in Details.
		const narrow = viewWith({ style }, 12);
		narrow.store.restore(task("a", { prompt: "" }), thread());
		clickLabel(narrow.view, "Subagent explore", 40);
		const frame = narrow.view.render(40);
		for (const row of frame) assert.equal(visibleWidth(row), 40, `${style} keeps the narrow frame width`);
		assert.match(frame.map(stripAnsi).join("\n"), /hello/, `${style} still draws its retained thread in Details`);
		narrow.view.dispose();
	}
});
