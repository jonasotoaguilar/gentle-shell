import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The delegated transport is pinned against the child's real tool: the native edit
// executes on a real file, and the event it produced is what the runner normalizes.
import { createEditTool } from "@earendil-works/pi-coding-agent";
import {
	applyTaskEvent,
	emptyThread,
	MISSING_TOOLS_NOTE_PREFIX,
	normalizeRpcEvent,
	ToolArgumentProgress,
	TASK_EVENT,
	TASK_STATUS,
	taskLabel,
	storedThread,
	TaskStore,
	TERMINAL_RETENTION,
	THREAD_ITEM,
	TOOL_DETAIL_MAX_CHARS,
	isFinished,
	toolItemDetails,
	type TaskRecord,
	type ToolItem,
} from "../lib/agents-protocol.ts";

function terminalError(message: Record<string, unknown>) {
	const [event] = normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", ...message }] });
	assert.equal(event?.type, TASK_EVENT.AGENT_END);
	return event as Extract<typeof event, { type: typeof TASK_EVENT.AGENT_END }>;
}

test("terminal assistant errors expose one closed category, never provider text (#2322)", () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["rate limit error type", { errorMessage: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}" }, "rate_limit"],
		["too many requests", { errorMessage: "Too Many Requests" }, "rate_limit"],
		["bare 429 status", { errorMessage: "429: {}" }, "rate_limit"],
		["quota on a 429", { errorMessage: "429 You exceeded your current quota (insufficient_quota)" }, "quota"],
		["invalid key", { errorMessage: "401 invalid x-api-key" }, "auth"],
		["forbidden status", { errorMessage: "Provider (403): {}" }, "auth"],
		["prompt too long", { errorMessage: "400 prompt is too long: 210000 tokens > 200000 maximum" }, "context_length"],
		["context window raw stop reason", { rawStopReason: "model_context_window_exceeded" }, "context_length"],
		["timed out", { errorMessage: "Request timed out." }, "timeout"],
		["diagnostic timeout code", { diagnostics: [{ type: "stream", timestamp: 1, error: { message: "x", code: "ETIMEDOUT" } }] }, "timeout"],
		["fetch failed", { errorMessage: "fetch failed" }, "network"],
		["connection reset", { errorMessage: "read ECONNRESET" }, "network"],
		["overloaded", { errorMessage: "529 {\"type\":\"overloaded_error\"}" }, "provider_unavailable"],
		["bad gateway status", { errorMessage: "502: <html>" }, "provider_unavailable"],
		["invalid request", { errorMessage: "400 invalid_request_error: messages.0 is malformed" }, "invalid_request"],
		["unmatched provider text", { errorMessage: "Provider finish_reason: content_filter" }, "unavailable"],
		["token count is not a status", { errorMessage: "stopped after 500 tokens" }, "unavailable"],
		["no error message", {}, "unavailable"],
		["non-string error message", { errorMessage: { status: 429 } }, "unavailable"],
		["raw stop reason that is not an identifier", { rawStopReason: "rate limit <script>" }, "unavailable"],
		["signal beyond the scan bound", { errorMessage: `${"x".repeat(5000)} rate limit` }, "unavailable"],
	];
	for (const [name, message, category] of cases) {
		assert.deepEqual(terminalError(message), { type: TASK_EVENT.AGENT_END, text: "", outcome: "error", diagnostic: `assistant reported an error (${category})`, errorCategory: category }, name);
	}
});

test("terminal error categories never carry provider payload into the event or the task (#2322)", () => {
	const secret = "sk-live-never-copy-7f3a";
	const event = terminalError({ errorMessage: `429 rate limit for key ${secret} at https://private.example/v1`, rawStopReason: "error", diagnostics: [{ type: "stream", timestamp: 1, error: { message: secret, code: secret } }] });
	assert.equal(event.errorCategory, "rate_limit");
	assert.equal(JSON.stringify(event).includes("never-copy"), false);
	assert.equal(JSON.stringify(event).includes("private.example"), false);
	const store = new TaskStore();
	store.add(record({ status: TASK_STATUS.RUNNING }));
	store.apply("t1", event, 2);
	const task = store.get("t1");
	assert.equal(task?.error, "assistant reported an error (rate_limit)");
	assert.equal(task?.lastStep, "assistant reported an error (rate_limit)");
	assert.equal(task?.result, null);
	assert.equal(JSON.stringify(task).includes("never-copy"), false);
	assert.equal(JSON.stringify(store.thread("t1")).includes("never-copy"), false);
});

test("status observers see only live transitions, remain isolated and cannot fail mutations", () => {
	const store = new TaskStore();
	const changes: Array<{ status: string; sequence: number; parentSessionId: string; producerId: string; runId: string }> = [];
	store.subscribeStatusChanges(() => { throw new Error("listener failure"); });
	store.subscribeStatusChanges(async () => { throw new Error("async failure"); });
	const stop = store.subscribeStatusChanges(change => { changes.push(change); });
	store.restore(record({ id: "restored" }), emptyThread());
	store.add(record());
	store.update("t1", { status: TASK_STATUS.RUNNING });
	store.update("t1", { status: TASK_STATUS.RUNNING, label: "new label" });
	const ask = { type: TASK_EVENT.ASK, request: { id: "q", method: "input", title: "Question" } } as const;
	store.apply("t1", ask, 2);
	store.apply("t1", ask, 3);
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "answer" }, 4);
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "more" }, 5);
	store.add(record({ id: "other", parentSessionId: "s2" }));
	assert.deepEqual(changes.map(change => change.status), ["queued", "running", "waiting", "running", "queued"]);
	assert.deepEqual(changes.map(change => change.sequence), [1, 2, 3, 4, 5]);
	assert.deepEqual(changes.map(change => change.parentSessionId), ["s1", "s1", "s1", "s1", "s2"]);
	assert.equal(new Set(changes.slice(0, 4).map(change => change.runId)).size, 1);
	assert.equal(store.get("t1")?.status, "running");
	const another = new TaskStore();
	let otherProducer: string | undefined;
	another.subscribeStatusChanges(change => { otherProducer = change.producerId; });
	another.add(record());
	assert.notEqual(otherProducer, changes[0].producerId);
	stop();
	store.update("t1", { status: TASK_STATUS.COMPLETED });
	assert.equal(changes.length, 5);
});

