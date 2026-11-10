import assert from "node:assert/strict";
import test from "node:test";
import { formatFileInsertion } from "../lib/file-picker-insert.ts";

// The picker's insertion form (S16/S17): a file below the session cwd is `@`
// plus its path from that cwd, because Pi resolves `@` against the session
// cwd; any other file is its real absolute path, never a `~` form.

const MAIN = { root: "/repo", kind: "main" as const, cwd: "/repo" };
const WORKTREE = { root: "/home/dev/gentle-worktrees/feature", kind: "worktree" as const, cwd: "/repo" };

// A session started in a subdirectory: the repository root is still /repo,
// but Pi resolves `@` against /repo/packages/app.
const SUBDIRECTORY = { root: "/repo", kind: "main" as const, cwd: "/repo/packages/app" };

test("a file from the session repository is inserted as @ plus its relative path", () => {
	assert.equal(formatFileInsertion(["AGENTS.md"], MAIN), "@AGENTS.md");
	assert.equal(formatFileInsertion(["src/index.ts"], MAIN), "@src/index.ts");
	assert.equal(formatFileInsertion(["themes/Gentle.json"], MAIN), "@themes/Gentle.json");
});

test("a file from a registered worktree is inserted as its absolute path, never @", () => {
	assert.equal(formatFileInsertion(["src/index.ts"], WORKTREE), "/home/dev/gentle-worktrees/feature/src/index.ts");
	assert.equal(formatFileInsertion(["AGENTS.md"], WORKTREE).startsWith("@"), false);
});

test("nested relative paths keep every separator", () => {
	assert.equal(formatFileInsertion(["packages/app/src/deep/file.ts"], MAIN), "@packages/app/src/deep/file.ts");
	assert.equal(
		formatFileInsertion(["packages/app/src/deep/file.ts"], WORKTREE),
		"/home/dev/gentle-worktrees/feature/packages/app/src/deep/file.ts",
	);
});

test("several files join with one space, in the given order", () => {
	assert.equal(formatFileInsertion(["b.ts", "a.ts", "dir/c.ts"], MAIN), "@b.ts @a.ts @dir/c.ts");
	assert.equal(
		formatFileInsertion(["one.ts", "two.ts"], WORKTREE),
		"/home/dev/gentle-worktrees/feature/one.ts /home/dev/gentle-worktrees/feature/two.ts",
	);
});

test("the joined text has no leading, trailing or doubled separator", () => {
	const text = formatFileInsertion(["one.ts", "two.ts", "three.ts"], MAIN);
	assert.equal(text, text.trim());
	assert.equal(/ {2}/.test(text), false);
});

test("an empty list yields an empty string", () => {
	assert.equal(formatFileInsertion([], MAIN), "");
	assert.equal(formatFileInsertion([], WORKTREE), "");
});

test("a path is never duplicated by the formatter", () => {
	const absolute = "/home/dev/gentle-worktrees/feature/src/index.ts";
	assert.equal(formatFileInsertion([absolute], WORKTREE), absolute);
	assert.equal(formatFileInsertion(["src/index.ts"], WORKTREE), absolute);
	assert.equal(formatFileInsertion(["src/index.ts", "src/index.ts"], WORKTREE), absolute);
	assert.equal(formatFileInsertion(["src/index.ts", "src/index.ts"], MAIN), "@src/index.ts");
});

test("Windows-style separators normalise to forward slashes", () => {
	assert.equal(formatFileInsertion(["src\\index.ts"], MAIN), "@src/index.ts");
	assert.equal(formatFileInsertion(["src\\nested\\dir\\file.ts"], MAIN), "@src/nested/dir/file.ts");
	assert.equal(formatFileInsertion(["src\\index.ts"], { root: "C:\\repo\\wt", kind: "worktree", cwd: "C:/repo" }), "C:/repo/wt/src/index.ts");
});

test("the home directory is never abbreviated to ~", () => {
	const text = formatFileInsertion(["src/index.ts"], { root: "/home/dev/gentle-worktrees/feature", kind: "worktree", cwd: "/repo" });
	assert.equal(text.includes("~"), false);
});

test("a file below the session cwd is @ plus the path from that cwd, not from the repository root", () => {
	assert.equal(formatFileInsertion(["packages/app/src/index.ts"], SUBDIRECTORY), "@src/index.ts");
	assert.equal(formatFileInsertion(["packages/app/AGENTS.md"], SUBDIRECTORY), "@AGENTS.md");
	assert.equal(formatFileInsertion(["packages/app/src/index.ts"], { ...SUBDIRECTORY, cwd: "/repo/packages/app/" }), "@src/index.ts", "a trailing slash on the cwd changes nothing");
});

test("a repository file outside the session cwd is inserted as its real absolute path", () => {
	assert.equal(formatFileInsertion(["lib/file-index.ts"], SUBDIRECTORY), "/repo/lib/file-index.ts", "a file above the cwd cannot be named relative to it");
	assert.equal(formatFileInsertion(["packages/other/x.ts"], SUBDIRECTORY), "/repo/packages/other/x.ts", "a sibling directory is outside the cwd");
	assert.equal(formatFileInsertion(["packages/app/src/index.ts", "lib/file-index.ts"], SUBDIRECTORY), "@src/index.ts /repo/lib/file-index.ts", "each file is named from the cwd that holds it");
});

test("a path that begins with ~ is emitted as its real absolute path, never in ~ form", () => {
	assert.equal(formatFileInsertion(["~/notes.md"], MAIN), "/repo/~/notes.md", "a file literally named ~ must not become a home reference");
	assert.equal(formatFileInsertion(["~"], MAIN), "/repo/~");
	assert.equal(formatFileInsertion(["~/notes.md"], MAIN).startsWith("~"), false);
	const underHome = { root: "/home/dev/repo", kind: "main" as const, cwd: "/home/dev/repo" };
	assert.equal(formatFileInsertion(["src/index.ts"], underHome), "@src/index.ts", "a repository under the home directory keeps the short @ form");
	assert.equal(formatFileInsertion(["src/index.ts"], underHome).startsWith("~"), false);
});

test("a worktree file stays absolute even when the session cwd is that worktree", () => {
	const inWorktree = { root: "/home/dev/gentle-worktrees/feature", kind: "worktree" as const, cwd: "/home/dev/gentle-worktrees/feature" };
	assert.equal(formatFileInsertion(["src/index.ts"], inWorktree), "/home/dev/gentle-worktrees/feature/src/index.ts");
});
