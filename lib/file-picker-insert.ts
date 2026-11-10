import { posix } from "node:path";
import type { FileScope } from "./file-scope-view.ts";

// The file picker's insertion form (S16/S17): the picker emits paths relative
// to the scope root it browsed, and this turns that payload into the exact
// text pasted into the prompt. Pure, so both forms are testable without a Pi
// session or a repository.

/** The part of a FileScope the reference form depends on, plus the session cwd. */
export type InsertionScope = Pick<FileScope, "root" | "kind"> & {
	/** The session's working directory: Pi resolves `@` against it, not against the repository root. */
	cwd: string;
};

// The repository's own path style is forward slashes (lib/file-index.ts), and
// Pi resolves the same form on every platform; a Windows path accepts them too.
function forwardSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

function normalizedPath(path: string): string {
	const slashed = forwardSlashes(path.trim());
	if (slashed.length === 0) return "";
	const normalized = posix.normalize(slashed);
	return normalized === "." ? "" : normalized;
}

function relativeToScope(relative: string): string {
	return normalizedPath(relative).replace(/^(\.\/)+/, "");
}

function scopeRoot(root: string): string {
	const normalized = normalizedPath(root);
	return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** The file's real absolute path: the scope root joined with its path in that root. */
function absolutePath(root: string, relative: string): string {
	const base = scopeRoot(root);
	return posix.normalize(base.length === 0 ? `/${relative}` : `${base}/${relative}`);
}

/** The path of `absolute` below `cwd`, or undefined when the file is not under it. */
function pathBelow(cwd: string, absolute: string): string | undefined {
	const base = scopeRoot(cwd);
	if (base.length === 0) return undefined;
	const prefix = base.endsWith("/") ? base : `${base}/`;
	return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : undefined;
}

/** True for a path that is already absolute, so it is never prefixed a second time. */
function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

/**
 * One file's reference. A file below the session cwd is `@` plus its path from
 * that cwd, which is what Pi resolves (`@AGENTS.md`), never the path from the
 * repository root: a session started in a subdirectory would name another file.
 * Any other file -- outside the cwd, from a registered worktree, or a name that
 * would read as a home reference -- is its real absolute path, because Pi does
 * not expand `~` and `@` resolves against the session cwd.
 */
export function fileReference(scope: InsertionScope, relative: string): string {
	const path = relativeToScope(relative);
	if (path.length === 0) return "";
	if (isAbsolutePath(path)) return path;
	const absolute = absolutePath(scope.root, path);
	if (scope.kind !== "main") return absolute;
	const fromCwd = pathBelow(scope.cwd, absolute);
	return fromCwd === undefined || fromCwd.startsWith("~") ? absolute : `@${fromCwd}`;
}

/**
 * The exact text Enter pastes for the chosen files: one reference per file,
 * space-separated, in the order given, with no leading, trailing or doubled
 * separator. A file the payload repeats is named once.
 */
export function formatFileInsertion(relativePaths: readonly string[], scope: InsertionScope): string {
	const references: string[] = [];
	for (const relative of relativePaths) {
		const reference = fileReference(scope, relative);
		if (reference.length > 0 && !references.includes(reference)) references.push(reference);
	}
	return references.join(" ");
}