test("all terminal statuses produce exactly one transition and restore establishes a silent baseline", () => {
	for (const status of [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.TIMED_OUT]) {
		const store = new TaskStore();
		const statuses: string[] = [];
		store.subscribeStatusChanges(change => { statuses.push(change.status); });
		store.restore(record({ status: TASK_STATUS.RUNNING }), emptyThread());
		store.update("t1", { status });
		store.update("t1", { status, result: "report" });
		store.add(record({ status }));
		assert.deepEqual(statuses, [status]);
		assert.equal(store.get("t1")?.status, status);
	}
});

// Gentle Agents protocol: the child pi process streams RPC events; the host
// normalizes them into small typed deltas, applies them to an append-only
// thread, and notifies only the listeners of the task that changed.

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id: "t1",
		agent: "gentle-ai-explore",
		mode: "task",
		prompt: "Map the repo",
		label: "map the repo",
		cwd: "/repo",
		parentSessionId: "s1",
		status: TASK_STATUS.QUEUED,
		createdAt: 1000,
		startedAt: null,
		endedAt: null,
		model: "openai-codex/gpt-5.6-terra",
		thinking: "high",
		sessionPath: null,
		error: null,
		result: null,
		lastStep: "queued",
		lastActivityAt: 1000,
		turns: 0,
		toolCalls: 0,
		tokens: 0,
		cost: 0,
		...overrides,
	};
}

test("normalizeRpcEvent maps pi RPC events to task deltas and ignores the rest", () => {
	assert.deepEqual(normalizeRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } }), [{ type: TASK_EVENT.TEXT, text: "Hi" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }), [{ type: TASK_EVENT.THINKING, text: "hmm" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }), [{ type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: { command: "ls" } }]);
	assert.deepEqual(normalizeRpcEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "a\nb" }] } }), [{ type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output: "a\nb" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "boom" }] } }), [{ type: TASK_EVENT.TOOL_END, callId: "c1", output: "boom", isError: true }]);
	assert.deepEqual(normalizeRpcEvent({ type: "turn_end" }), [{ type: TASK_EVENT.TURN_END }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done." }], stopReason: "stop" }] }), [{ type: TASK_EVENT.AGENT_END, text: "done.", outcome: "success" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "WebSocket error with untrusted provider payload" }] }), [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "error", diagnostic: "assistant reported an error (network)", errorCategory: "network" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }), [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "aborted", diagnostic: "assistant aborted" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }] }), [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "empty", diagnostic: "assistant returned no final report" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_settled" }), [{ type: TASK_EVENT.AGENT_SETTLED }]);
	assert.deepEqual(normalizeRpcEvent({ type: "message_update", assistantMessageEvent: { type: "error", reason: "error", error: { message: "rate limited" } } }), [{ type: TASK_EVENT.ERROR, message: "rate limited" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Delete?" }), [{ type: TASK_EVENT.ASK, request: { id: "u1", method: "confirm", title: "Delete?" } }]);
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u2", method: "setStatus", statusKey: "mcp" }), [], "fire-and-forget UI requests never count as questions");
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u3", method: "notify", message: "hi" }), []);
	assert.deepEqual(normalizeRpcEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }), [{ type: TASK_EVENT.NOTE, text: "retrying (1/3)" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 9621, cost: { total: 0.0193 } } } }), [{ type: TASK_EVENT.USAGE, tokens: 9621, cost: 0.0193 }]);
	assert.deepEqual(normalizeRpcEvent({ type: "message_end", message: { role: "user" } }), []);
	assert.deepEqual(normalizeRpcEvent({ type: "queue_update" }), []);
	assert.deepEqual(normalizeRpcEvent("garbage"), []);
});

// Pi times every tool call with a monotonic clock and puts the measurement on
// the call's own `tool_execution_end`; nothing else in the protocol knows how
// long a call took, so that number is carried through exactly as it arrived and
// never derived from the parent's clock.
test("normalizeRpcEvent carries the child's own tool duration and never invents one", () => {
	const end = (durationMs: unknown) => normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "ok" }] }, durationMs });
	assert.deepEqual(end(1234), [{ type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false, durationMs: 1234 }]);
	// Zero is a measurement (a call faster than a millisecond), not an absence.
	assert.deepEqual(end(0), [{ type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false, durationMs: 0 }]);
	for (const notAMeasurement of [undefined, null, "1200", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		assert.deepEqual(end(notAMeasurement), [{ type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false }], `${String(notAMeasurement)} is not a measurement`);
		assert.equal(Object.hasOwn(end(notAMeasurement)[0] as object, "durationMs"), false, `${String(notAMeasurement)} leaves the event without a time`);
	}
});

