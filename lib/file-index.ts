import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GitResult, GitRunner } from "./shell-changes.ts";

// The file picker's data source (S10 listing, S3 preview). Both halves are
// pure and session-independent: Git is injected exactly like
// ShellDeps.gitRunner, and a preview is one bounded read, so the panel can be
// tested and rendered without a running Pi agent.

export type RepositoryListing = { ok: true; files: string[] } | { ok: false; message: string };

// -z avoids Git's quoting of paths containing whitespace or newlines; the
// cached and others sources together are the tracked files plus the
// untracked ones Git does not ignore, which is the picker's whole list.
const LIST_ARGS = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Byte order, not locale order: the list is rebuilt on every refresh and must
// come out the same everywhere.
function byCodePoint(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Repository-relative POSIX paths; a failed listing is a failure, never an empty success. */
export async function listRepositoryFiles(git: GitRunner): Promise<RepositoryListing> {
	let result: GitResult;
	try {
		result = await git(LIST_ARGS);
	} catch (error) {
		return { ok: false, message: `Cannot list repository files: ${errorMessage(error)}` };
	}
	if (result.truncated) return { ok: false, message: "Cannot list repository files: the listing was truncated." };
	if (result.code !== 0) return { ok: false, message: `Cannot list repository files: git ls-files exited with code ${result.code}.` };
	const paths = new Set<string>();
	for (const path of result.stdout.split("\0")) if (path.length > 0) paths.add(path);
	return { ok: true, files: [...paths].sort(byCodePoint) };
}

// The picker's row model (S12): the listing above plus each file's working-tree
// state and modification time, and none of the view concerns that consume them.
export interface FileEntry {
	path: string;
	state: "new" | "updated" | "clean";
	mtimeMs?: number;
}

export type RepositoryEntriesResult = { ok: true; entries: FileEntry[] } | { ok: false; message: string };

// One call decides every state: -z avoids quoted paths, and
// --untracked-files=all lists untracked files instead of their directory.
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

// Change state alone carries no absence time, so the mtimes come from a stat
// under this root. It is resolved from Git rather than process.cwd() because
// the picker can browse a registered worktree (S15/S16).
const ROOT_ARGS = ["rev-parse", "--show-toplevel"];

const CHANGES_ERROR = "Cannot read repository changes";

/** `XY <path>` records; a rename or copy puts its original path in the next field. */
function parseStatus(stdout: string): Map<string, "new" | "updated"> {
	const states = new Map<string, "new" | "updated">();
	const fields = stdout.split("\0");
	for (let index = 0; index < fields.length; index += 1) {
		const record = fields[index] ?? "";
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		const path = record.slice(3);
		if (path.length > 0) states.set(path, code === "??" ? "new" : "updated");
		if (code[0] === "R" || code[0] === "C") index += 1;
	}
	return states;
}

async function repositoryRoot(git: GitRunner): Promise<string | undefined> {
	try {
		const result = await git(ROOT_ARGS);
		if (result.code !== 0 || result.truncated) return undefined;
		const root = result.stdout.trim();
		return root.length > 0 ? root : undefined;
	} catch {
		return undefined;
	}
}

// An mtime feeds the age label, not the list: an unreadable file or root leaves
// mtimeMs undefined rather than failing the whole picker.
function modificationTime(root: string | undefined, path: string): number | undefined {
	if (root === undefined) return undefined;
	try {
		return statSync(join(root, path)).mtimeMs;
	} catch {
		return undefined;
	}
}

// Newest change first; entries without an mtime (a deletion, an unreadable
// file) follow the timed ones, and path breaks every tie so the order is stable.
function byRecency(left: FileEntry, right: FileEntry): number {
	if (left.mtimeMs !== undefined && right.mtimeMs !== undefined && left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
	if (left.mtimeMs !== undefined && right.mtimeMs === undefined) return -1;
	if (left.mtimeMs === undefined && right.mtimeMs !== undefined) return 1;
	return byCodePoint(left.path, right.path);
}

/**
 * The picker's rows: the same file set as `listRepositoryFiles`, changed files
 * first and newest first, then untouched files by path.
 */
export async function listRepositoryEntries(git: GitRunner): Promise<RepositoryEntriesResult> {
	const listing = await listRepositoryFiles(git);
	if (listing.ok === false) return { ok: false, message: listing.message };
	return entriesFor(git, listing.files);
}

async function entriesFor(git: GitRunner, files: string[]): Promise<RepositoryEntriesResult> {
	let status: GitResult;
	try {
		status = await git(STATUS_ARGS);
	} catch (error) {
		return { ok: false, message: `${CHANGES_ERROR}: ${errorMessage(error)}` };
	}
	if (status.truncated) return { ok: false, message: `${CHANGES_ERROR}: the status was truncated.` };
	if (status.code !== 0) return { ok: false, message: `${CHANGES_ERROR}: git status exited with code ${status.code}.` };
	const states = parseStatus(status.stdout);
	const changedPaths = files.filter((path) => states.has(path));
	const root = changedPaths.length > 0 ? await repositoryRoot(git) : undefined;
	const changed: FileEntry[] = changedPaths.map((path) => {
		const entry: FileEntry = { path, state: states.get(path) ?? "updated" };
		const mtimeMs = modificationTime(root, path);
		if (mtimeMs !== undefined) entry.mtimeMs = mtimeMs;
		return entry;
	});
	const clean: FileEntry[] = files.filter((path) => !states.has(path)).sort(byCodePoint).map((path) => ({ path, state: "clean" }));
	return { ok: true, entries: [...changed.sort(byRecency), ...clean] };
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A coarse label for one elapsed age; the caller computes it once at open (S12). */
export function formatAge(mtimeMs: number, nowMs: number): string {
	const elapsed = nowMs - mtimeMs;
	if (elapsed < MINUTE) return `${Math.max(0, Math.floor(elapsed / 1000))}s`;
	if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
	if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
	return `${Math.floor(elapsed / DAY)}d`;
}

// A preview is the first bytes of a file, never the whole file: the caps keep
// one minified line, one huge binary, or one enormous source file from
// reaching the renderer. maxLineWidth counts characters, not terminal cells.
export const FILE_PREVIEW_LIMITS = Object.freeze({ maxBytes: 64 * 1024, maxLines: 200, maxLineWidth: 400 });

export const FILE_PREVIEW_BINARY_NOTICE = "Binary file — preview not available.";

const ELLIPSIS = "…";

export type FilePreview =
	| { kind: "text"; lines: string[]; truncated: boolean }
	| { kind: "binary"; message: string }
	| { kind: "error"; message: string };

/** One whole read of at most `buffer.length` bytes, so a pipe or a short read cannot cut it short. */
function readInto(fd: number, buffer: Buffer): number {
	let length = 0;
	while (length < buffer.length) {
		const read = readSync(fd, buffer, length, buffer.length - length, length);
		if (read === 0) break;
		length += read;
	}
	return length;
}

function unreadable(relative: string, error: unknown): FilePreview {
	const code = (error as { code?: unknown } | null)?.code;
	return { kind: "error", message: `Cannot read ${relative}${typeof code === "string" ? ` (${code})` : ""}.` };
}

export function readFilePreview(root: string, relative: string): FilePreview {
	let fd: number;
	try {
		fd = openSync(join(root, relative), "r");
	} catch (error) {
		return unreadable(relative, error);
	}
	let head: Buffer;
	let overBudget: boolean;
	try {
		const buffer = Buffer.allocUnsafe(FILE_PREVIEW_LIMITS.maxBytes);
		const length = readInto(fd, buffer);
		// A full budget is only a truncation when a further byte exists: a file
		// of exactly maxBytes previews whole.
		overBudget = length === buffer.length && readSync(fd, Buffer.allocUnsafe(1), 0, 1, length) > 0;
		head = buffer.subarray(0, length);
	} catch (error) {
		return unreadable(relative, error);
	} finally {
		closeSync(fd);
	}
	if (head.includes(0)) return { kind: "binary", message: FILE_PREVIEW_BINARY_NOTICE };
	// A lone CR counts as a line break too, so an old Mac file reads as lines.
	const split = head.toString("utf8").replace(/\r\n?/g, "\n").split("\n");
	if (split[split.length - 1] === "") split.pop();
	const cappedLines = split.length > FILE_PREVIEW_LIMITS.maxLines;
	const candidates = cappedLines ? split.slice(0, FILE_PREVIEW_LIMITS.maxLines) : split;
	let widthCapped = false;
	const lines = candidates.map((line) => {
		if (line.length <= FILE_PREVIEW_LIMITS.maxLineWidth) return line;
		widthCapped = true;
		return `${line.slice(0, FILE_PREVIEW_LIMITS.maxLineWidth - 1)}${ELLIPSIS}`;
	});
	return { kind: "text", lines, truncated: overBudget || cappedLines || widthCapped };
}
