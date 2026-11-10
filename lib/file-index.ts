import { closeSync, openSync, readSync } from "node:fs";
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