test("applyTaskEvent retains the measured duration on the finished tool item and on nothing else", () => {
	let thread = emptyThread();
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: { command: "ls" } });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output: "partial" });
	assert.equal((thread.items[0] as ToolItem).durationMs, undefined, "a call still running has no measured duration");
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false, durationMs: 321 });
	assert.equal((thread.items[0] as ToolItem).durationMs, 321);
	assert.equal((thread.items[0] as ToolItem).running, false);
	assert.equal((thread.items[0] as ToolItem).output, "ok");
	// A later update never overwrites the measurement, and never invents one.
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output: "ok again" });
	assert.equal((thread.items[0] as ToolItem).durationMs, 321);
	// A child that reported no measurement leaves the field absent, so the pane
	// has nothing to draw instead of a made-up elapsed time.
	let unmeasured = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TOOL_START, callId: "c2", name: "bash", args: {} });
	unmeasured = applyTaskEvent(unmeasured, { type: TASK_EVENT.TOOL_END, callId: "c2", output: "ok", isError: false });
	assert.equal(Object.hasOwn(unmeasured.items[0] as object, "durationMs"), false, "no timing is invented for a call the child did not measure");
});

// The Agents pane draws a tool call with the chat's own card, and one card reads
// more than the result text: an edit's card counts the rows its display diff added
// and removed (`✓ +2 / -1`) and draws that diff when expanded. None of that can be
// derived from the text the thread used to keep alone, so the diff is the one
// details field that travels — per tool, bounded, and sanitized at the boundary.
test("normalizeRpcEvent transports an edit's own display diff and no other result details", () => {
	const end = (toolName: string, details: unknown) => normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "c1", toolName, isError: false, result: { content: [{ type: "text", text: "Successfully replaced 1 occurrence" }], details } });
	const diff = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-1 old\n+1 new";
	// The display diff travels; the patch and every other field stay in the child.
	assert.deepEqual(end("edit", { diff, patch: "the whole patch", firstChangedLine: 1 }), [{ type: TASK_EVENT.TOOL_END, callId: "c1", output: "Successfully replaced 1 occurrence", isError: false, details: { diff } }]);
	// The field is a per-tool allowlist: another tool's details are its own card's
	// business and never enter the thread.
	for (const toolName of ["bash", "write", "read", "codemode", "subagent_run", ""]) {
		const [event] = end(toolName, { diff, childCalls: [{ name: "bash" }], fullOutputPath: "/tmp/x" });
		assert.equal(Object.hasOwn(event as object, "details"), false, `${toolName || "an unnamed tool"} carries no details`);
	}
});

test("a malformed or untrusted diff never becomes retained details", () => {
	const end = (details: unknown) => normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "edit", isError: false, result: { content: [], details } })[0] as { details?: unknown };
	assert.deepEqual(end({ diff: "-1 old\n+1 new" }).details, { diff: "-1 old\n+1 new" }, "a well-formed diff travels unchanged");
	assert.deepEqual(end({ diff: "" }).details, { diff: "" }, "an empty diff is still the diff the call produced");
	for (const details of [undefined, null, "diff", 7, true, [], {}, { diff: 7 }, { diff: null }, { diff: ["-1"] }, { diff: { text: "-1" } }, { patch: "x" }]) {
		assert.equal(Object.hasOwn(end(details), "details"), false, `${JSON.stringify(details)?.slice(0, 40)} is not a diff`);
	}
	// Untrusted bytes are removed at the boundary, and the text they sat in stays:
	// the same sanitizer the store applies to every retained string.
	assert.deepEqual(end({ diff: "\u001b[31m-1 old\u001b[0m\n+1 new\u0007" }).details, { diff: "-1 old\n+1 new" });
	assert.deepEqual(end({ diff: "\u009b31m-1 old" }).details, { diff: "-1 old" }, "a raw C1 CSI sequence is removed whole, not decoded");
	assert.deepEqual(end({ diff: "\u001b]0;title\u0007-1 old" }).details, { diff: "-1 old" }, "a whole OSC sequence goes, not just its introducer");
});

/** A realistic TypeScript source, one function per line, as a child would edit it. */
function source(lines: number): string {
	const rows = Array.from({ length: lines }, (_row, index) => `export function fn${index}(value: number): number { return value + ${index}; }`);
	return `${rows.join("\n")}\n`;
}

/** The rows and the added/removed counts an edit card reads off a display diff. */
function counted(diff: string): { rows: number; additions: number; removals: number } {
	const rows = diff.split("\n");
	let additions = 0;
	let removals = 0;
	for (const row of rows) {
		if (row.startsWith("+") && !row.startsWith("+++")) additions += 1;
		if (row.startsWith("-") && !row.startsWith("---")) removals += 1;
	}
	return { rows: rows.length, additions, removals };
}

