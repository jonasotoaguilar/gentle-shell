import type { FileScope } from "./file-scope-view.ts";

// The file picker's insertion form (S16/S17): the picker emits paths relative
// to the scope root it browsed, and this turns that payload into the exact
// text pasted into the prompt. Pure, so both forms are testable without a Pi
// session or a repository.

/** The part of a FileScope the reference form depends on. */
export type InsertionScope = Pick<FileScope, "root" | "kind">;

// The repository's own path style is forward slashes (lib/file-index.ts), and
// Pi resolves the same form on every platform; a Windows path accepts them too.
function forwardSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

function relativeToScope(relative: string): string {
	return forwardSlashes(relative.trim()).replace(/^(\.\/)+/, "");
}

function scopeRoot(root: string): string {
	const normalized = forwardSlashes(root.trim());
	return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** True for a path that is already absolute, so it is never prefixed a second time. */
function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

/**
 * One file's reference: `@` plus the repository-relative path for a file of
 * the session repository, its real absolute path for a file of a registered
 * worktree (`@` resolves against the session path, so it would name the wrong
 * file there). The home directory is never shortened: Pi does not expand `~`.
 */
export function fileReference(scope: InsertionScope, relative: string): string {
	const path = relativeToScope(relative);
	if (path.length === 0) return "";
	if (isAbsolutePath(path)) return path;
	if (scope.kind === "main") return `@${path}`;
	return `${scopeRoot(scope.root)}/${path}`;
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
