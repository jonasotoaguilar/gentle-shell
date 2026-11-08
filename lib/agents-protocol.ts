import { createHash, randomUUID } from "node:crypto";
import { sanitizeTerminalText } from "./terminal-theme.ts";

// Gentle Agents protocol. A child pi process streams RPC events; the host
// turns each one into a small typed delta, applies it to an append-only,
// bounded thread, and tells only the listeners of that task. Nothing here
// rebuilds a transcript, re-validates a whole snapshot, or fans out globally.

export const TASK_STATUS = {
	QUEUED: "queued",
	RUNNING: "running",
	WAITING: "waiting",
	COMPLETED: "completed",
	FAILED: "failed",
	CANCELLED: "cancelled",
	TIMED_OUT: "timed_out",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const FINISHED_STATUSES: readonly TaskStatus[] = [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.TIMED_OUT];

export const TASK_EVENT = {
	TEXT: "text",
	THINKING: "thinking",
	TOOL_START: "tool_start",
	TOOL_UPDATE: "tool_update",
	TOOL_END: "tool_end",
	TURN_END: "turn_end",
	AGENT_END: "agent_end",
	AGENT_SETTLED: "agent_settled",
	ERROR: "error",
	ASK: "ask",
	NOTE: "note",
	USAGE: "usage",
	RESPONSE_OBSERVATION: "response_observation",
} as const;

export type TaskEventType = (typeof TASK_EVENT)[keyof typeof TASK_EVENT];

export const THREAD_ITEM = {
	TEXT: "text",
	THINKING: "thinking",
	TOOL: "tool",
	NOTE: "note",
} as const;

export type ThreadItemKind = (typeof THREAD_ITEM)[keyof typeof THREAD_ITEM];

export interface AskRequest {
	id: string;
	method: string;
	title: string;
}

export interface TextEvent { type: typeof TASK_EVENT.TEXT; text: string }
export interface ThinkingEvent { type: typeof TASK_EVENT.THINKING; text: string }
export interface ToolStartEvent { type: typeof TASK_EVENT.TOOL_START; callId: string; name: string; args: Record<string, unknown> }
export interface ToolUpdateEvent { type: typeof TASK_EVENT.TOOL_UPDATE; callId: string; output: string }

/**
 * The whole edit's own totals for a diff the thread could not keep whole, counted by the
 * protocol over the child's complete display diff with the same rule the chat's edit card
 * counts with. They are structured numbers rather than a line the card would have to parse
 * back out of the untrusted diff text, and they are what a card states instead of the rows
 * it happens to hold.
 */
export interface ToolDiffTruncation {
	/** Rows in the child's whole display diff. */
	readonly rows: number;
	/** Added and removed rows in the child's whole display diff. */
	readonly additions: number;
	readonly removals: number;
}

/**
 * The display details a retained call may carry: the parts of a tool result the
 * chat's own card draws beyond the result's text, kept so the Agents thread pane
 * can draw that card instead of approximating it.
 *
 * Today that is exactly one field — `edit`'s display diff — plus, when that diff had to
 * be cut to fit its budget, the whole edit's totals (see `ToolDiffTruncation`). An edit's
 * card counts the rows the diff added and removed (`✓ +2 / -1`) and draws the diff when
 * expanded, and neither can be derived from the result text. Nothing else travels:
 * another tool's details belong to its own card, and a payload the pane does not have a
 * card to read is a payload it does not keep. This is in-process display data only — the
 * presence activity, the RPC publisher and the history file all project it out (see
 * `storedThread`).
 */
export interface ToolItemDetails {
	/** The edit's display-oriented diff, as the child computed it. */
	readonly diff: string;
	/** The whole edit's totals, present only when `diff` is a prefix of the edit's own
	 * display diff (see `truncatedDiff`); absent for a diff kept whole, which states its
	 * own counts. */
	readonly truncated?: ToolDiffTruncation;
}

/**
 * The longest display diff the thread keeps, in characters. A diff that fits is kept
 * whole, so the edit card counts the rows the edit really produced and its expanded
 * view is the diff the child computed, row for row — the same card the transcript
 * draws. A larger one is cut at a row boundary and opens with a marker row that
 * states the truncation and the edit's whole totals (see `truncatedDiff`), because
 * dropping it whole made a delegated edit read `✓ applied` with no diff at all in
 * the pane while the transcript counted and drew the very same change. The retained
 * diff is inside this budget either way, so a thread of them stays bounded.
 */
export const TOOL_DETAIL_MAX_CHARS = 64_000;

/** The tools whose result details the thread keeps. A per-tool field whitelist,
 * so a new tool has to be added here on purpose. */
const DETAIL_TOOLS: ReadonlySet<string> = new Set(["edit"]);

export interface ToolEndEvent {
	type: typeof TASK_EVENT.TOOL_END;
	callId: string;
	output: string;
	isError: boolean;
	/**
	 * Milliseconds the child measured for this call, from Pi's monotonic clock and
	 * carried on its own `tool_execution_end`; absent when the child recorded none
	 * (an older Pi, a call that did not run). Nothing else knows how long a call
	 * took, so this is the only elapsed time the pane may draw.
	 */
	durationMs?: number;
	/** The bounded display details the call's result carried (see
	 * `ToolItemDetails`), absent when the result had none of the fields the pane
	 * draws or the tool keeps none. */
	details?: ToolItemDetails;
}
export interface TurnEndEvent { type: typeof TASK_EVENT.TURN_END }
/** Closed terminal-error vocabulary (#2322). A category, never provider text. */
export const TERMINAL_ERROR_CATEGORY = {
	AUTH: "auth",
	RATE_LIMIT: "rate_limit",
	QUOTA: "quota",
	CONTEXT_LENGTH: "context_length",
	TIMEOUT: "timeout",
	NETWORK: "network",
	PROVIDER_UNAVAILABLE: "provider_unavailable",
	INVALID_REQUEST: "invalid_request",
	UNAVAILABLE: "unavailable",
} as const;

export type TerminalErrorCategory = (typeof TERMINAL_ERROR_CATEGORY)[keyof typeof TERMINAL_ERROR_CATEGORY];

export interface AgentEndEvent {
	type: typeof TASK_EVENT.AGENT_END;
	text: string;
	outcome: "success" | "error" | "aborted" | "empty";
	diagnostic?: string;
	/** Present only when outcome is "error". */
	errorCategory?: TerminalErrorCategory;
}
export interface AgentSettledEvent { type: typeof TASK_EVENT.AGENT_SETTLED }
export interface ErrorEvent { type: typeof TASK_EVENT.ERROR; message: string }
export interface AskEvent { type: typeof TASK_EVENT.ASK; request: AskRequest }
export interface NoteEvent { type: typeof TASK_EVENT.NOTE; text: string }
export interface UsageEvent { type: typeof TASK_EVENT.USAGE; tokens: number; cost: number }

export type ChildUnavailable = Readonly<{ state: "unavailable" }>;
export type ChildMetadata = Readonly<{ state: "observed"; value: string }> | ChildUnavailable;
export type ChildTokenMeasurement = Readonly<{ state: "reported"; value: number }> | ChildUnavailable;
export interface ChildResponseObservation {
	/** SDK message metadata, not authenticated route or selected-model evidence. */
	readonly provider: ChildMetadata;
	readonly model: ChildMetadata;
	readonly responseModel: ChildMetadata;
	/** Exact provider-native effort when supplied, NOT Pi's selected effort. */
	readonly providerThinkingLevel: ChildMetadata;
	readonly selected: Readonly<{ provider: ChildUnavailable; model: ChildUnavailable; effort: ChildUnavailable }>;
	readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	/** Reasoning is a subset of output, not an additional token total. */
	readonly tokens: Readonly<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "reasoning", ChildTokenMeasurement>>;
}
export interface ResponseObservationEvent { type: typeof TASK_EVENT.RESPONSE_OBSERVATION; observation: ChildResponseObservation }

export type TaskEvent = ResponseObservationEvent | TextEvent | ThinkingEvent | ToolStartEvent | ToolUpdateEvent | ToolEndEvent | TurnEndEvent | AgentEndEvent | AgentSettledEvent | ErrorEvent | AskEvent | NoteEvent | UsageEvent;

export interface TextItem { kind: typeof THREAD_ITEM.TEXT; text: string }
export interface ThinkingItem { kind: typeof THREAD_ITEM.THINKING; text: string }
export interface ToolItem {
	kind: typeof THREAD_ITEM.TOOL;
	callId: string;
	name: string;
	args: Record<string, unknown>;
	output: string;
	running: boolean;
	isError: boolean;
	/** The child's own measurement for this call (see `ToolEndEvent.durationMs`).
	 * Absent while the call runs, when the child recorded none, and on a remote
	 * presence row, which carries no timing at all. */
	durationMs?: number;
	/** The bounded display details this call's result carried, when the tool keeps
	 * any (see `ToolItemDetails`). Absent for every other call, for a thread
	 * restored from a history file, and for a remote presence row. */
	details?: ToolItemDetails;
}
export interface NoteItem { kind: typeof THREAD_ITEM.NOTE; text: string }

export type ThreadItem = TextItem | ThinkingItem | ToolItem | NoteItem;

export interface ThreadLimits {
	maxItems: number;
	maxOutputChars: number;
}

export interface TaskThread {
	items: ThreadItem[];
	dropped: number;
	version: number;
	limits: ThreadLimits;
}

export interface TaskRecord {
	/** Retained legacy payload, never interpreted or replayed as launch authority. */
	sddRemediation?: unknown;
	/** Exact runtime-generated SDD preflight block retained only for continuation transport. */
	sddPreflightContext?: string;
	id: string;
	agent: string;
	mode: string;
	prompt: string;
	/** One line for the card: what the subagent is doing. */
	label: string;
	cwd: string;
	parentSessionId: string;
	status: TaskStatus;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	model: string;
	/** Launch-layer token recorded next to `model` (#2180): which profile layer won.
	 * Host-computed at the launch seam; absent for requests and records that never named one. */
	modelSource?: string;
	thinking: string | undefined;
	sessionPath: string | null;
	error: string | null;
	result: string | null;
	lastStep: string;
	lastActivityAt: number;
	turns: number;
	toolCalls: number;
	tokens: number;
	cost: number;
}

export interface TaskSummary {
	running: number;
	queued: number;
	waiting: number;
	finished: number;
}

export type TaskListener = (task: TaskRecord, thread: TaskThread) => void;
export type SummaryListener = (summary: TaskSummary) => void;
export interface TaskStatusChange {
	readonly producerId: string;
	readonly sessionId: string;
	readonly parentSessionId: string;
	readonly taskId: string;
	readonly runId: string;
	readonly status: TaskStatus;
	readonly previousStatus?: TaskStatus;
	readonly sequence: number;
}
export type StatusChangeListener = (change: TaskStatusChange) => void | Promise<void>;

const DEFAULT_LIMITS: ThreadLimits = { maxItems: 400, maxOutputChars: 16_000 };
/** Finished tasks keep their thread weight only for this many most-recent
 * records per parent session, matching the agents view's visible history cap
 * (MAX_FINISHED_PER_SESSION in agents-view.ts, pinned by tests); older
 * terminal tasks (record, thread, run id, listeners) leave the store
 * entirely. Running tasks are never evicted. */
export const TERMINAL_RETENTION = 200;
/** Child UI requests that block on an answer; everything else (notify, setStatus, setWidget) is noise here. */
export const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);
/** The one child notify that reaches the task thread: requested --tools the child does not have (#1690). */
export const MISSING_TOOLS_NOTE_PREFIX = "gentle-agents: requested tools missing in child:";
const LABEL_MAX = 72;
const TEXT_CAP = 20_000;
const ELLIPSIS = "…";