/** Runs the child's own edit tool over a real file and returns the result it produced. */
async function realEdit(t: { after(fn: () => Promise<void>): void }, lines: number, blocks: number) {
	const dir = await mkdtemp(join(tmpdir(), "gentle-edit-diff-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "src.ts"), source(lines), "utf8");
	const edits = Array.from({ length: blocks }, (_block, index) => ({
		oldText: `export function fn${index}(value: number): number { return value + ${index}; }`,
		newText: `export function fn${index}(value: number): number {\n  const scaled = value * ${index};\n  return scaled + ${index};\n}`,
	}));
	return createEditTool(dir).execute("call-1", { path: "src.ts", edits } as never, undefined, undefined);
}

// The reported failure: a delegated edit whose diff is large read `✓ applied` in the
// Agents pane while the transcript counted and drew the very same change, because the
// transport dropped any diff over its budget whole. A realistic edit's diff is well
// over that budget, so the real diff — not a fixture — has to survive the transport.
test("a realistic large diff from the child's own edit tool survives the transport whole", async (t) => {
	const result = await realEdit(t, 400, 60);
	const childDiff = (result.details as { diff: string }).diff;
	assert.ok(childDiff.length > 8_000, `the fixture is the reported case: ${childDiff.length} characters of real diff`);
	const [event] = normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result, isError: false });
	assert.equal(event?.type, TASK_EVENT.TOOL_END);
	const details = (event as { details?: { diff: string } }).details;
	assert.equal(details?.diff, childDiff, "the pane draws the child's own diff, row for row");
	assert.deepEqual(counted(details!.diff), counted(childDiff), "so the card counts the rows the edit really produced");
	assert.equal(counted(details!.diff).additions, 240, "60 replaced blocks became 240 added rows");
	assert.equal(counted(details!.diff).removals, 60, "and 60 removed rows");
	// The store keeps it on the finished item, which is what the pane draws.
	const thread = [
		{ type: TASK_EVENT.TOOL_START, callId: "call-1", name: "edit", args: { path: "src.ts", edits: [] } },
		event!,
	].reduce((current, next) => applyTaskEvent(current, next as never), emptyThread());
	assert.equal((thread.items[0] as ToolItem).details?.diff, childDiff);
});

// The budget is still a bound: what exceeds it is cut at a row boundary and closed by
// one marker row, so the pane states the truncation and the edit's whole totals instead
// of falling back to an acknowledgement, and never half a row.
test("a diff over the budget is truncated at a row boundary and says what it left out", async (t) => {
	const result = await realEdit(t, 2_000, 400);
	const childDiff = (result.details as { diff: string }).diff;
	assert.ok(childDiff.length > TOOL_DETAIL_MAX_CHARS, `the fixture is over the budget: ${childDiff.length} characters`);
	const [event] = normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result, isError: false });
	const kept = (event as { details?: { diff: string; truncated?: unknown } }).details!;
	assert.ok(kept.diff.length <= TOOL_DETAIL_MAX_CHARS, `the retained diff stays inside its budget (${kept.diff.length})`);
	const rows = kept.diff.split("\n");
	const marker = rows[0]!;
	const shown = rows.slice(1);
	const whole = counted(childDiff);
	// The whole edit's totals travel as structured numbers the protocol counted, so no
	// card has to parse them back out of the untrusted diff text.
	assert.deepEqual(kept.truncated, { rows: whole.rows, additions: whole.additions, removals: whole.removals }, "the cut diff carries the whole edit's own totals as metadata");
	assert.equal(whole.rows, 2005);
	assert.equal(whole.additions, 1600);
	assert.equal(whole.removals, 400);
	// Every retained row is a whole row of the child's diff, in the child's order.
	assert.deepEqual(shown, childDiff.split("\n").slice(0, shown.length), "the retained rows are the diff's own head, whole rows only");
	// The marker is a context row: it never adds to or removes from the counts.
	assert.equal(marker.startsWith("+") || marker.startsWith("-"), false, "the marker is not a change row");
	assert.match(marker, /diff truncated/, "the truncation is stated, not silent");
	assert.match(marker, new RegExp(`${shown.length} of ${whole.rows} rows`), "it states how much of the diff is shown");
	assert.match(marker, new RegExp(`\\+${whole.additions} / -${whole.removals}`), "and the whole edit's own totals, which the shown rows cannot state");
	assert.ok(whole.additions > counted(shown.join("\n")).additions, "the shown rows really are fewer than the edit made");
});

// A whole diff states its own counts, so it carries no truncation metadata; a diff the
// thread kept whole never claims to be a prefix.
test("a diff inside the budget carries no truncation metadata and is kept whole", async (t) => {
	const result = await realEdit(t, 400, 60);
	const childDiff = (result.details as { diff: string }).diff;
	const [event] = normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result, isError: false });
	const details = (event as { details?: { diff: string; truncated?: unknown } }).details!;
	assert.equal(details.diff, childDiff);
	assert.equal(Object.hasOwn(details, "truncated"), false, "a complete diff claims no truncation");
});

// The metadata is a claim, and the drawing boundary re-checks it: an item restored from
// disk, copied from a hand-built thread or written by a later version is not evidence
// that its numbers are a real diff's totals.
test("truncation metadata is re-validated where it is drawn, so no item can claim invented totals", () => {
	const handed = (details: unknown) => toolItemDetails("edit", details);
	const diff = " … diff truncated: 1 of 5 rows shown; the whole edit is +2 / -1\n+1 new";
	const totals = { rows: 5, additions: 2, removals: 1 };
	assert.deepEqual(handed({ diff, truncated: totals }), { diff, truncated: totals }, "a consistent claim is kept");
	assert.deepEqual(handed({ diff, truncated: { ...totals, future: "x" } }), { diff, truncated: totals }, "a later version's extra field is dropped, not the claim");
	assert.deepEqual(handed({ diff: "-1 old\n+1 new", truncated: totals }), { diff: "-1 old\n+1 new" }, "a complete diff keeps no claim, whatever it was handed");
	for (const truncated of [
		{ rows: "5", additions: 2, removals: 1 }, { rows: 5.5, additions: 2, removals: 1 },
		{ rows: -5, additions: 2, removals: 1 }, { rows: 5, additions: -2, removals: 1 },
		{ rows: 5, additions: 2 }, { rows: 2, additions: 2, removals: 1 },
		[5, 2, 1], "truncated", 7, null, true,
	]) {
		const kept = handed({ diff, truncated });
		assert.equal(Object.hasOwn(kept!, "truncated"), false, `${JSON.stringify(truncated)} is not a whole edit's totals`);
		assert.equal(kept!.diff, diff, "the diff itself is still kept");
	}
	// A claim that understates the rows it is drawn with is not that diff's totals.
	const twoAdditions = " … diff truncated: 2 of 5 rows shown; the whole edit is +2 / -1\n+1 a\n+2 b";
	assert.deepEqual(handed({ diff: twoAdditions, truncated: { rows: 5, additions: 1, removals: 0 } }), { diff: twoAdditions });
});

