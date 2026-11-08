import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { TASK_EVENT, TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";
import { AgentsView } from "../lib/agents-view.ts";
import { clearAgentToolRenderers, registerAgentToolRenderers } from "../lib/agents-tool-renderers.ts";
import { createCodeGraphCardRenderer, createQuietToolRenderer } from "../extensions/quiet-tools.ts";

// The Agents overlay's steady state, measured rather than asserted by inspection.
// The pane draws the chat's own cards, so an open pays for every retained item
// once; after that a frame is only the visible window. These checks hold the two
// halves of that apart: the deterministic ones count draws, and the timing ones
// keep a generous ceiling so a real regression (a frame that walks the thread or
// re-draws its cards) shows up instead of a scheduling blip.
initTheme("dark");

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
const PROSE = "## Handoff\n\nThe retained thread keeps the same presentation as the transcript, so a call reads the same in both places.\n\nA second paragraph that wraps across the pane.\n";
const OUTPUT = Array.from({ length: 12 }, (_, index) => `row ${index} of the command output`).join("\n");
const TOOL_NAMES = ["bash", "read", "grep", "edit", "write", "subagent_run"] as const;

function task(id: string): TaskRecord {
	return { id, agent: "explore", mode: "task", prompt: "Investigate the render cost.", label: "perf", cwd: "/repo/worktrees/feat-perf",
		parentSessionId: "s", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "gpt-5.6-terra",
		thinking: undefined, sessionPath: "/sessions/x.jsonl", error: null, result: null, lastStep: "grep", lastActivityAt: 1000,
		turns: 0, toolCalls: 0, tokens: 34_000, cost: 0.27 };
}

/** A thread of the mix a real child retains: prose, thinking runs and finished tool calls. */
function storeWith(items: number): TaskStore {
	const store = new TaskStore();
	store.add(task("a"));
	let calls = 0;
	for (let index = 0; index < items; index += 1) {
		const slot = index % 4;
		if (slot === 0) store.apply("a", { type: TASK_EVENT.TEXT, text: PROSE }, 2000 + index);
		else if (slot === 1) store.apply("a", { type: TASK_EVENT.THINKING, text: "The thread keeps its own display state, so a toggle moves that card alone." }, 2000 + index);
		else {
			const name = TOOL_NAMES[calls % TOOL_NAMES.length]!;
			const callId = `c${calls}`;
			calls += 1;
			store.apply("a", { type: TASK_EVENT.TOOL_START, callId, name, args: name === "bash" ? { command: "pnpm test" } : { path: "lib/agents-view.ts" } }, 2000 + index);
			store.apply("a", { type: TASK_EVENT.TOOL_END, callId, output: OUTPUT, isError: false }, 2000 + index);
		}
	}
	return store;
}

function view(store: TaskStore): AgentsView {
	return new AgentsView({
		theme, rows: 40, store, sessionId: "s", now: () => 61_000,
		// Pi's own default: the chat's tool cards are collapsed.
		toolsExpanded: () => false,
		onCancel() {}, onOpen() {}, onClose() {}, requestRender() {},
	});
}

function median(samples: number[]): number {
	const ordered = [...samples].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function time(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

/** Register the chat's real cards, the way extensions/quiet-tools.ts offers them on load. */
function registerChatCards(onDraw?: () => void): void {
	const cards = Object.fromEntries((["read", "grep", "find", "ls", "edit", "write"] as const).map((name) => [name, createQuietToolRenderer(name)]));
	registerAgentToolRenderers({
		...cards,
		bash: createQuietToolRenderer("bash"),
		codegraph: createCodeGraphCardRenderer(),
		...(onDraw === undefined ? {} : { subagent_run: countingRenderer(onDraw) }),
	}, { owner: "agents-performance" });
}

/** A `renderShell: "self"` card that only counts the draws it is asked for. */
function countingRenderer(onDraw: () => void): { renderShell: "self"; renderCall: () => Component; renderResult: (result: AgentToolResult<unknown>) => Component } {
	const rows = (): string[] => ["call"];
	return {
		renderShell: "self",
		renderCall: () => { onDraw(); return { render: rows, invalidate() {} }; },
		renderResult: () => ({ render: rows, invalidate() {} }),
	};
}

test("a warm frame and a scroll step draw no tool card again", () => {
	// The pane caches one render per item, so nothing is drawn twice for the same
	// width and state: a steady frame and a scroll step only cut the visible window.
	// Counting the calls is deterministic, so this cannot drift with the machine.
	let draws = 0;
	registerChatCards(() => { draws += 1; });
	try {
		const store = storeWith(200);
		const pane = view(store);
		pane.render(120);
		const open = draws;
		assert.ok(open >= 1, "the first frame draws the retained calls");
		draws = 0;
		pane.render(120);
		assert.equal(draws, 0, "a warm frame re-draws no card");
		pane.handleInput("\u001b[5~");
		pane.render(120);
		assert.equal(draws, 0, "a scroll step re-draws no card");
		pane.dispose();
	} finally {
		clearAgentToolRenderers("agents-performance");
	}
});

test("a warm frame of a 400-item thread stays under a bounded cost and does not scale with it", (t) => {
	registerChatCards();
	try {
		const measure = (items: number) => {
			const store = storeWith(items);
			const pane = view(store);
			pane.render(120);
			const warm = median(Array.from({ length: 25 }, () => time(() => pane.render(120))));
			pane.handleInput("\u001b[5~");
			pane.render(120);
			const scroll = median(Array.from({ length: 9 }, () => time(() => {
				pane.handleInput("\u001b[5~");
				pane.render(120);
			})));
			pane.dispose();
			return { warm, scroll };
		};
		// A first pass warms the JIT so the ceiling reflects the steady state it guards.
		measure(40);
		const small = measure(40);
		const large = measure(400);
		t.diagnostic(`warm frame: 40 items ${small.warm.toFixed(3)}ms, 400 items ${large.warm.toFixed(3)}ms; scroll step: ${small.scroll.toFixed(3)}ms / ${large.scroll.toFixed(3)}ms`);
		assert.ok(large.warm < 5, `a warm 400-item frame is ${large.warm.toFixed(3)}ms, under the 5ms ceiling`);
		assert.ok(large.scroll < 5, `a 400-item scroll step is ${large.scroll.toFixed(3)}ms, under the 5ms ceiling`);
		// Ten times the retained items must not cost a warm frame ten times as much:
		// the frame reuses the assembled rows instead of walking them again.
		assert.ok(large.warm <= small.warm * 3 + 0.5, `a warm 400-item frame (${large.warm.toFixed(3)}ms) stays near a warm 40-item frame (${small.warm.toFixed(3)}ms)`);
		assert.ok(large.scroll <= small.scroll * 3 + 0.5, `a 400-item scroll step (${large.scroll.toFixed(3)}ms) stays near a 40-item one (${small.scroll.toFixed(3)}ms)`);
	} finally {
		clearAgentToolRenderers("agents-performance");
	}
});
