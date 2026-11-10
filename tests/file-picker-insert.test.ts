import assert from "node:assert/strict";
import test from "node:test";
import { formatFileInsertion } from "../lib/file-picker-insert.ts";

// The picker's insertion form (S16/S17): a file inside the session repository
// is `@` plus its repository-relative path, because Pi resolves `@` against
// the session path; a file from a registered worktree is its real absolute
// path, because `@` would name a different file there.

const MAIN = { root: "/repo", kind: "main" as const };
const WORKTREE = { root: "/home/dev/gentle-worktrees/feature", kind: "worktree" as const };

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
	assert.equal(formatFileInsertion(["src\\index.ts"], { root: "C:\\repo\\wt", kind: "worktree" }), "C:/repo/wt/src/index.ts");
});

test("the home directory is never abbreviated to ~", () => {
	const text = formatFileInsertion(["src/index.ts"], { root: "/home/dev/gentle-worktrees/feature", kind: "worktree" });
	assert.equal(text.includes("~"), false);
});