// Nothing about a cut diff reaches the history file: the file's shape is a contract, and
// the structured totals are a live display fact like the diff they describe.
test("storedThread projects truncation metadata out with the diff it describes", () => {
	let thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TOOL_START, callId: "c1", name: "edit", args: { path: "a.ts" } });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false, details: { diff: "-1 old\n+1 new", truncated: { rows: 9, additions: 6, removals: 3 } } });
	const stored = storedThread(thread);
	assert.deepEqual(Object.keys(stored.items[0] as object).sort(), ["args", "callId", "isError", "kind", "name", "output", "running"], "the stored item keeps the shape the file always had");
	assert.equal(JSON.stringify(stored).includes("truncated"), false, "no truncation metadata reaches the stored form");
	assert.equal(JSON.stringify(stored).includes("diff"), false, "and no diff either");
	assert.deepEqual((thread.items[0] as ToolItem).details, { diff: "-1 old\n+1 new", truncated: { rows: 9, additions: 6, removals: 3 } }, "the live thread keeps both");
});

// Untrusted bytes are removed before anything is counted or drawn, and the totals the
// marker and the card state are counted over the cleaned text.
test("a cut diff is sanitized before it is measured, so untrusted bytes cannot reach a count", () => {
	const noisy = `${Array.from({ length: 6_000 }, (_row, index) => `+${index} \u001b[31madded ${index}\u001b[0m`).join("\n")}\u001b]0;title\u0007`;
	const details = toolItemDetails("edit", { diff: noisy })!;
	assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(details.diff), false, "no control byte survives into the retained diff");
	assert.equal(details.diff.includes("\u001b"), false, "and no escape sequence either");
	assert.match(details.diff, /diff truncated/);
	assert.deepEqual(details.truncated, { rows: 6_000, additions: 6_000, removals: 0 }, "the totals are the rows the cleaned diff has");
});
test("the budget is exact and a diff cut inside its first row keeps that row's sign", () => {
	const end = (diff: string) => (normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "edit", isError: false, result: { content: [], details: { diff } } })[0] as { details?: { diff: string } }).details!.diff;
	const full = Array.from({ length: 40 }, (_row, index) => `+${index} added row ${index}`).join("\n");
	const exact = full.length <= TOOL_DETAIL_MAX_CHARS ? `${full}${"x".repeat(TOOL_DETAIL_MAX_CHARS - full.length)}` : full;
	assert.equal(exact.length, TOOL_DETAIL_MAX_CHARS);
	assert.equal(end(exact), exact, "a diff exactly at the budget is kept whole");
	const kept = end(`${exact}y`);
	assert.ok(kept.length <= TOOL_DETAIL_MAX_CHARS);
	assert.match(kept, /diff truncated/);
	assert.deepEqual(toolItemDetails("edit", { diff: `${exact}y` })!.truncated, { rows: 40, additions: 40, removals: 0 });
	// One row longer than the budget: the head row is cut, keeps its `+` so the card
	// still counts one addition, and says on the row itself that it was cut.
	const single = end(`+1 ${"z".repeat(TOOL_DETAIL_MAX_CHARS)}`);
	assert.ok(single.length <= TOOL_DETAIL_MAX_CHARS);
	assert.equal(single.split("\n")[1].startsWith("+1 "), true, "the cut row keeps its sign and line number");
	assert.match(single.split("\n")[1], / …$/, "and says on the row itself that it was cut");
	assert.match(single, /diff truncated/);
	assert.match(single, /1 of 1 rows/, "it never claims more rows than the diff has");
});

test("applyTaskEvent keeps an edit's details on its finished item and never invents or later replaces them", () => {
	const diff = "-1 old\n+1 new";
	let thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TOOL_START, callId: "c1", name: "edit", args: { path: "a.ts" } });
	assert.equal((thread.items[0] as ToolItem).details, undefined, "a running call has no result details yet");
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output: "half" });
	assert.equal((thread.items[0] as ToolItem).details, undefined, "a partial update never carries details");
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "c1", output: "Successfully replaced 1 occurrence", isError: false, details: { diff } });
	assert.deepEqual((thread.items[0] as ToolItem).details, { diff });
	// A later update replaces the output and leaves the details the result carried.
	const finished = thread;
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output: "later output" });
	assert.notStrictEqual(thread, finished);
	assert.deepEqual((thread.items[0] as ToolItem).details, { diff });
	// A call whose result carried no details keeps none, so the pane has nothing to
	// state instead of a diff it would have had to invent.
	let plain = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TOOL_START, callId: "c2", name: "edit", args: { path: "b.ts" } });
	plain = applyTaskEvent(plain, { type: TASK_EVENT.TOOL_END, callId: "c2", output: "ok", isError: false });
	assert.equal(Object.hasOwn(plain.items[0] as object, "details"), false);
});