function clean(value: unknown): string {
	return typeof value === "string" ? sanitizeTerminalText(value) : "";
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? clean((part as { text?: unknown }).text) : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

function keepTail(text: string, max: number): string {
	return text.length <= max ? text : `${ELLIPSIS}${text.slice(text.length - max + 1)}`;
}

const ERROR_SCAN_MAX = 4096;
const ERROR_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// First match wins: specific causes before the generic statuses they share
// (quota and context errors often arrive as 429 or 400).
const ERROR_KEYWORDS: ReadonlyArray<readonly [TerminalErrorCategory, RegExp]> = [
	[TERMINAL_ERROR_CATEGORY.CONTEXT_LENGTH, /context.?length|context.?window|maximum context|prompt is too long|too many tokens/i],
	[TERMINAL_ERROR_CATEGORY.QUOTA, /quota|billing|out of budget|usage.?limit|credit balance/i],
	[TERMINAL_ERROR_CATEGORY.AUTH, /unauthori[sz]ed|forbidden|authenticat|api.?key|permission.?denied/i],
	[TERMINAL_ERROR_CATEGORY.RATE_LIMIT, /rate.?limit|too many requests/i],
	[TERMINAL_ERROR_CATEGORY.TIMEOUT, /time.?out|timed out|deadline exceeded/i],
	[TERMINAL_ERROR_CATEGORY.NETWORK, /network|connection|websocket|ECONN(?:RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|other side closed/i],
	[TERMINAL_ERROR_CATEGORY.PROVIDER_UNAVAILABLE, /overloaded|unavailable|server.?error|internal.?error|server_busy|capacity|high demand/i],
	[TERMINAL_ERROR_CATEGORY.INVALID_REQUEST, /invalid.?request|bad request/i],
];
// Only a status in a status position: leading ("429: ...", "429 {...}"),
// parenthesized ("Provider (403): ...") or labeled ("status 503", "HTTP 502").
const HTTP_STATUS = /(?:^\s*|\(|\b(?:status(?:\s+code)?|http)\s*:?\s*)([45]\d\d)(?=[\s):,{]|$)/i;

function statusCategory(status: number): TerminalErrorCategory {
	if (status === 401 || status === 403) return TERMINAL_ERROR_CATEGORY.AUTH;
	if (status === 429) return TERMINAL_ERROR_CATEGORY.RATE_LIMIT;
	if (status === 408 || status === 504) return TERMINAL_ERROR_CATEGORY.TIMEOUT;
	if (status >= 500) return TERMINAL_ERROR_CATEGORY.PROVIDER_UNAVAILABLE;
	return TERMINAL_ERROR_CATEGORY.INVALID_REQUEST;
}

function diagnosticCodes(diagnostics: unknown): string[] {
	if (!Array.isArray(diagnostics)) return [];
	return diagnostics.slice(0, 8).map((entry) => {
		const code = (entry as { error?: { code?: unknown } } | null)?.error?.code;
		return typeof code === "number" ? String(code) : typeof code === "string" && ERROR_IDENTIFIER.test(code) ? code : "";
	});
}

/** Scans bounded structured signals; the scanned text itself is never retained. */
function terminalErrorCategory(message: { errorMessage?: unknown; rawStopReason?: unknown; diagnostics?: unknown }): TerminalErrorCategory {
	const signals = [
		typeof message.errorMessage === "string" ? message.errorMessage.slice(0, ERROR_SCAN_MAX) : "",
		typeof message.rawStopReason === "string" && ERROR_IDENTIFIER.test(message.rawStopReason) ? message.rawStopReason : "",
		...diagnosticCodes(message.diagnostics),
	].filter((signal) => signal.length > 0);
	for (const [category, pattern] of ERROR_KEYWORDS) if (signals.some((signal) => pattern.test(signal))) return category;
	for (const signal of signals) {
		const status = HTTP_STATUS.exec(signal)?.[1];
		if (status) return statusCategory(Number(status));
	}
	return TERMINAL_ERROR_CATEGORY.UNAVAILABLE;
}

function terminalAssistant(messages: unknown): Omit<AgentEndEvent, "type"> {
	if (!Array.isArray(messages)) return { text: "", outcome: "empty", diagnostic: "assistant returned no final report" };
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string; content?: unknown; stopReason?: unknown; errorMessage?: unknown; rawStopReason?: unknown; diagnostics?: unknown };
		if (message?.role !== "assistant") continue;
		const stopReason = clean(message.stopReason).toLowerCase();
		// Do not preserve unbounded provider error payloads. Only a category from
		// the closed vocabulary leaves this function, never the scanned text.
		if (stopReason === "error") {
			const errorCategory = terminalErrorCategory(message);
			return { text: "", outcome: "error", diagnostic: `assistant reported an error (${errorCategory})`, errorCategory };
		}
		if (stopReason === "aborted") return { text: "", outcome: "aborted", diagnostic: "assistant aborted" };
		const text = contentText(message.content);
		return text.length > 0
			? { text, outcome: "success" }
			: { text: "", outcome: "empty", diagnostic: "assistant returned no final report" };
	}
	return { text: "", outcome: "empty", diagnostic: "assistant returned no final report" };
}

type Raw = Record<string, unknown>;

function askRequest(raw: Raw): AskRequest {
	const title = clean(raw.title) || clean(raw.message) || clean(raw.method);
	return { id: String(raw.id ?? ""), method: String(raw.method ?? ""), title };
}

const CHILD_UNAVAILABLE: ChildUnavailable = Object.freeze({ state: "unavailable" });
const CHILD_SELECTION = Object.freeze({ provider: CHILD_UNAVAILABLE, model: CHILD_UNAVAILABLE, effort: CHILD_UNAVAILABLE });

function childMetadata(value: unknown, max: number): ChildMetadata {
	// Retain bounded identifier fields only; do not truncate into another identity.
	return typeof value === "string" && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
		? Object.freeze({ state: "observed", value }) : CHILD_UNAVAILABLE;
}

function childTokens(value: unknown): ChildTokenMeasurement {
	// SDK default zeros are not provider-presence evidence (same as primary adapter).
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000
		? Object.freeze({ state: "reported", value }) : CHILD_UNAVAILABLE;
}

function childResponse(message: Raw): ChildResponseObservation | undefined {
	const reason = message.stopReason;
	if (reason !== "stop" && reason !== "length" && reason !== "toolUse" && reason !== "error" && reason !== "aborted") return undefined;
	const usage = message.usage as Raw | undefined;
	return Object.freeze({
		provider: childMetadata(message.provider, 32), model: childMetadata(message.model, 128),
		responseModel: childMetadata(message.responseModel, 128), providerThinkingLevel: childMetadata(message.providerThinkingLevel, 32),
		// RPC has no per-request selected state; get_state observes launch only.
		selected: CHILD_SELECTION, stopReason: reason,
		tokens: Object.freeze({ input: childTokens(usage?.input), output: childTokens(usage?.output),
			cacheRead: childTokens(usage?.cacheRead), cacheWrite: childTokens(usage?.cacheWrite),
			totalTokens: childTokens(usage?.totalTokens), reasoning: childTokens(usage?.reasoning) }),
	});
}

const ARGUMENT_PROGRESS_MAX = 4096;

/** The row separator of a display diff, and the mark a cut row ends with. */
const DIFF_ROW_SEPARATOR = "\n";
const DIFF_ROW_ELLIPSIS = "…";
const ADDED_ROW_CODE = "+".charCodeAt(0);
const REMOVED_ROW_CODE = "-".charCodeAt(0);

/** One display diff's rows, and the added and removed rows among them. */
interface DisplayDiffCounts { rows: number; additions: number; removals: number }

/**
 * Counts a display diff the way the chat's edit card counts it (`✓ +2 / -1`): a row
 * is an addition when it starts with `+` and is not a patch's `+++` file header, and a
 * removal when it starts with `-` and is not a `---` one. The marker row below is
 * built from these numbers, so it has to agree with the card's own rule exactly, and
 * the scan walks the string without allocating a row array for it.
 */
function displayDiffCounts(diff: string): DisplayDiffCounts {
	const counts: DisplayDiffCounts = { rows: 1, additions: 0, removals: 0 };
	let start = 0;
	for (;;) {
		const end = diff.indexOf(DIFF_ROW_SEPARATOR, start);
		const rowEnd = end < 0 ? diff.length : end;
		const mark = diff.charCodeAt(start);
		const header = rowEnd - start >= 3 && diff.charCodeAt(start + 1) === mark && diff.charCodeAt(start + 2) === mark;
		if (mark === ADDED_ROW_CODE && !header) counts.additions += 1;
		else if (mark === REMOVED_ROW_CODE && !header) counts.removals += 1;
		if (end < 0) return counts;
		counts.rows += 1;
		start = end + 1;
	}
}

/**
 * The one row that opens a cut diff: a context row, so it never adds to or removes
 * from the counts the card reads, stating how much of the diff is shown and the whole
 * edit's own totals — the numbers the shown rows cannot state themselves. It opens the
 * diff so the expanded card says, before the rows it does show, that they are a prefix
 * of the edit. A collapsed card previews change rows only, so there the summary counts
 * the rows the pane was given and this marker is the expanded card's answer to that.
 */
function truncationMarker(shownRows: number, whole: DisplayDiffCounts): string {
	return ` ${DIFF_ROW_ELLIPSIS} diff truncated: ${shownRows} of ${whole.rows} rows shown; the whole edit is +${whole.additions} / -${whole.removals}`;
}

/**
 * Cuts a display diff that is over the budget: the marker row, then whole rows from the
 * diff's head, with the whole edit's totals beside them as structured numbers. Nothing
 * retained is half a row, except when the diff's own first row is longer than the whole
 * budget — there the row is cut but keeps its mark and line number, so the card still
 * counts the row the edit produced, and ends with the same ellipsis the marker uses. The
 * result is always inside `TOOL_DETAIL_MAX_CHARS`.
 */
function truncatedDiff(diff: string): { diff: string; truncated: ToolDiffTruncation } {
	const whole = displayDiffCounts(diff);
	const truncated: ToolDiffTruncation = Object.freeze({ rows: whole.rows, additions: whole.additions, removals: whole.removals });
	const cutSuffix = ` ${DIFF_ROW_ELLIPSIS}`;
	// Reserve the longest marker this diff can produce (it names at most every row as
	// shown) plus the marks a cut adds, so the retained text fits whatever the real
	// counts turn out to be, in both branches below.
	const reserve = truncationMarker(whole.rows, whole).length + DIFF_ROW_SEPARATOR.length + cutSuffix.length;
	const head = diff.slice(0, Math.max(0, TOOL_DETAIL_MAX_CHARS - reserve));
	const boundary = head.lastIndexOf(DIFF_ROW_SEPARATOR);
	if (boundary > 0) {
		const kept = head.slice(0, boundary);
		return { diff: `${truncationMarker(displayDiffCounts(kept).rows, whole)}${DIFF_ROW_SEPARATOR}${kept}`, truncated };
	}
	const firstRow = head.split(DIFF_ROW_SEPARATOR, 1)[0];
	if (firstRow.length === 0) return { diff: truncationMarker(0, whole), truncated };
	return { diff: `${truncationMarker(1, whole)}${DIFF_ROW_SEPARATOR}${firstRow}${cutSuffix}`, truncated };
}

/** The one row a cut diff opens with, as the layout above writes it. */
const TRUNCATION_MARKER_PREFIX = ` ${DIFF_ROW_ELLIPSIS} diff truncated:`;

function diffTotal(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The whole edit's totals as an item claims them, or `undefined` when this boundary cannot
 * stand behind the claim. A claim is a truncation only for a diff that opens with the marker
 * row this module writes — a diff kept whole states its own counts, so a claim handed with one
 * is dropped rather than allowed to override them — and its three numbers have to be whole,
 * non-negative, able to describe rows that include them, and never fewer than the rows the
 * retained diff still shows.
 */
function diffTruncation(value: unknown, diff: string): ToolDiffTruncation | undefined {
	if (!diff.startsWith(TRUNCATION_MARKER_PREFIX)) return undefined;
	const claim = value as { rows?: unknown; additions?: unknown; removals?: unknown } | null | undefined;
	if (claim === null || typeof claim !== "object") return undefined;
	const rows = diffTotal(claim.rows);
	const additions = diffTotal(claim.additions);
	const removals = diffTotal(claim.removals);
	if (rows === undefined || additions === undefined || removals === undefined) return undefined;
	if (additions + removals > rows) return undefined;
	const kept = displayDiffCounts(diff);
	if (kept.additions > additions || kept.removals > removals) return undefined;
	return Object.freeze({ rows, additions, removals });
}

/**
 * The child's own tool duration, or `undefined` when the value it sent is not a
 * measurement. Pi times each call with a monotonic clock and rounds the result;
 * anything else (a missing field, a string, a negative or non-finite number) is
 * not a duration, and the parent never substitutes one of its own.
 */
function toolDuration(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The display details to keep for one finished call, or `undefined` when the call
 * keeps none. Both boundaries that hand details to a renderer call this — the RPC
 * normalizer below and the pane's reused renderer — because an item restored from
 * disk or built by another writer is not evidence that what it carries is a
 * bounded, sanitized diff.
 *
 * Two rules, in order: the tool has to be one that keeps details, and `diff` has to
 * be a string. Untrusted bytes are then removed with the same sanitizer the store
 * applies to every retained string, which is also the one the chat's card applies
 * before it counts, so both places count the same rows; the budget is judged on that
 * cleaned text, which is what the card reads. A diff inside the budget is kept whole and
 * carries no truncation claim; a larger one opens with a marker row and carries the whole
 * edit's totals as structured numbers (see `truncatedDiff`), so a large real diff is never
 * silently dropped and no card has to read a count back out of the diff text.
 *
 * The sanitized copy and the row scan are proportional to the diff the child already
 * sent on its own event; only the value the thread retains is bounded.
 */
export function toolItemDetails(toolName: string, details: unknown): ToolItemDetails | undefined {
	if (!DETAIL_TOOLS.has(toolName)) return undefined;
	const source = details as { diff?: unknown; truncated?: unknown } | null | undefined;
	const diff = source?.diff;
	if (typeof diff !== "string") return undefined;
	const text = clean(diff);
	if (text.length > TOOL_DETAIL_MAX_CHARS) return Object.freeze(truncatedDiff(text));
	const truncated = diffTruncation(source?.truncated, text);
	return Object.freeze(truncated === undefined ? { diff: text } : { diff: text, truncated });
}

/** Per-child liveness evidence, separate from display events and usage.
 * RPC deltas have no sequence number. Reject duplicate fingerprints rather
 * than claiming indistinguishable repeated bytes are fresh progress. Retain
 * only hashes, never arguments; exhaustion fails closed until a new message.
 */
export class ToolArgumentProgress {
	private timestamp = -1;
	private active = false;
	private readonly blocks = new Map<number, boolean>();
	private readonly fingerprints = new Set<string>();

	observe(raw: Record<string, unknown>): boolean {
		if (raw.type === "message_start") {
			const message = raw.message as Raw | undefined;
			if (message?.role === "assistant" && typeof message.timestamp === "number" && Number.isSafeInteger(message.timestamp)
				&& message.timestamp >= 0 && message.timestamp > this.timestamp && !this.active) {
				this.timestamp = message.timestamp;
				this.active = true;
				this.blocks.clear();
				this.fingerprints.clear();
			}
			return false;
		}
		if (raw.type === "message_end" || raw.type === "agent_end" || raw.type === "agent_settled" || raw.type === "turn_end") {
			this.active = false;
			this.blocks.clear();
			this.fingerprints.clear();
			return false;
		}
		if (!this.active || raw.type !== "message_update") return false;
		const inner = raw.assistantMessageEvent as Raw | undefined;
		if (!inner || typeof inner !== "object") return false;
		const index = inner.contentIndex;
		if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= ARGUMENT_PROGRESS_MAX) return false;
		if (inner.type === "toolcall_start") {
			// Older Pi RPC forwards SDK partial snapshots; current RPC puts the
			// identity directly on toolcall_start. Neither shape is persisted.
			const partial = inner.partial as Raw | undefined;
			const block = Array.isArray(partial?.content) ? partial.content[index] as Raw | undefined : undefined;
			const id = inner.id ?? (block?.type === "toolCall" ? block.id : undefined);
			const name = inner.toolName ?? (block?.type === "toolCall" ? block.name : undefined);
			if (typeof id === "string" && id.length > 0 && typeof name === "string" && name.length > 0 && !this.blocks.has(index)) this.blocks.set(index, true);
			return false;
		}
		if (inner.type === "toolcall_end") {
			if (this.blocks.has(index)) this.blocks.set(index, false);
			return false;
		}
		if (inner.type !== "toolcall_delta" || this.blocks.get(index) !== true || typeof inner.delta !== "string" || inner.delta.length === 0) return false;
		if (this.fingerprints.size >= ARGUMENT_PROGRESS_MAX) return false;
		const fingerprint = createHash("sha256").update(`${index}:`).update(inner.delta).digest("hex");
		if (this.fingerprints.has(fingerprint)) return false;
		this.fingerprints.add(fingerprint);
		return true;
	}
}

// One RPC line in, zero or more deltas out. Streaming deltas carry only the
// chunk; whole-message payloads that pi repeats on every update are ignored.
export function normalizeRpcEvent(raw: unknown, options: { observeResponses?: boolean } = {}): TaskEvent[] {
	if (!raw || typeof raw !== "object") return [];
	const event = raw as Raw;
	switch (event.type) {
		case "message_update": {
			const inner = event.assistantMessageEvent as Raw | undefined;
			if (!inner) return [];
			if (inner.type === "text_delta") return [{ type: TASK_EVENT.TEXT, text: clean(inner.delta) }];
			if (inner.type === "thinking_delta") return [{ type: TASK_EVENT.THINKING, text: clean(inner.delta) }];
			if (inner.type === "error") {
				const error = inner.error as Raw | undefined;
				return [{ type: TASK_EVENT.ERROR, message: clean(error?.message) || clean(inner.reason) || "unknown error" }];
			}
			return [];
		}
		case "tool_execution_start":
			return [{ type: TASK_EVENT.TOOL_START, callId: String(event.toolCallId ?? ""), name: clean(event.toolName), args: (event.args as Record<string, unknown>) ?? {} }];
		case "tool_execution_update":
			return [{ type: TASK_EVENT.TOOL_UPDATE, callId: String(event.toolCallId ?? ""), output: contentText((event.partialResult as Raw | undefined)?.content) }];
		case "tool_execution_end": {
			const durationMs = toolDuration(event.durationMs);
			// The child's own measurement rides the event as it arrived; a call it did
			// not time carries none, so the pane draws no elapsed time for it. The
			// display details are the result's own, kept only for a tool the pane has a
			// card to read them with.
			const details = toolItemDetails(clean(event.toolName), (event.result as Raw | undefined)?.details);
			return [{ type: TASK_EVENT.TOOL_END, callId: String(event.toolCallId ?? ""), output: contentText((event.result as Raw | undefined)?.content), isError: event.isError === true, ...(durationMs === undefined ? {} : { durationMs }), ...(details === undefined ? {} : { details }) }];
		}
		case "message_end": {
			const message = event.message as Raw | undefined;
			const usage = message?.role === "assistant" ? (message.usage as Raw | undefined) : undefined;
			const events: TaskEvent[] = [];
			if (usage) {
				const cost = usage.cost as Raw | undefined;
				events.push({ type: TASK_EVENT.USAGE, tokens: Number(usage.totalTokens ?? 0) || 0, cost: Number(cost?.total ?? 0) || 0 });
			}
			if (options.observeResponses === true && message?.role === "assistant") {
				const observation = childResponse(message);
				if (observation) events.push({ type: TASK_EVENT.RESPONSE_OBSERVATION, observation });
			}
			return events;
		}
		case "turn_end":
			return [{ type: TASK_EVENT.TURN_END }];
		case "agent_end":
			return [{ type: TASK_EVENT.AGENT_END, ...terminalAssistant(event.messages) }];
		case "agent_settled":
			return [{ type: TASK_EVENT.AGENT_SETTLED }];
		case "extension_ui_request":
			if (event.method === "notify" && typeof event.message === "string" && event.message.startsWith(MISSING_TOOLS_NOTE_PREFIX)) return [{ type: TASK_EVENT.NOTE, text: clean(event.message) }];
			return DIALOG_METHODS.has(String(event.method)) ? [{ type: TASK_EVENT.ASK, request: askRequest(event) }] : [];
		case "auto_retry_start":
			return [{ type: TASK_EVENT.NOTE, text: `retrying (${String(event.attempt ?? "?")}/${String(event.maxAttempts ?? "?")})` }];
		case "extension_error":
			return [{ type: TASK_EVENT.NOTE, text: `extension error: ${clean(event.error)}` }];
		default:
			return [];
	}
}

// The card shows one line per task: an explicit label, or the first sentence
// of the prompt clipped to a readable length.
export function taskLabel(prompt: string, label?: string): string {
	const explicit = clean(label).replace(/\s+/g, " ").trim();
	if (explicit.length > 0) return explicit.length > LABEL_MAX ? `${explicit.slice(0, LABEL_MAX - 1)}…` : explicit;
	const firstLine = clean(prompt).split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
	const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
	const compact = sentence.replace(/\s+/g, " ").replace(/[.:]$/, "");
	return compact.length > LABEL_MAX ? `${compact.slice(0, LABEL_MAX - 1)}…` : compact;
}

export function emptyThread(limits: Partial<ThreadLimits> = {}): TaskThread {
	return { items: [], dropped: 0, version: 0, limits: { ...DEFAULT_LIMITS, ...limits } };
}

/**
 * The thread as the finished-task history file keeps it, for the one writer that
 * puts a thread on disk (extensions/gentle-agents.ts). That file's shape is part
 * of the contract with every reader — this version's and an older Pi's — so the
 * live thread's display-only facts are projected out on the way out: the child's
 * tool timing and any tool details it kept never reach disk. A thread that carries
 * neither is returned as it is, so the common case allocates nothing; an item
 * without them is kept by identity, because a projection is not an edit.
 */
export function storedThread(thread: TaskThread): TaskThread {
	const projects = (item: ThreadItem): item is ToolItem => item.kind === THREAD_ITEM.TOOL && (item.durationMs !== undefined || item.details !== undefined);
	if (!thread.items.some(projects)) return thread;
	return {
		...thread,
		items: thread.items.map((item): ThreadItem => {
			if (!projects(item)) return item;
			// A field whitelist, like the presence and RPC projections: a new display fact
			// has to be added here on purpose before it can reach a stored file.
			const stored: ToolItem = { kind: item.kind, callId: item.callId, name: item.name, args: item.args, output: item.output, running: item.running, isError: item.isError };
			return stored;
		}),
	};
}

function withItems(thread: TaskThread, items: ThreadItem[], dropped = thread.dropped): TaskThread {
	return { ...thread, items, dropped, version: thread.version + 1 };
}

function push(thread: TaskThread, item: ThreadItem): TaskThread {
	const items = [...thread.items, item];
	const overflow = Math.max(0, items.length - thread.limits.maxItems);
	return withItems(thread, overflow > 0 ? items.slice(overflow) : items, thread.dropped + overflow);
}

function appendText(thread: TaskThread, kind: typeof THREAD_ITEM.TEXT | typeof THREAD_ITEM.THINKING, raw: string): TaskThread {
	const text = clean(raw);
	if (text.length === 0) return thread;
	const last = thread.items[thread.items.length - 1];
	if (last && last.kind === kind) {
		const merged = { ...last, text: keepTail(last.text + text, TEXT_CAP) };
		return withItems(thread, [...thread.items.slice(0, -1), merged]);
	}
	return push(thread, { kind, text } as ThreadItem);
}

function updateTool(thread: TaskThread, callId: string, patch: Partial<ToolItem>): TaskThread {
	const index = thread.items.findIndex((item) => item.kind === THREAD_ITEM.TOOL && item.callId === callId);
	if (index < 0) return thread;
	const current = thread.items[index] as ToolItem;
	const next: ToolItem = { ...current, ...patch, output: keepTail(patch.output === undefined ? current.output : clean(patch.output), thread.limits.maxOutputChars) };
	const items = [...thread.items];
	items[index] = next;
	return withItems(thread, items);
}

export function askNote(request: AskRequest): string {
	return `asked: ${request.title}`;
}

export function applyTaskEvent(thread: TaskThread, event: TaskEvent): TaskThread {
	switch (event.type) {
		case TASK_EVENT.TEXT:
			return appendText(thread, THREAD_ITEM.TEXT, event.text);
		case TASK_EVENT.THINKING:
			return appendText(thread, THREAD_ITEM.THINKING, event.text);
		case TASK_EVENT.TOOL_START:
			return push(thread, { kind: THREAD_ITEM.TOOL, callId: event.callId, name: event.name, args: event.args, output: "", running: true, isError: false });
		case TASK_EVENT.TOOL_UPDATE:
			return updateTool(thread, event.callId, { output: event.output });
		case TASK_EVENT.TOOL_END: {
			// The duration is carried only when the child measured one, and the details
			// only when its result had them, so a call without either keeps no field
			// instead of a placeholder the pane might draw.
			const patch: Partial<ToolItem> = { output: event.output, running: false, isError: event.isError };
			if (event.durationMs !== undefined) patch.durationMs = event.durationMs;
			if (event.details !== undefined) patch.details = event.details;
			return updateTool(thread, event.callId, patch);
		}
		case TASK_EVENT.ERROR:
			return push(thread, { kind: THREAD_ITEM.NOTE, text: `error: ${event.message}` });
		case TASK_EVENT.ASK:
			return push(thread, { kind: THREAD_ITEM.NOTE, text: askNote(event.request) });
		case TASK_EVENT.NOTE:
			return push(thread, { kind: THREAD_ITEM.NOTE, text: clean(event.text) });
		default:
			return thread;
	}
}

export function isFinished(status: TaskStatus): boolean {
	return FINISHED_STATUSES.includes(status);
}

// What a task event means for the record itself: the step label the widget
// shows, the counters, and the waiting/running flip around user questions.
function recordPatch(task: TaskRecord, event: TaskEvent): Partial<TaskRecord> {
	const resumed = task.status === TASK_STATUS.WAITING && event.type !== TASK_EVENT.ASK ? { status: TASK_STATUS.RUNNING } : {};
	switch (event.type) {
		case TASK_EVENT.TOOL_START:
			return { ...resumed, lastStep: event.name, toolCalls: task.toolCalls + 1 };
		case TASK_EVENT.TURN_END:
			return { ...resumed, turns: task.turns + 1 };
		case TASK_EVENT.AGENT_END:
			return event.outcome === "success"
				? { ...resumed, result: event.text, error: null, lastStep: "responded" }
				: { ...resumed, result: null, error: event.diagnostic ?? "assistant did not produce a final report", lastStep: event.diagnostic ?? "assistant failed" };
		case TASK_EVENT.ERROR:
			return { ...resumed, lastStep: `error: ${event.message}` };
		case TASK_EVENT.ASK:
			return { status: TASK_STATUS.WAITING, lastStep: askNote(event.request) };
		case TASK_EVENT.TEXT:
			return { ...resumed, lastStep: task.lastStep === "queued" || task.lastStep === "starting" ? "writing" : task.lastStep };
		case TASK_EVENT.USAGE:
			return { ...resumed, tokens: task.tokens + event.tokens, cost: task.cost + event.cost };
		default:
			return resumed;
	}
}

export function summarize(tasks: Iterable<TaskRecord>): TaskSummary {
	const summary: TaskSummary = { running: 0, queued: 0, waiting: 0, finished: 0 };
	for (const task of tasks) {
		if (task.status === TASK_STATUS.RUNNING) summary.running += 1;
		else if (task.status === TASK_STATUS.QUEUED) summary.queued += 1;
		else if (task.status === TASK_STATUS.WAITING) summary.waiting += 1;
		else summary.finished += 1;
	}
	return summary;
}

export class TaskStore {
	private readonly tasks = new Map<string, TaskRecord>();
	private readonly threads = new Map<string, TaskThread>();
	private readonly listeners = new Map<string, Set<TaskListener>>();
	private readonly summaryListeners = new Set<SummaryListener>();
	private readonly limits: Partial<ThreadLimits>;
	private readonly producerId = randomUUID();
	private sequence = 0;
	private readonly runIds = new Map<string, string>();
	private readonly statusListeners = new Set<StatusChangeListener>();
	// Insertion-ordered recency of finished tasks, oldest first (Set keeps
	// insertion order); prune evicts from the front.
	private readonly terminalOrder = new Set<string>();

	constructor(limits: Partial<ThreadLimits> = {}) {
		this.limits = limits;
	}

	add(task: TaskRecord): void {
		const previous = this.tasks.get(task.id)?.status;
		if (!this.tasks.has(task.id)) this.runIds.set(task.id, randomUUID());
		this.tasks.set(task.id, task);
		this.threads.set(task.id, emptyThread(this.limits));
		this.notifyStatus(task, previous);
		if (isFinished(task.status)) {
			this.markTerminal(task.id);
			this.listeners.delete(task.id);
			this.pruneTerminal();
		}
		this.notifySummary();
	}

	// Bring a task back from disk with its thread; a live task is never
	// overwritten by a stored copy.
	restore(task: TaskRecord, thread: TaskThread): boolean {
		if (this.tasks.has(task.id)) return false;
		this.tasks.set(task.id, task);
		this.runIds.set(task.id, randomUUID());
		this.threads.set(task.id, { ...thread, limits: { ...DEFAULT_LIMITS, ...this.limits } });
		if (isFinished(task.status)) {
			this.markTerminal(task.id);
			this.listeners.delete(task.id);
			this.pruneTerminal();
		}
		this.notifySummary();
		return true;
	}

	get(id: string): TaskRecord | undefined {
		return this.tasks.get(id);
	}

	thread(id: string): TaskThread {
		return this.threads.get(id) ?? emptyThread(this.limits);
	}

	list(parentSessionId?: string): TaskRecord[] {
		return [...this.tasks.values()]
			.filter((task) => parentSessionId === undefined || task.parentSessionId === parentSessionId)
			.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt);
	}

	summary(parentSessionId?: string): TaskSummary {
		return summarize(this.list(parentSessionId));
	}

	// A status change is the only thing the summary cares about; everything
	// that happens inside a task stays with that task's listeners.
	update(id: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
		const current = this.tasks.get(id);
		if (!current) return undefined;
		const next = { ...current, ...patch };
		this.tasks.set(id, next);
		this.notifyStatus(next, current.status);
		this.notifyTask(next);
		if (next.status !== current.status) {
			// The terminal transition itself is the final notification; after it
			// the task never changes, so its listeners stop costing anything.
			if (isFinished(next.status)) {
				this.listeners.delete(next.id);
				this.markTerminal(next.id);
			}
			this.pruneTerminal();
			this.notifySummary();
		}
		return next;
	}

	apply(id: string, event: TaskEvent, at: number): TaskRecord | undefined {
		const current = this.tasks.get(id);
		if (!current) return undefined;
		this.threads.set(id, applyTaskEvent(this.thread(id), event));
		return this.update(id, { ...recordPatch(current, event), lastActivityAt: at });
	}

	subscribe(id: string, listener: TaskListener): () => void {
		const set = this.listeners.get(id) ?? new Set<TaskListener>();
		set.add(listener);
		this.listeners.set(id, set);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(id);
		};
	}

	subscribeSummary(listener: SummaryListener): () => void {
		this.summaryListeners.add(listener);
		return () => this.summaryListeners.delete(listener);
	}

	/** Optional, content-free observer. Restores and unchanged snapshots are silent. */
	subscribeStatusChanges(listener: StatusChangeListener): () => void {
		this.statusListeners.add(listener);
		return () => { this.statusListeners.delete(listener); };
	}

	private markTerminal(id: string): void {
		if (!this.terminalOrder.has(id)) this.terminalOrder.add(id);
	}

	/** Evict the oldest finished tasks beyond TERMINAL_RETENTION per parent
	 * session, with their threads, run ids and listeners. Running tasks are
	 * never evicted; a task that left the terminal state is skipped as stale. */
	private pruneTerminal(): void {
		const finished = new Map<string, number>();
		for (const task of this.tasks.values()) {
			if (!isFinished(task.status)) continue;
			finished.set(task.parentSessionId, (finished.get(task.parentSessionId) ?? 0) + 1);
		}
		if (finished.size === 0) return;
		for (const id of this.terminalOrder) {
			const task = this.tasks.get(id);
			if (!task || !isFinished(task.status)) { this.terminalOrder.delete(id); continue; }
			const count = finished.get(task.parentSessionId) ?? 0;
			if (count <= TERMINAL_RETENTION) continue;
			this.tasks.delete(id);
			this.threads.delete(id);
			this.listeners.delete(id);
			this.runIds.delete(id);
			this.terminalOrder.delete(id);
			finished.set(task.parentSessionId, count - 1);
		}
	}

	private notifyStatus(task: TaskRecord, previousStatus?: TaskStatus): void {
		if (task.status === previousStatus) return;
		const change: TaskStatusChange = Object.freeze({ producerId: this.producerId,
			sessionId: task.parentSessionId, parentSessionId: task.parentSessionId, taskId: task.id,
			runId: this.runIds.get(task.id)!, status: task.status, previousStatus, sequence: ++this.sequence });
		for (const listener of [...this.statusListeners]) {
			try { void Promise.resolve(listener(change)).catch(() => {}); } catch { /* Observability cannot fail a mutation. */ }
		}
	}

	private notifyTask(task: TaskRecord): void {
		const set = this.listeners.get(task.id);
		if (!set) return;
		const thread = this.thread(task.id);
		for (const listener of set) listener(task, thread);
	}

	private notifySummary(): void {
		if (this.summaryListeners.size === 0) return;
		const summary = this.summary();
		for (const listener of this.summaryListeners) listener(summary);
	}
}