// A display detail is retained for the live pane and for nothing that leaves this
// process: the history file's shape is a contract with every reader, present and
// older, and a diff is file content the child never asked to have written down.
test("storedThread projects display details out so the history file keeps the shape it always had", () => {
	let thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TOOL_START, callId: "c1", name: "edit", args: { path: "a.ts" } });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false, details: { diff: "-1 old\n+1 new" } });
	const stored = storedThread(thread);
	assert.deepEqual(Object.keys(stored.items[0] as object).sort(), ["args", "callId", "isError", "kind", "name", "output", "running"], "the stored item keeps the shape the file always had");
	assert.equal(JSON.stringify(stored).includes("diff"), false, "no display detail reaches the stored form");
	assert.deepEqual((thread.items[0] as ToolItem).details, { diff: "-1 old\n+1 new" }, "the live thread keeps the diff the pane draws");
	assert.equal(stored.version, thread.version, "projection is not an edit");
	assert.equal(stored.dropped, thread.dropped);
});

// The finished-task history file on disk is not a place to grow new fields, so
// the thread is projected on the way out: the child's display-only tool timing
// stays in the live thread, which is what the pane draws.
test("storedThread keeps the history file's shape and never strips the live thread", () => {
	let thread = emptyThread();
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: { command: "ls" } });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "done" });
	assert.strictEqual(storedThread(thread), thread, "a thread that carries no timing is stored as it is");
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false, durationMs: 1234 });
	const stored = storedThread(thread);
	assert.deepEqual(Object.keys(stored.items[0] as object).sort(), ["args", "callId", "isError", "kind", "name", "output", "running"], "the stored item keeps the shape the file always had");
	assert.equal(JSON.stringify(stored).includes("durationMs"), false, "no timing reaches the stored form");
	assert.equal((thread.items[0] as ToolItem).durationMs, 1234, "the live thread keeps the measurement the pane draws");
	assert.equal(stored.items[1], thread.items[1], "an item without timing is kept as it is");
	assert.equal(stored.version, thread.version, "projection is not an edit");
	assert.equal(stored.dropped, thread.dropped);
});

// #1690: Pi drops unknown --tools names silently, so the child reports them
// with one marked notify; only that notify reaches the task thread.
test("normalizeRpcEvent turns the marked missing-tools notify into a note and drops every other notify", () => {
	const message = `${MISSING_TOOLS_NOTE_PREFIX} gentle_review_scope, codegraph`;
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u1", method: "notify", message, notifyType: "warning" }), [{ type: TASK_EVENT.NOTE, text: message }]);
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u2", method: "notify", message: "requested tools missing in child: x" }), [], "an unmarked notify stays dropped");
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u3", method: "notify", message: ` ${MISSING_TOOLS_NOTE_PREFIX} x` }), [], "the marker must be a prefix");
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u4", method: "setStatus", statusKey: "k", statusText: `${MISSING_TOOLS_NOTE_PREFIX} x` }), [], "only notify carries the marker");
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u5", method: "notify", message: `${MISSING_TOOLS_NOTE_PREFIX} \u001B[2Jx` }), [{ type: TASK_EVENT.NOTE, text: `${MISSING_TOOLS_NOTE_PREFIX} x` }], "child text is sanitized");
});

test("argument liveness accepts current and legacy Pi starts without display or usage deltas", () => {
	for (const start of [{ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "write" },
		{ type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", id: "c1", name: "write", arguments: {} }] } }]) {
		const progress = new ToolArgumentProgress();
		const update = (inner: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: inner });
		const delta = update({ type: "toolcall_delta", contentIndex: 0, delta: "private" });
		assert.equal(progress.observe(delta), false, "no active generation");
		progress.observe({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
		assert.equal(progress.observe(delta), false, "no announced block");
		assert.equal(progress.observe(update(start)), false, "announcement alone is not progress");
		assert.equal(progress.observe(delta), true);
		assert.equal(progress.observe(delta), false);
		assert.deepEqual(normalizeRpcEvent(delta), [], "no arguments in display events or provisional totals");
		progress.observe(update({ type: "toolcall_end", contentIndex: 0 }));
		assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "late" })), false);
		progress.observe(update(start));
		assert.equal(progress.observe(delta), false, "a closed block cannot be reopened");
	}
});

test("argument liveness fails closed on malformed starts, stale generations and fingerprint exhaustion", () => {
	const progress = new ToolArgumentProgress();
	const update = (inner: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: inner });
	for (const timestamp of [undefined, "1", -1, 1.5]) progress.observe({ type: "message_start", message: { role: "assistant", timestamp } });
	assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "x" })), false);
	progress.observe({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
	for (const fields of [{ id: 1, toolName: "write" }, { id: "c", toolName: "" }, { partial: null }]) {
		progress.observe(update({ type: "toolcall_start", contentIndex: 0, ...fields }));
		assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "x" })), false);
	}
	progress.observe(update({ type: "toolcall_start", contentIndex: 0, id: "c", toolName: "write" }));
	for (let index = 0; index < 4096; index++) assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: String(index) })), true);
	assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "over-cap" })), false);
	progress.observe({ type: "message_end" });
	progress.observe({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
	progress.observe(update({ type: "toolcall_start", contentIndex: 0, id: "c", toolName: "write" }));
	assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "stale" })), false);
});

test("response observations are opt-in, finalized, field-specific and content-free", () => {
	const message = { role: "assistant", provider: "openai", model: "gpt-4o", responseModel: "gpt-4o-2024-08-06",
		providerThinkingLevel: "high", stopReason: "stop", content: [{ type: "text", text: "private response" }],
		errorMessage: "private error", responseId: "private id", modelVersion: "invented",
		usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: -1, totalTokens: 16, reasoning: 2 } };
	const raw = { type: "message_end", message };
	assert.deepEqual(normalizeRpcEvent(raw), [{ type: TASK_EVENT.USAGE, tokens: 16, cost: 0 }]);
	const events = normalizeRpcEvent(raw, { observeResponses: true });
	assert.equal(events.length, 2);
	const observation = events.find((event) => event.type === "response_observation")?.observation;
	assert.ok(observation);
	assert.deepEqual(observation.provider, { state: "observed", value: "openai" });
	assert.deepEqual(observation.model, { state: "observed", value: "gpt-4o" });
	assert.deepEqual(observation.responseModel, { state: "observed", value: message.responseModel });
	assert.deepEqual(observation.providerThinkingLevel, { state: "observed", value: "high" });
	assert.deepEqual(observation.selected, { provider: { state: "unavailable" }, model: { state: "unavailable" }, effort: { state: "unavailable" } });
	assert.deepEqual(observation.tokens, { input: { state: "reported", value: 12 }, output: { state: "reported", value: 4 },
		cacheRead: { state: "unavailable" }, cacheWrite: { state: "unavailable" }, totalTokens: { state: "reported", value: 16 },
		reasoning: { state: "reported", value: 2 } });
	assert.doesNotMatch(JSON.stringify(observation), /private|invented|modelVersion|content|responseId/);
	for (const stopReason of ["stop", "length", "toolUse", "error", "aborted"]) {
		const [event] = normalizeRpcEvent({ type: "message_end", message: { role: "assistant", stopReason } }, { observeResponses: true });
		assert.ok(event?.type === "response_observation", "missing usage still exposes a response");
		assert.equal(event.observation.stopReason, stopReason);
	}
	for (const stopReason of ["pending", "deferred", undefined, "private error"]) {
		assert.deepEqual(normalizeRpcEvent({ type: "message_end", message: { role: "assistant", stopReason } }, { observeResponses: true }), []);
	}
	for (const type of ["message_start", "message_update", "turn_end", "agent_end"]) {
		assert.ok(!normalizeRpcEvent({ type, message, messages: [message] }, { observeResponses: true }).some((event) => event.type === "response_observation"));
	}
	assert.deepEqual(normalizeRpcEvent({ type: "message_end", message: { ...message, role: "toolResult" } }, { observeResponses: true }), []);
});

test("response observations reject malformed counters and unbounded metadata without coercion", () => {
	for (const value of [0, -1, 1.5, NaN, Infinity, "12", null, undefined, 1_000_000_001]) {
		const [event] = normalizeRpcEvent({ type: "message_end", message: { role: "assistant", stopReason: "error",
			provider: "x".repeat(33), model: "x".repeat(129), responseModel: "private\ntext", providerThinkingLevel: {},
			usage: { input: value, output: value, cacheRead: value, cacheWrite: value, totalTokens: value, reasoning: value } } }, { observeResponses: true }).filter((event) => event.type === "response_observation");
		assert.ok(event);
		for (const field of Object.values(event.observation.tokens)) assert.deepEqual(field, { state: "unavailable" });
		for (const field of ["provider", "model", "responseModel", "providerThinkingLevel"] as const) assert.deepEqual(event.observation[field], { state: "unavailable" });
	}
});

test("taskLabel prefers an explicit label and otherwise takes the prompt's first sentence", () => {
	assert.equal(taskLabel("Map the repo. Then report.", "  map  the repo "), "map the repo");
	assert.equal(taskLabel("Repeat a fresh read-only exploration of lib. Own runtime architecture: extensions, hooks."), "Repeat a fresh read-only exploration of lib");
	assert.equal(taskLabel("\n\nFirst line here:\nsecond"), "First line here");
	assert.equal(taskLabel(`${"x".repeat(100)} tail`).length, 72);
	assert.equal(taskLabel("\x1b[31mred\x1b[0m"), "red");
});

test("applyTaskEvent appends incrementally: text deltas merge, tool output is replaced, items stay bounded", () => {
	let thread = emptyThread({ maxItems: 3, maxOutputChars: 9 });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "Hel" });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "lo" });
	assert.deepEqual(thread.items, [{ kind: THREAD_ITEM.TEXT, text: "Hello" }]);
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: { command: "ls" } });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output: "line one\nline two" });
	assert.equal(thread.items[1].kind, THREAD_ITEM.TOOL);
	assert.equal((thread.items[1] as { output: string }).output, "…line two", "tool output keeps the tail");
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false });
	assert.deepEqual(thread.items[1], { kind: THREAD_ITEM.TOOL, callId: "c1", name: "bash", args: { command: "ls" }, output: "ok", running: false, isError: false });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.NOTE, text: "retrying (1/3)" });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "After" });
	assert.equal(thread.items.length, 3);
	assert.equal(thread.dropped, 1, "the oldest item made room");
	assert.equal(thread.items[0].kind, THREAD_ITEM.TOOL);
	assert.equal(thread.version, 7);
});

test("applyTaskEvent sanitizes text, ignores updates for unknown tools, and records asks as notes", () => {
	let thread = emptyThread();
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "\x1b[31mred\x1b[0m" });
	assert.deepEqual(thread.items, [{ kind: THREAD_ITEM.TEXT, text: "red" }]);
	const before = thread;
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "missing", output: "x" });
	assert.strictEqual(thread, before);
	thread = applyTaskEvent(thread, { type: TASK_EVENT.ASK, request: { id: "u1", method: "confirm", title: "Delete?" } });
	assert.deepEqual(thread.items[1], { kind: THREAD_ITEM.NOTE, text: "asked: Delete?" });
});

test("TaskStore notifies only the listeners of the task that changed and keeps summaries cheap", () => {
	const store = new TaskStore();
	store.add(record({ id: "a" }));
	store.add(record({ id: "b", agent: "worker" }));
	const seenA: string[] = [];
	const seenB: string[] = [];
	const summaries: string[] = [];
	const offA = store.subscribe("a", (task) => seenA.push(`${task.status}:${task.lastStep}`));
	store.subscribe("b", (task) => seenB.push(task.status));
	store.subscribeSummary((summary) => summaries.push(`${summary.running}/${summary.queued}/${summary.finished}`));
	store.update("a", { status: TASK_STATUS.RUNNING, startedAt: 2000, lastStep: "starting" });
	store.apply("a", { type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: {} }, 2500);
	assert.deepEqual(seenA, ["running:starting", "running:bash"]);
	assert.deepEqual(seenB, []);
	assert.deepEqual(summaries, ["1/1/0"], "an event inside a task never touches the summary");
	assert.equal(store.get("a")?.toolCalls, 1);
	assert.equal(store.get("a")?.lastActivityAt, 2500);
	assert.equal(store.thread("a").items.length, 1);
	offA();
	store.update("a", { status: TASK_STATUS.COMPLETED, endedAt: 3000 });
	assert.equal(seenA.length, 2, "unsubscribed listener stays quiet");
	assert.deepEqual(summaries, ["1/1/0", "0/1/1"]);
	assert.deepEqual(store.list("s1").map((task) => task.id), ["a", "b"], "newest activity first");
	assert.equal(store.get("missing"), undefined);
	assert.deepEqual(store.thread("missing"), emptyThread());
});

// Finished tasks must release their weight: a bounded window of the most
// recent ones stays readable, older ones leave the store entirely, and a
// terminal task's listeners go quiet after the one final transition.
test("TaskStore keeps a bounded window of finished tasks and silences terminal listeners", () => {
	const store = new TaskStore();
	const seen: string[] = [];
	store.add(record({ id: "watched", status: TASK_STATUS.RUNNING, lastActivityAt: 1 }));
	store.add(record({ id: "filler", status: TASK_STATUS.RUNNING, lastActivityAt: 2 }));
	store.subscribe("watched", (task) => seen.push(task.status));
	// `watched` completes the window once it finishes, so the next terminal
	// task evicts exactly the oldest one.
	for (let index = 0; index < TERMINAL_RETENTION - 1; index += 1) {
		store.add(record({ id: `done-${index}`, status: TASK_STATUS.COMPLETED, lastActivityAt: 10 + index }));
	}
	assert.equal(store.list().filter((task) => isFinished(task.status)).length, TERMINAL_RETENTION - 1, "retained finished tasks stay at the cap");
	assert.ok(store.get("watched") && store.get("filler"), "running tasks are never evicted");
	store.update("watched", { status: TASK_STATUS.COMPLETED, endedAt: 50 });
	assert.deepEqual(seen, ["completed"], "the terminal transition itself still notifies exactly once");
	store.apply("watched", { type: TASK_EVENT.TEXT, text: "late" }, 60);
	assert.deepEqual(seen, ["completed"], "a terminal task's listener stays quiet afterwards");
	store.add(record({ id: "newest", status: TASK_STATUS.COMPLETED, lastActivityAt: 1_000 }));
	assert.equal(store.get("done-0"), undefined, "the oldest finished task is evicted");
	assert.ok(store.get("done-1") && store.get("newest"), "recent finished tasks remain readable");
	assert.ok(store.get("filler"), "running tasks survive eviction");
	assert.equal(store.list().filter((task) => isFinished(task.status)).length, TERMINAL_RETENTION);
	assert.deepEqual(store.thread("done-0"), emptyThread(), "an evicted task's thread weight is released");
	assert.ok(store.thread("done-1").limits.maxItems > 0, "a retained finished task stays renderable");
	assert.equal(store.summary().finished, TERMINAL_RETENTION, "summaries reflect the bounded window");
});

test("TaskStore.apply moves the task to waiting on ask, back to running on any later event, and counts turns", () => {
	const store = new TaskStore();
	store.add(record({ id: "a", status: TASK_STATUS.RUNNING }));
	store.apply("a", { type: TASK_EVENT.ASK, request: { id: "u1", method: "input", title: "Name?" } }, 1);
	assert.equal(store.get("a")?.status, TASK_STATUS.WAITING);
	assert.equal(store.get("a")?.lastStep, "asked: Name?");
	store.apply("a", { type: TASK_EVENT.TEXT, text: "thanks" }, 2);
	assert.equal(store.get("a")?.status, TASK_STATUS.RUNNING);
	store.apply("a", { type: TASK_EVENT.TURN_END }, 3);
	store.apply("a", { type: TASK_EVENT.TURN_END }, 4);
	assert.equal(store.get("a")?.turns, 2);
	store.apply("a", { type: TASK_EVENT.USAGE, tokens: 100, cost: 0.5 }, 4);
	store.apply("a", { type: TASK_EVENT.USAGE, tokens: 50, cost: 0.25 }, 4);
	assert.equal(store.get("a")?.tokens, 150);
	assert.equal(store.get("a")?.cost, 0.75);
	store.apply("a", { type: TASK_EVENT.AGENT_END, text: "final answer", outcome: "success" }, 5);
	assert.equal(store.get("a")?.result, "final answer");
	assert.equal(store.get("a")?.status, TASK_STATUS.RUNNING, "agent_end alone does not finish: the runner decides");
});
